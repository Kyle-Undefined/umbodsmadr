import type { ApprovalDecision, EvaluationResult, Manifest, ToolCall } from '../core/types.ts';
import { classifyToolCall } from './classifier.ts';
import { compilePolicy, type CompiledPolicy, type CompiledPolicyMatch } from './compiled-policy.ts';
import { findMatchingRule } from './rule-matcher.ts';
import { resolveWorkspace, type WorkspaceResolution } from './workspace.ts';
type Classification = EvaluationResult['classification'];

export interface PolicyTraceMatch extends CompiledPolicyMatch {
	selected: boolean;
}

export interface PolicyEvaluationTrace {
	result: EvaluationResult;
	matches: PolicyTraceMatch[];
}

interface PolicyContext {
	resolution: WorkspaceResolution;
	match?: CompiledPolicyMatch;
	policyScope: 'global' | 'workspace';
	effectiveDefault: ApprovalDecision;
	defaultScope: 'global' | 'workspace';
	defaultReason: string;
	legacyReadonlyAutoAllow: boolean;
}

function resolvePolicyContext(
	manifest: Manifest,
	compiled: CompiledPolicy,
	call: ToolCall,
	classification: Classification
): PolicyContext {
	const resolution = resolveWorkspace(manifest, call);
	const globalGuard = compiled.matchGlobalGuard(call, classification);
	if (globalGuard) return policyContext(resolution, globalGuard, 'global', manifest, classification);
	const workspaceGuard = compiled.matchWorkspaceGuard(resolution.workspace, call, classification);
	if (workspaceGuard) return policyContext(resolution, workspaceGuard, 'workspace', manifest, classification);
	const workspaceMatch = compiled.matchWorkspaceRule(resolution.workspace, call, classification);
	if (workspaceMatch) return policyContext(resolution, workspaceMatch, 'workspace', manifest, classification);
	return policyContext(resolution, compiled.matchGlobalRule(call, classification), 'global', manifest, classification);
}

function policyContext(
	resolution: WorkspaceResolution,
	match: CompiledPolicyMatch | undefined,
	policyScope: 'global' | 'workspace',
	manifest: Manifest,
	classification: Classification
): PolicyContext {
	const defaultResolution = resolveClassificationDefault(manifest, resolution, classification);
	return {
		resolution,
		match,
		policyScope,
		effectiveDefault: defaultResolution.decision,
		defaultScope: defaultResolution.scope,
		defaultReason: defaultResolution.reason,
		legacyReadonlyAutoAllow:
			classification === 'readonly' &&
			manifest.policy.defaults === undefined &&
			resolution.workspace?.defaults === undefined,
	};
}

function resolveClassificationDefault(
	manifest: Manifest,
	resolution: WorkspaceResolution,
	classification: Classification
): { decision: ApprovalDecision; scope: 'global' | 'workspace'; reason: string } {
	const workspace = resolution.workspace;
	const workspaceDefault = workspace?.defaults?.[classification];
	if (workspaceDefault) {
		return {
			decision: workspaceDefault,
			scope: 'workspace',
			reason: `workspace "${workspace.id}".defaults.${classification}=${workspaceDefault}`,
		};
	}
	if (workspace?.default_unknown) {
		return {
			decision: workspace.default_unknown,
			scope: 'workspace',
			reason: `workspace "${workspace.id}".default_unknown=${workspace.default_unknown}`,
		};
	}
	const globalDefault = manifest.policy.defaults?.[classification];
	if (globalDefault) {
		return { decision: globalDefault, scope: 'global', reason: `policy.defaults.${classification}=${globalDefault}` };
	}
	return {
		decision: manifest.policy.default_unknown,
		scope: 'global',
		reason: `policy.default_unknown=${manifest.policy.default_unknown}`,
	};
}

function matchedRuleResult(context: PolicyContext, classification: Classification): EvaluationResult {
	const match = context.match as CompiledPolicyMatch;
	const pattern = match.id;
	const workspaceId = context.resolution.workspace?.id;
	const label = match.kind === 'guard' ? 'guard' : 'rule';
	const workspaceReason = `matched ${label} "${pattern}" in workspace "${workspaceId}"`;
	const globalSuffix = workspaceId ? ` for workspace "${workspaceId}"` : '';
	return {
		decision: match.decision,
		classification,
		matchedRule: pattern,
		policyScope: context.policyScope,
		resolvedWorkspaceId: workspaceId,
		reason:
			match.reason ??
			(context.policyScope === 'workspace'
				? workspaceReason
				: `matched ${label} "${pattern}" in global policy${globalSuffix}`),
	};
}

