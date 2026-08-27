import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AuditLogStore, openAuditLogReader } from '../../src/db/audit-log.ts';
import type { ApprovalDecision, EvaluationResult, ToolCall } from '../../src/core/types.ts';
import { computeToolUsage } from '../../src/analytics/tool-usage.ts';
import { simulatePolicy } from '../../src/analytics/policy-simulation.ts';
import { makeManifest } from '../helpers.ts';

let tempDir: string;
let dbPath: string;
let store: AuditLogStore;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'umbod-maintenance-test-'));
	dbPath = join(tempDir, 'audit.db');
	store = new AuditLogStore(dbPath, { journalMode: 'wal' });
});

afterEach(() => {
	store.close();
	rmSync(tempDir, { recursive: true, force: true });
});

function append(timestamp: string, decision: ApprovalDecision = 'allow', command = 'git status') {
	const call: ToolCall = {
		agent: 'test',
		tool: 'bash',
		command,
		timestamp,
		workingDirectory: '/tmp/project',
		inputs: { command },
	};
	const result: EvaluationResult = {
		decision,
		classification: decision === 'allow' ? 'readonly' : 'destructive',
		reason: 'fixture',
	};
	return store.append(call, result);
}

describe('audit database maintenance', () => {
	test('reports exact empty database statistics without exposing the absolute path', () => {
		const status = store.databaseStatus({ olderThanDays: 90 }, new Date('2026-08-26T00:00:00.000Z'));
		expect(status.auditRows).toBe(0);
		expect(status.oldestAuditTimestamp).toBeNull();
		expect(status.approvals).toEqual({ pending: 0, approved: 0, denied: 0 });
		expect(status.eligibleAuditRows).toBe(0);
		expect(status.journalMode).toBe('wal');
		expect(status.databasePath).not.toContain(tempDir);
		expect(status.files.mainBytes).toBeGreaterThan(0);
		expect(status.estimatedReusableBytes).toBe(status.pageSizeBytes * status.freeListPages);
	});

	test('preview is read-only, uses a strict cutoff boundary, and always retains pending approvals', () => {
		const now = new Date('2026-08-26T00:00:00.000Z');
		append('2026-05-27T23:59:59.999Z');
		append('2026-05-28T00:00:00.000Z');
		const approved = append('2026-05-01T00:00:00.000Z', 'approve');
		store.resolveApprovalRequest(approved.approvalRequestId as number, 'approved', '2026-05-01T00:01:00.000Z');
		append('2026-04-01T00:00:00.000Z', 'approve');
		const before = store.databaseStatus();
		const beforeMtime = statSync(dbPath).mtimeMs;
		const preview = store.previewCleanup({ olderThanDays: 90 }, now);
		const after = store.databaseStatus();

		expect(preview.cutoff).toBe('2026-05-28T00:00:00.000Z');
		expect(preview.eligibleAuditRows).toBe(2);
		expect(preview.retainedAuditRows).toBe(2);
		expect(preview.approvalRowsAffected).toEqual({ pending: 0, approved: 1, denied: 0 });
		expect(preview.pendingApprovalRowsPreserved).toBe(1);
		expect(preview.readOnly).toBe(true);
		expect(preview.estimated).toBe(false);
		expect(after.maintenanceRevision).toBe(before.maintenanceRevision);
		expect(after.auditRows).toBe(before.auditRows);
		expect(statSync(dbPath).mtimeMs).toBe(beforeMtime);
	});

	test('cleanup cascades resolved approvals, preserves pending rows, and keeps FTS consistent', () => {
		const old = append('2026-01-01T00:00:00.000Z', 'approve', 'obsolete searchable command');
		store.resolveApprovalRequest(old.approvalRequestId as number, 'denied');
		const pending = append('2026-01-02T00:00:00.000Z', 'approve', 'pending searchable command');
		append('2026-08-20T00:00:00.000Z', 'allow', 'recent searchable command');
		const preview = store.previewCleanup({ olderThanDays: 90 }, new Date('2026-08-26T00:00:00.000Z'));
		const result = store.executeCleanup({ previewReceipt: preview.previewReceipt, execute: true });

		expect(result.deletedAuditRows).toBe(1);
		expect(result.deletedApprovalRows.denied).toBe(1);
		expect(result.preservedPendingApprovals).toBe(1);
		expect(result.compactionPerformed).toBe(false);
		expect(store.getApprovalStatus(pending.approvalRequestId as number)).toBe('pending');
		expect(store.listRecentFiltered({ search: 'obsolete searchable' })).toHaveLength(0);
		expect(store.listRecentFiltered({ search: 'pending searchable' })).toHaveLength(1);

		const native = new Database(dbPath, { readonly: true });
		try {
			expect(
				native
					.query('SELECT COUNT(*) AS count FROM approval_requests WHERE id = ?')
					.get(old.approvalRequestId as number) as {
					count: number;
				}
			).toEqual({ count: 0 });
			expect(native.query('PRAGMA foreign_key_check').all()).toHaveLength(0);
		} finally {
			native.close();
		}
	});

	test('rejects stale receipts after insertion or approval resolution', () => {
		append('2026-01-01T00:00:00.000Z');
		const preview = store.previewCleanup({ olderThanDays: 90 }, new Date('2026-08-26T00:00:00.000Z'));
		expect(() =>
			store.executeCleanup({ previewReceipt: preview.previewReceipt, olderThanDays: 30, execute: true })
		).toThrow('does not match');
		append('2026-08-25T00:00:00.000Z');
		expect(() => store.executeCleanup({ previewReceipt: preview.previewReceipt, execute: true })).toThrow('stale');

		const pending = append('2026-01-02T00:00:00.000Z', 'approve');
		const second = store.previewCleanup({ olderThanDays: 90 }, new Date('2026-08-26T00:00:00.000Z'));
		store.resolveApprovalRequest(pending.approvalRequestId as number, 'approved');
		expect(() => store.executeCleanup({ previewReceipt: second.previewReceipt, execute: true })).toThrow('stale');
	});

	test('analytics and policy simulation continue against retained rows after cleanup', () => {
		append('2026-01-01T00:00:00.000Z', 'allow', 'old command');
		append('2026-08-20T00:00:00.000Z', 'allow', 'git status');
		const preview = store.previewCleanup({ olderThanDays: 90 }, new Date('2026-08-26T00:00:00.000Z'));
		store.executeCleanup({ previewReceipt: preview.previewReceipt, execute: true });
		const manifest = makeManifest({ rules: { 'git status': 'allow' } });
		expect(computeToolUsage(store, manifest).totals.entries).toBe(1);
		const simulation = simulatePolicy(manifest, manifest, store, { all: true });
		expect(simulation.dataset).toMatchObject({ eligible: 1, evaluated: 1, truncated: false });
	});

	test('rolls back deletion and provenance when a SQLite delete trigger fails', () => {
		append('2026-01-01T00:00:00.000Z');
		const preview = store.previewCleanup({ olderThanDays: 90 }, new Date('2026-08-26T00:00:00.000Z'));
		const native = new Database(dbPath, { readwrite: true });
		native.exec(
			`CREATE TRIGGER maintenance_failure BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`
		);
		native.close();

		expect(() => store.executeCleanup({ previewReceipt: preview.previewReceipt, execute: true })).toThrow(
			'fixture failure'
		);
		expect(store.countFiltered()).toBe(1);
		const verifier = new Database(dbPath, { readonly: true });
		try {
			expect(verifier.query('SELECT COUNT(*) AS count FROM audit_maintenance_history').get()).toEqual({ count: 0 });
		} finally {
			verifier.close();
		}
	});

	test('validates retention bounds and pending preservation', () => {
		for (const value of [0, -1, 1.5, 36_501, Number.NaN]) {
			expect(() => store.previewCleanup({ olderThanDays: value })).toThrow('olderThanDays');
		}
		expect(() => store.previewCleanup({ olderThanDays: 90, preservePendingApprovals: false as true })).toThrow(
			'preservePendingApprovals must be true'
		);
	});

	test('compaction checkpoints WAL and reports exact before and after sizes', () => {
		for (let index = 0; index < 100; index += 1) append('2026-01-01T00:00:00.000Z', 'allow', `old ${index}`);
		const preview = store.previewCleanup({ olderThanDays: 90 }, new Date('2026-08-26T00:00:00.000Z'));
		store.executeCleanup({ previewReceipt: preview.previewReceipt, execute: true });
		const result = store.compactDatabase({ execute: true });
		expect(result.journalMode).toBe('wal');
		expect(result.checkpoint.busy).toBe(0);
		expect(result.filesBefore.mainBytes).toBeGreaterThan(0);
		expect(result.filesAfter.mainBytes).toBe(fileSize(dbPath));
		expect(result.requiredBytes).toBeGreaterThan(0);
		expect(result.maintenanceRevision).toBeGreaterThan(preview.maintenanceRevision);
	});

	test('compaction refuses an active WAL reader and leaves the database usable', () => {
		store.close();
		store = new AuditLogStore(dbPath, { journalMode: 'wal', busyTimeoutMs: 50 });
		append('2026-08-20T00:00:00.000Z');
		const reader = openAuditLogReader(dbPath);
		try {
			reader.withSnapshot(() => {
				reader.listRecent();
				append('2026-08-21T00:00:00.000Z');
				expect(() => store.compactDatabase({ execute: true })).toThrow('active readers or writers');
			});
		} finally {
			reader.close();
		}
		expect(store.countFiltered()).toBe(2);
		expect(store.databaseStatus().maintenanceState).toBe('idle');
	});
});

function fileSize(path: string): number {
	return statSync(path).size;
}
