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
	mode?: 'enforce' | 'warn' | 'observe';
	maxUses?: number;
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
		optionalSelectorMatches(rule.operations, (candidate) => candidate === inputs.call.operation),
	].every(Boolean);
}

function structuredMatches(
	rules: readonly StructuredRule[] | readonly PolicyGuard[] | undefined,
	inputs: EvaluationInputs,
	kind: 'guard' | 'structured',
	scope: 'global' | 'workspace'
): CompiledPolicyMatch[] {
	return (rules ?? [])
		.filter((rule) => {
			const evaluatedAt = Date.parse(inputs.call.timestamp);
			return (
				matchesSelectors(rule, inputs) &&
				(rule.expiresAt === undefined ||
					(Number.isFinite(evaluatedAt) ? evaluatedAt : Date.now()) < Date.parse(rule.expiresAt))
			);
		})
		.map((rule) => ({
			id: rule.id,
			decision: rule.decision,
			reason: rule.reason,
			kind,
			scope,
			mode: rule.mode,
			maxUses: rule.maxUses,
		}));
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
	const usage = new Map<string, number>();
	const selectMatch = (matches: CompiledPolicyMatch[]): CompiledPolicyMatch | undefined => {
		for (const match of matches) {
			if (match.mode === 'observe') continue;
			const key = `${match.scope}:${match.kind}:${match.id}`;
			const used = usage.get(key) ?? 0;
			if (match.maxUses !== undefined && used >= match.maxUses) continue;
			usage.set(key, used + 1);
			return match;
		}
		return undefined;
	};
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
			return selectMatch(structuredMatches(manifest.guards, inputsFor(call, classification), 'guard', 'global'));
		},
		matchWorkspaceGuard(workspace, call, classification) {
			return selectMatch(structuredMatches(workspace?.guards, inputsFor(call, classification), 'guard', 'workspace'));
		},
		matchWorkspaceRule(workspace, call, classification) {
			const inputs = inputsFor(call, classification);
			return (
				selectMatch(structuredMatches(workspace?.structuredRules, inputs, 'structured', 'workspace')) ??
				(workspace ? legacyMatches(workspace.rules, inputs, 'workspace')[0] : undefined)
			);
		},
		matchGlobalRule(call, classification) {
			const inputs = inputsFor(call, classification);
			return (
				selectMatch(structuredMatches(manifest.structuredRules, inputs, 'structured', 'global')) ??
				legacyMatches(manifest.rules, inputs, 'global')[0]
			);
		},
	};
}
