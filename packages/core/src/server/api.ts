import { findAdapterById } from '../adapters/index.ts';
import { analyzeRules } from '../analytics/rule-analysis.ts';
import { computeCoverage } from '../analytics/coverage.ts';
import { computeToolUsage } from '../analytics/tool-usage.ts';
import type { AuditFilter } from '../analytics/types.ts';
import type {
	ApprovalDecision,
	ApprovalStatus,
	AuditEntry,
	EvaluationResult,
	Manifest,
	ToolCall,
} from '../core/types.ts';
import { AuditLogStore } from '../db/audit-log.ts';
import { toPermissionDecision } from '../hooks/adapter-utils.ts';
import { PolicyEngine } from '../policy/engine.ts';
import { resolveTimeParam } from '../utils/duration.ts';
import { errorMessage } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import type { SessionLogSource } from '../sessions/types.ts';
import { parseEvaluatePayload, resolveAgentId } from './parse.ts';

export interface ActivityEntry extends AuditEntry {
	id: number;
	approvalRequestId?: number;
}

export type ApprovalPrompt = (call: ToolCall, reason: string) => Promise<ApprovalDecision>;

export interface UmbodOptions {
	manifest: Manifest;
	/** Path to the SQLite audit database. Required unless auditLog is provided. */
	dbPath?: string;
	/** Preconstructed store; takes precedence over dbPath. */
	auditLog?: AuditLogStore;
	/** Defaults to manifest.env.timeout seconds. 0 waits forever. */
	approvalTimeoutMs?: number;
	/** Interactive approval hook (CLI prompt, host app UI, ...). Used when approval_method is "cli" or "both". */
	approvalPrompt?: ApprovalPrompt;
	/** Fires for every evaluated tool call, after it is written to the audit log. */
	onActivity?: (entry: ActivityEntry) => void;
	/** Session transcript roots used by coverage analysis. Defaults to local Claude and Codex directories. */
	sessionLogSources?: SessionLogSource[];
}

export interface Umbod {
	readonly manifest: Manifest;
	readonly auditLog: AuditLogStore;
	evaluate(call: ToolCall): EvaluationResult;
	/** Resolve a pending approval. Returns false if it was already resolved. */
	resolveApproval(approvalRequestId: number, status: Exclude<ApprovalStatus, 'pending'>): boolean;
	listPendingApprovals(): ReturnType<AuditLogStore['listPendingApprovals']>;
	/**
	 * Handles umbod API routes (/health, /api/*). Returns undefined for
	 * anything else so callers can mount their own routes around it.
	 */
	fetch(req: Request): Response | Promise<Response> | undefined;
	close(): void;
}

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

function parseIntParam(url: URL, name: string): number | undefined {
	const str = url.searchParams.get(name);
	if (str === null) return undefined;
	const n = Number.parseInt(str, 10);
	return Number.isFinite(n) ? n : undefined;
}

/** Reads since/until (ISO or relative like "7d"), agent, and project params. Throws on malformed times. */
function parseAuditFilter(url: URL): AuditFilter {
	return {
		since: resolveTimeParam(url.searchParams.get('since') ?? undefined),
		until: resolveTimeParam(url.searchParams.get('until') ?? undefined),
		agent: url.searchParams.get('agent') ?? undefined,
		project: url.searchParams.get('project') ?? undefined,
	};
}

