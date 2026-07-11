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
let store: AuditLogStore;

/** Evaluates through the real engine so matched_rule reflects actual behavior. */
function record(manifest: Manifest, call: Partial<ToolCall>): number | undefined {
	const engine = new PolicyEngine(manifest);
	const input = makeCall(call);
	const { approvalRequestId } = store.append(input, engine.evaluate(input));
	return approvalRequestId;
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'umbod-rule-analysis-test-'));
	store = new AuditLogStore(join(tempDir, 'test.db'));
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
	});

	test('marks rules stale when unmatched inside the window', () => {
		const manifest = makeManifest({ rules: { 'git *': 'allow' } });
		record(manifest, { command: 'git status', timestamp: '2020-01-01T00:00:00.000Z' });

		const analysis = analyzeRules(manifest, store, { since: '2025-01-01T00:00:00.000Z' });

		const finding = analysis.rules.find((rule) => rule.pattern === 'git *');
		expect(finding?.status).toBe('stale');
		expect(finding?.matchCountAllTime).toBe(1);
		expect(finding?.matchCount).toBe(0);
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
});
