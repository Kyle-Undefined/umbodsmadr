import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { analyzeRules } from '../../src/analytics/rule-analysis.ts';
import { AuditLogStore } from '../../src/db/audit-log.ts';
import { PolicyEngine } from '../../src/policy/engine.ts';
import type { Manifest, ToolCall } from '../../src/core/types.ts';
import { makeCall, makeManifest } from '../helpers.ts';

let tempDir: string;

class CountingAuditLogStore extends AuditLogStore {
	matchedRuleCountsCalls = 0;
	unmatchedEntriesCalls = 0;
	approvalHotspotsCalls = 0;

	override matchedRuleCounts(
		filter: Parameters<AuditLogStore['matchedRuleCounts']>[0] = {}
	): ReturnType<AuditLogStore['matchedRuleCounts']> {
		this.matchedRuleCountsCalls += 1;
		return super.matchedRuleCounts(filter);
	}

	override unmatchedEntries(
		filter: Parameters<AuditLogStore['unmatchedEntries']>[0] = {},
		limit?: number
	): ReturnType<AuditLogStore['unmatchedEntries']> {
		this.unmatchedEntriesCalls += 1;
		return super.unmatchedEntries(filter, limit);
	}

	override approvalHotspots(
		filter: Parameters<AuditLogStore['approvalHotspots']>[0] = {},
		sampleLimit?: number
	): ReturnType<AuditLogStore['approvalHotspots']> {
		this.approvalHotspotsCalls += 1;
		return super.approvalHotspots(filter, sampleLimit);
	}
}

let store: CountingAuditLogStore;

/** Evaluates through the real engine so matched_rule reflects actual behavior. */
function record(manifest: Manifest, call: Partial<ToolCall>): number | undefined {
	const engine = new PolicyEngine(manifest);
	const input = makeCall(call);
	const { approvalRequestId } = store.append(input, engine.evaluate(input));
	return approvalRequestId;
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'umbod-rule-analysis-test-'));
	store = new CountingAuditLogStore(join(tempDir, 'test.db'));
});

afterEach(() => {
	store.close();
	rmSync(tempDir, { recursive: true, force: true });
});

