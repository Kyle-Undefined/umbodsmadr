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
	matchedSelectors?: string[];
	priority?: number;
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

function matchedSelectorKinds(rule: StructuredRule | PolicyGuard, inputs: EvaluationInputs): string[] | undefined {
	const tool = inputs.call.tool.toLowerCase();
	const checks: Array<[string, boolean, boolean]> = [
		[
			'tools',
			rule.tools !== undefined,
			optionalSelectorMatches(rule.tools, (candidate) => candidate.toLowerCase() === tool),
		],
		[
			'commands',
			rule.commands !== undefined,
			optionalSelectorMatches(rule.commands, (pattern) => matchesAny(inputs.commands, [pattern])),
		],
		[
			'paths',
			rule.paths !== undefined,
			optionalSelectorMatches(rule.paths, (pattern) => matchesAnyPath(inputs.paths, [pattern])),
		],
		[
			'classifications',
			rule.classifications !== undefined,
			optionalSelectorMatches(rule.classifications, (candidate) => candidate === inputs.classification),
		],
		[
			'agents',
			rule.agents !== undefined,
			optionalSelectorMatches(rule.agents, (candidate) => candidate === inputs.call.agent),
		],
		[
			'operations',
			rule.operations !== undefined,
			optionalSelectorMatches(rule.operations, (candidate) => candidate === inputs.call.operation),
		],
		[
			'workspaces',
			rule.workspaces !== undefined,
			optionalSelectorMatches(rule.workspaces, (candidate) => candidate === inputs.call.workspaceId),
		],
	];
	const configured = checks.filter(([, present]) => present);
	const matches =
		rule.selectorMode === 'any'
			? configured.some(([, , matched]) => matched)
			: configured.every(([, , matched]) => matched);
	return matches ? configured.filter(([, , matched]) => matched).map(([kind]) => kind) : undefined;
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
				matchedSelectorKinds(rule, inputs) !== undefined &&
				(rule.expiresAt === undefined ||
					(Number.isFinite(evaluatedAt) ? evaluatedAt : Date.now()) < Date.parse(rule.expiresAt))
			);
		})
		.map((rule, index) => ({
			id: rule.id,
			decision: rule.decision,
			reason: rule.reason,
			kind,
			scope,
			mode: rule.mode,
			maxUses: rule.maxUses,
			matchedSelectors: matchedSelectorKinds(rule, inputs),
			priority: rule.priority,
			index,
		}))
		.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.index - right.index)
		.map(({ index: _index, ...match }) => match);
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
