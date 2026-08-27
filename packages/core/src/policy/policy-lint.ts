import type { ApprovalDecision, Manifest, StructuredRule, WorkspaceConfig } from '../core/types.ts';
import { matchesPattern } from './rule-matcher.ts';

export type PolicyLintSeverity = 'warning' | 'error';

export interface PolicyLintFinding {
	code: 'compound-prefix-allow' | 'shadowed-rule' | 'workspace-preempts-global' | 'permissive-mutation-default';
	severity: PolicyLintSeverity;
	message: string;
	ruleId?: string;
	workspaceId?: string;
}

const DECISION_RANK: Record<ApprovalDecision, number> = { allow: 0, approve: 1, block: 2 };

function selectorValue(value: unknown[] | undefined): unknown[] | null {
	return value === undefined ? null : value;
}

function selectorIdentity(rule: StructuredRule): string {
	return JSON.stringify({
		tools: selectorValue(rule.tools),
		commands: selectorValue(rule.commands),
		componentsAny: selectorValue(rule.componentsAny),
		componentsAll: selectorValue(rule.componentsAll),
		compound: rule.compound,
		paths: selectorValue(rule.paths),
		pathsAll: selectorValue(rule.pathsAll),
		classifications: selectorValue(rule.classifications),
		agents: selectorValue(rule.agents),
		operations: selectorValue(rule.operations),
		workspaces: selectorValue(rule.workspaces),
		selectorMode: rule.selectorMode,
		priority: rule.priority,
	});
}

function selectorIdentityWithoutCommands(rule: StructuredRule): string {
	return JSON.stringify({
		tools: selectorValue(rule.tools),
		componentsAny: selectorValue(rule.componentsAny),
		componentsAll: selectorValue(rule.componentsAll),
		compound: rule.compound,
		paths: selectorValue(rule.paths),
		pathsAll: selectorValue(rule.pathsAll),
		classifications: selectorValue(rule.classifications),
		agents: selectorValue(rule.agents),
		operations: selectorValue(rule.operations),
		workspaces: selectorValue(rule.workspaces),
		selectorMode: rule.selectorMode,
		priority: rule.priority,
	});
}

function patternRepresentative(pattern: string): string | undefined {
	if (/^\/.+\/[gimsuy]*$/.test(pattern)) return undefined;
	return pattern.replaceAll('*', 'umbod-sample');
}

function patternSubsumes(earlier: string, later: string): boolean {
	const representative = patternRepresentative(later);
	return representative !== undefined && matchesPattern(representative, earlier);
}

function lintStructuredShadows(
	rules: readonly StructuredRule[],
	findings: PolicyLintFinding[],
	workspaceId?: string
): void {
	const earlier = new Map<string, string>();
	for (const rule of rules) {
		const identity = selectorIdentity(rule);
		const shadowedBy = earlier.get(identity);
		if (shadowedBy) {
			findings.push({
				code: 'shadowed-rule',
				severity: 'warning',
				ruleId: rule.id,
				workspaceId,
				message: `rule "${rule.id}" has the same selectors and priority as earlier rule "${shadowedBy}"`,
			});
		} else {
			earlier.set(identity, rule.id);
		}
		if (rule.commands?.length) {
			const prior = rules
				.slice(0, rules.indexOf(rule))
				.find(
					(candidate) =>
						candidate.commands?.some((earlierPattern) =>
							rule.commands?.every((laterPattern) => patternSubsumes(earlierPattern, laterPattern))
						) && selectorIdentityWithoutCommands(candidate) === selectorIdentityWithoutCommands(rule)
				);
			if (prior && !findings.some((finding) => finding.ruleId === rule.id && finding.code === 'shadowed-rule')) {
				findings.push({
					code: 'shadowed-rule',
					severity: 'warning',
					ruleId: rule.id,
					workspaceId,
					message: `rule "${rule.id}" command selectors are consumed by earlier rule "${prior.id}"`,
				});
			}
		}
	}
}

