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
				inputs: { key: 'value' },
			}),
			makeResult({
				decision: 'block',
				classification: 'destructive',
				matchedRule: 'rm *',
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
		expect(entry.inputs).toEqual({ key: 'value' });
		expect(entry.decision).toBe('block');
		expect(entry.classification).toBe('destructive');
		expect(entry.matchedRule).toBe('rm *');
		expect(entry.reason).toBe('matched rule "rm *"');
	});
});

// ── listRecent ───────────────────────────────────────────────

describe('audit log > listRecent', () => {
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
