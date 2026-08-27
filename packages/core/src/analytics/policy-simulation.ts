import { createHash } from 'node:crypto';

import type { ApprovalDecision, CallClassification, Manifest, StoredAuditEntry } from '../core/types.ts';
import type { AuditLogReader } from '../db/audit-log.ts';
import { PolicyEngine, type PolicyEvaluationTrace } from '../policy/engine.ts';
import { lintPolicy, type PolicyLintFinding } from '../policy/policy-lint.ts';
import { affectedPaths } from '../policy/rule-candidates.ts';
import { analyzeShellCommand } from '../policy/shell-analyzer.ts';
import { inferredOperation } from '../policy/operations.ts';
import type { AuditFilter, DecisionCounts } from './types.ts';

export type DecisionTransition = `${ApprovalDecision}->${ApprovalDecision}`;

export interface PolicySimulationOptions extends AuditFilter {
	limit?: number;
	all?: boolean;
	examplesPerTransition?: number;
}

export interface PolicySimulationExample {
	id: number;
	agent: string;
	tool: string;
	command: string;
	classification: CallClassification;
	workspaceId?: string;
	historicalDecision: ApprovalDecision;
	approvalStatus?: StoredAuditEntry['approvalStatus'];
	baselineDecision: ApprovalDecision;
	candidateDecision: ApprovalDecision;
	baselineMatchedRule?: string;
	candidateMatchedRule?: string;
	candidateReason: string;
	candidateMatchedSelectors?: string[];
	operation?: string;
	shellComponents: string[];
	affectedPaths: ReturnType<typeof affectedPaths>;
}

export interface SimulatedRuleFinding {
	id: string;
	kind: 'guard' | 'structured' | 'legacy';
	scope: 'global' | 'workspace';
	workspaceId?: string;
	matched: number;
	selected: number;
	status: 'selected' | 'shadowed' | 'never_observed';
}

type TransitionCounts = Partial<Record<DecisionTransition, number>>;

export interface PolicySimulation {
	baselineManifestHash: string;
	candidateManifestHash: string;
	dataset: {
		strategy: 'latest-by-id-desc';
		eligible: number;
		evaluated: number;
		truncated: boolean;
		limit: number | null;
		since?: string;
		until?: string;
	};
	transitions: TransitionCounts;
	decisionTotals: {
		baseline: DecisionCounts;
		candidate: DecisionCounts;
	};
	unchangedDecisions: number;
	policyChanges: number;
	newlyCovered: number;
	stillUnmatched: number;
	safety: {
		blockedToAllow: number;
		approveToAllow: number;
		previouslyDeniedToAllow: number;
		unresolvedWorkspace: number;
	};
	examples: Partial<Record<DecisionTransition, PolicySimulationExample[]>>;
	policyChangeExamples: PolicySimulationExample[];
	newlyCoveredExamples: PolicySimulationExample[];
	stillUnmatchedExamples: PolicySimulationExample[];
	previouslyDeniedToAllowExamples: PolicySimulationExample[];
	unresolvedWorkspaceExamples: PolicySimulationExample[];
	ruleExamples: Record<string, PolicySimulationExample[]>;
	breakdown: {
		agents: Record<string, TransitionCounts>;
		tools: Record<string, TransitionCounts>;
		classifications: Record<string, TransitionCounts>;
		workspaces: Record<string, TransitionCounts>;
	};
	candidateRules: SimulatedRuleFinding[];
	historicalDecisions: DecisionCounts;
	lint: PolicyLintFinding[];
}

