import { describe, expect, test } from 'bun:test';
import { lintPolicy } from '../../src/policy/policy-lint.ts';
import { makeManifest } from '../helpers.ts';

describe('policy lint', () => {
	test('warns about compound-consuming allows and permissive mutation defaults', () => {
		const findings = lintPolicy(
			makeManifest({
				policy: {
					default_unknown: 'approve',
					approval_method: 'web',
					defaults: { stateful: 'allow' },
				},
				rules: { 'git diff *': 'allow' },
			})
		);
		expect(findings.map((finding) => finding.code)).toContain('compound-prefix-allow');
		expect(findings.map((finding) => finding.code)).toContain('permissive-mutation-default');
	});

	test('accepts component-bounded allow rules and reports duplicate selectors', () => {
		const findings = lintPolicy(
			makeManifest({
				structuredRules: [
					{ id: 'diff', decision: 'allow', commands: ['git diff *'], compound: false },
					{ id: 'duplicate', decision: 'approve', commands: ['git diff *'], compound: false },
				],
			})
		);
		expect(findings).toContainEqual(expect.objectContaining({ code: 'shadowed-rule', ruleId: 'duplicate' }));
		expect(findings.some((finding) => finding.code === 'compound-prefix-allow')).toBe(false);
	});

	test('distinguishes workspace preemption from non-relaxable guards', () => {
		const findings = lintPolicy(
			makeManifest({
				rules: { 'git push *': 'block' },
				guards: [{ id: 'force', decision: 'block', commands: ['git push --force *'] }],
				workspaces: [{ id: 'repo', roots: ['/work/repo'], rules: { 'git push *': 'allow' } }],
			})
		);
		expect(findings).toContainEqual(
			expect.objectContaining({ code: 'workspace-preempts-global', workspaceId: 'repo' })
		);
	});

	test('detects prefix rules that make later approvals unreachable', () => {
		const legacy = lintPolicy(makeManifest({ rules: { 'git *': 'allow', 'git push *': 'approve' } }));
		expect(legacy).toContainEqual(expect.objectContaining({ code: 'shadowed-rule', ruleId: 'git push *' }));
		const structured = lintPolicy(
			makeManifest({
				structuredRules: [
					{ id: 'all-git', decision: 'allow', commands: ['git *'] },
					{ id: 'push', decision: 'approve', commands: ['git push *'] },
				],
			})
		);
		expect(structured).toContainEqual(expect.objectContaining({ code: 'shadowed-rule', ruleId: 'push' }));
	});
});
