import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AuditLogStore } from '../../src/db/audit-log.ts';
import { SCHEMA_VERSION } from '../../src/db/schema.ts';

const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  args_json TEXT,
  working_directory TEXT,
  inputs_json TEXT,
  timestamp TEXT NOT NULL,
  decision TEXT NOT NULL,
  classification TEXT NOT NULL,
  matched_rule TEXT,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_log_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY(audit_log_id) REFERENCES audit_log(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);
`;

let tempDir: string;
let dbPath: string;

function seedLegacyDatabase(): void {
	const db = new Database(dbPath, { create: true });
	db.exec(LEGACY_SCHEMA);
	db.query(
		`INSERT INTO audit_log (
      agent, tool, command, args_json, working_directory, inputs_json, timestamp,
      decision, classification, matched_rule, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		'codex',
		'bash',
		'git status',
		'[]',
		'/tmp/project',
		JSON.stringify({ session_id: 'sess-legacy-1', tool_use_id: 'call_abc123', tool_name: 'exec_command' }),
		'2026-01-01T00:00:00.000Z',
		'allow',
		'readonly',
		null,
		'auto-allowed readonly tool call'
	);
	db.query(
		`INSERT INTO audit_log (
      agent, tool, command, args_json, working_directory, inputs_json, timestamp,
      decision, classification, matched_rule, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		'claude',
		'bash',
		'ls',
		'[]',
		null,
		JSON.stringify({ no_session: true }),
		'2026-01-01T00:00:01.000Z',
		'allow',
		'readonly',
		null,
		'auto-allowed readonly tool call'
	);
	db.close();
}

function tableColumns(path: string): Set<string> {
	const db = new Database(path);
	const columns = new Set(
		(db.query('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>).map((row) => row.name)
	);
	db.close();
	return columns;
}

function userVersion(path: string): number {
	const db = new Database(path);
	const { user_version } = db.query('PRAGMA user_version').get() as { user_version: number };
	db.close();
	return user_version;
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'umbod-migration-test-'));
	dbPath = join(tempDir, 'test.db');
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe('audit log > migration', () => {
	test('fresh database gets latest schema and version stamp', () => {
		const store = new AuditLogStore(dbPath);
		store.close();

		const columns = tableColumns(dbPath);
		expect(columns.has('session_id')).toBe(true);
		expect(columns.has('tool_use_id')).toBe(true);
		expect(userVersion(dbPath)).toBe(SCHEMA_VERSION);
	});

	test('legacy database gains columns and backfills from inputs_json', () => {
		seedLegacyDatabase();

		const store = new AuditLogStore(dbPath);
		const entries = store.listRecent();
		store.close();

		expect(userVersion(dbPath)).toBe(SCHEMA_VERSION);
		const legacy = entries.find((entry) => entry.command === 'git status');
		expect(legacy?.sessionId).toBe('sess-legacy-1');
		expect(legacy?.toolUseId).toBe('call_abc123');

		const withoutSession = entries.find((entry) => entry.command === 'ls');
		expect(withoutSession?.sessionId).toBeUndefined();
		expect(withoutSession?.toolUseId).toBeUndefined();
	});

	test('reopening a migrated database is idempotent', () => {
		seedLegacyDatabase();

		const first = new AuditLogStore(dbPath);
		first.close();
		const second = new AuditLogStore(dbPath);
		const entries = second.listRecent();
		second.close();

		expect(userVersion(dbPath)).toBe(SCHEMA_VERSION);
		expect(entries).toHaveLength(2);
	});

	test('append stores sessionId and toolUseId columns', () => {
		const store = new AuditLogStore(dbPath);
		store.append(
			{
				agent: 'claude',
				tool: 'bash',
				command: 'git status',
				timestamp: new Date().toISOString(),
				sessionId: 'sess-new-1',
				toolUseId: 'toolu_xyz',
			},
			{ decision: 'allow', classification: 'readonly', reason: 'auto-allowed readonly tool call' }
		);
		const [entry] = store.listRecent(1);
		store.close();

		expect(entry?.sessionId).toBe('sess-new-1');
		expect(entry?.toolUseId).toBe('toolu_xyz');
	});
});
