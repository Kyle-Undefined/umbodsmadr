import type { Server, ServerWebSocket } from 'bun';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

import { createUmbod, logger, type Manifest, type PolicyManager, type Umbod } from '@umbod/core';

import { CliApprovalQueue } from './cli-approval.ts';
import { renderDashboard } from './ui.ts';
import { alpineJs, dashboardCss, dashboardJs } from './ui-assets.ts';

export interface ServeOptions {
	host: string;
	port: number;
	manifest: Manifest;
	policyManager?: PolicyManager;
	manifestPath?: string;
	dbPath: string;
	approvalTimeoutMs: number;
}

type ActivitySocket = ServerWebSocket<undefined>;

const DEFAULT_ACTIVITY_LIMIT = 200;
const UI_ASSETS = new Map([
	['/assets/alpine.js', { contents: alpineJs, contentType: 'application/javascript; charset=utf-8' }],
	['/assets/dashboard.css', { contents: dashboardCss, contentType: 'text/css; charset=utf-8' }],
	['/assets/dashboard.js', { contents: dashboardJs, contentType: 'application/javascript; charset=utf-8' }],
]);

function parseLimitParam(url: URL): number {
	const str = url.searchParams.get('limit');
	if (str === null) return DEFAULT_ACTIVITY_LIMIT;
	if (!/^\d+$/.test(str)) return DEFAULT_ACTIVITY_LIMIT;
	const n = Number(str);
	return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_ACTIVITY_LIMIT;
}

function handleDashboard(umbod: Umbod, limit: number): Response {
	const analytics = umbod.analyticsSnapshot();
	const html = renderDashboard(
		umbod.manifest,
		umbod.auditLog.listRecent(limit),
		umbod.listPendingApprovals(),
		analytics.tools,
		analytics.rules,
		umbod.policyStatus
	);
	return new Response(html, {
		headers: { 'content-type': 'text/html; charset=utf-8' },
	});
}

function handleServerFetch(
	req: Request,
	server: Server<undefined>,
	umbod: Umbod
): Response | Promise<Response> | undefined {
	const url = new URL(req.url);
	if (url.pathname === '/ws') {
		return server.upgrade(req) ? undefined : new Response('upgrade failed', { status: 500 });
	}
	const asset = req.method === 'GET' ? UI_ASSETS.get(url.pathname) : undefined;
	if (asset) {
		return new Response(asset.contents, {
			headers: { 'content-type': asset.contentType },
		});
	}
	if (req.method === 'GET' && url.pathname === '/') {
		return handleDashboard(umbod, parseLimitParam(url));
	}
	return umbod.fetch(req) ?? new Response('not found', { status: 404 });
}

export interface ServeHandle {
	server: Server<undefined>;
	umbod: Umbod;
	policyWatcher?: FSWatcher;
}

function watchPolicy(umbod: Umbod, manifestPath: string | undefined): FSWatcher | undefined {
	if (manifestPath === undefined) return undefined;
	let reloadTimer: ReturnType<typeof setTimeout> | undefined;
	const manifestName = basename(manifestPath);
	return watch(dirname(manifestPath), (_event, changedPath) => {
		if (changedPath !== null && changedPath !== manifestName) return;
		if (reloadTimer !== undefined) clearTimeout(reloadTimer);
		reloadTimer = setTimeout(() => {
			void umbod.reloadPolicy(manifestPath).then((status) => {
				if (status.reloadStatus === 'active') {
					logger.info('policy reloaded', { generation: status.generation, activeHash: status.activeHash });
				} else {
					logger.warn('policy reload failed; retaining previous policy', { error: status.reloadError });
				}
			});
		}, 100);
	});
}

export async function startHttpServer(options: ServeOptions): Promise<ServeHandle> {
	const sockets = new Set<ActivitySocket>();
	const cliApprovalQueue = new CliApprovalQueue();

	const umbod = createUmbod({
		manifest: options.manifest,
		policyManager: options.policyManager,
		dbPath: options.dbPath,
		auditLogOptions: { journalMode: 'wal' },
		approvalTimeoutMs: options.approvalTimeoutMs,
		approvalPrompt: (call, reason) => cliApprovalQueue.request(call, reason),
		onActivity(entry) {
			const message = JSON.stringify(entry);
			for (const socket of sockets) {
				try {
					socket.send(message);
				} catch {
					// Socket may have disconnected; ignore and continue
				}
			}
		},
	});

	const server = Bun.serve({
		hostname: options.host,
		port: options.port,
		fetch(req, serverInstance) {
			return handleServerFetch(req, serverInstance, umbod);
		},
		websocket: {
			open(socket) {
				sockets.add(socket);
			},
			message() {},
			close(socket) {
				sockets.delete(socket);
			},
		},
	});

	logger.info(`server listening on http://${server.hostname}:${server.port}`);
	return { server, umbod, policyWatcher: watchPolicy(umbod, options.manifestPath) };
}