function fallbackResult(context: PolicyContext, classification: Classification): EvaluationResult {
	const workspaceId = context.resolution.workspace?.id;
	return {
		decision: context.effectiveDefault,
		classification,
		policyScope: context.defaultScope,
		resolvedWorkspaceId: workspaceId,
		reason: `no matching rule, fell back to ${context.defaultReason}`,
	};
}

function sensitiveSearchFallback(
	manifest: Manifest,
	context: PolicyContext,
	classification: Classification
): EvaluationResult {
	const workspace = context.resolution.workspace;
	const decision = workspace?.default_unknown ?? manifest.policy.default_unknown;
	const scope = workspace?.default_unknown === undefined ? 'global' : 'workspace';
	const source =
		scope === 'workspace'
			? `workspace "${workspace?.id}".default_unknown=${decision}`
			: `policy.default_unknown=${decision}`;
	return {
		decision,
		classification,
		policyScope: scope,
		resolvedWorkspaceId: workspace?.id,
		reason: `directory search may expose hidden files protected by block rules; fell back to ${source}`,
	};
}

function unresolvedWorkspaceResult(context: PolicyContext, classification: Classification): EvaluationResult {
	return {
		decision: 'block',
		classification,
		policyScope: 'global',
		reason: `requested workspace "${context.resolution.requestedWorkspaceId}" was not configured and working directory did not match a configured workspace`,
	};
}

function hiddenProbeMatch(
	call: ToolCall,
	manifest: Manifest,
	compiled: CompiledPolicy,
	context: PolicyContext,
	classification: Classification
): [string, ApprovalDecision] | undefined {
	if (compiled.hasPathGuard(context.resolution.workspace)) return ['structured path guard', 'block'];
	const probe = `${call.command}/.hidden_probe`;
	const probeCall = { ...call, command: probe, inputs: { tool_input: { path: probe } } };
	const guard =
		compiled.matchGlobalGuard(probeCall, classification) ??
		compiled.matchWorkspaceGuard(context.resolution.workspace, probeCall, classification);
	if (guard) return [guard.id, guard.decision];
	return (
		(context.resolution.workspace ? findMatchingRule(probe, context.resolution.workspace.rules) : undefined) ??
		findMatchingRule(probe, manifest.rules)
	);
}

function readonlyResult(
	call: ToolCall,
	manifest: Manifest,
	compiled: CompiledPolicy,
	context: PolicyContext,
	classification: Classification
): EvaluationResult {
	if (/^(grep|glob)$/.test(call.tool)) {
		if (!call.command) {
			return {
				...fallbackResult(context, classification),
				reason: 'readonly tool call with empty command',
			};
		}
		const probeMatch = hiddenProbeMatch(call, manifest, compiled, context, classification);
		if (probeMatch && probeMatch[1] !== 'allow') {
			return sensitiveSearchFallback(manifest, context, classification);
		}
	}

	if (!context.legacyReadonlyAutoAllow) return fallbackResult(context, classification);
	return {
		decision: 'allow',
		classification,
		policyScope: 'global',
		resolvedWorkspaceId: context.resolution.workspace?.id,
		reason: 'auto-allowed readonly tool call',
	};
}

export class PolicyEngine {
	private readonly compiled: CompiledPolicy;

	constructor(private readonly manifest: Manifest) {
		this.compiled = compilePolicy(manifest);
	}

	evaluate(call: ToolCall): EvaluationResult {
		return this.evaluateWithTrace(call).result;
	}

	evaluateWithTrace(call: ToolCall): PolicyEvaluationTrace {
		const classification = classifyToolCall(call);
		const context = resolvePolicyContext(this.manifest, this.compiled, call, classification);
		const tracedMatches =
			context.resolution.source === 'unresolved'
				? []
				: this.compiled.traceMatches(context.resolution.workspace, call, classification);
		let result: EvaluationResult;
		if (context.resolution.source === 'unresolved') {
			result = unresolvedWorkspaceResult(context, classification);
		} else if (context.match) {
			result = matchedRuleResult(context, classification);
		} else if (classification === 'readonly') {
			result = readonlyResult(call, this.manifest, this.compiled, context, classification);
		} else {
			result = fallbackResult(context, classification);
		}
		return {
			result,
			matches: tracedMatches.map((match) => ({
				...match,
				selected: result.matchedRule === match.id && result.policyScope === match.scope,
			})),
		};
	}
}