function manifestHash(manifest: Manifest): string {
	const policy = {
		policy: manifest.policy,
		rules: manifest.rules,
		structuredRules: manifest.structuredRules ?? [],
		guards: manifest.guards ?? [],
		workspaces: manifest.workspaces ?? [],
	};
	return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

function incrementTransition(target: TransitionCounts, transition: DecisionTransition): void {
	target[transition] = (target[transition] ?? 0) + 1;
}

function incrementBreakdown(
	target: Record<string, TransitionCounts>,
	key: string | undefined,
	transition: DecisionTransition
): void {
	const normalized = key?.trim() || '(none)';
	const counts = (target[normalized] ??= {});
	incrementTransition(counts, transition);
}

function ruleKey(scope: 'global' | 'workspace', workspaceId: string | undefined, id: string): string {
	return `${scope}:${workspaceId ?? ''}:${id}`;
}

// fallow-ignore-next-line complexity -- this inventories every ordered rule source into one report identity map.
function candidateRuleMap(manifest: Manifest): Map<string, SimulatedRuleFinding> {
	const findings = new Map<string, SimulatedRuleFinding>();
	const add = (
		id: string,
		kind: SimulatedRuleFinding['kind'],
		scope: SimulatedRuleFinding['scope'],
		workspaceId?: string
	) =>
		findings.set(ruleKey(scope, workspaceId, id), {
			id,
			kind,
			scope,
			workspaceId,
			matched: 0,
			selected: 0,
			status: 'never_observed',
		});
	for (const guard of manifest.guards ?? []) add(guard.id, 'guard', 'global');
	for (const rule of manifest.structuredRules ?? []) add(rule.id, 'structured', 'global');
	for (const pattern of Object.keys(manifest.rules)) add(pattern, 'legacy', 'global');
	for (const workspace of manifest.workspaces ?? []) {
		for (const guard of workspace.guards ?? []) add(guard.id, 'guard', 'workspace', workspace.id);
		for (const rule of workspace.structuredRules ?? []) add(rule.id, 'structured', 'workspace', workspace.id);
		for (const pattern of Object.keys(workspace.rules)) add(pattern, 'legacy', 'workspace', workspace.id);
	}
	return findings;
}

function recordCandidateTrace(
	findings: Map<string, SimulatedRuleFinding>,
	trace: PolicyEvaluationTrace,
	workspaceId: string | undefined
): void {
	for (const match of trace.matches) {
		const finding = findings.get(
			ruleKey(match.scope ?? 'global', match.scope === 'workspace' ? workspaceId : undefined, match.id)
		);
		if (!finding) continue;
		finding.matched += 1;
		if (match.selected) finding.selected += 1;
	}
}

function finalizeFindings(findings: Map<string, SimulatedRuleFinding>): SimulatedRuleFinding[] {
	return [...findings.values()].map((finding) => ({
		...finding,
		status: finding.selected > 0 ? 'selected' : finding.matched > 0 ? 'shadowed' : 'never_observed',
	}));
}

function exampleFor(
	entry: StoredAuditEntry,
	baseline: PolicyEvaluationTrace,
	candidate: PolicyEvaluationTrace
): PolicySimulationExample {
	const shell = entry.tool === 'bash' ? analyzeShellCommand(entry.command) : undefined;
	return {
		id: entry.id,
		agent: entry.agent,
		tool: entry.tool,
		command: entry.command,
		classification: candidate.result.classification,
		workspaceId: candidate.result.resolvedWorkspaceId,
		historicalDecision: entry.decision,
		approvalStatus: entry.approvalStatus,
		baselineDecision: baseline.result.decision,
		candidateDecision: candidate.result.decision,
		baselineMatchedRule: baseline.result.matchedRule,
		candidateMatchedRule: candidate.result.matchedRule,
		candidateReason: candidate.result.reason,
		candidateMatchedSelectors: candidate.result.matchedSelectors,
		operation: entry.operation ?? inferredOperation(entry.tool, entry.command),
		shellComponents: shell?.components.map((component) => component.command) ?? [],
		affectedPaths: affectedPaths(entry),
	};
}

function samePolicyResult(baseline: PolicyEvaluationTrace, candidate: PolicyEvaluationTrace): boolean {
	return (
		baseline.result.decision === candidate.result.decision &&
		baseline.result.classification === candidate.result.classification &&
		baseline.result.matchedRule === candidate.result.matchedRule &&
		baseline.result.policyScope === candidate.result.policyScope &&
		baseline.result.resolvedWorkspaceId === candidate.result.resolvedWorkspaceId
	);
}

// fallow-ignore-next-line complexity -- one snapshot aggregation keeps all transition, safety, and trace counters consistent.
export function simulatePolicy(
	baselineManifest: Manifest,
	candidateManifest: Manifest,
	auditLog: AuditLogReader,
	options: PolicySimulationOptions = {}
): PolicySimulation {
	const requestedLimit = options.all ? undefined : (options.limit ?? 2000);
	if (requestedLimit !== undefined && (!Number.isInteger(requestedLimit) || requestedLimit < 1)) {
		throw new Error('policy simulation limit must be a positive integer');
	}
	const examplesPerTransition = options.examplesPerTransition ?? 3;
	if (!Number.isInteger(examplesPerTransition) || examplesPerTransition < 0) {
		throw new Error('policy simulation examplesPerTransition must be a non-negative integer');
	}
	const filter: AuditFilter = {
		since: options.since,
		until: options.until,
		agent: options.agent,
		project: options.project,
		workspace: options.workspace,
		tool: options.tool,
		classification: options.classification,
		decision: options.decision,
		search: options.search,
	};
	const baselineEngine = new PolicyEngine(baselineManifest);
	const candidateEngine = new PolicyEngine(candidateManifest);
	const transitions: TransitionCounts = {};
	const examples: PolicySimulation['examples'] = {};
	const policyChangeExamples: PolicySimulationExample[] = [];
	const newlyCoveredExamples: PolicySimulationExample[] = [];
	const stillUnmatchedExamples: PolicySimulationExample[] = [];
	const previouslyDeniedToAllowExamples: PolicySimulationExample[] = [];
	const unresolvedWorkspaceExamples: PolicySimulationExample[] = [];
	const ruleExamples: Record<string, PolicySimulationExample[]> = {};
	const breakdown: PolicySimulation['breakdown'] = { agents: {}, tools: {}, classifications: {}, workspaces: {} };
	const candidateRules = candidateRuleMap(candidateManifest);
	const historicalDecisions: DecisionCounts = { allow: 0, block: 0, approve: 0 };
	const baselineTotals: DecisionCounts = { allow: 0, block: 0, approve: 0 };
	const candidateTotals: DecisionCounts = { allow: 0, block: 0, approve: 0 };
	let unchangedDecisions = 0;
	let policyChanges = 0;
	let newlyCovered = 0;
	let stillUnmatched = 0;
	let blockedToAllow = 0;
	let approveToAllow = 0;
	let previouslyDeniedToAllow = 0;
	let unresolvedWorkspace = 0;
	let eligible = 0;
	let evaluated = 0;

	// fallow-ignore-next-line complexity -- one bounded snapshot pass keeps every counter and evidence sample consistent.
	auditLog.withSnapshot(() => {
		eligible = auditLog.countFiltered(filter);
		const evaluationLimit = requestedLimit ?? eligible;
		let cursor: number | undefined;
		while (evaluated < evaluationLimit) {
			const page = auditLog.listRecentBatch(filter, cursor, Math.min(20000, evaluationLimit - evaluated));
			const entries = page.entries;
			if (entries.length === 0) break;
			for (const entry of entries) {
				const baseline = baselineEngine.evaluateWithTrace(entry);
				const candidate = candidateEngine.evaluateWithTrace(entry);
				const transition = `${baseline.result.decision}->${candidate.result.decision}` as DecisionTransition;
				incrementTransition(transitions, transition);
				incrementBreakdown(breakdown.agents, entry.agent, transition);
				incrementBreakdown(breakdown.tools, entry.tool, transition);
				incrementBreakdown(breakdown.classifications, candidate.result.classification, transition);
				incrementBreakdown(breakdown.workspaces, candidate.result.resolvedWorkspaceId, transition);
				historicalDecisions[entry.decision] += 1;
				baselineTotals[baseline.result.decision] += 1;
				candidateTotals[candidate.result.decision] += 1;
				if (baseline.result.decision === candidate.result.decision) unchangedDecisions += 1;
				if (!samePolicyResult(baseline, candidate)) {
					policyChanges += 1;
					if (policyChangeExamples.length < examplesPerTransition) {
						policyChangeExamples.push(exampleFor(entry, baseline, candidate));
					}
				}
				const simulationExample = exampleFor(entry, baseline, candidate);
				if (!baseline.result.matchedRule && candidate.result.matchedRule) {
					newlyCovered += 1;
					if (newlyCoveredExamples.length < examplesPerTransition) newlyCoveredExamples.push(simulationExample);
				}
				if (!candidate.result.matchedRule) {
					stillUnmatched += 1;
					if (stillUnmatchedExamples.length < examplesPerTransition) stillUnmatchedExamples.push(simulationExample);
				}
				if (transition === 'block->allow') blockedToAllow += 1;
				if (transition === 'approve->allow') approveToAllow += 1;
				if (
					candidate.result.decision === 'allow' &&
					(entry.decision === 'block' || entry.approvalStatus === 'denied')
				) {
					previouslyDeniedToAllow += 1;
					if (previouslyDeniedToAllowExamples.length < examplesPerTransition)
						previouslyDeniedToAllowExamples.push(simulationExample);
				}
				if (candidate.result.reason.startsWith('requested workspace')) {
					unresolvedWorkspace += 1;
					if (unresolvedWorkspaceExamples.length < examplesPerTransition)
						unresolvedWorkspaceExamples.push(simulationExample);
				}
				const transitionExamples = (examples[transition] ??= []);
				if (transitionExamples.length < examplesPerTransition)
					transitionExamples.push(exampleFor(entry, baseline, candidate));
				recordCandidateTrace(candidateRules, candidate, candidate.result.resolvedWorkspaceId);
				for (const match of candidate.matches) {
					const key = ruleKey(
						match.scope ?? 'global',
						match.scope === 'workspace' ? candidate.result.resolvedWorkspaceId : undefined,
						match.id
					);
					const retained = (ruleExamples[key] ??= []);
					if (retained.length < examplesPerTransition) retained.push(simulationExample);
				}
			}
			evaluated += entries.length;
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
	});

	return {
		baselineManifestHash: manifestHash(baselineManifest),
		candidateManifestHash: manifestHash(candidateManifest),
		dataset: {
			strategy: 'latest-by-id-desc',
			eligible,
			evaluated,
			truncated: evaluated < eligible,
			limit: requestedLimit ?? null,
			since: options.since,
			until: options.until,
		},
		transitions,
		decisionTotals: { baseline: baselineTotals, candidate: candidateTotals },
		unchangedDecisions,
		policyChanges,
		newlyCovered,
		stillUnmatched,
		safety: { blockedToAllow, approveToAllow, previouslyDeniedToAllow, unresolvedWorkspace },
		examples,
		policyChangeExamples,
		newlyCoveredExamples,
		stillUnmatchedExamples,
		previouslyDeniedToAllowExamples,
		unresolvedWorkspaceExamples,
		ruleExamples,
		breakdown,
		candidateRules: finalizeFindings(candidateRules),
		historicalDecisions,
		lint: lintPolicy(candidateManifest),
	};
}
