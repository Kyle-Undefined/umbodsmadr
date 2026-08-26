import type {
	ApprovalDecision,
	CallClassification,
	Manifest,
	PolicyGuard,
	StructuredRule,
	ToolCall,
	WorkspaceConfig,
} from '../core/types.ts';
import { matchesPattern } from './rule-matcher.ts';
import { ruleMatchCandidates, rulePathCandidates } from './rule-candidates.ts';

export interface CompiledPolicyMatch {
	id: string;
	decision: ApprovalDecision;
	reason?: string;
	kind: 'guard' | 'structured' | 'legacy';
	scope?: 'global' | 'workspace';
}

interface EvaluationInputs {
	call: ToolCall;
	classification: CallClassification;
	commands: string[];
	paths: string[];
}

function matchesAny(values: string[], patterns: string[]): boolean {
	return values.some((value) => patterns.some((pattern) => matchesPattern(value, pattern)));
}

function matchesAnyPath(values: string[], patterns: string[]): boolean {
	return values.some((value) =>
		patterns.some((rawPattern) => {
			const pattern = rawPattern.replaceAll('\\', '/');
			return matchesPattern(value, pattern) || (pattern.startsWith('**/') && matchesPattern(value, pattern.slice(3)));
		})
	);
}

function optionalSelectorMatches<T>(configured: T[] | undefined, predicate: (value: T) => boolean): boolean {
	return configured === undefined || configured.some(predicate);
}

function matchesSelectors(rule: StructuredRule | PolicyGuard, inputs: EvaluationInputs): boolean {
	const tool = inputs.call.tool.toLowerCase();
	return [
		optionalSelectorMatches(rule.tools, (candidate) => candidate.toLowerCase() === tool),
		optionalSelectorMatches(rule.commands, (pattern) => matchesAny(inputs.commands, [pattern])),
		optionalSelectorMatches(rule.paths, (pattern) => matchesAnyPath(inputs.paths, [pattern])),
		optionalSelectorMatches(rule.classifications, (candidate) => candidate === inputs.classification),
		optionalSelectorMatches(rule.agents, (candidate) => candidate === inputs.call.agent),
	].every(Boolean);
}

function structuredMatches(
	rules: readonly StructuredRule[] | readonly PolicyGuard[] | undefined,
	inputs: EvaluationInputs,
	kind: 'guard' | 'structured',
	scope: 'global' | 'workspace'
): CompiledPolicyMatch[] {
	return (rules ?? [])
		.filter((rule) => matchesSelectors(rule, inputs))
		.map((rule) => ({ id: rule.id, decision: rule.decision, reason: rule.reason, kind, scope }));
}

function legacyMatches(
	rules: Manifest['rules'],
	inputs: EvaluationInputs,
	scope: 'global' | 'workspace'
): CompiledPolicyMatch[] {
	const matches = new Map<string, CompiledPolicyMatch>();
	for (const candidate of ruleMatchCandidates(inputs.call)) {
		for (const [pattern, decision] of Object.entries(rules)) {
			if (matchesPattern(candidate, pattern) && !matches.has(pattern)) {
				matches.set(pattern, { id: pattern, decision, kind: 'legacy', scope });
			}
		}
	}
	return [...matches.values()];
}

export interface CompiledPolicy {
	traceMatches(
		workspace: WorkspaceConfig | undefined,
		call: ToolCall,
		classification: CallClassification
	): CompiledPolicyMatch[];
	hasPathGuard(workspace: WorkspaceConfig | undefined): boolean;
	matchGlobalGuard(call: ToolCall, classification: CallClassification): CompiledPolicyMatch | undefined;
	matchWorkspaceGuard(
		workspace: WorkspaceConfig | undefined,
		call: ToolCall,
		classification: CallClassification
	): CompiledPolicyMatch | undefined;
	matchWorkspaceRule(
		workspace: WorkspaceConfig | undefined,
		call: ToolCall,
		classification: CallClassification
	): CompiledPolicyMatch | undefined;
	matchGlobalRule(call: ToolCall, classification: CallClassification): CompiledPolicyMatch | undefined;
}

export function compilePolicy(manifest: Manifest): CompiledPolicy {
	const inputsFor = (call: ToolCall, classification: CallClassification): EvaluationInputs => ({
		call,
		classification,
		commands: call.command.trim() ? [call.command.trim()] : [],
		paths: rulePathCandidates(call),
	});

	return {
		traceMatches(workspace, call, classification) {
			const inputs = inputsFor(call, classification);
			return [
				...structuredMatches(manifest.guards, inputs, 'guard', 'global'),
				...structuredMatches(workspace?.guards, inputs, 'guard', 'workspace'),
				...structuredMatches(workspace?.structuredRules, inputs, 'structured', 'workspace'),
				...(workspace ? legacyMatches(workspace.rules, inputs, 'workspace') : []),
				...structuredMatches(manifest.structuredRules, inputs, 'structured', 'global'),
				...legacyMatches(manifest.rules, inputs, 'global'),
			];
		},
		hasPathGuard(workspace) {
			return (
				(manifest.guards ?? []).some((guard) => guard.paths !== undefined) ||
				(workspace?.guards ?? []).some((guard) => guard.paths !== undefined)
			);
		},
		matchGlobalGuard(call, classification) {
			return structuredMatches(manifest.guards, inputsFor(call, classification), 'guard', 'global')[0];
		},
		matchWorkspaceGuard(workspace, call, classification) {
			return structuredMatches(workspace?.guards, inputsFor(call, classification), 'guard', 'workspace')[0];
		},
		matchWorkspaceRule(workspace, call, classification) {
			const inputs = inputsFor(call, classification);
			return (
				structuredMatches(workspace?.structuredRules, inputs, 'structured', 'workspace')[0] ??
				(workspace ? legacyMatches(workspace.rules, inputs, 'workspace')[0] : undefined)
			);
		},
		matchGlobalRule(call, classification) {
			const inputs = inputsFor(call, classification);
			return (
				structuredMatches(manifest.structuredRules, inputs, 'structured', 'global')[0] ??
				legacyMatches(manifest.rules, inputs, 'global')[0]
			);
		},
	};
}
