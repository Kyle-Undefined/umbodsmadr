import type { Server, ServerWebSocket } from 'bun';

import { findAdapterById } from '../adapters/index.ts';
import type { ApprovalDecision, EvaluationResult, Manifest, ToolCall } from '../core/types.ts';
import { AuditLogStore } from '../db/audit-log.ts';
import { toPermissionDecision } from '../hooks/adapter-utils.ts';
import { errorMessage } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import { parseEvaluatePayload, resolveAgentId } from './parse.ts';
import { renderDashboard } from './ui.ts';
import { alpineJs, dashboardCss, dashboardJs } from './ui-assets.ts';
import { CliApprovalQueue } from './cli-approval.ts';

interface ServerOptions {
	host: string;
	port: number;
	manifest: Manifest;
	auditLog: AuditLogStore;
	approvalTimeoutMs: number;
	evaluate(call: ToolCall): EvaluationResult;
}

type ActivitySocket = ServerWebSocket<undefined>;

const APPROVAL_POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLimitParam(url: URL): number | undefined {
	const str = url.searchParams.get('limit');
	if (str === null) return undefined;
	const n = Number.parseInt(str, 10);
	return Number.isFinite(n) ? n : undefined;
}

function decisionToApprovalStatus(decision: ApprovalDecision): 'approved' | 'denied' {
	return decision === 'allow' ? 'approved' : 'denied';
}

function publishEntry(sockets: Set<ActivitySocket>, auditLog: AuditLogStore, call: ToolCall, result: EvaluationResult) {
	const { entryId, approvalRequestId } = auditLog.append(call, result);
	const entry = { id: entryId, ...call, ...result, approvalRequestId };

	const message = JSON.stringify(entry);
	for (const socket of sockets) {
		try {
			socket.send(message);
		} catch {
			// Socket may have disconnected; ignore and continue
		}
	}

	return entry;
}

async function waitForApprovalResolution(
	auditLog: AuditLogStore,
	approvalRequestId: number,
	timeoutMs: number
): Promise<ApprovalDecision> {
	const deadline = timeoutMs === 0 ? undefined : Date.now() + timeoutMs;

	for (;;) {
		const status = auditLog.getApprovalStatus(approvalRequestId);

		if (status === 'approved') {
			return 'allow';
		}

		if (status === 'denied') {
			return 'block';
		}

		if (status === undefined) {
			logger.warn('approval request not found', { approvalRequestId });
			return 'block';
		}

		if (deadline !== undefined && Date.now() >= deadline) {
			logger.warn('approval request timed out', {
				approvalRequestId,
				timeoutMs,
			});
			return 'block';
		}

		await sleep(APPROVAL_POLL_INTERVAL_MS);
	}
}

// ── Route handlers ──────────────────────────────────────────────

function handleDashboard(manifest: Manifest, auditLog: AuditLogStore, limit?: number): Response {
	const approvalMethod = manifest.policy.approval_method;
	const pendingApprovals = approvalMethod === 'cli' ? [] : auditLog.listPendingApprovals();
	const html = renderDashboard(manifest, auditLog.listRecent(limit), pendingApprovals);
	return new Response(html, {
		headers: { 'content-type': 'text/html; charset=utf-8' },
	});
}

function handleHealth(manifest: Manifest): Response {
	return Response.json({
		status: 'ok',
		environment: manifest.env.name,
		version: manifest.env.version,
	});
}

function handleManifest(manifest: Manifest): Response {
	return Response.json({
		env: manifest.env,
		policy: manifest.policy,
		rules: manifest.rules,
	});
}

function handleApprovalAction(auditLog: AuditLogStore, approvalId: number, action: string): Response {
	const status: 'approved' | 'denied' = action === 'approve' ? 'approved' : 'denied';
	const resolved = auditLog.resolveApprovalRequest(approvalId, status);

	return Response.json({ ok: resolved, approvalRequestId: approvalId, status }, { status: resolved ? 200 : 409 });
}

function handleEvaluate(req: Request, options: ServerOptions, sockets: Set<ActivitySocket>): Promise<Response> {
	return req
		.json()
		.then((call) => {
			const input = parseEvaluatePayload(call);
			const result = options.evaluate(input);
			const entry = publishEntry(sockets, options.auditLog, input, result);

			return Response.json({ ok: true, entry });
		})
		.catch((error: unknown) => {
			logger.warn('failed to evaluate tool call', { error: errorMessage(error) });
			return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 });
		});
}

