import { dirname } from 'node:path';

import type { AuditEntry, Manifest } from '../core/types.ts';
import type { AuditLogStore } from '../db/audit-log.ts';
import { matchesPattern } from '../policy/rule-matcher.ts';
import { ruleMatchCandidates } from '../policy/rule-candidates.ts';
import type { AuditFilter, RuleSuggestion } from './types.ts';

export interface SuggestRulesOptions extends AuditFilter {
	minOccurrences?: number;
	replayLimit?: number;
}

const DEFAULT_MIN_OCCURRENCES = 5;
const PURITY_THRESHOLD = 0.9;
const SAMPLE_LIMIT = 3;
const GAP_SAMPLE_LIMIT = 50;

/** Commands whose first two tokens form the natural rule prefix ("git push", "npm run", ...). */
const MULTIWORD_COMMANDS = new Set([
	'git',
	'npm',
	'bun',
	'pnpm',
	'yarn',
	'docker',
	'cargo',
	'gh',
	'kubectl',
	'make',
	'uv',
]);

interface Cluster {
	pattern: string;
	entries: AuditEntry[];
	approved: number;
	denied: number;
	destructive: number;
	commands: Set<string>;
}

function projectImpact(
	entries: AuditEntry[],
	pattern: string,
	decision: 'allow' | 'block'
): NonNullable<RuleSuggestion['impact']> {
	const matchingCalls = entries.filter((entry) =>
		ruleMatchCandidates(entry).some((candidate) => matchesPattern(candidate, pattern))
	);
	const gaps = matchingCalls.filter((entry) => entry.matchedRule === undefined);
	const before = { allow: 0, block: 0, approve: 0 };
	for (const entry of matchingCalls) before[entry.decision] += 1;
	const after = { allow: 0, block: 0, approve: 0 };
	after[decision] = matchingCalls.length;
	return {
		matchingCalls: matchingCalls.length,
		explicitlyCoveredBefore: matchingCalls.length - gaps.length,
		coverageGained: gaps.length,
		before,
		after,
		decisionChanges: matchingCalls.filter((entry) => entry.decision !== decision).length,
		gaps: gaps.slice(0, GAP_SAMPLE_LIMIT).map((entry, index) => ({
			id: entry.id ?? -(index + 1),
			command: entry.command,
			decision: entry.decision,
			classification: entry.classification,
		})),
		gapCount: gaps.length,
	};
}

/** Derives the candidate rule pattern a tool call would cluster under. */
export function clusterKey(entry: AuditEntry): string | undefined {
	if (entry.tool === 'bash') {
		const tokens = entry.command.trim().split(/\s+/);
		const first = tokens[0];
		if (first === undefined || first.length === 0) return undefined;
		if (MULTIWORD_COMMANDS.has(first) && tokens.length > 1) {
			return `${first} ${tokens[1]} *`;
		}
		return `${first} *`;
	}

	// Non-bash tools: cluster on the "<tool> <path>" candidate's directory.
	const toolPrefix = `${entry.tool} `;
	for (const candidate of ruleMatchCandidates(entry)) {
		if (!candidate.startsWith(toolPrefix)) continue;
		const path = candidate.slice(toolPrefix.length);
		const dir = dirname(path);
		if (dir === '.' || dir === '/') return undefined;
		return `${entry.tool} ${dir}/*`;
	}

	return undefined;
}

