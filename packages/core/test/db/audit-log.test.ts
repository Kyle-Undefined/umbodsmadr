import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { AuditLogStore } from '../../src/db/audit-log.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EvaluationResult, ToolCall } from '../../src/core/types.ts';

let tempDir: string;
let store: AuditLogStore;

function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
	return {
		agent: 'test',
		tool: 'bash',
		command: 'git status',
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

function makeResult(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
	return {
		decision: 'allow',
		classification: 'readonly',
		reason: 'auto-allowed readonly tool call',
		...overrides,
	};
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'umbod-test-'));
	store = new AuditLogStore(join(tempDir, 'test.db'));
});

afterEach(() => {
	store.close();
	rmSync(tempDir, { recursive: true, force: true });
});

// ── Append and retrieve ──────────────────────────────────────

describe('audit log > append', () => {
	test('appends entry and returns id', () => {
		const { entryId } = store.append(makeCall(), makeResult());
		expect(entryId).toBeGreaterThan(0);
	});

	test('creates approval request when decision is approve', () => {
		const { entryId, approvalRequestId } = store.append(
			makeCall(),
			makeResult({ decision: 'approve', reason: 'matched rule' })
		);
		expect(entryId).toBeGreaterThan(0);
		expect(approvalRequestId).toBeGreaterThan(0);
	});

	test('no approval request for allow decision', () => {
		const { approvalRequestId } = store.append(makeCall(), makeResult({ decision: 'allow' }));
		expect(approvalRequestId).toBeUndefined();
	});

	test('no approval request for block decision', () => {
		const { approvalRequestId } = store.append(makeCall(), makeResult({ decision: 'block' }));
		expect(approvalRequestId).toBeUndefined();
	});

	test('stores all fields', () => {
		store.append(
			makeCall({
				agent: 'claude',
				tool: 'bash',
				command: 'rm -rf /tmp',
				args: ['--verbose'],
				workingDirectory: '/home/user',
				workspaceId: 'client',
				inputs: { key: 'value' },
			}),
			makeResult({
				decision: 'block',
				classification: 'destructive',
				matchedRule: 'rm *',
				policyScope: 'workspace',
				resolvedWorkspaceId: 'client',
				reason: 'matched rule "rm *"',
			})
		);

		const entries = store.listRecent(1);
		expect(entries).toHaveLength(1);
		const entry = entries[0];
		expect(entry.agent).toBe('claude');
		expect(entry.tool).toBe('bash');
		expect(entry.command).toBe('rm -rf /tmp');
		expect(entry.args).toEqual(['--verbose']);
		expect(entry.workingDirectory).toBe('/home/user');
		expect(entry.workspaceId).toBe('client');
		expect(entry.inputs).toEqual({ key: 'value' });
		expect(entry.decision).toBe('block');
		expect(entry.classification).toBe('destructive');
		expect(entry.matchedRule).toBe('rm *');
		expect(entry.policyScope).toBe('workspace');
		expect(entry.resolvedWorkspaceId).toBe('client');
		expect(entry.reason).toBe('matched rule "rm *"');
	});
});

// ── listRecent ───────────────────────────────────────────────

describe('audit log > listRecent', () => {
	test('filters persisted calls by canonical operation', () => {
		store.append(makeCall({ tool: 'read', operation: 'filesystem.read', command: '/work/a' }), makeResult());
		store.append(makeCall({ tool: 'write', operation: 'filesystem.write', command: '/work/b' }), makeResult());
		expect(store.listRecentFiltered({ operation: 'filesystem.read' })).toEqual([
			expect.objectContaining({ operation: 'filesystem.read', command: '/work/a' }),
		]);
	});

	test('returns empty for fresh database', () => {
		expect(store.listRecent()).toEqual([]);
	});

	test('returns entries in reverse order (newest first)', () => {
		store.append(makeCall({ command: 'first' }), makeResult());
		store.append(makeCall({ command: 'second' }), makeResult());
		store.append(makeCall({ command: 'third' }), makeResult());

		const entries = store.listRecent();
		expect(entries[0].command).toBe('third');
		expect(entries[1].command).toBe('second');
		expect(entries[2].command).toBe('first');
	});

	test('respects limit', () => {
		for (let i = 0; i < 10; i++) {
			store.append(makeCall({ command: `cmd-${i}` }), makeResult());
		}

		expect(store.listRecent(3)).toHaveLength(3);
	});

	test('includes approval status when present', () => {
		store.append(makeCall(), makeResult({ decision: 'approve', reason: 'needs approval' }));

		const entries = store.listRecent();
		expect(entries[0].approvalStatus).toBe('pending');
	});

	test('approval status undefined for non-approval entries', () => {
		store.append(makeCall(), makeResult({ decision: 'allow' }));

		const entries = store.listRecent();
		expect(entries[0].approvalStatus).toBeUndefined();
	});
});

