import type { ApprovalDecision, EvaluationResult, Manifest, ToolCall } from '../core/types.ts';
import { classifyToolCall } from './classifier.ts';
import { findMatchingRule } from './rule-matcher.ts';
import { ruleMatchCandidates } from './rule-candidates.ts';
import { resolveWorkspace, type WorkspaceResolution } from './workspace.ts';

function findFirstMatchingRule(
	candidates: string[],
	rules: Manifest['rules']
): [pattern: string, decision: ApprovalDecision] | undefined {
	for (const input of candidates) {
		const match = findMatchingRule(input, rules);
		if (match) return match;
	}

	return undefined;
}

type RuleMatch = [pattern: string, decision: ApprovalDecision];
type Classification = EvaluationResult['classification'];

interface PolicyContext {
	resolution: WorkspaceResolution;
	match?: RuleMatch;
	policyScope: 'global' | 'workspace';
	effectiveDefault: ApprovalDecision;
}

function resolvePolicyContext(manifest: Manifest, call: ToolCall): PolicyContext {
	const candidates = ruleMatchCandidates(call);
	const resolution = resolveWorkspace(manifest, call);
	const workspaceMatch = resolution.workspace
		? findFirstMatchingRule(candidates, resolution.workspace.rules)
		: undefined;
	const globalMatch = workspaceMatch ? undefined : findFirstMatchingRule(candidates, manifest.rules);
	return {
		resolution,
		match: workspaceMatch ?? globalMatch,
		policyScope: workspaceMatch ? 'workspace' : 'global',
		effectiveDefault: resolution.workspace?.default_unknown ?? manifest.policy.default_unknown,
	};
}

function matchedRuleResult(context: PolicyContext, classification: Classification): EvaluationResult {
	const [pattern, decision] = context.match as RuleMatch;
	const workspaceId = context.resolution.workspace?.id;
	const workspaceReason = `matched rule "${pattern}" in workspace "${workspaceId}"`;
	const globalSuffix = workspaceId ? ` for workspace "${workspaceId}"` : '';
	return {
		decision,
		classification,
		matchedRule: pattern,
		policyScope: context.policyScope,
		resolvedWorkspaceId: workspaceId,
		reason:
			context.policyScope === 'workspace'
				? workspaceReason
				: `matched rule "${pattern}" in global policy${globalSuffix}`,
	};
}

function fallbackScope(context: PolicyContext): 'global' | 'workspace' {
	return context.resolution.workspace?.default_unknown === undefined ? 'global' : 'workspace';
}

function fallbackResult(context: PolicyContext, classification: Classification): EvaluationResult {
	const scope = fallbackScope(context);
	const workspaceId = context.resolution.workspace?.id;
	return {
		decision: context.effectiveDefault,
		classification,
		policyScope: scope,
		resolvedWorkspaceId: workspaceId,
		reason:
			scope === 'workspace'
				? `no matching rule, fell back to workspace "${workspaceId}".default_unknown=${context.effectiveDefault}`
				: `no matching rule, fell back to policy.default_unknown=${context.effectiveDefault}`,
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

function hiddenProbeMatch(call: ToolCall, manifest: Manifest, context: PolicyContext): RuleMatch | undefined {
	const probe = `${call.command}/.hidden_probe`;
	return (
		(context.resolution.workspace ? findMatchingRule(probe, context.resolution.workspace.rules) : undefined) ??
		findMatchingRule(probe, manifest.rules)
	);
}

function readonlyResult(
	call: ToolCall,
	manifest: Manifest,
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
		const probeMatch = hiddenProbeMatch(call, manifest, context);
		if (probeMatch && probeMatch[1] !== 'allow') {
			return {
				...fallbackResult(context, classification),
				reason: 'directory search may expose hidden files protected by block rules',
			};
		}
	}

	return {
		decision: 'allow',
		classification,
		policyScope: 'global',
		resolvedWorkspaceId: context.resolution.workspace?.id,
		reason: 'auto-allowed readonly tool call',
	};
}

export class PolicyEngine {
	constructor(private readonly manifest: Manifest) {}

	evaluate(call: ToolCall): EvaluationResult {
		const classification = classifyToolCall(call);
		const context = resolvePolicyContext(this.manifest, call);
		if (context.resolution.source === 'unresolved') {
			return unresolvedWorkspaceResult(context, classification);
		}
		if (context.match) return matchedRuleResult(context, classification);
		if (classification === 'readonly') return readonlyResult(call, this.manifest, context, classification);
		return fallbackResult(context, classification);
	}
}