export function createUmbod(options: UmbodOptions): Umbod {
	const { manifest, onActivity, approvalPrompt } = options;
	const approvalMethod = manifest.policy.approval_method;
	const approvalTimeoutMs = options.approvalTimeoutMs ?? manifest.env.timeout * 1000;
	const sessionLogSources = options.sessionLogSources ?? [{ agent: 'claude' }, { agent: 'codex' }];

	if (!options.auditLog && options.dbPath === undefined) {
		throw new Error('createUmbod requires either dbPath or auditLog');
	}

	const auditLog = options.auditLog ?? new AuditLogStore(options.dbPath as string);
	const engine = new PolicyEngine(manifest);

	function publishEntry(call: ToolCall, result: EvaluationResult): ActivityEntry {
		const { entryId, approvalRequestId } = auditLog.append(call, result);
		const entry: ActivityEntry = { id: entryId, ...call, ...result, approvalRequestId };

		try {
			onActivity?.(entry);
		} catch (error: unknown) {
			logger.warn('activity listener threw', { error: errorMessage(error) });
		}

		return entry;
	}

	async function waitForApprovalResolution(approvalRequestId: number): Promise<ApprovalDecision> {
		const deadline = approvalTimeoutMs === 0 ? undefined : Date.now() + approvalTimeoutMs;

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
				logger.warn('approval request timed out', { approvalRequestId, timeoutMs: approvalTimeoutMs });
				return 'block';
			}

			await sleep(APPROVAL_POLL_INTERVAL_MS);
		}
	}

	async function resolveApprovalDecision(
		approvalRequestId: number,
		call: ToolCall,
		reason: string
	): Promise<ApprovalDecision> {
		if (approvalPrompt && approvalMethod === 'cli') {
			// Prompt only: resolve the DB record directly from the prompt's answer
			const decision = await approvalPrompt(call, reason);
			auditLog.resolveApprovalRequest(approvalRequestId, decisionToApprovalStatus(decision));
			return decision;
		}

		if (approvalPrompt && approvalMethod === 'both') {
			// Both: prompt runs in background and resolves the DB; polling is the gate
			void approvalPrompt(call, reason)
				.then((decision) => {
					auditLog.resolveApprovalRequest(approvalRequestId, decisionToApprovalStatus(decision));
				})
				.catch((error: unknown) => {
					logger.warn('failed to resolve prompted approval request', {
						approvalRequestId,
						error: errorMessage(error),
					});
				});
			return waitForApprovalResolution(approvalRequestId);
		}

		// "web" (or no prompt wired up): wait for the DB record to be resolved externally
		return waitForApprovalResolution(approvalRequestId);
	}

	// ── Route handlers ──────────────────────────────────────────────

	function handleHealth(): Response {
		return Response.json({
			status: 'ok',
			environment: manifest.env.name,
			version: manifest.env.version,
		});
	}

	function handleManifest(): Response {
		return Response.json({
			env: manifest.env,
			policy: manifest.policy,
			rules: manifest.rules,
		});
	}

	function listPendingApprovals(): ReturnType<AuditLogStore['listPendingApprovals']> {
		return approvalMethod === 'cli' ? [] : auditLog.listPendingApprovals();
	}

	function handleApprovalAction(approvalId: number, action: string): Response {
		const status: 'approved' | 'denied' = action === 'approve' ? 'approved' : 'denied';
		const resolved = auditLog.resolveApprovalRequest(approvalId, status);

		return Response.json({ ok: resolved, approvalRequestId: approvalId, status }, { status: resolved ? 200 : 409 });
	}

	function handleEvaluate(req: Request): Promise<Response> {
		return req
			.json()
			.then((call) => {
				const input = parseEvaluatePayload(call);
				const result = engine.evaluate(input);
				const entry = publishEntry(input, result);

				return Response.json({ ok: true, entry });
			})
			.catch((error: unknown) => {
				logger.warn('failed to evaluate tool call', { error: errorMessage(error) });
				return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 });
			});
	}

	async function handleHook(req: Request, url: URL): Promise<Response> {
		const agentId = resolveAgentId(req, url);

		if (!agentId) {
			return Response.json({ ok: false, error: 'missing hook adapter identity' }, { status: 400 });
		}

		const adapter = findAdapterById(agentId);

		if (!adapter) {
			return Response.json({ ok: false, error: `unknown hook adapter "${agentId}"` }, { status: 404 });
		}

		try {
			const payload = await req.json();
			const call = adapter.normalizePayload(payload);
			const result = engine.evaluate(call);
			const entry = publishEntry(call, result);
			let finalDecision = result.decision;

			if (result.decision === 'approve' && entry.approvalRequestId) {
				finalDecision = await resolveApprovalDecision(entry.approvalRequestId, call, result.reason);
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
		} catch (error: unknown) {
			logger.warn('failed to process hook payload', {
				agentId,
				error: errorMessage(error),
			});
			return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 });
		}
	}

	function analyticsError(error: unknown): Response {
		return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 });
	}

	function handleAnalytics(url: URL): Response | Promise<Response> | undefined {
		if (!url.pathname.startsWith('/api/analytics/')) return undefined;

		try {
			const filter = parseAuditFilter(url);
			if (url.pathname === '/api/analytics/tools') {
				return Response.json(
					computeToolUsage(auditLog, manifest, {
						...filter,
						recentWindowDays: parseIntParam(url, 'recentDays'),
						topCommandsPerTool: parseIntParam(url, 'topCommands'),
					})
				);
			}
			if (url.pathname === '/api/analytics/rules') {
				return Response.json(
					analyzeRules(manifest, auditLog, {
						...filter,
						minOccurrences: parseIntParam(url, 'minOccurrences'),
					})
				);
			}
			if (url.pathname !== '/api/analytics/coverage') return undefined;

			const since = filter.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
			const sources = sessionLogSources
				.filter((source) => filter.agent === undefined || source.agent === filter.agent)
				.map((source) => ({
					...source,
					since,
					until: filter.until ?? source.until,
					project: filter.project ?? source.project,
				}));
			return computeCoverage(auditLog, sources, {
				...filter,
				since,
				heuristicWindowMs: parseIntParam(url, 'heuristicWindowMs'),
				gapLimit: parseIntParam(url, 'gapLimit'),
			})
				.then((report) => Response.json(report))
				.catch(analyticsError);
		} catch (error: unknown) {
			return analyticsError(error);
		}
	}

	function handleGet(url: URL): Response | Promise<Response> | undefined {
		if (url.pathname === '/health') {
			return handleHealth();
		}

		if (url.pathname === '/api/activity') {
			return Response.json(auditLog.listRecent(parseLimitParam(url)));
		}

		if (url.pathname === '/api/approvals') {
			return Response.json(listPendingApprovals());
		}

		if (url.pathname === '/api/manifest') {
			return handleManifest();
		}

		return handleAnalytics(url);
	}

	function handlePost(req: Request, url: URL): Response | Promise<Response> | undefined {
		const approvalMatch = url.pathname.match(/^\/api\/approvals\/(\d+)\/(approve|deny)$/);
		if (approvalMatch) {
			return handleApprovalAction(Number(approvalMatch[1]), approvalMatch[2]);
		}

		if (url.pathname === '/api/evaluate') {
			return handleEvaluate(req);
		}

		if (url.pathname === '/api/hooks') {
			return handleHook(req, url);
		}

		return undefined;
	}

	function handleFetch(req: Request): Response | Promise<Response> | undefined {
		const url = new URL(req.url);
		if (req.method === 'GET') return handleGet(url);
		if (req.method === 'POST') return handlePost(req, url);
		return undefined;
	}

	return {
		manifest,
		auditLog,
		evaluate: (call) => engine.evaluate(call),
		resolveApproval: (approvalRequestId, status) => auditLog.resolveApprovalRequest(approvalRequestId, status),
		listPendingApprovals,
		fetch: handleFetch,
		close: () => auditLog.close(),
	};
}
