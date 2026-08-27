import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateStarterPolicyDraft } from '../../src/analytics/starter-policy.ts';
import { parseManifestSource } from '../../src/config/manifest.ts';
import { AuditLogStore } from '../../src/db/audit-log.ts';
import { runManifestTests } from '../../src/policy/manifest-tests.ts';
import { makeCall } from '../helpers.ts';

describe('starter policy draft', () => {
	let directory: string;
	let store: AuditLogStore;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'umbod-draft-'));
		store = new AuditLogStore(join(directory, 'audit.db'));
	});
	afterEach(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});

	test('generates a conservative valid manifest with passing regression fixtures', () => {
		store.append(makeCall({ tool: 'bash', command: 'git status', operation: 'git.read' }), {
			decision: 'allow',
			classification: 'readonly',
			reason: 'test',
		});
		store.append(makeCall({ tool: 'bash', command: 'git commit -m test', operation: 'git.commit' }), {
			decision: 'approve',
			classification: 'stateful',
			reason: 'test',
		});
		const draft = generateStarterPolicyDraft(store, { name: 'test-draft' });
		const manifest = parseManifestSource(draft.source, 'generated draft');
		expect(manifest.structuredRules).toContainEqual(
			expect.objectContaining({ operations: ['git.read'], decision: 'allow' })
		);
		expect(manifest.structuredRules).toContainEqual(
			expect.objectContaining({ operations: ['git.commit'], decision: 'approve' })
		);
		expect(runManifestTests(manifest).failed).toBe(0);
		expect(draft.warnings[0]).toContain('draft');
	});

	test('does not generate an allow fixture that conflicts with the credential guard', () => {
		store.append(makeCall({ tool: 'read', command: '/work/.env', inputs: { file_path: '/work/.env' } }), {
			decision: 'allow',
			classification: 'readonly',
			reason: 'legacy fixture',
		});
		const draft = generateStarterPolicyDraft(store);
		const manifest = parseManifestSource(draft.source, 'generated sensitive draft');
		expect(manifest.structuredRules ?? []).toHaveLength(0);
		expect(runManifestTests(manifest).failed).toBe(0);
	});
});
