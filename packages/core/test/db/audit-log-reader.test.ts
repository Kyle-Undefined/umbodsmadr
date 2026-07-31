import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAnalyticsReader } from '../../src/analytics/reader.ts';
import { AuditLogStore, openAuditLogReader } from '../../src/db/audit-log.ts';
import { SCHEMA_VERSION } from '../../src/db/schema.ts';
import { createUmbod } from '../../src/server/api.ts';
import { makeManifest } from '../helpers.ts';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'umbod-reader-test-'));
	dbPath = join(tempDir, 'audit.db');
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function appendStatus(store: AuditLogStore): void {
	store.append(
		{ agent: 'codex', tool: 'bash', command: 'git status', timestamp: '2026-07-31T12:00:00.000Z' },
		{ decision: 'allow', classification: 'readonly', reason: 'test' }
	);
}

function version(path: string): number {
	const database = new Database(path);
	const row = database.query('PRAGMA user_version').get() as { user_version: number };
	database.close();
	return row.user_version;
}

describe('read-only audit log reader', () => {
	test('opens current data without changing the database file', () => {
		const writer = new AuditLogStore(dbPath);
		appendStatus(writer);
		writer.close();
		const before = statSync(dbPath);

		const reader = openAuditLogReader(dbPath, { busyTimeoutMs: 2500 });
		expect(reader.listRecent(1)[0]?.command).toBe('git status');
		expect(reader.matchedRuleCounts()).toEqual([]);
		reader.close();

		const after = statSync(dbPath);
		expect(after.size).toBe(before.size);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(version(dbPath)).toBe(SCHEMA_VERSION);
	});

	test('does not create a missing database', () => {
		expect(() => openAuditLogReader(dbPath)).toThrow();
		expect(existsSync(dbPath)).toBe(false);
	});

	test('refuses empty and legacy databases without migrating them', () => {
		const empty = new Database(dbPath, { create: true });
		empty.close();
		const emptyBefore = statSync(dbPath);
		expect(() => openAuditLogReader(dbPath)).toThrow(`audit database schema version 0`);
		expect(statSync(dbPath).mtimeMs).toBe(emptyBefore.mtimeMs);

		const legacyPath = join(tempDir, 'legacy.db');
		const legacy = new Database(legacyPath, { create: true });
		legacy.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY, command TEXT NOT NULL)');
		legacy.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
		legacy.close();
		const legacyBefore = statSync(legacyPath);

		expect(() => openAuditLogReader(legacyPath)).toThrow(`open it with AuditLogStore to migrate`);
		expect(version(legacyPath)).toBe(SCHEMA_VERSION - 1);
		expect(statSync(legacyPath).mtimeMs).toBe(legacyBefore.mtimeMs);
	});

	test('refuses newer schemas without lowering their version', () => {
		const database = new Database(dbPath, { create: true });
		database.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
		database.close();

		expect(() => openAuditLogReader(dbPath)).toThrow('newer than this Umbod build supports');
		expect(() => new AuditLogStore(dbPath)).toThrow('newer than this Umbod build supports');
		expect(version(dbPath)).toBe(SCHEMA_VERSION + 1);
	});

	test('refuses a current version stamp with an incomplete schema', () => {
		const writer = new AuditLogStore(dbPath);
		writer.close();
		const database = new Database(dbPath);
		database.exec('DROP TABLE approval_requests');
		database.close();

		expect(() => openAuditLogReader(dbPath)).toThrow('required table "approval_requests" is missing');
	});

	test('falls back to folded scans when the optional FTS index is unavailable', () => {
		const writer = new AuditLogStore(dbPath);
		writer.append(
			{ agent: 'codex', tool: 'bash', command: 'Grímr inspect', timestamp: '2026-07-31T12:00:00.000Z' },
			{ decision: 'allow', classification: 'readonly', reason: 'test' }
		);
		writer.close();
		const database = new Database(dbPath);
		database.exec('DROP TRIGGER audit_log_command_fts_insert');
		database.close();

		const reader = openAuditLogReader(dbPath);
		expect(reader.listRecentPage({ search: 'grimr' }, 1, 20).entries).toHaveLength(1);
		reader.close();

		const repairedWriter = new AuditLogStore(dbPath);
		repairedWriter.close();
		const repairedReader = openAuditLogReader(dbPath);
		expect(repairedReader.listRecentPage({ search: 'GRIMR' }, 1, 20).entries).toHaveLength(1);
		repairedReader.close();
	});

	test('is natively read-only and does not expose mutation methods', () => {
		const writer = new AuditLogStore(dbPath);
		writer.close();
		const reader = openAuditLogReader(dbPath);

		expect('append' in reader).toBe(false);
		const nativeDatabase = (reader as unknown as { database: Database }).database;
		expect(() => nativeDatabase.exec("INSERT INTO audit_log (command) VALUES ('nope')")).toThrow('readonly');
		reader.close();
	});

	test('observes external commits through its connection-local revision', () => {
		const writer = new AuditLogStore(dbPath);
		const reader = openAuditLogReader(dbPath);
		const before = reader.revision();

		appendStatus(writer);

		expect(reader.revision()).not.toBe(before);
		expect(reader.listRecent(1)[0]?.command).toBe('git status');
		reader.close();
		writer.close();
	});

	test('uses a new revision identity after reopening', () => {
		const writer = new AuditLogStore(dbPath);
		const first = openAuditLogReader(dbPath);
		const firstRevision = first.revision();
		first.close();

		appendStatus(writer);
		const second = openAuditLogReader(dbPath);
		expect(second.revision()).not.toBe(firstRevision);
		second.close();
		writer.close();
	});

	test('rejects asynchronous snapshot callbacks', () => {
		const writer = new AuditLogStore(dbPath);
		writer.close();
		const reader = openAuditLogReader(dbPath);

		expect(() => reader.withSnapshot(async () => reader.listRecent())).toThrow(
			'withSnapshot requires a synchronous callback'
		);
		reader.close();
	});

	test('WAL lets a writer commit while a reader holds a stable snapshot', () => {
		const writer = new AuditLogStore(dbPath, { journalMode: 'wal' });
		appendStatus(writer);
		const reader = openAuditLogReader(dbPath);
		const during = reader.withSnapshot(() => {
			const beforeWrite = reader.listRecent().map((entry) => entry.command);
			writer.append(
				{ agent: 'codex', tool: 'bash', command: 'git diff', timestamp: '2026-07-31T12:01:00.000Z' },
				{ decision: 'allow', classification: 'readonly', reason: 'test' }
			);
			const afterWrite = reader.listRecent().map((entry) => entry.command);
			return { beforeWrite, afterWrite };
		});

		expect(during.beforeWrite).toEqual(['git status']);
		expect(during.afterWrite).toEqual(['git status']);
		expect(reader.listRecent().map((entry) => entry.command)).toEqual(['git diff', 'git status']);
		reader.close();
		writer.close();
	});

	test('passes writable connection options through createUmbod', () => {
		const umbod = createUmbod({
			manifest: makeManifest(),
			dbPath,
			auditLogOptions: { journalMode: 'wal', busyTimeoutMs: 2500 },
		});
		const database = new Database(dbPath);
		const journal = database.query('PRAGMA journal_mode').get() as { journal_mode: string };
		const timeout = database.query('PRAGMA busy_timeout').get() as { timeout: number };
		expect(journal.journal_mode).toBe('wal');
		// busy_timeout is connection-local, so the second connection keeps its own default.
		expect(timeout.timeout).toBe(0);
		database.close();
		umbod.close();
	});

	test('owns an idempotently closed connection without affecting a writer', () => {
		const writer = new AuditLogStore(dbPath);
		const reader = openAuditLogReader(dbPath);
		reader.close();
		reader.close();
		expect(() => reader.listRecent()).toThrow();

		appendStatus(writer);
		expect(writer.listRecent()).toHaveLength(1);
		writer.close();
	});

	test('provides a migration-free high-level analytics reader', () => {
		const writer = new AuditLogStore(dbPath);
		appendStatus(writer);
		writer.close();

		const reader = createAnalyticsReader({ dbPath, manifest: makeManifest() });
		const snapshot = reader.snapshot();
		expect(snapshot.tools.totals.entries).toBe(1);
		expect(snapshot.revision).toBe(reader.revision());
		const calls = reader.listCalls({}, { pageSize: 10, projection: 'summary' });
		expect(calls.entries).toHaveLength(1);
		const entry = calls.entries[0];
		if (!entry) throw new Error('expected a stored audit entry');
		const id: number = entry.id;
		expect(reader.getCall(id)?.command).toBe('git status');
		reader.close();
	});
});
