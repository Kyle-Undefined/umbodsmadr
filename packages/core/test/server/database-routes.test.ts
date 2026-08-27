import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createUmbod } from '../../src/server/api.ts';
import type { AuditCleanupPreview } from '../../src/db/maintenance-types.ts';
import { makeCall, makeManifest } from '../helpers.ts';

let tempDir: string;
let umbod: ReturnType<typeof createUmbod>;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'umbod-database-routes-'));
	umbod = createUmbod({
		manifest: makeManifest(),
		dbPath: join(tempDir, 'audit.db'),
		auditLogOptions: { journalMode: 'wal' },
	});
	umbod.auditLog.append(makeCall({ timestamp: '2026-01-01T00:00:00.000Z' }), {
		decision: 'allow',
		classification: 'readonly',
		reason: 'fixture',
	});
});

afterEach(() => {
	umbod.close();
	rmSync(tempDir, { recursive: true, force: true });
});

async function route(path: string, init?: RequestInit): Promise<Response> {
	const response = await umbod.fetch(new Request(`http://umbod.test${path}`, init));
	if (!response) throw new Error(`route did not handle ${path}`);
	return response;
}

describe('database maintenance API routes', () => {
	test('reports status and validates methods', async () => {
		const status = await route('/api/database/status?olderThanDays=90');
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({ auditRows: 1, eligibleAuditRows: 1, journalMode: 'wal' });
		const wrongMethod = await route('/api/database/status', { method: 'DELETE' });
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get('allow')).toBe('GET, POST');
	});

	test('previews read-only then requires explicit execution and the exact receipt', async () => {
		const before = umbod.auditLog.countFiltered();
		const previewResponse = await route('/api/database/cleanup/preview', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ olderThanDays: 90, preservePendingApprovals: true }),
		});
		const preview = (await previewResponse.json()) as AuditCleanupPreview;
		expect(previewResponse.status).toBe(200);
		expect(preview.readOnly).toBe(true);
		expect(umbod.auditLog.countFiltered()).toBe(before);

		const missingExecution = await route('/api/database/cleanup', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ previewReceipt: preview.previewReceipt }),
		});
		expect(missingExecution.status).toBe(400);
		expect(umbod.auditLog.countFiltered()).toBe(before);

		const execution = await route('/api/database/cleanup', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ previewReceipt: preview.previewReceipt, execute: true }),
		});
		expect(execution.status).toBe(200);
		expect(await execution.json()).toMatchObject({ deletedAuditRows: 1, retainedAuditRows: 0 });
	});

	test('rejects cross-origin mutations and stale receipts', async () => {
		const forbidden = await route('/api/database/cleanup/preview', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: 'https://example.test' },
			body: JSON.stringify({ olderThanDays: 90 }),
		});
		expect(forbidden.status).toBe(403);

		const preview = (await (
			await route('/api/database/cleanup/preview', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ olderThanDays: 90 }),
			})
		).json()) as AuditCleanupPreview;
		umbod.auditLog.append(makeCall({ timestamp: '2026-08-25T00:00:00.000Z' }), {
			decision: 'allow',
			classification: 'readonly',
			reason: 'new write',
		});
		const stale = await route('/api/database/cleanup', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ previewReceipt: preview.previewReceipt, execute: true }),
		});
		expect(stale.status).toBe(409);
	});

	test('rejects conflicting or unsafe retention inputs', async () => {
		for (const body of [
			{ olderThanDays: 0 },
			{ olderThanDays: -1 },
			{ olderThanDays: 36_501 },
			{ olderThanDays: 90, preservePendingApprovals: false },
			{ cutoff: '2026-01-01T00:00:00.000Z' },
		]) {
			const response = await route('/api/database/cleanup/preview', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
		}
	});
});
