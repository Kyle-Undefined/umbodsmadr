import type { Server, ServerWebSocket } from 'bun';

import { createUmbod, logger, type Manifest, type Umbod } from '@umbod/core';

import { CliApprovalQueue } from './cli-approval.ts';
import { renderDashboard } from './ui.ts';
import { alpineJs, dashboardCss, dashboardJs } from './ui-assets.ts';

export interface ServeOptions {
	host: string;
	port: number;
	manifest: Manifest;
	dbPath: string;
	approvalTimeoutMs: number;
}

type ActivitySocket = ServerWebSocket<undefined>;

function parseLimitParam(url: URL): number | undefined {
	const str = url.searchParams.get('limit');
	if (str === null) return undefined;
	const n = Number.parseInt(str, 10);
	return Number.isFinite(n) ? n : undefined;
}

function handleDashboard(umbod: Umbod, limit?: number): Response {
	const html = renderDashboard(umbod.manifest, umbod.auditLog.listRecent(limit), umbod.listPendingApprovals());
	return new Response(html, {
		headers: { 'content-type': 'text/html; charset=utf-8' },
	});
}

export interface ServeHandle {
	server: Server<undefined>;
	umbod: Umbod;
}

export async function startHttpServer(options: ServeOptions): Promise<ServeHandle> {
	const sockets = new Set<ActivitySocket>();
	const approvalMethod = options.manifest.policy.approval_method;
	const cliApprovalQueue = approvalMethod !== 'web' ? new CliApprovalQueue() : null;

	const umbod = createUmbod({
		manifest: options.manifest,
		dbPath: options.dbPath,
		approvalTimeoutMs: options.approvalTimeoutMs,
		approvalPrompt: cliApprovalQueue ? (call, reason) => cliApprovalQueue.request(call, reason) : undefined,
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
			const url = new URL(req.url);

			if (url.pathname === '/ws') {
				const upgraded = serverInstance.upgrade(req);
				return upgraded ? undefined : new Response('upgrade failed', { status: 500 });
			}

			if (req.method === 'GET' && url.pathname === '/assets/alpine.js') {
				return new Response(alpineJs, {
					headers: { 'content-type': 'application/javascript; charset=utf-8' },
				});
			}

			if (req.method === 'GET' && url.pathname === '/assets/dashboard.css') {
				return new Response(dashboardCss, {
					headers: { 'content-type': 'text/css; charset=utf-8' },
				});
			}

			if (req.method === 'GET' && url.pathname === '/assets/dashboard.js') {
				return new Response(dashboardJs, {
					headers: { 'content-type': 'application/javascript; charset=utf-8' },
				});
			}

			if (req.method === 'GET' && url.pathname === '/') {
				return handleDashboard(umbod, parseLimitParam(url));
			}

			return umbod.fetch(req) ?? new Response('not found', { status: 404 });
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
	return { server, umbod };
}
