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

interface ClusterProposal {
	decision: 'allow' | 'block';
	kind: Extract<RuleSuggestion['kind'], 'promote-approved' | 'block-denied'>;
}

interface SuggestionContext {
	manifest: Manifest;
	workspaceId?: string;
	minOccurrences: number;
	blockedEntries: AuditEntry[];
	replayEntries: AuditEntry[];
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

function buildClusters(entries: AuditEntry[]): Cluster[] {
	const clusters = new Map<string, Cluster>();
	for (const entry of entries) {
		if (entry.matchedRule !== undefined || entry.decision !== 'approve') continue;
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
	return [...clusters.values()];
}

function dominantProposal(cluster: Cluster): ClusterProposal | undefined {
	const resolved = cluster.approved + cluster.denied;
	if (resolved === 0) return undefined;
	if (cluster.approved / resolved >= PURITY_THRESHOLD) {
		return { decision: 'allow', kind: 'promote-approved' };
	}
	return cluster.denied / resolved >= PURITY_THRESHOLD ? { decision: 'block', kind: 'block-denied' } : undefined;
}

function destructiveProposalIsSafe(cluster: Cluster, proposal: ClusterProposal, minOccurrences: number): boolean {
	if (proposal.decision !== 'allow' || cluster.destructive === 0) return true;
	return cluster.denied === 0 && cluster.entries.length >= minOccurrences * 2;
}

function clusterPatternIsValid(cluster: Cluster): boolean {
	return cluster.entries.every((entry) =>
		ruleMatchCandidates(entry).some((candidate) => matchesPattern(candidate, cluster.pattern))
	);
}

function clusterProposal(cluster: Cluster, minOccurrences: number): ClusterProposal | undefined {
	if (cluster.entries.length < minOccurrences) return undefined;
	const proposal = dominantProposal(cluster);
	if (!proposal || !destructiveProposalIsSafe(cluster, proposal, minOccurrences)) return undefined;
	return clusterPatternIsValid(cluster) ? proposal : undefined;
}

function preemptionConflict(cluster: Cluster, context: SuggestionContext): string | undefined {
	const workspace = context.workspaceId
		? context.manifest.workspaces?.find((entry) => entry.id === context.workspaceId)
		: undefined;
	const effectiveRuleSets = workspace ? [workspace.rules, context.manifest.rules] : [context.manifest.rules];
	for (const [existing] of effectiveRuleSets.flatMap((rules) => Object.entries(rules))) {
		if (matchesPattern(cluster.pattern.replace(/ \*$/, ''), existing)) {
			return `preempted by existing rule "${existing}" — insert before it`;
		}
	}
	return undefined;
}

function clusterConflicts(cluster: Cluster, proposal: ClusterProposal, context: SuggestionContext): string[] {
	const conflicts: string[] = [];
	const preemption = preemptionConflict(cluster, context);
	if (preemption) conflicts.push(preemption);

	if (proposal.decision === 'allow') {
		const flipped = context.blockedEntries.filter((entry) =>
			ruleMatchCandidates(entry).some((candidate) => matchesPattern(candidate, cluster.pattern))
		);
		if (flipped.length > 0) {
			conflicts.push(
				`would allow ${flipped.length} call(s) that were previously blocked or denied (e.g. "${flipped[0]?.command}")`
			);
		}
	}
	return conflicts;
}

function clusterRationale(cluster: Cluster, proposal: ClusterProposal): string {
	const occurrences = cluster.entries.length;
	const rationale =
		proposal.decision === 'allow'
			? `${occurrences} approval prompts, ${cluster.approved} approved / ${cluster.denied} denied — promote to allow`
			: `${occurrences} approval prompts, ${cluster.denied} denied / ${cluster.approved} approved — block outright`;
	return cluster.destructive > 0 && proposal.decision === 'allow'
		? `${rationale} (includes ${cluster.destructive} destructive-classified call(s) — review carefully)`
		: rationale;
}

function suggestionForCluster(cluster: Cluster, context: SuggestionContext): RuleSuggestion | undefined {
	const proposal = clusterProposal(cluster, context.minOccurrences);
	if (!proposal) return undefined;
	return {
		pattern: cluster.pattern,
		decision: proposal.decision,
		workspaceId: context.workspaceId,
		kind: proposal.kind,
		rationale: clusterRationale(cluster, proposal),
		evidence: {
			occurrences: cluster.entries.length,
			approvedCount: cluster.approved,
			deniedCount: cluster.denied,
			distinctCommands: cluster.commands.size,
			sampleCommands: [...cluster.commands].slice(0, SAMPLE_LIMIT),
		},
		conflicts: clusterConflicts(cluster, proposal, context),
		impact: projectImpact(context.replayEntries, cluster.pattern, proposal.decision),
	};
}

export function suggestRules(
	manifest: Manifest,
	auditLog: AuditLogStore,
	options: SuggestRulesOptions = {},
	preloadedEntries?: AuditEntry[]
): RuleSuggestion[] {
	const minOccurrences = options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
	const filter = {
		since: options.since,
		until: options.until,
		agent: options.agent,
		project: options.project,
		workspace: options.workspace,
	};
	const replayLimit = options.replayLimit ?? 2000;
	const workspace = options.workspace
		? manifest.workspaces?.find((entry) => entry.id === options.workspace)
		: undefined;
	if (options.workspace !== undefined && workspace === undefined) {
		throw new Error(`workspace "${options.workspace}" is not configured`);
	}
	const replayEntries = preloadedEntries ?? auditLog.listRecentFiltered(filter, replayLimit);
	const clusterEntries = preloadedEntries ?? auditLog.unmatchedEntries(filter, replayLimit);
	const blockedEntries = replayEntries.filter(
		(entry) => entry.decision === 'block' || entry.approvalStatus === 'denied'
	);
	const context: SuggestionContext = {
		manifest,
		workspaceId: workspace?.id,
		minOccurrences,
		blockedEntries,
		replayEntries,
	};
	const suggestions = buildClusters(clusterEntries).flatMap((cluster) => {
		const suggestion = suggestionForCluster(cluster, context);
		return suggestion ? [suggestion] : [];
	});

	return suggestions.sort((a, b) => b.evidence.occurrences - a.evidence.occurrences);
}
