import type { AuditEntry, Manifest, WorkspaceConfig } from '../core/types.ts';
import type { AuditLogReader } from '../db/audit-log.ts';
import { PolicyEngine } from '../policy/engine.ts';
import { matchesPattern } from '../policy/rule-matcher.ts';
import { renderTomlSnippet } from './toml.ts';
import { suggestRules } from './suggestions.ts';
import type { AuditFilter, RuleAnalysis, RuleFinding, RuleSuggestion } from './types.ts';

export interface RuleAnalysisOptions extends AuditFilter {
	/** Summary returns rule health without hotspots, suggestions, or TOML detail. */
	projection?: 'full' | 'summary';
	/** Minimum cluster size before a rule suggestion qualifies. Default 5. */
	minOccurrences?: number;
	/** Cap on audit entries replayed for empirical shadow detection and validation. Default 2000. */
	replayLimit?: number;
}

const REGEX_PATTERN_RE = /^\/(.+)\/([gimsuy]*)$/;

function invalidRegexNote(pattern: string): string | undefined {
	const match = REGEX_PATTERN_RE.exec(pattern);
	if (!match) return undefined;

	try {
		new RegExp(match[1] as string, match[2]);
		return undefined;
	} catch (error: unknown) {
		return error instanceof Error ? error.message : String(error);
	}
}

function isWildcardFree(pattern: string): boolean {
	return !REGEX_PATTERN_RE.test(pattern) && !pattern.includes('*');
}

type MatchedRuleRow = ReturnType<AuditLogReader['matchedRuleCounts']>[number];

function resolveAnalysisWorkspace(manifest: Manifest, workspaceId: string | undefined): WorkspaceConfig | undefined {
	if (workspaceId === undefined) return undefined;
	const workspace = manifest.workspaces?.find((entry) => entry.id === workspaceId);
	if (!workspace) throw new Error(`workspace "${workspaceId}" is not configured`);
	return workspace;
}

function rowMatchesScope(row: MatchedRuleRow, workspaceId: string | undefined): boolean {
	return workspaceId
		? row.policyScope === 'workspace' && row.resolvedWorkspaceId === workspaceId
		: row.policyScope !== 'workspace';
}

function matchedRuleCountMap(rows: MatchedRuleRow[], workspaceId: string | undefined): Map<string, MatchedRuleRow> {
	const counts = new Map<string, MatchedRuleRow>();
	for (const row of rows) {
		if (!rowMatchesScope(row, workspaceId)) continue;
		const current = counts.get(row.matchedRule);
		counts.set(row.matchedRule, {
			...row,
			count: (current?.count ?? 0) + row.count,
			lastMatched: current && current.lastMatched > row.lastMatched ? current.lastMatched : row.lastMatched,
		});
	}
	return counts;
}

function empiricalShadows(
	entries: AuditEntry[],
	manifest: Manifest,
	scope: 'global' | 'workspace',
	workspaceId?: string
): Map<string, string> {
	const shadowedBy = new Map<string, string>();
	const engine = new PolicyEngine(manifest);
	for (const entry of entries) {
		const trace = engine.evaluateWithTrace(entry);
		const matching = trace.matches.filter(
			(match) => match.scope === scope && (scope === 'global' || trace.result.resolvedWorkspaceId === workspaceId)
		);
		const winner = trace.matches.find((match) => match.selected);
		if (!winner) continue;
		for (const match of matching) {
			if (!match.selected && !shadowedBy.has(match.id)) shadowedBy.set(match.id, winner.id);
		}
	}
	return shadowedBy;
}

function addStaticShadows(
	rulePatterns: Array<[string, Manifest['rules'][string]]>,
	shadowedBy: Map<string, string>
): void {
	for (let index = 0; index < rulePatterns.length; index += 1) {
		const [pattern] = rulePatterns[index] as [string, Manifest['rules'][string]];
		if (shadowedBy.has(pattern) || !isWildcardFree(pattern)) continue;
		for (let earlierIndex = 0; earlierIndex < index; earlierIndex += 1) {
			const [earlier] = rulePatterns[earlierIndex] as [string, Manifest['rules'][string]];
			if (!matchesPattern(pattern, earlier)) continue;
			shadowedBy.set(pattern, earlier);
			break;
		}
	}
}

function matchedCount(row: MatchedRuleRow | undefined): number {
	return row ? row.count : 0;
}

function findingState(
	pattern: string,
	allTimeCount: number,
	windowCount: number,
	shadowedBy: Map<string, string>
): Pick<RuleFinding, 'status' | 'note'> {
	const invalidNote = invalidRegexNote(pattern);
	if (invalidNote !== undefined) {
		return { status: 'invalid', note: `regex fails to compile: ${invalidNote}` };
	}
	if (allTimeCount === 0) {
		return { status: shadowedBy.has(pattern) ? 'shadowed' : 'dead' };
	}
	return { status: windowCount === 0 ? 'stale' : 'active' };
}

function ruleFinding(
	[pattern, decision]: [string, Manifest['rules'][string]],
	workspaceId: string | undefined,
	allTimeCounts: Map<string, MatchedRuleRow>,
	windowCounts: Map<string, MatchedRuleRow>,
	shadowedBy: Map<string, string>
): RuleFinding {
	const allTime = allTimeCounts.get(pattern);
	const inWindow = windowCounts.get(pattern);
	const matchCount = matchedCount(inWindow);
	const matchCountAllTime = matchedCount(allTime);
	const { status, note } = findingState(pattern, matchCountAllTime, matchCount, shadowedBy);

	return {
		pattern,
		decision,
		workspaceId,
		matchCount,
		matchCountAllTime,
		lastMatched: allTime?.lastMatched,
		status,
		shadowedBy: status === 'shadowed' ? shadowedBy.get(pattern) : undefined,
		note,
	};
}