async function resolveApprovalDecision(
	auditLog: AuditLogStore,
	approvalRequestId: number,
	cliApprovalQueue: CliApprovalQueue | null,
	approvalMethod: string,
	call: ToolCall,
	reason: string,
	timeoutMs: number
): Promise<ApprovalDecision> {
	if (cliApprovalQueue && approvalMethod === 'cli') {
		// CLI only: prompt user and resolve DB directly
		const decision = await cliApprovalQueue.request(call, reason);
		auditLog.resolveApprovalRequest(approvalRequestId, decisionToApprovalStatus(decision));
		return decision;
	}

	if (cliApprovalQueue && approvalMethod === 'both') {
		// Both: CLI prompts in background and resolves DB; web polling is the gate
		void cliApprovalQueue
			.request(call, reason)
			.then((decision) => {
				auditLog.resolveApprovalRequest(approvalRequestId, decisionToApprovalStatus(decision));
			})
			.catch((error: unknown) => {
				logger.warn('failed to resolve CLI approval request', {
					approvalRequestId,
					error: errorMessage(error),
				});
			});
		return waitForApprovalResolution(auditLog, approvalRequestId, timeoutMs);
	}

	// approvalMethod === "web": wait for dashboard to resolve DB
	return waitForApprovalResolution(auditLog, approvalRequestId, timeoutMs);
}

function handleHook(
	req: Request,
	url: URL,
	options: ServerOptions,
	sockets: Set<ActivitySocket>,
	cliApprovalQueue: CliApprovalQueue | null,
	approvalMethod: string
): Response | Promise<Response> {
	const agentId = resolveAgentId(req, url);

	if (!agentId) {
		return Response.json({ ok: false, error: 'missing hook adapter identity' }, { status: 400 });
	}

	const adapter = findAdapterById(agentId);

	if (!adapter) {
		return Response.json({ ok: false, error: `unknown hook adapter "${agentId}"` }, { status: 404 });
	}

	return req
		.json()
		.then(async (payload) => {
			const call = adapter.normalizePayload(payload);
			const result = options.evaluate(call);
			const entry = publishEntry(sockets, options.auditLog, call, result);
			let finalDecision = result.decision;

			if (result.decision === 'approve' && entry.approvalRequestId) {
				finalDecision = await resolveApprovalDecision(
					options.auditLog,
					entry.approvalRequestId,
					cliApprovalQueue,
					approvalMethod,
					call,
					result.reason,
					options.approvalTimeoutMs
				);
			}

			const body = {
				permissionDecision: toPermissionDecision(finalDecision),
				permissionDecisionReason: result.reason,
				hookSpecificOutput: {
					hookEventName: adapter.hookEvent,
				},
			};

			// Hooks always respond 200; consumers read permissionDecision from the body.
			return Response.json(body, { status: 200 });
		})
		.catch((error: unknown) => {
			logger.warn('failed to process hook payload', {
				agentId,
				error: errorMessage(error),
			});
			return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 });
		});
}

// ── Server bootstrap ────────────────────────────────────────────

export async function startHttpServer(options: ServerOptions): Promise<Server<undefined>> {
	const sockets = new Set<ActivitySocket>();
	const approvalMethod = options.manifest.policy.approval_method;
	const cliApprovalQueue = approvalMethod !== 'web' ? new CliApprovalQueue() : null;

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
				return handleDashboard(options.manifest, options.auditLog, parseLimitParam(url));
			}

			if (req.method === 'GET' && url.pathname === '/health') {
				return handleHealth(options.manifest);
			}

			if (req.method === 'GET' && url.pathname === '/api/activity') {
				return Response.json(options.auditLog.listRecent(parseLimitParam(url)));
			}

			if (req.method === 'GET' && url.pathname === '/api/approvals') {
				const pending = approvalMethod === 'cli' ? [] : options.auditLog.listPendingApprovals();
				return Response.json(pending);
			}

			if (req.method === 'GET' && url.pathname === '/api/manifest') {
				return handleManifest(options.manifest);
			}

			const approvalMatch = url.pathname.match(/^\/api\/approvals\/(\d+)\/(approve|deny)$/);
			if (req.method === 'POST' && approvalMatch) {
				return handleApprovalAction(options.auditLog, Number(approvalMatch[1]), approvalMatch[2]);
			}

			if (req.method === 'POST' && url.pathname === '/api/evaluate') {
				return handleEvaluate(req, options, sockets);
			}

			if (req.method === 'POST' && url.pathname === '/api/hooks') {
				return handleHook(req, url, options, sockets, cliApprovalQueue, approvalMethod);
			}

			return new Response('not found', { status: 404 });
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
	return server;
}
