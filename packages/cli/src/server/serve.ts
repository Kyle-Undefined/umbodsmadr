import type { Server, ServerWebSocket } from 'bun';
import { watch, type FSWatcher } from 'node:fs';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';

import {
	createUmbod,
	logger,
	parseManifestSource,
	runManifestTests,
	type Manifest,
	type PolicyManager,
	type Umbod,
} from '@umbod/core';

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

function handleDashboard(umbod: Umbod, limit: number, policySourceAvailable: boolean): Response {
	const analytics = umbod.analyticsSnapshot();
	const html = renderDashboard(
		umbod.manifest,
		umbod.auditLog.listRecent(limit),
		umbod.listPendingApprovals(),
		analytics.tools,
		analytics.rules,
		umbod.policyStatus,
		policySourceAvailable
	);
	return new Response(html, {
		headers: { 'content-type': 'text/html; charset=utf-8' },
	});
}

// fallow-ignore-next-line complexity -- bounded UI, asset, and source route dispatch remains one explicit trust boundary.
function handleServerFetch(
	req: Request,
	server: Server<undefined>,
	umbod: Umbod,
	manifestPath?: string
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
		return handleDashboard(umbod, parseLimitParam(url), manifestPath !== undefined);
	}
	if (url.pathname === '/api/policy/source') {
		if (!manifestPath) return Response.json({ ok: false, error: 'manifest source is unavailable' }, { status: 404 });
		if (req.method === 'GET') {
			return readFile(manifestPath, 'utf8').then((source) =>
				Response.json({ source, sourceHash: createHash('sha256').update(source).digest('hex') })
			);
		}
		if (req.method === 'POST') return savePolicySource(req, umbod, manifestPath);
	}
	return umbod.fetch(req) ?? new Response('not found', { status: 404 });
}

// fallow-ignore-next-line complexity -- one transactional source-save boundary keeps validation, rollback, and responses together.
async function savePolicySource(req: Request, umbod: Umbod, manifestPath: string): Promise<Response> {
	let temporaryPath: string | undefined;
	try {
		const origin = req.headers.get('origin');
		if (origin !== null && origin !== new URL(req.url).origin) {
			return Response.json({ ok: false, error: 'cross-origin policy activation is not allowed' }, { status: 403 });
		}
		const body = (await req.json()) as Record<string, unknown>;
		if (typeof body.source !== 'string' || !body.source.trim() || body.source.length > 1_000_000) {
			throw new Error('source must be a non-empty TOML string no larger than 1 MB');
		}
		const current = await readFile(manifestPath, 'utf8');
		const currentHash = createHash('sha256').update(current).digest('hex');
		if (body.expectedSourceHash !== currentHash) {
			return Response.json(
				{ ok: false, error: 'manifest changed since it was loaded; reload before saving' },
				{ status: 409 }
			);
		}
		const candidate = parseManifestSource(body.source, manifestPath);
		if (
			candidate.env.name !== umbod.manifest.env.name ||
			candidate.server.host !== umbod.manifest.server.host ||
			candidate.server.port !== umbod.manifest.server.port
		) {
			throw new Error('manifest env.name and server host/port require a restart');
		}
		const tests = runManifestTests(candidate);
		if (tests.failed > 0) {
			return Response.json({ ok: false, error: 'embedded policy tests failed', tests }, { status: 400 });
		}
		temporaryPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
		const fileMode = (await stat(manifestPath)).mode;
		await writeFile(temporaryPath, body.source, { encoding: 'utf8', flag: 'wx', mode: fileMode });
		await rename(temporaryPath, manifestPath);
		temporaryPath = undefined;
		const status = await umbod.reloadPolicy(manifestPath);
		if (status.reloadStatus !== 'active') {
			temporaryPath = `${manifestPath}.${process.pid}.${randomUUID()}.rollback.tmp`;
			await writeFile(temporaryPath, current, { encoding: 'utf8', flag: 'wx', mode: fileMode });
			await rename(temporaryPath, manifestPath);
			temporaryPath = undefined;
			await umbod.reloadPolicy(manifestPath);
			return Response.json(
				{ ok: false, error: status.reloadError ?? 'policy activation failed', status },
				{ status: 500 }
			);
		}
		return Response.json({
			ok: true,
			tests,
			status,
			sourceHash: createHash('sha256').update(body.source).digest('hex'),
		});
	} catch (error: unknown) {
		return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
	} finally {
		if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
	}
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
			return handleServerFetch(req, serverInstance, umbod, options.manifestPath);
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
