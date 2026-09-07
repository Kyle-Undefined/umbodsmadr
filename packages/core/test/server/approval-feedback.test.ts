import { describe, expect, test } from 'bun:test';
import { createUmbod, type ApprovalResponse, type UmbodOptions } from '../../src/server/api.ts';
import { makeCall, makeManifest } from '../helpers.ts';

const feedback = 'Use "read-only" instead.\n雪 🦉 $HOME $(touch forbidden) `whoami` ; & | < > \' \\';
const call = makeCall({ command: 'git push', sessionId: 'one', toolUseId: 'same' });
function instance(options: Partial<UmbodOptions> = {}) {
	return createUmbod({
		manifest: makeManifest({
			rules: { 'git push': 'approve' },
			policy: { default_unknown: 'block', approval_method: 'cli' },
		}),
		dbPath: ':memory:',
		...options,
	});
}
function deferred() {
	let resolve!: (value: ApprovalResponse | 'allow' | 'block') => void;
	const promise = new Promise<ApprovalResponse | 'allow' | 'block'>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe('approval feedback', () => {
	for (const response of [
		'allow',
		'block',
		'approve',
		{ decision: 'block', userFeedback: feedback },
		{ decision: 'allow', userFeedback: feedback },
	] as const) {
		test(`legacy and structured response: ${JSON.stringify(response)}`, async () => {
			const umbod = instance({ approvalPrompt: async () => response });
			try {
				const result = await umbod.authorize(call);
				expect(result.decision).toBe(
					(typeof response === 'string' ? response : response.decision) === 'allow' ? 'allow' : 'block'
				);
				expect(result.policyDecision).toBe('approve');
				expect(result.userFeedback).toBe(typeof response === 'string' ? undefined : feedback);
				expect(result.entry.reason).not.toContain(feedback);
			} finally {
				umbod.close();
			}
		});
	}

	test('per-call prompt and authoritative policy block', async () => {
		const umbod = instance();
		try {
			expect(
				(await umbod.authorize(call, { approvalPrompt: async () => ({ decision: 'block', userFeedback: feedback }) }))
					.userFeedback
			).toBe(feedback);
			let prompted = false;
			const result = await umbod.authorize(
				{ ...call, command: 'unknown' },
				{
					approvalPrompt: async () => {
						prompted = true;
						return { decision: 'allow', userFeedback: feedback };
					},
				}
			);
			expect(prompted).toBe(false);
			expect(result.decision).toBe('block');
			expect(result.userFeedback).toBeUndefined();
		} finally {
			umbod.close();
		}
	});

	for (const method of ['cli', 'both'] as const) {
		test(`${method}: concurrent identical ids resolved out of order`, async () => {
			const pending = [deferred(), deferred()];
			let next = 0;
			const umbod = instance({
				manifest: makeManifest({
					rules: { 'git push': 'approve' },
					policy: { default_unknown: 'block', approval_method: method },
				}),
				approvalPrompt: () => pending[next++].promise,
			});
			try {
				const first = umbod.authorize(call);
				const second = umbod.authorize({ ...call, sessionId: 'two' });
				pending[1].resolve({ decision: 'block', userFeedback: 'second' });
				expect((await second).userFeedback).toBe('second');
				pending[0].resolve({ decision: 'block', userFeedback: 'first' });
				expect((await first).userFeedback).toBe('first');
			} finally {
				umbod.close();
			}
		});
	}

	test('both: external winner and timeout discard losing or late feedback', async () => {
		const pending = [deferred(), deferred()];
		let next = 0;
		const umbod = instance({
			manifest: makeManifest({
				rules: { 'git push': 'approve' },
				policy: { default_unknown: 'block', approval_method: 'both' },
			}),
			approvalTimeoutMs: 10,
			approvalPrompt: () => pending[next++].promise,
		});
		try {
			const first = umbod.authorize(call);
			umbod.resolveApproval(umbod.listPendingApprovals()[0].id, 'denied');
			pending[0].resolve({ decision: 'allow', userFeedback: 'loser' });
			expect(await first).toMatchObject({ decision: 'block' });
			expect((await first).userFeedback).toBeUndefined();
			const second = await umbod.authorize(call);
			expect(second.decision).toBe('block');
			expect(second.userFeedback).toBeUndefined();
			pending[1].resolve({ decision: 'allow', userFeedback: 'late' });
			await Bun.sleep(0);
			expect(umbod.auditLog.getApprovalStatus(second.entry.approvalRequestId!)).toBe('pending');
		} finally {
			umbod.close();
		}
	});

	test('callback cancellation rejects authorization; hook fails closed', async () => {
		const umbod = instance({
			approvalPrompt: async () => {
				throw new Error('cancelled');
			},
		});
		try {
			await expect(umbod.authorize(call)).rejects.toThrow('cancelled');
			const response = await umbod.fetch(
				new Request('http://localhost/api/hooks?agent=codex', {
					method: 'POST',
					body: JSON.stringify({ tool_name: 'bash', command: 'git push' }),
				})
			);
			expect(response!.status).toBe(400);
		} finally {
			umbod.close();
		}
	});

	test('hook preserves raw feedback, policy reason, and attributed denial independently', async () => {
		const umbod = instance({ approvalPrompt: async () => ({ decision: 'block', userFeedback: feedback }) });
		try {
			const response = await umbod.fetch(
				new Request('http://localhost/api/hooks?agent=codex', {
					method: 'POST',
					body: JSON.stringify({ tool_name: 'bash', command: 'git push' }),
				})
			);
			const body = await response!.json();
			expect(body.permissionDecision).toBe('deny');
			expect(body.userFeedback).toBe(feedback);
			expect(body.policyReason).not.toContain(feedback);
			expect(body.permissionDecisionReason).toBe(`${body.policyReason}\n\nUser feedback:\n${feedback}`);
		} finally {
			umbod.close();
		}
	});
});
