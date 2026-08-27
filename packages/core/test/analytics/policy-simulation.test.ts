import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { simulatePolicy } from '../../src/analytics/policy-simulation.ts';
import type { Manifest, ToolCall } from '../../src/core/types.ts';
import { AuditLogStore } from '../../src/db/audit-log.ts';
import { PolicyEngine } from '../../src/policy/engine.ts';
import { makeCall, makeManifest } from '../helpers.ts';

let tempDir: string;
let store: AuditLogStore;

function record(manifest: Manifest, call: Partial<ToolCall>): void {
	const input = makeCall(call);
	store.append(input, new PolicyEngine(manifest).evaluate(input));
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'umbod-policy-simulation-'));
	store = new AuditLogStore(join(tempDir, 'audit.db'));
});

afterEach(() => {
	store.close();
	rmSync(tempDir, { recursive: true, force: true });
});

describe('policy simulation', () => {
	test('identical manifests produce only unchanged transitions without writing audit rows', () => {
		const manifest = makeManifest({ rules: { 'git status': 'allow' } });
		record(manifest, { command: 'git status' });
		const before = store.countFiltered();

		const result = simulatePolicy(manifest, manifest, store);

		expect(result.transitions).toEqual({ 'allow->allow': 1 });
		expect(result.unchangedDecisions).toBe(1);
		expect(result.policyChanges).toBe(0);
		expect(result.dataset).toMatchObject({ eligible: 1, evaluated: 1, truncated: false, limit: 2000 });
		expect(store.countFiltered()).toBe(before);
	});

	test('separates historical, replayed baseline, and candidate decisions', () => {
		const historical = makeManifest({ rules: { 'cargo build': 'block' } });
		const baseline = makeManifest({ rules: { 'cargo build': 'approve' } });
		const candidate = makeManifest({ rules: { 'cargo build': 'allow' } });
		record(historical, { command: 'cargo build' });

		const result = simulatePolicy(baseline, candidate, store);

		expect(result.transitions).toEqual({ 'approve->allow': 1 });
		expect(result.safety).toMatchObject({ approveToAllow: 1, previouslyDeniedToAllow: 1 });
		expect(result.examples['approve->allow']?.[0]).toMatchObject({
			historicalDecision: 'block',
			baselineDecision: 'approve',
			candidateDecision: 'allow',
		});
	});

	test('includes lint and derived matching evidence in raw drill-down examples', () => {
		const baseline = makeManifest();
		const candidate = makeManifest({ rules: { 'git diff *': 'allow' } });
		record(baseline, {
			command: 'git diff --check && git commit -m test',
			operation: 'git.commit',
			inputs: { tool_input: { path: 'src/app.ts' } },
		});
		const result = simulatePolicy(baseline, candidate, store);
		expect(result.lint).toContainEqual(expect.objectContaining({ code: 'compound-prefix-allow' }));
		expect(result.policyChangeExamples[0]).toMatchObject({
			operation: 'git.commit',
			shellComponents: ['git diff --check', 'git commit -m test'],
			affectedPaths: [expect.objectContaining({ path: 'src/app.ts' })],
			candidateReason: expect.stringContaining('git diff *'),
		});
	});

	test('replays persisted trusted operation metadata through candidate selectors', () => {
		const baseline = makeManifest({ policy: { default_unknown: 'block', approval_method: 'web' } });
		const candidate = makeManifest({
			policy: { default_unknown: 'block', approval_method: 'web' },
			structuredRules: [{ id: 'host-reads', decision: 'allow', operations: ['filesystem.read'] }],
		});
		record(baseline, { tool: 'host_tool', operation: 'filesystem.read', command: '/work/file' });

		const result = simulatePolicy(baseline, candidate, store);
		expect(result.transitions).toEqual({ 'block->allow': 1 });
		expect(result.policyChangeExamples[0]?.candidateMatchedRule).toBe('host-reads');
	});

	test('backfills canonical operations for historical shell calls during replay', () => {
		const baseline = makeManifest({ policy: { default_unknown: 'approve', approval_method: 'web' } });
		const candidate = makeManifest({
			policy: { default_unknown: 'approve', approval_method: 'web' },
			structuredRules: [{ id: 'commits', decision: 'block', operations: ['git.commit'] }],
		});
		record(baseline, { command: 'git commit -m test' });
		const result = simulatePolicy(baseline, candidate, store);
		expect(result.transitions).toEqual({ 'approve->block': 1 });
		expect(result.policyChangeExamples[0]?.operation).toBe('git.commit');
	});

	test('reports newly covered calls and selector-aware shadowed rules', () => {
		const baseline = makeManifest({ policy: { default_unknown: 'approve', approval_method: 'web' } });
		const candidate = makeManifest({
			policy: { default_unknown: 'approve', approval_method: 'web' },
			structuredRules: [{ id: 'builds', decision: 'allow', commands: ['cargo build'] }],
			rules: { 'cargo *': 'block' },
		});
		record(baseline, { command: 'cargo build' });

		const result = simulatePolicy(baseline, candidate, store);

		expect(result.newlyCovered).toBe(1);
		expect(result.policyChanges).toBe(1);
		expect(result.policyChangeExamples[0]).toMatchObject({
			baselineDecision: 'approve',
			candidateDecision: 'allow',
			candidateMatchedRule: 'builds',
		});
		expect(result.newlyCoveredExamples[0]?.candidateMatchedRule).toBe('builds');
		expect(result.ruleExamples['global::builds']?.[0]?.command).toBe('cargo build');
		expect(result.ruleExamples['global::cargo *']?.[0]?.command).toBe('cargo build');
		expect(result.candidateRules.find((rule) => rule.id === 'builds')).toMatchObject({
			matched: 1,
			selected: 1,
			status: 'selected',
		});
		expect(result.candidateRules.find((rule) => rule.id === 'cargo *')).toMatchObject({
			matched: 1,
			selected: 0,
			status: 'shadowed',
		});
	});

	test('reports global guard safety transitions and unresolved workspaces', () => {
		const baseline = makeManifest({ rules: { '*': 'allow' } });
		const candidate = makeManifest({
			rules: { '*': 'allow' },
			guards: [{ id: 'credentials', decision: 'block', paths: ['**/.env'] }],
		});
		record(baseline, { tool: 'Read', command: '/work/.env', inputs: { file_path: '/work/.env' } });
		record(baseline, { command: 'git status', workspaceId: 'missing' });

		const result = simulatePolicy(baseline, candidate, store);

		expect(result.transitions['allow->block']).toBe(1);
		expect(result.safety.unresolvedWorkspace).toBe(1);
		expect(result.unresolvedWorkspaceExamples[0]?.command).toBe('git status');
		expect(result.candidateRules.find((rule) => rule.id === 'credentials')).toMatchObject({ selected: 1 });
	});

	test('reports bounded samples and supports full replay', () => {
		const baseline = makeManifest();
		for (let index = 0; index < 5; index += 1) record(baseline, { command: `cargo build ${index}` });

		const bounded = simulatePolicy(baseline, baseline, store, { limit: 2 });
		const full = simulatePolicy(baseline, baseline, store, { all: true });

		expect(bounded.dataset).toMatchObject({ eligible: 5, evaluated: 2, truncated: true, limit: 2 });
		expect(full.dataset).toMatchObject({ eligible: 5, evaluated: 5, truncated: false, limit: null });
	});
});
