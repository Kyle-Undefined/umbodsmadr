import type { AuditEntry, Manifest } from '../core/types.ts';
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

export function analyzeRules(
	manifest: Manifest,
	auditLog: AuditLogStore,
	options: RuleAnalysisOptions = {}
): RuleAnalysis {
	const window = { since: options.since, until: options.until };
	const filter = { ...window, agent: options.agent, project: options.project };
	const replayLimit = options.replayLimit ?? 2000;

	const allTimeCounts = new Map(auditLog.matchedRuleCounts({}).map((row) => [row.matchedRule, row]));
	const windowCounts = new Map(auditLog.matchedRuleCounts(filter).map((row) => [row.matchedRule, row]));

	const rulePatterns = Object.entries(manifest.rules);

	// Empirical shadow detection: replay recent history and record cases where
	// a rule would have matched but an earlier rule consumed the call.
	const shadowedBy = new Map<string, string>();
	const replayEntries = auditLog.listRecentFiltered(filter, replayLimit);
	for (const entry of replayEntries) {
		const { winner, matching } = replayEntry(entry, manifest.rules);
		if (winner === undefined) continue;
		for (const pattern of matching) {
			if (pattern !== winner && !shadowedBy.has(pattern)) {
				shadowedBy.set(pattern, winner);
			}
		}
	}

	// Static shadow detection: a wildcard-free rule whose literal text an
	// earlier rule already matches can never win.
	for (let i = 0; i < rulePatterns.length; i += 1) {
		const [pattern] = rulePatterns[i] as [string, Manifest['rules'][string]];
		if (shadowedBy.has(pattern) || !isWildcardFree(pattern)) continue;

		for (let j = 0; j < i; j += 1) {
			const [earlier] = rulePatterns[j] as [string, Manifest['rules'][string]];
			if (matchesPattern(pattern, earlier)) {
				shadowedBy.set(pattern, earlier);
				break;
			}
		}
	}

	const rules: RuleFinding[] = rulePatterns.map(([pattern, decision]) => {
		const allTime = allTimeCounts.get(pattern);
		const inWindow = windowCounts.get(pattern);
		const invalidNote = invalidRegexNote(pattern);

		let status: RuleFinding['status'] = 'active';
		let note: string | undefined;

		if (invalidNote !== undefined) {
			status = 'invalid';
			note = `regex fails to compile: ${invalidNote}`;
		} else if ((allTime?.count ?? 0) === 0 && shadowedBy.has(pattern)) {
			status = 'shadowed';
		} else if ((allTime?.count ?? 0) === 0) {
			status = 'dead';
		} else if ((inWindow?.count ?? 0) === 0) {
			status = 'stale';
		}

		return {
			pattern,
			decision,
			matchCount: inWindow?.count ?? 0,
			matchCountAllTime: allTime?.count ?? 0,
			lastMatched: allTime?.lastMatched,
			status,
			shadowedBy: status === 'shadowed' ? shadowedBy.get(pattern) : undefined,
			note,
		};
	});

	const approvalHotspots = auditLog.approvalHotspots(filter);

	const minedSuggestions = suggestRules(manifest, auditLog, {
		...filter,
		minOccurrences: options.minOccurrences,
		replayLimit,
	});

	const hygieneSuggestions: RuleSuggestion[] = rules
		.filter((finding) => finding.status === 'dead' || finding.status === 'invalid' || finding.status === 'shadowed')
		.map((finding) => ({
			pattern: finding.pattern,
			decision: finding.decision,
			kind:
				finding.status === 'invalid'
					? 'fix-invalid'
					: finding.status === 'shadowed'
						? 'reorder-shadowed'
						: 'remove-dead',
			rationale:
				finding.status === 'invalid'
					? `${finding.note ?? 'invalid regex'} — this rule silently never matches`
					: finding.status === 'shadowed'
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
		}));

	const suggestions = [...minedSuggestions, ...hygieneSuggestions];

	return {
		window,
		rules,
		approvalHotspots,
		suggestions,
		tomlSnippet: renderTomlSnippet(suggestions, window),
	};
}
