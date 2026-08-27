import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AuditLogStore, type AuditCleanupPreview } from '@umbod/core';
import { Database } from 'bun:sqlite';
import { runDatabaseCommand } from '../src/commands/database.ts';

let tempDir: string;
let databasePath: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'umbod-database-cli-'));
	databasePath = join(tempDir, 'audit.db');
	const store = new AuditLogStore(databasePath, { journalMode: 'wal' });
	store.append(
		{ agent: 'test', tool: 'bash', command: 'old command', timestamp: '2026-01-01T00:00:00.000Z' },
		{ decision: 'allow', classification: 'readonly', reason: 'fixture' }
	);
	store.close();
	spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

test('database CLI keeps dry-run distinct from explicit receipt execution', async () => {
	const preview = (await runDatabaseCommand('cleanup', {
		databasePath,
		olderThanDays: 90,
		dryRun: true,
		json: true,
	})) as AuditCleanupPreview;
	const verifier = new AuditLogStore(databasePath);
	expect(verifier.countFiltered()).toBe(1);
	verifier.close();

	await expect(
		runDatabaseCommand('cleanup', { databasePath, previewReceipt: preview.previewReceipt, json: true })
	).rejects.toThrow('requires --execute');
	const executed = await runDatabaseCommand('cleanup', {
		databasePath,
		previewReceipt: preview.previewReceipt,
		execute: true,
		json: true,
	});
	expect(executed).toMatchObject({ deletedAuditRows: 1, retainedAuditRows: 0 });
});

test('database CLI validates conflicting modes and compaction execution', async () => {
	await expect(
		runDatabaseCommand('cleanup', { databasePath, olderThanDays: 90, dryRun: true, execute: true, json: true })
	).rejects.toThrow('cannot be combined');
	await expect(runDatabaseCommand('compact', { databasePath, json: true })).rejects.toThrow('requires --execute');
	const compacted = await runDatabaseCommand('compact', { databasePath, execute: true, json: true });
	expect(compacted).toHaveProperty('filesBefore');
});

test('read-only CLI operations refuse rather than migrate an older schema', async () => {
	const native = new Database(databasePath, { readwrite: true });
	native.exec('PRAGMA user_version = 7');
	native.close();
	await expect(runDatabaseCommand('status', { databasePath, json: true })).rejects.toThrow('requires schema version');
	const verifier = new Database(databasePath, { readonly: true });
	try {
		expect(verifier.query('PRAGMA user_version').get()).toEqual({ user_version: 7 });
	} finally {
		verifier.close();
	}
});
