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
import { analyzeShellCommand } from './shell-analyzer.ts';
import { inferredOperation } from './operations.ts';

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
	components: string[];
	compound: boolean;
}

function matchesAny(values: string[], patterns: string[]): boolean {
	return values.some((value) => patterns.some((pattern) => matchesPattern(value, pattern)));
}

function matchesAnyPath(values: string[], patterns: string[]): boolean {
	return values.some((value) =>
		patterns.some((rawPattern) => {
			const pattern = /^\/.+\/[gimsuy]*$/.test(rawPattern) ? rawPattern : rawPattern.replaceAll('\\', '/');
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
			'components_any',
			rule.componentsAny !== undefined,
			optionalSelectorMatches(rule.componentsAny, (pattern) => matchesAny(inputs.components, [pattern])),
		],
		[
			'components_all',
			rule.componentsAll !== undefined,
			rule.componentsAll !== undefined &&
				inputs.components.length > 0 &&
				inputs.components.every((component) => matchesAny([component], rule.componentsAll as string[])),
		],
		['compound', rule.compound !== undefined, rule.compound === inputs.compound],
		[
			'paths',
			rule.paths !== undefined,
			optionalSelectorMatches(rule.paths, (pattern) => matchesAnyPath(inputs.paths, [pattern])),
		],
		[
			'paths_all',
			rule.pathsAll !== undefined,
			rule.pathsAll !== undefined &&
				inputs.paths.length > 0 &&
				inputs.paths.every((path) => matchesAnyPath([path], rule.pathsAll as string[])),
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
	const inputCache = new WeakMap<ToolCall, Map<CallClassification, EvaluationInputs>>();
	const structuredEntries = [
		...(manifest.guards ?? []),
		...(manifest.structuredRules ?? []),
		...(manifest.workspaces ?? []).flatMap((workspace) => [
			...(workspace.guards ?? []),
			...(workspace.structuredRules ?? []),
		]),
	];
	const needsComponents = structuredEntries.some(
		(rule) => rule.componentsAny !== undefined || rule.componentsAll !== undefined || rule.compound !== undefined
	);
	const needsPaths = structuredEntries.some((rule) => rule.paths !== undefined || rule.pathsAll !== undefined);
	const needsOperations = structuredEntries.some((rule) => rule.operations !== undefined);
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
	// fallow-ignore-next-line complexity -- lazily derives only selector facts used by this compiled manifest.
	const inputsFor = (call: ToolCall, classification: CallClassification): EvaluationInputs => {
		const cached = inputCache.get(call)?.get(classification);
		if (cached) return cached;
		const effectiveCall =
			needsOperations && call.operation === undefined
				? { ...call, operation: inferredOperation(call.tool, call.command) }
				: call;
		const shell =
			needsComponents && effectiveCall.tool === 'bash' ? analyzeShellCommand(effectiveCall.command) : undefined;
		const inputs = {
			call: effectiveCall,
			classification,
			commands: effectiveCall.command.trim() ? [effectiveCall.command.trim()] : [],
			paths: needsPaths ? rulePathCandidates(effectiveCall) : [],
			components: shell?.components.map((component) => component.command) ?? [],
			compound: shell?.compound ?? false,
		};
		const byClassification = inputCache.get(call) ?? new Map<CallClassification, EvaluationInputs>();
		byClassification.set(classification, inputs);
		inputCache.set(call, byClassification);
		return inputs;
	};

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
