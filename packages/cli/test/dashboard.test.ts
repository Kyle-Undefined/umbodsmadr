import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

import { dashboardJs } from '../src/server/ui-assets.ts';

type JsonRecord = Record<string, unknown>;
type SocketListener = (event: { data?: string }) => void;
type FetchResponse = {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
};
type FetchHandler = (url: string, options?: { method?: string }) => Promise<FetchResponse>;

interface DashboardStore {
	entries: JsonRecord[];
	approvals: JsonRecord[];
	activityRevision: number;
	insightWorkspace: string;
	insights: { tools: JsonRecord; rules: JsonRecord };
	coverage: JsonRecord | null;
	coverageError: string;
	coverageLoading: boolean;
	refreshApprovals(): Promise<void>;
	refreshActivity(): Promise<void>;
	loadCoverage(): Promise<void>;
	loadInsights(): Promise<void>;
	receiveActivity(entry: JsonRecord): void;
	resolveApproval(id: number, action: string): Promise<void>;
}

function dashboardHarness(options: {
	search?: string;
	entries?: JsonRecord[];
	approvals?: JsonRecord[];
	manifest?: JsonRecord;
	fetch: FetchHandler;
}): {
	store: DashboardStore;
	socket: {
		count(): number;
		open(index?: number): void;
		close(index?: number): void;
		emit(entry: JsonRecord, index?: number): void;
	};
	fetchCalls: string[];
} {
	const initListeners: Array<() => void> = [];
	const sockets: FakeWebSocket[] = [];
	const fetchCalls: string[] = [];
	let store: DashboardStore | undefined;

	class FakeWebSocket {
		readonly listeners = new Map<string, SocketListener[]>();

		constructor(_url: string) {
			sockets.push(this);
		}

		addEventListener(name: string, listener: SocketListener): void {
			const listeners = this.listeners.get(name) ?? [];
			listeners.push(listener);
			this.listeners.set(name, listeners);
		}

		emit(name: string, event: { data?: string } = {}): void {
			for (const listener of this.listeners.get(name) ?? []) listener(event);
		}
	}

	const bootstrap = JSON.stringify({
		entries: options.entries ?? [],
		approvals: options.approvals ?? [],
		manifest: options.manifest ?? {},
	});
	const context = {
		document: {
			getElementById(id: string) {
				return id === 'umbod-bootstrap' ? { textContent: bootstrap } : null;
			},
			addEventListener(name: string, listener: () => void) {
				if (name === 'alpine:init') initListeners.push(listener);
			},
		},
		window: { WebSocket: FakeWebSocket },
		Alpine: {
			store(_name: string, value?: DashboardStore) {
				if (value !== undefined) store = value;
				return store;
			},
		},
		location: { protocol: 'http:', host: 'localhost:9090', search: options.search ?? '' },
		URLSearchParams,
		WebSocket: FakeWebSocket,
		fetch(url: string, fetchOptions?: { method?: string }) {
			fetchCalls.push(url);
			return options.fetch(url, fetchOptions);
		},
		setTimeout(callback: () => void) {
			callback();
			return 1;
		},
		clearTimeout() {},
		console: { error() {} },
		Date,
		JSON,
		Object,
		Array,
		Set,
		Number,
		Intl,
		isNaN,
	};

	runInNewContext(dashboardJs, context);
	for (const listener of initListeners) listener();
	if (store === undefined) throw new Error('dashboard store was not initialized');

	return {
		store,
		socket: {
			count() {
				return sockets.length;
			},
			open(index = sockets.length - 1) {
				sockets[index]?.emit('open');
			},
			close(index = sockets.length - 1) {
				sockets[index]?.emit('close');
			},
			emit(entry, index = sockets.length - 1) {
				sockets[index]?.emit('message', { data: JSON.stringify(entry) });
			},
		},
		fetchCalls,
	};
}

function jsonResponse(value: unknown): FetchResponse {
	return {
		ok: true,
		status: 200,
		async json() {
			return value;
		},
	};
}