function structuredFinding(
	rule: NonNullable<Manifest['structuredRules']>[number] | NonNullable<Manifest['guards']>[number],
	workspaceId: string | undefined,
	allTimeCounts: Map<string, MatchedRuleRow>,
	windowCounts: Map<string, MatchedRuleRow>,
	kind: 'structured rule' | 'guard',
	shadowedBy: Map<string, string>
): RuleFinding {
	const allTime = allTimeCounts.get(rule.id);
	const inWindow = windowCounts.get(rule.id);
	const matchCount = matchedCount(inWindow);
	const matchCountAllTime = matchedCount(allTime);
	const status =
		matchCountAllTime === 0 ? (shadowedBy.has(rule.id) ? 'shadowed' : 'dead') : matchCount === 0 ? 'stale' : 'active';
	return {
		pattern: rule.id,
		decision: rule.decision,
		workspaceId,
		matchCount,
		matchCountAllTime,
		lastMatched: allTime?.lastMatched,
		status,
		shadowedBy: status === 'shadowed' ? shadowedBy.get(rule.id) : undefined,
		note: `${kind} id`,
	};
}

function hygieneSuggestion(finding: RuleFinding): RuleSuggestion {
	const invalid = finding.status === 'invalid';
	const shadowed = finding.status === 'shadowed';
	return {
		pattern: finding.pattern,
		decision: finding.decision,
		workspaceId: finding.workspaceId,
		kind: invalid ? 'fix-invalid' : shadowed ? 'reorder-shadowed' : 'remove-dead',
		rationale: invalid
			? `${finding.note ?? 'invalid regex'} — this rule silently never matches`
			: shadowed
				? `never wins: earlier rule "${finding.shadowedBy}" captures its matches first`
				: 'never matched any recorded tool call',
		evidence: {
			occurrences: finding.matchCountAllTime,
			approvedCount: 0,
			deniedCount: 0,
			distinctCommands: 0,
			sampleCommands: [],
		},
		conflicts: [],
	};
}

// fallow-ignore-next-line complexity -- this composes independently tested analytics projections and readers.
export function analyzeRules(
	manifest: Manifest,
	auditLog: AuditLogReader,
	options: RuleAnalysisOptions = {}
): RuleAnalysis {
	const window = { since: options.since, until: options.until };
	const filter = {
		...window,
		agent: options.agent,
		project: options.project,
		workspace: options.workspace,
	};
	const replayLimit = options.replayLimit ?? 2000;
	const workspace = resolveAnalysisWorkspace(manifest, options.workspace);
	const allTimeRows = auditLog.matchedRuleCounts(workspace ? { workspace: workspace.id } : {});
	const allTimeCounts = matchedRuleCountMap(allTimeRows, workspace?.id);
	const windowMatchesAllTime =
		options.since === undefined &&
		options.until === undefined &&
		options.agent === undefined &&
		options.project === undefined;
	const windowRows = windowMatchesAllTime ? allTimeRows : auditLog.matchedRuleCounts(filter);
	const windowCounts = matchedRuleCountMap(windowRows, workspace?.id);
	const analyzedRules = workspace?.rules ?? manifest.rules;
	const analyzedStructuredRules = workspace ? (workspace.structuredRules ?? []) : (manifest.structuredRules ?? []);
	const analyzedGuards = workspace ? (workspace.guards ?? []) : (manifest.guards ?? []);
	const rulePatterns = Object.entries(analyzedRules);

	// Empirical shadow detection: replay recent history and record cases where
	// a rule would have matched but an earlier rule consumed the call.
	const replayEntries =
		options.projection !== 'summary' || rulePatterns.length > 0 ? auditLog.listRecentFiltered(filter, replayLimit) : [];
	const shadowedBy = empiricalShadows(replayEntries, manifest, workspace ? 'workspace' : 'global', workspace?.id);

	// Static shadow detection: a wildcard-free rule whose literal text an
	// earlier rule already matches can never win.
	addStaticShadows(rulePatterns, shadowedBy);
	const rules = [
		...analyzedStructuredRules.map((rule) =>
			structuredFinding(rule, workspace?.id, allTimeCounts, windowCounts, 'structured rule', shadowedBy)
		),
		...analyzedGuards.map((guard) =>
			structuredFinding(guard, workspace?.id, allTimeCounts, windowCounts, 'guard', shadowedBy)
		),
		...rulePatterns.map((entry) => ruleFinding(entry, workspace?.id, allTimeCounts, windowCounts, shadowedBy)),
	];
	if (options.projection === 'summary') {
		return {
			projection: 'summary',
			window,
			workspaceId: workspace?.id,
			rules,
			approvalHotspots: [],
			suggestions: [],
			tomlSnippet: '',
		};
	}

	const clusterEntries = auditLog.unmatchedEntries(filter, replayLimit);
	const approvalHotspots = auditLog.approvalHotspots(filter);

	const minedSuggestions = suggestRules(
		manifest,
		auditLog,
		{
			...filter,
			minOccurrences: options.minOccurrences,
			replayLimit,
		},
		{ replayEntries, clusterEntries }
	);

	const hygieneSuggestions: RuleSuggestion[] = rules
		.filter(
			(finding) =>
				finding.note !== 'structured rule id' &&
				finding.note !== 'guard id' &&
				(finding.status === 'dead' || finding.status === 'invalid' || finding.status === 'shadowed')
		)
		.map(hygieneSuggestion);

	const suggestions = [...minedSuggestions, ...hygieneSuggestions];

	return {
		projection: 'full',
		window,
		workspaceId: workspace?.id,
		rules,
		approvalHotspots,
		suggestions,
		tomlSnippet: renderTomlSnippet(suggestions, window, workspace?.id),
	};
}