// ── Approval workflow ────────────────────────────────────────

describe('audit log > approval workflow', () => {
	test('pending approval appears in listPendingApprovals', () => {
		const { approvalRequestId } = store.append(
			makeCall({ command: 'rm -rf /tmp' }),
			makeResult({ decision: 'approve' })
		);

		const pending = store.listPendingApprovals();
		expect(pending).toHaveLength(1);
		expect(pending[0].id).toBe(approvalRequestId!);
		expect(pending[0].status).toBe('pending');
		expect(pending[0].entry.command).toBe('rm -rf /tmp');
	});

	test('getApprovalStatus returns pending', () => {
		const { approvalRequestId } = store.append(makeCall(), makeResult({ decision: 'approve' }));

		expect(store.getApprovalStatus(approvalRequestId!)).toBe('pending');
	});

	test('resolveApprovalRequest approves', () => {
		const { approvalRequestId } = store.append(makeCall(), makeResult({ decision: 'approve' }));

		const resolved = store.resolveApprovalRequest(approvalRequestId!, 'approved');
		expect(resolved).toBe(true);
		expect(store.getApprovalStatus(approvalRequestId!)).toBe('approved');
	});

	test('resolveApprovalRequest denies', () => {
		const { approvalRequestId } = store.append(makeCall(), makeResult({ decision: 'approve' }));

		const resolved = store.resolveApprovalRequest(approvalRequestId!, 'denied');
		expect(resolved).toBe(true);
		expect(store.getApprovalStatus(approvalRequestId!)).toBe('denied');
	});

	test('double resolve returns false', () => {
		const { approvalRequestId } = store.append(makeCall(), makeResult({ decision: 'approve' }));

		store.resolveApprovalRequest(approvalRequestId!, 'approved');
		const secondResolve = store.resolveApprovalRequest(approvalRequestId!, 'denied');
		expect(secondResolve).toBe(false);
		// Still approved from first resolve
		expect(store.getApprovalStatus(approvalRequestId!)).toBe('approved');
	});

	test('resolved approval disappears from pending list', () => {
		const { approvalRequestId } = store.append(makeCall(), makeResult({ decision: 'approve' }));

		expect(store.listPendingApprovals()).toHaveLength(1);
		store.resolveApprovalRequest(approvalRequestId!, 'approved');
		expect(store.listPendingApprovals()).toHaveLength(0);
	});

	test('getApprovalStatus returns undefined for nonexistent id', () => {
		expect(store.getApprovalStatus(99999)).toBeUndefined();
	});

	test('resolveApprovalRequest returns false for nonexistent id', () => {
		expect(store.resolveApprovalRequest(99999, 'approved')).toBe(false);
	});
});

// ── Multiple approvals ───────────────────────────────────────

describe('audit log > multiple approvals', () => {
	test('multiple pending approvals listed', () => {
		store.append(makeCall({ command: 'cmd1' }), makeResult({ decision: 'approve' }));
		store.append(makeCall({ command: 'cmd2' }), makeResult({ decision: 'approve' }));
		store.append(makeCall({ command: 'cmd3' }), makeResult({ decision: 'approve' }));

		expect(store.listPendingApprovals()).toHaveLength(3);
	});

	test("resolving one doesn't affect others", () => {
		const { approvalRequestId: id1 } = store.append(makeCall({ command: 'cmd1' }), makeResult({ decision: 'approve' }));
		store.append(makeCall({ command: 'cmd2' }), makeResult({ decision: 'approve' }));

		store.resolveApprovalRequest(id1!, 'approved');
		expect(store.listPendingApprovals()).toHaveLength(1);
		expect(store.listPendingApprovals()[0].entry.command).toBe('cmd2');
	});

	test('pending approvals respect limit', () => {
		for (let i = 0; i < 10; i++) {
			store.append(makeCall({ command: `cmd-${i}` }), makeResult({ decision: 'approve' }));
		}

		expect(store.listPendingApprovals(3)).toHaveLength(3);
	});
});