function lintLegacyShadows(rules: Manifest['rules'], findings: PolicyLintFinding[], workspaceId?: string): void {
	const entries = Object.entries(rules);
	for (let index = 1; index < entries.length; index += 1) {
		const [pattern] = entries[index] as [string, ApprovalDecision];
		const earlier = entries.slice(0, index).find(([candidate]) => patternSubsumes(candidate, pattern));
		if (!earlier) continue;
		findings.push({
			code: 'shadowed-rule',
			severity: 'warning',
			ruleId: pattern,
			workspaceId,
			message: `legacy rule "${pattern}" is consumed by earlier pattern "${earlier[0]}"`,
		});
	}
}

function compoundPrefixMatches(pattern: string): boolean {
	if (!pattern.includes('*')) return false;
	const literalPrefix = pattern.slice(0, pattern.indexOf('*')).trimEnd();
	return literalPrefix.length > 0 && matchesPattern(`${literalPrefix} safe && umbod_mutation`, pattern);
}

// fallow-ignore-next-line complexity -- bounded static checks cover structured and legacy compatibility grammars together.
function lintCompoundAllows(
	manifest: Manifest,
	findings: PolicyLintFinding[],
	rules: readonly StructuredRule[],
	legacy: Manifest['rules'],
	workspaceId?: string
): void {
	for (const rule of rules) {
		if (rule.decision !== 'allow' || rule.compound === false || rule.componentsAny || rule.componentsAll) continue;
		for (const pattern of rule.commands ?? []) {
			if (!compoundPrefixMatches(pattern)) continue;
			findings.push({
				code: 'compound-prefix-allow',
				severity: 'warning',
				ruleId: rule.id,
				workspaceId,
				message: `allow rule "${rule.id}" command pattern "${pattern}" can consume a compound shell invocation; add compound = false or component selectors`,
			});
		}
	}
	for (const [pattern, decision] of Object.entries(legacy)) {
		if (decision !== 'allow' || !compoundPrefixMatches(pattern)) continue;
		findings.push({
			code: 'compound-prefix-allow',
			severity: 'warning',
			ruleId: pattern,
			workspaceId,
			message: `legacy allow pattern "${pattern}" can consume a compound shell invocation; migrate it to a structured rule with compound = false`,
		});
	}
	void manifest;
}

function lintWorkspacePreemption(manifest: Manifest, workspace: WorkspaceConfig, findings: PolicyLintFinding[]): void {
	for (const [pattern, decision] of Object.entries(workspace.rules)) {
		const globalDecision = manifest.rules[pattern];
		if (globalDecision && DECISION_RANK[decision] < DECISION_RANK[globalDecision]) {
			findings.push({
				code: 'workspace-preempts-global',
				severity: 'warning',
				ruleId: pattern,
				workspaceId: workspace.id,
				message: `workspace "${workspace.id}" decision ${decision} preempts stricter global rule "${pattern}" (${globalDecision}); use a global guard if it must be invariant`,
			});
		}
	}
}

export function lintPolicy(manifest: Manifest): PolicyLintFinding[] {
	const findings: PolicyLintFinding[] = [];
	lintStructuredShadows(manifest.structuredRules ?? [], findings);
	lintLegacyShadows(manifest.rules, findings);
	lintCompoundAllows(manifest, findings, manifest.structuredRules ?? [], manifest.rules);
	for (const workspace of manifest.workspaces ?? []) {
		lintStructuredShadows(workspace.structuredRules ?? [], findings, workspace.id);
		lintLegacyShadows(workspace.rules, findings, workspace.id);
		lintCompoundAllows(manifest, findings, workspace.structuredRules ?? [], workspace.rules, workspace.id);
		lintWorkspacePreemption(manifest, workspace, findings);
	}
	for (const classification of ['stateful', 'destructive', 'external'] as const) {
		const decision = manifest.policy.defaults?.[classification] ?? manifest.policy.default_unknown;
		if (decision === 'allow') {
			findings.push({
				code: 'permissive-mutation-default',
				severity: 'warning',
				message: `${classification} calls fall back to allow when no rule matches`,
			});
		}
	}
	return findings;
}