async function settlePromises(): Promise<void> {
	for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

describe('dashboard activity updates', () => {
	test('prepends pushed entries within the selected limit without refetching activity', async () => {
		const harness = dashboardHarness({
			search: '?limit=2',
			entries: [
				{ id: 2, decision: 'allow' },
				{ id: 1, decision: 'allow' },
			],
			fetch: async () => jsonResponse([]),
		});

		harness.socket.emit({ id: 3, decision: 'block', command: 'curl example.com' });
		await Promise.resolve();

		expect(harness.store.entries.map((entry) => entry.id)).toEqual([3, 2]);
		expect(harness.fetchCalls).toEqual(['/api/approvals']);
	});

	test('uses the bounded default for a malformed activity limit', async () => {
		const harness = dashboardHarness({
			search: '?limit=3x',
			fetch: async () => jsonResponse([]),
		});

		harness.socket.open();
		await settlePromises();

		expect(harness.fetchCalls[0]).toBe('/api/activity?limit=200');
	});

	test('backfills bounded activity on every socket open and reconnects after close', async () => {
		let activityFetch = 0;
		const harness = dashboardHarness({
			search: '?limit=2',
			entries: [{ id: 1, decision: 'allow' }],
			fetch: async (url) => {
				if (url.startsWith('/api/activity')) {
					activityFetch += 1;
					return jsonResponse(
						activityFetch === 1
							? [
									{ id: 3, decision: 'allow' },
									{ id: 2, decision: 'allow' },
								]
							: [
									{ id: 4, decision: 'block' },
									{ id: 3, decision: 'allow' },
								]
					);
				}
				return jsonResponse([]);
			},
		});

		harness.socket.open();
		await settlePromises();
		expect(harness.store.entries.map((entry) => entry.id)).toEqual([3, 2]);

		harness.socket.close();
		expect(harness.socket.count()).toBe(2);
		harness.socket.open();
		await settlePromises();

		expect(harness.store.entries.map((entry) => entry.id)).toEqual([4, 3]);
		expect(harness.fetchCalls).toEqual([
			'/api/activity?limit=2',
			'/api/approvals',
			'/api/activity?limit=2',
			'/api/approvals',
		]);
	});

	test('keeps streamed activity that arrives while a reconnect backfill is pending', async () => {
		let resolveActivity: ((response: FetchResponse) => void) | undefined;
		const activityResponse = new Promise<FetchResponse>((resolve) => {
			resolveActivity = resolve;
		});
		const harness = dashboardHarness({
			search: '?limit=2',
			entries: [{ id: 2, decision: 'allow' }],
			fetch: async (url) => {
				if (url.startsWith('/api/activity')) return activityResponse;
				return jsonResponse([]);
			},
		});

		harness.socket.open();
		harness.socket.emit({ id: 4, decision: 'block', reason: 'streamed' });
		resolveActivity?.(
			jsonResponse([
				{ id: 4, decision: 'allow', reason: 'stale snapshot' },
				{ id: 3, decision: 'allow' },
			])
		);
		await settlePromises();

		expect(harness.store.entries.map((entry) => entry.id)).toEqual([4, 3]);
		expect(harness.store.entries[0]?.reason).toBe('streamed');
		expect(harness.fetchCalls.filter((url) => url.startsWith('/api/activity'))).toEqual(['/api/activity?limit=2']);
	});

	test('updates the matching activity status after resolving an approval', async () => {
		const resolvedAt = '2026-07-30T12:00:00.000Z';
		const harness = dashboardHarness({
			entries: [{ id: 12, decision: 'approve', approvalStatus: 'pending' }],
			approvals: [{ id: 7, auditLogId: 12 }],
			fetch: async (url) => jsonResponse(url === '/api/approvals' ? [] : { status: 'approved', resolvedAt }),
		});

		await harness.store.resolveApproval(7, 'approve');

		expect(harness.store.entries[0].approvalStatus).toBe('approved');
		expect(harness.store.entries[0].approvalResolvedAt).toBe(resolvedAt);
		expect(harness.store.approvals).toEqual([]);
		expect(harness.fetchCalls).toEqual(['/api/approvals/7/approve', '/api/approvals']);
	});

	test('ignores an older approval refresh that finishes after a resolved result', async () => {
		let approvalFetch = 0;
		let resolveOlderApprovals: ((response: FetchResponse) => void) | undefined;
		const olderApprovals = new Promise<FetchResponse>((resolve) => {
			resolveOlderApprovals = resolve;
		});
		const harness = dashboardHarness({
			entries: [{ id: 12, decision: 'approve', approvalStatus: 'pending' }],
			approvals: [{ id: 7, auditLogId: 12 }],
			fetch: async (url) => {
				if (url.startsWith('/api/activity')) return jsonResponse([]);
				if (url === '/api/approvals/7/approve') return jsonResponse({ status: 'approved' });
				approvalFetch += 1;
				return approvalFetch === 1 ? olderApprovals : jsonResponse([]);
			},
		});

		harness.socket.open();
		await harness.store.resolveApproval(7, 'approve');
		expect(harness.store.approvals).toEqual([]);

		resolveOlderApprovals?.(jsonResponse([{ id: 7, auditLogId: 12 }]));
		await settlePromises();

		expect(harness.store.approvals).toEqual([]);
		expect(harness.store.entries[0]?.approvalStatus).toBe('approved');
	});

	test('keeps a local approval result when an older activity backfill finishes later', async () => {
		let resolveActivity: ((response: FetchResponse) => void) | undefined;
		const activityResponse = new Promise<FetchResponse>((resolve) => {
			resolveActivity = resolve;
		});
		const harness = dashboardHarness({
			entries: [{ id: 12, decision: 'approve', approvalStatus: 'pending' }],
			approvals: [{ id: 7, auditLogId: 12 }],
			fetch: async (url) => {
				if (url.startsWith('/api/activity')) return activityResponse;
				if (url === '/api/approvals/7/approve') return jsonResponse({ status: 'approved' });
				return jsonResponse([]);
			},
		});

		harness.socket.open();
		await harness.store.resolveApproval(7, 'approve');
		expect(harness.store.entries[0]?.approvalStatus).toBe('approved');
		expect(harness.store.activityRevision).toBe(1);
		resolveActivity?.(jsonResponse([{ id: 12, decision: 'approve', approvalStatus: 'pending' }]));
		await settlePromises();

		expect(harness.store.entries[0]?.approvalStatus).toBe('approved');
	});

	test('scopes insight and coverage requests to the selected workspace', async () => {
		const harness = dashboardHarness({
			manifest: { workspaces: [{ id: 'client' }] },
			fetch: async (url) => {
				if (url.startsWith('/api/analytics/tools')) {
					return jsonResponse({ totals: { entries: 0 }, byTool: [] });
				}
				if (url.startsWith('/api/analytics/rules')) {
					return jsonResponse({ rules: [], suggestions: [], tomlSnippet: '' });
				}
				return jsonResponse({ coverageRatio: 1, totals: { gaps: 0 } });
			},
		});
		harness.store.insightWorkspace = 'client';

		await harness.store.loadInsights();
		await harness.store.loadCoverage();

		expect(harness.fetchCalls).toEqual([
			'/api/analytics/tools?workspace=client',
			'/api/analytics/rules?workspace=client',
			'/api/analytics/coverage?workspace=client',
		]);
	});

	test('keeps newer workspace insights when older requests finish last', async () => {
		let resolveOlderTools: ((response: FetchResponse) => void) | undefined;
		let resolveOlderRules: ((response: FetchResponse) => void) | undefined;
		const olderTools = new Promise<FetchResponse>((resolve) => {
			resolveOlderTools = resolve;
		});
		const olderRules = new Promise<FetchResponse>((resolve) => {
			resolveOlderRules = resolve;
		});
		const harness = dashboardHarness({
			fetch: async (url) => {
				if (url === '/api/analytics/tools?workspace=older') return olderTools;
				if (url === '/api/analytics/rules?workspace=older') return olderRules;
				if (url.startsWith('/api/analytics/tools')) return jsonResponse({ workspace: 'newer' });
				return jsonResponse({ workspace: 'newer' });
			},
		});

		harness.store.insightWorkspace = 'older';
		const olderRequest = harness.store.loadInsights();
		harness.store.insightWorkspace = 'newer';
		await harness.store.loadInsights();
		expect(harness.store.insights.tools.workspace).toBe('newer');
		expect(harness.store.insights.rules.workspace).toBe('newer');

		resolveOlderTools?.(jsonResponse({ workspace: 'older' }));
		resolveOlderRules?.(jsonResponse({ workspace: 'older' }));
		await olderRequest;

		expect(harness.store.insights.tools.workspace).toBe('newer');
		expect(harness.store.insights.rules.workspace).toBe('newer');
	});

	test('keeps newer workspace coverage when an older request finishes last', async () => {
		let resolveOlderCoverage: ((response: FetchResponse) => void) | undefined;
		const olderCoverage = new Promise<FetchResponse>((resolve) => {
			resolveOlderCoverage = resolve;
		});
		const harness = dashboardHarness({
			fetch: async (url) => {
				if (url === '/api/analytics/coverage?workspace=older') return olderCoverage;
				return jsonResponse({ workspace: 'newer', coverageRatio: 1 });
			},
		});

		harness.store.insightWorkspace = 'older';
		const olderRequest = harness.store.loadCoverage();
		harness.store.insightWorkspace = 'newer';
		await harness.store.loadCoverage();
		expect(harness.store.coverage?.workspace).toBe('newer');
		expect(harness.store.coverageLoading).toBe(false);

		resolveOlderCoverage?.(jsonResponse({ workspace: 'older', coverageRatio: 0 }));
		await olderRequest;

		expect(harness.store.coverage?.workspace).toBe('newer');
		expect(harness.store.coverageError).toBe('');
		expect(harness.store.coverageLoading).toBe(false);
	});
});
