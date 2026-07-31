import type { AuditEntry, Manifest, WorkspaceConfig } from '../core/types.ts';
import type { AuditLogStore } from '../db/audit-log.ts';
import { matchesPattern } from '../policy/rule-matcher.ts';
import { ruleMatchCandidates } from '../policy/rule-candidates.ts';
import { renderTomlSnippet } from './toml.ts';
import { suggestRules } from './suggestions.ts';
import type { AuditFilter, RuleAnalysis, RuleFinding, RuleSuggestion } from './types.ts';

export interface RuleAnalysisOptions extends AuditFilter {
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

/**
 * Replays a historical tool call against the full rule list exactly like the
 * engine does, returning every pattern that would match plus the winner.
 */
function replayEntry(entry: AuditEntry, rules: Manifest['rules']): { winner?: string; matching: string[] } {
	const candidates = ruleMatchCandidates(entry);
	const matching: string[] = [];
	let winner: string | undefined;

	for (const [pattern] of Object.entries(rules)) {
		const matches = candidates.some((candidate) => matchesPattern(candidate, pattern));
		if (!matches) continue;
		matching.push(pattern);
	}

	// First match in insertion order over the first candidate that hits it —
	// mirror findFirstMatchingRule: iterate candidates outer, rules inner.
	outer: for (const candidate of candidates) {
		for (const [pattern] of Object.entries(rules)) {
			if (matchesPattern(candidate, pattern)) {
				winner = pattern;
				break outer;
			}
		}
	}

	return { winner, matching };
}

type MatchedRuleRow = ReturnType<AuditLogStore['matchedRuleCounts']>[number];

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

function empiricalShadows(entries: AuditEntry[], rules: Manifest['rules']): Map<string, string> {
	const shadowedBy = new Map<string, string>();
	for (const entry of entries) {
		const { winner, matching } = replayEntry(entry, rules);
		if (winner === undefined) continue;
		for (const pattern of matching) {
			if (pattern !== winner && !shadowedBy.has(pattern)) shadowedBy.set(pattern, winner);
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

export function analyzeRules(
	manifest: Manifest,
	auditLog: AuditLogStore,
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
	const windowCounts = matchedRuleCountMap(auditLog.matchedRuleCounts(filter), workspace?.id);
	const analyzedRules = workspace?.rules ?? manifest.rules;
	const rulePatterns = Object.entries(analyzedRules);

	// Empirical shadow detection: replay recent history and record cases where
	// a rule would have matched but an earlier rule consumed the call.
	const replayEntries = auditLog.listRecentFiltered(filter, replayLimit);
	const shadowedBy = empiricalShadows(replayEntries, analyzedRules);

	// Static shadow detection: a wildcard-free rule whose literal text an
	// earlier rule already matches can never win.
	addStaticShadows(rulePatterns, shadowedBy);
	const rules = rulePatterns.map((entry) => ruleFinding(entry, workspace?.id, allTimeCounts, windowCounts, shadowedBy));

	const approvalHotspots = auditLog.approvalHotspots(filter);

	const minedSuggestions = suggestRules(
		manifest,
		auditLog,
		{
			...filter,
			minOccurrences: options.minOccurrences,
			replayLimit,
		},
		replayEntries
	);

	const hygieneSuggestions: RuleSuggestion[] = rules
		.filter((finding) => finding.status === 'dead' || finding.status === 'invalid' || finding.status === 'shadowed')
		.map(hygieneSuggestion);

	const suggestions = [...minedSuggestions, ...hygieneSuggestions];

	return {
		window,
		workspaceId: workspace?.id,
		rules,
		approvalHotspots,
		suggestions,
		tomlSnippet: renderTomlSnippet(suggestions, window, workspace?.id),
	};
}