describe('audit log > folded search', () => {
	test('matches case, accents, combining marks, and non-decomposing Latin letters', () => {
		for (const command of ['Grímr inspect', 'Cafe\u0301 status', 'smørrebrød make', 'Straße check', 'Ægir run']) {
			store.append(makeCall({ command }), makeResult());
		}

		expect(store.listRecentPage({ search: 'grimr' }, 1, 20).entries.map((entry) => entry.command)).toEqual([
			'Grímr inspect',
		]);
		expect(store.listRecentPage({ search: 'CAFÉ' }, 1, 20).entries.map((entry) => entry.command)).toEqual([
			'Cafe\u0301 status',
		]);
		expect(store.listRecentPage({ search: 'smorrebrod' }, 1, 20).entries.map((entry) => entry.command)).toEqual([
			'smørrebrød make',
		]);
		expect(store.listRecentPage({ search: 'strasse' }, 1, 20).entries.map((entry) => entry.command)).toEqual([
			'Straße check',
		]);
		expect(store.listRecentPage({ search: 'aegir' }, 1, 20).entries.map((entry) => entry.command)).toEqual([
			'Ægir run',
		]);
	});

	test('treats percent, underscore, quotes, and short searches literally', () => {
		store.append(makeCall({ command: 'printf 100%_done' }), makeResult());
		store.append(makeCall({ command: 'printf 100xxdone' }), makeResult());
		store.append(makeCall({ command: 'say "hello"' }), makeResult());

		expect(store.listRecentPage({ search: '%_' }, 1, 20).entries.map((entry) => entry.command)).toEqual([
			'printf 100%_done',
		]);
		expect(store.listRecentPage({ search: '"hello"' }, 1, 20).entries.map((entry) => entry.command)).toEqual([
			'say "hello"',
		]);
	});
});

describe('audit log > cursor calls', () => {
	test('pages by descending id without duplicates when newer calls arrive', () => {
		for (let index = 1; index <= 6; index += 1) {
			store.append(makeCall({ command: `command-${index}` }), makeResult());
		}

		const first = store.listRecentCursor({}, { pageSize: 2, projection: 'summary', includeTotal: false });
		expect(first.entries.map((entry) => entry.command)).toEqual(['command-6', 'command-5']);
		expect(first).toMatchObject({ pageSize: 2, hasMore: true });
		expect(first.nextCursor).toBe(String(first.entries[1]?.id));
		expect(first.total).toBeUndefined();
		expect(first.totalPages).toBeUndefined();
		expect('args' in (first.entries[0] ?? {})).toBe(false);
		expect('inputs' in (first.entries[0] ?? {})).toBe(false);
		expect('reason' in (first.entries[0] ?? {})).toBe(false);

		store.append(makeCall({ command: 'concurrent-newer' }), makeResult());
		const second = store.listRecentCursor({}, { cursor: Number(first.nextCursor), pageSize: 3, projection: 'summary' });
		expect(second.entries.map((entry) => entry.command)).toEqual(['command-4', 'command-3', 'command-2']);
		expect(second.nextCursor).toBe(String(second.entries[2]?.id));

		const final = store.listRecentCursor(
			{},
			{ cursor: Number(second.nextCursor), pageSize: 3, projection: 'summary', includeTotal: true }
		);
		expect(final.entries.map((entry) => entry.command)).toEqual(['command-1']);
		expect(final).toMatchObject({ hasMore: false, nextCursor: null, total: 7, totalPages: 3 });
	});

	test('loads full detail separately', () => {
		const { entryId } = store.append(
			makeCall({ command: 'git status', args: ['--short'], inputs: { source: 'test' } }),
			makeResult({ reason: 'detail reason' })
		);

		expect(store.getEntry(entryId)).toMatchObject({
			id: entryId,
			command: 'git status',
			args: ['--short'],
			inputs: { source: 'test' },
			reason: 'detail reason',
		});
		expect(store.getEntry(entryId + 1)).toBeUndefined();
	});

	test('pages analytics batches by id without duplicates', () => {
		for (let index = 1; index <= 5; index += 1) {
			store.append(makeCall({ command: `batch-${index}` }), makeResult());
		}
		const first = store.listRecentBatch({}, undefined, 2);
		const second = store.listRecentBatch({}, first.nextCursor, 2);
		const final = store.listRecentBatch({}, second.nextCursor, 2);

		expect(first.entries.map((entry) => entry.command)).toEqual(['batch-5', 'batch-4']);
		expect(second.entries.map((entry) => entry.command)).toEqual(['batch-3', 'batch-2']);
		expect(final.entries.map((entry) => entry.command)).toEqual(['batch-1']);
		expect(final.nextCursor).toBeUndefined();
	});
});
