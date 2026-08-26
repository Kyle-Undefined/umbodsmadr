import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { suggestRules, clusterKey } from '../../src/analytics/suggestions.ts';
import { AuditLogStore } from '../../src/db/audit-log.ts';
import type { ApprovalStatus, CallClassification, ToolCall } from '../../src/core/types.ts';
import { makeCall, makeManifest } from '../helpers.ts';

let tempDir: string;
let store: AuditLogStore;

function recordApproval(
	call: Partial<ToolCall>,
	resolution: Exclude<ApprovalStatus, 'pending'> | 'pending',
	classification: CallClassification = 'unknown'
): void {
	const { approvalRequestId } = store.append(makeCall(call), {
		decision: 'approve',
		classification,
		reason: 'no matching rule, fell back to policy.default_unknown=approve',
	});
	if (resolution !== 'pending' && approvalRequestId !== undefined) {
		store.resolveApprovalRequest(approvalRequestId, resolution);
	}
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'umbod-suggestions-test-'));
	store = new AuditLogStore(join(tempDir, 'test.db'));
});

afterEach(() => {
	store.close();
	rmSync(tempDir, { recursive: true, force: true });
});

describe('analytics > cluster key', () => {
	test('bash commands cluster on first token', () => {
		expect(
			clusterKey({ ...makeCall({ command: 'ls -la' }), decision: 'approve', classification: 'unknown', reason: '' })
		).toBe('ls *');
	});

	test('multiword commands cluster on two tokens', () => {
		expect(
			clusterKey({
				...makeCall({ command: 'git push origin main' }),
				decision: 'approve',
				classification: 'unknown',
				reason: '',
			})
		).toBe('git push *');
	});

	test('non-bash tools cluster on directory', () => {
		const entry = {
			...makeCall({
				tool: 'write',
				command: 'write /home/x/proj/file.ts',
				inputs: { tool_input: { file_path: '/home/x/proj/file.ts' } },
			}),
			decision: 'approve' as const,
			classification: 'unknown' as const,
			reason: '',
		};
		expect(clusterKey(entry)).toBe('write /home/x/proj/*');
	});
});