// fallow-ignore-next-line complexity -- staged mining, safety validation, and replay projection pipeline
export function suggestRules(
	manifest: Manifest,
	auditLog: AuditLogStore,
	options: SuggestRulesOptions = {}
): RuleSuggestion[] {
	const minOccurrences = options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
	const filter = { since: options.since, until: options.until, agent: options.agent, project: options.project };
	const replayLimit = options.replayLimit ?? 2000;

	// Mine calls that hit the approval queue without a rule match — the
	// signal for "this keeps interrupting; write a rule for it".
	const unmatched = auditLog.unmatchedEntries(filter, replayLimit).filter((entry) => entry.decision === 'approve');

	const clusters = new Map<string, Cluster>();
	for (const entry of unmatched) {
		const pattern = clusterKey(entry);
		if (pattern === undefined) continue;

		const cluster = clusters.get(pattern) ?? {
			pattern,
			entries: [],
			approved: 0,
			denied: 0,
			destructive: 0,
			commands: new Set<string>(),
		};
		cluster.entries.push(entry);
		cluster.commands.add(entry.command);
		if (entry.approvalStatus === 'approved') cluster.approved += 1;
		if (entry.approvalStatus === 'denied') cluster.denied += 1;
		if (entry.classification === 'destructive') cluster.destructive += 1;
		clusters.set(pattern, cluster);
	}

	// Historical blocked calls, used to flag allow-suggestions that would
	// flip a past block decision.
	const blockedEntries = auditLog
		.listRecentFiltered(filter, replayLimit)
		.filter((entry) => entry.decision === 'block' || entry.approvalStatus === 'denied');
	const replayEntries = auditLog.listRecentFiltered(filter, replayLimit);

	const suggestions: RuleSuggestion[] = [];

	for (const cluster of clusters.values()) {
		const occurrences = cluster.entries.length;
		if (occurrences < minOccurrences) continue;

		const resolved = cluster.approved + cluster.denied;
		if (resolved === 0) continue;

		let decision: 'allow' | 'block';
		let kind: RuleSuggestion['kind'];
		if (cluster.approved / resolved >= PURITY_THRESHOLD) {
			decision = 'allow';
			kind = 'promote-approved';
		} else if (cluster.denied / resolved >= PURITY_THRESHOLD) {
			decision = 'block';
			kind = 'block-denied';
		} else {
			continue; // mixed outcomes stay in the hotspot report
		}

		// Destructive calls only get an allow rule on overwhelming evidence.
		if (decision === 'allow' && cluster.destructive > 0) {
			if (cluster.denied > 0 || occurrences < minOccurrences * 2) {
				continue;
			}
		}

		// Offline validation: the pattern must actually match its own cluster
		// through the real candidate/matcher pipeline.
		const matchesAll = cluster.entries.every((entry) =>
			ruleMatchCandidates(entry).some((candidate) => matchesPattern(candidate, cluster.pattern))
		);
		if (!matchesAll) continue;

		const conflicts: string[] = [];

		// An existing rule that matches the pattern's own text would preempt it.
		for (const [existing] of Object.entries(manifest.rules)) {
			if (matchesPattern(cluster.pattern.replace(/ \*$/, ''), existing)) {
				conflicts.push(`preempted by existing rule "${existing}" — insert before it`);
				break;
			}
		}

		if (decision === 'allow') {
			const flipped = blockedEntries.filter((entry) =>
				ruleMatchCandidates(entry).some((candidate) => matchesPattern(candidate, cluster.pattern))
			);
			if (flipped.length > 0) {
				conflicts.push(
					`would allow ${flipped.length} call(s) that were previously blocked or denied (e.g. "${flipped[0]?.command}")`
				);
			}
		}

		const rationale =
			decision === 'allow'
				? `${occurrences} approval prompts, ${cluster.approved} approved / ${cluster.denied} denied — promote to allow`
				: `${occurrences} approval prompts, ${cluster.denied} denied / ${cluster.approved} approved — block outright`;

		suggestions.push({
			pattern: cluster.pattern,
			decision,
			kind,
			rationale:
				cluster.destructive > 0 && decision === 'allow'
					? `${rationale} (includes ${cluster.destructive} destructive-classified call(s) — review carefully)`
					: rationale,
			evidence: {
				occurrences,
				approvedCount: cluster.approved,
				deniedCount: cluster.denied,
				distinctCommands: cluster.commands.size,
				sampleCommands: [...cluster.commands].slice(0, SAMPLE_LIMIT),
			},
			conflicts,
			impact: projectImpact(replayEntries, cluster.pattern, decision),
		});
	}

	return suggestions.sort((a, b) => b.evidence.occurrences - a.evidence.occurrences);
}