describe('analytics > rule analysis', () => {
	test('marks matched rules active and never-matched rules dead', () => {
		const manifest = makeManifest({ rules: { 'git *': 'allow', 'docker *': 'approve' } });
		record(manifest, { command: 'git status' });

		const analysis = analyzeRules(manifest, store);

		expect(analysis.rules.find((rule) => rule.pattern === 'git *')?.status).toBe('active');
		expect(analysis.rules.find((rule) => rule.pattern === 'docker *')?.status).toBe('dead');
		expect(store.matchedRuleCountsCalls).toBe(1);
	});

	test('marks rules stale when unmatched inside the window', () => {
		const manifest = makeManifest({ rules: { 'git *': 'allow' } });
		record(manifest, { command: 'git status', timestamp: '2020-01-01T00:00:00.000Z' });

		const analysis = analyzeRules(manifest, store, { since: '2025-01-01T00:00:00.000Z' });

		const finding = analysis.rules.find((rule) => rule.pattern === 'git *');
		expect(finding?.status).toBe('stale');
		expect(finding?.matchCountAllTime).toBe(1);
		expect(finding?.matchCount).toBe(0);
		expect(store.matchedRuleCountsCalls).toBe(2);
	});

	test('summary projection skips hotspot and suggestion detail', () => {
		const manifest = makeManifest({ rules: { 'git *': 'allow' } });
		record(manifest, { command: 'git status' });

		const analysis = analyzeRules(manifest, store, { projection: 'summary' });

		expect(analysis.projection).toBe('summary');
		expect(analysis.rules[0]).toMatchObject({ pattern: 'git *', status: 'active' });
		expect(analysis.approvalHotspots).toEqual([]);
		expect(analysis.suggestions).toEqual([]);
		expect(analysis.tomlSnippet).toBe('');
		expect(store.unmatchedEntriesCalls).toBe(0);
		expect(store.approvalHotspotsCalls).toBe(0);
	});

	test('keeps all-time rule counts outside an agent-filtered window', () => {
		const manifest = makeManifest({ rules: { 'git *': 'allow' } });
		record(manifest, { agent: 'claude', command: 'git status' });

		const analysis = analyzeRules(manifest, store, { agent: 'codex' });

		expect(analysis.rules.find((rule) => rule.pattern === 'git *')).toMatchObject({
			status: 'stale',
			matchCountAllTime: 1,
			matchCount: 0,
		});
		expect(store.matchedRuleCountsCalls).toBe(2);
	});

	test('flags invalid regex rules', () => {
		const manifest = makeManifest({ rules: { '/[/': 'block' } });

		const analysis = analyzeRules(manifest, store);

		const finding = analysis.rules.find((rule) => rule.pattern === '/[/');
		expect(finding?.status).toBe('invalid');
		expect(finding?.note).toContain('regex fails to compile');
		expect(analysis.suggestions.some((s) => s.kind === 'fix-invalid')).toBe(true);
	});

	test('detects statically shadowed rules', () => {
		const manifest = makeManifest({ rules: { 'git *': 'allow', 'git status': 'block' } });

		const analysis = analyzeRules(manifest, store);

		const finding = analysis.rules.find((rule) => rule.pattern === 'git status');
		expect(finding?.status).toBe('shadowed');
		expect(finding?.shadowedBy).toBe('git *');
		expect(analysis.suggestions.some((s) => s.kind === 'reorder-shadowed')).toBe(true);
	});

	test('detects empirically shadowed rules from history', () => {
		const manifest = makeManifest({ rules: { 'git *': 'allow', '/^git push/': 'approve' } });
		record(manifest, { command: 'git push origin main' });

		const analysis = analyzeRules(manifest, store);

		const finding = analysis.rules.find((rule) => rule.pattern === '/^git push/');
		expect(finding?.status).toBe('shadowed');
		expect(finding?.shadowedBy).toBe('git *');
	});

	test('limits empirical shadow detection to the requested window and project', () => {
		const manifest = makeManifest({ rules: { 'git *': 'allow', '/^git push/': 'approve' } });
		record(manifest, {
			command: 'git push origin main',
			timestamp: '2020-01-01T00:00:00.000Z',
			workingDirectory: '/work/other',
		});

		const analysis = analyzeRules(manifest, store, {
			since: '2025-01-01T00:00:00.000Z',
			project: '/work/current',
		});

		expect(analysis.rules.find((rule) => rule.pattern === '/^git push/')?.status).toBe('dead');
	});

	test('reports approval hotspots with resolution outcomes', () => {
		const manifest = makeManifest({ rules: { 'gh *': 'approve' } });
		const first = record(manifest, { command: 'gh pr create' });
		const second = record(manifest, { command: 'gh pr merge' });
		if (first !== undefined) store.resolveApprovalRequest(first, 'approved');
		if (second !== undefined) store.resolveApprovalRequest(second, 'denied');

		const analysis = analyzeRules(manifest, store);

		const hotspot = analysis.approvalHotspots.find((h) => h.commandKey === 'gh');
		expect(hotspot?.total).toBe(2);
		expect(hotspot?.approved).toBe(1);
		expect(hotspot?.denied).toBe(1);
		expect(hotspot?.sampleCommands.length).toBeGreaterThan(0);
	});

	test('limits replay separately from unmatched suggestion candidates', () => {
		const manifest = makeManifest({
			policy: { default_unknown: 'approve', approval_method: 'web' },
			rules: { 'echo *': 'allow' },
		});
		for (let index = 0; index < 5; index += 1) {
			const { approvalRequestId } = store.append(makeCall({ command: `git push origin branch-${index}` }), {
				decision: 'approve',
				classification: 'unknown',
				reason: 'no matching rule, fell back to policy.default_unknown=approve',
			});
			if (approvalRequestId !== undefined) store.resolveApprovalRequest(approvalRequestId, 'approved');
		}
		for (let index = 0; index < 5; index += 1) {
			record(manifest, { command: `echo newer-${index}` });
		}

		const analysis = analyzeRules(manifest, store, { minOccurrences: 5, replayLimit: 5 });
		const suggestion = analysis.suggestions.find((entry) => entry.pattern === 'git push *');

		expect(suggestion).toMatchObject({
			kind: 'promote-approved',
			evidence: { occurrences: 5, approvedCount: 5 },
			impact: { matchingCalls: 0 },
		});
	});

	test('keeps approval hotspot samples inside the requested workspace', () => {
		const manifest = makeManifest({
			rules: { 'gh *': 'approve' },
			workspaces: [
				{ id: 'client', roots: ['/work/client'], rules: {} },
				{ id: 'personal', roots: ['/work/personal'], rules: {} },
			],
		});
		record(manifest, {
			workspaceId: 'client',
			workingDirectory: '/work/client',
			command: 'gh pr create --repo client/project',
		});
		record(manifest, {
			workspaceId: 'personal',
			workingDirectory: '/work/personal',
			command: 'gh pr create --repo personal/project',
		});

		const analysis = analyzeRules(manifest, store, { workspace: 'client' });
		const hotspot = analysis.approvalHotspots.find((entry) => entry.commandKey === 'gh');

		expect(hotspot?.total).toBe(1);
		expect(hotspot?.sampleCommands).toEqual(['gh pr create --repo client/project']);
	});

	test('analyzes workspace rule health independently from global rules', () => {
		const manifest = makeManifest({
			rules: { 'git push *': 'approve' },
			workspaces: [
				{
					id: 'client',
					roots: ['/work/client'],
					rules: { 'git push *': 'block', 'terraform plan *': 'approve' },
				},
			],
		});
		record(manifest, {
			workspaceId: 'client',
			workingDirectory: '/work/client',
			command: 'git push origin main',
		});

		const analysis = analyzeRules(manifest, store, { workspace: 'client' });
		expect(analysis.workspaceId).toBe('client');
		expect(analysis.rules.find((rule) => rule.pattern === 'git push *')).toMatchObject({
			workspaceId: 'client',
			status: 'active',
			matchCount: 1,
		});
		expect(analysis.rules.find((rule) => rule.pattern === 'terraform plan *')?.status).toBe('dead');
		expect(analysis.tomlSnippet).toContain('Workspace target: "client"');
		expect(analysis.tomlSnippet).toContain('Move and uncomment each proposed entry');
		expect(analysis.tomlSnippet).not.toContain('\n[workspaces.rules]\n');
		expect(store.matchedRuleCountsCalls).toBe(1);
	});

	test('rejects analytics for an unknown workspace id', () => {
		expect(() => analyzeRules(makeManifest(), store, { workspace: 'missing' })).toThrow('not configured');
	});
});