describe('analytics > rule suggestions', () => {
	test('suggests allow for consistently approved clusters', () => {
		for (let i = 0; i < 5; i += 1) {
			recordApproval({ command: `git push origin branch-${i}` }, 'approved');
		}

		const suggestions = suggestRules(
			makeManifest({ policy: { default_unknown: 'approve', approval_method: 'web' } }),
			store
		);

		const suggestion = suggestions.find((s) => s.pattern === 'git push *');
		expect(suggestion?.decision).toBe('allow');
		expect(suggestion?.kind).toBe('promote-approved');
		expect(suggestion?.evidence.occurrences).toBe(5);
		expect(suggestion?.evidence.approvedCount).toBe(5);
		expect(suggestion?.impact).toMatchObject({
			matchingCalls: 5,
			explicitlyCoveredBefore: 0,
			coverageGained: 5,
			before: { allow: 0, block: 0, approve: 5 },
			after: { allow: 5, block: 0, approve: 0 },
			decisionChanges: 5,
			gapCount: 5,
		});
		expect(suggestion?.impact?.gaps).toHaveLength(5);
	});

	test('projects suggestion impact through guards instead of assuming a textual allow wins', () => {
		for (let i = 0; i < 5; i += 1) {
			recordApproval(
				{
					tool: 'read',
					command: `read /work/secret-${i}.env`,
					inputs: { tool_input: { file_path: `/work/secret-${i}.env` } },
				},
				'approved',
				'readonly'
			);
		}
		const manifest = makeManifest({
			policy: { default_unknown: 'approve', approval_method: 'web' },
			guards: [{ id: 'credentials', decision: 'block', paths: ['**/*.env'] }],
		});

		const suggestion = suggestRules(manifest, store).find((item) => item.pattern === 'read /work/*');

		expect(suggestion?.decision).toBe('allow');
		expect(suggestion?.impact?.after).toEqual({ allow: 0, block: 5, approve: 0 });
		expect(suggestion?.impact?.decisionChanges).toBe(0);
		expect(suggestion?.conflicts).toEqual([]);
	});

	test('suggests block for consistently denied clusters', () => {
		for (let i = 0; i < 5; i += 1) {
			recordApproval({ command: `curl https://evil-${i}.example` }, 'denied');
		}

		const suggestions = suggestRules(makeManifest(), store);

		const suggestion = suggestions.find((s) => s.pattern === 'curl *');
		expect(suggestion?.decision).toBe('block');
		expect(suggestion?.kind).toBe('block-denied');
	});

	test('skips clusters below the occurrence threshold', () => {
		recordApproval({ command: 'git push origin main' }, 'approved');

		expect(suggestRules(makeManifest(), store)).toHaveLength(0);
	});

	test('skips mixed-outcome clusters', () => {
		for (let i = 0; i < 3; i += 1) recordApproval({ command: `gh pr create -t x${i}` }, 'approved');
		for (let i = 0; i < 3; i += 1) recordApproval({ command: `gh pr merge ${i}` }, 'denied');

		const suggestions = suggestRules(makeManifest(), store, { minOccurrences: 5 });
		expect(suggestions.find((s) => s.pattern.startsWith('gh '))).toBeUndefined();
	});

	test('withholds allow suggestions for destructive clusters without overwhelming evidence', () => {
		for (let i = 0; i < 5; i += 1) {
			recordApproval({ command: `rm -rf /tmp/scratch-${i}` }, 'approved', 'destructive');
		}

		const suggestions = suggestRules(makeManifest(), store);
		expect(suggestions.find((s) => s.pattern === 'rm *')).toBeUndefined();
	});

	test('allows destructive clusters at double threshold with zero denials', () => {
		for (let i = 0; i < 10; i += 1) {
			recordApproval({ command: `rm -rf /tmp/scratch-${i}` }, 'approved', 'destructive');
		}

		const suggestion = suggestRules(makeManifest(), store).find((s) => s.pattern === 'rm *');
		expect(suggestion?.decision).toBe('allow');
		expect(suggestion?.rationale).toContain('destructive');
	});

	test('flags allow suggestions that would flip past blocks', () => {
		for (let i = 0; i < 5; i += 1) {
			recordApproval({ command: `git push origin branch-${i}` }, 'approved');
		}
		store.append(makeCall({ command: 'git push --force origin main' }), {
			decision: 'block',
			classification: 'unknown',
			reason: 'matched rule "git push --force *"',
			matchedRule: 'git push --force *',
		});

		const suggestion = suggestRules(makeManifest(), store).find((s) => s.pattern === 'git push *');
		expect(suggestion?.conflicts.some((c) => c.includes('previously blocked'))).toBe(true);
	});

	test('limits conflict replay to the requested project', () => {
		for (let i = 0; i < 5; i += 1) {
			recordApproval({ command: `git push origin branch-${i}`, workingDirectory: '/work/current' }, 'approved');
		}
		store.append(makeCall({ command: 'git push --force origin main', workingDirectory: '/work/other' }), {
			decision: 'block',
			classification: 'unknown',
			reason: 'matched rule "git push --force *"',
			matchedRule: 'git push --force *',
		});

		const suggestion = suggestRules(makeManifest(), store, { project: '/work/current' }).find(
			(s) => s.pattern === 'git push *'
		);
		expect(suggestion?.conflicts.some((c) => c.includes('previously blocked'))).toBe(false);
	});

	test('flags patterns preempted by an existing earlier rule', () => {
		for (let i = 0; i < 5; i += 1) {
			recordApproval({ command: `git push origin branch-${i}` }, 'approved');
		}

		const manifest = makeManifest({ rules: { 'git *': 'approve' } });
		const suggestion = suggestRules(manifest, store).find((s) => s.pattern === 'git push *');
		expect(suggestion?.conflicts.some((c) => c.includes('preempted'))).toBe(true);
	});

	test('scopes suggestions to a configured workspace', () => {
		for (let i = 0; i < 5; i += 1) {
			const { approvalRequestId } = store.append(
				makeCall({
					command: `git push origin branch-${i}`,
					workspaceId: 'client',
					workingDirectory: '/work/client',
				}),
				{
					decision: 'approve',
					classification: 'unknown',
					policyScope: 'workspace',
					resolvedWorkspaceId: 'client',
					reason: 'workspace fallback',
				}
			);
			if (approvalRequestId !== undefined) store.resolveApprovalRequest(approvalRequestId, 'approved');
		}
		const manifest = makeManifest({
			workspaces: [{ id: 'client', roots: ['/work/client'], default_unknown: 'approve', rules: {} }],
		});
		const suggestion = suggestRules(manifest, store, { workspace: 'client' }).find(
			(entry) => entry.pattern === 'git push *'
		);
		expect(suggestion).toMatchObject({ workspaceId: 'client', decision: 'allow' });
	});
});
