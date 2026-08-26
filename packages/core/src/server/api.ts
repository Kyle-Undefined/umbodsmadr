import { findAdapterById } from '../adapters/index.ts';
import { analyzeRules } from '../analytics/rule-analysis.ts';
import { computeCoverage, scopeCoverageSources } from '../analytics/coverage.ts';
import { computeAnalyticsSnapshot } from '../analytics/snapshot.ts';
import { computeToolUsage } from '../analytics/tool-usage.ts';
import { simulatePolicy } from '../analytics/policy-simulation.ts';
import type { AnalyticsSnapshotQuery, AuditFilter } from '../analytics/types.ts';
import type {
	ApprovalDecision,
	ApprovalStatus,
	AuditEntry,
	EvaluationResult,
	Manifest,
	ToolCall,
} from '../core/types.ts';
import { AuditLogStore, type AuditLogStoreOptions } from '../db/audit-log.ts';
import { toPermissionDecision } from '../hooks/adapter-utils.ts';
import { PolicyManager, type PolicyStatus } from '../policy/policy-manager.ts';
import { parseManifestSource } from '../config/manifest.ts';
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

export interface AuthorizeOptions {
	/** Per-call host approval UI. Overrides the prompt supplied to createUmbod. */
	approvalPrompt?: ApprovalPrompt;
	/** Treat an approve decision as allowed without prompting, while recording the resolution. */
	bypassApproval?: boolean;
}

export interface AuthorizationResult {
	entry: ActivityEntry;
	/** The policy engine's original decision. */
	policyDecision: ApprovalDecision;
	/** The decision after any host approval or bypass has been resolved. */
	decision: Exclude<ApprovalDecision, 'approve'>;
}

export interface UmbodOptions {
	manifest: Manifest;
	/** Reloadable policy owner. When omitted, Umbod creates a static generation from manifest. */
	policyManager?: PolicyManager;
	/** Path to the SQLite audit database. Required unless auditLog is provided. */
	dbPath?: string;
	/** Preconstructed store; takes precedence over dbPath. */
	auditLog?: AuditLogStore;
	/** Writable connection settings used when Umbod owns the store. */
	auditLogOptions?: AuditLogStoreOptions;
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
	readonly policyStatus: PolicyStatus;
	readonly auditLog: AuditLogStore;
	evaluate(call: ToolCall): EvaluationResult;
	/** Evaluate, audit, and fully resolve a tool call for an in-process host. */
	authorize(call: ToolCall, options?: AuthorizeOptions): Promise<AuthorizationResult>;
	/** Resolve a pending approval. Returns false if it was already resolved. */
	resolveApproval(approvalRequestId: number, status: Exclude<ApprovalStatus, 'pending'>): boolean;
	listPendingApprovals(): ReturnType<AuditLogStore['listPendingApprovals']>;
	/** Compute tool and rule reports against one consistent audit snapshot. */
	analyticsSnapshot(options?: AnalyticsSnapshotQuery): ReturnType<typeof computeAnalyticsSnapshot>;
	reloadPolicy(manifestPath: string): Promise<PolicyStatus>;
	/**
	 * Handles umbod API routes (/health, /api/*). Returns undefined for
	 * anything else so callers can mount their own routes around it.
	 */
	fetch(req: Request): Response | Promise<Response> | undefined;
	close(): void;
}

const APPROVAL_POLL_INTERVAL_MS = 250;
const DEFAULT_ACTIVITY_LIMIT = 200;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLimitParam(url: URL): number {
	const str = url.searchParams.get('limit');
	if (str === null) return DEFAULT_ACTIVITY_LIMIT;
	if (!/^\d+$/.test(str)) return DEFAULT_ACTIVITY_LIMIT;
	const n = Number(str);
	return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_ACTIVITY_LIMIT;
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

function optionalQueryParam(url: URL, name: string): string | undefined {
	const value = url.searchParams.get(name);
	return value === null ? undefined : value;
}

function parseBooleanParam(url: URL, name: string, fallback: boolean): boolean {
	const value = url.searchParams.get(name);
	if (value === null) return fallback;
	if (value === 'true' || value === '1') return true;
	if (value === 'false' || value === '0') return false;
	throw new Error(`${name} must be true, false, 1, or 0`);
}

function parseCursor(url: URL): number | undefined {
	const value = url.searchParams.get('cursor');
	if (value === null || value === '' || value === 'start') return undefined;
	if (!/^\d+$/.test(value)) throw new Error('cursor must be "start" or a positive audit entry id');
	const cursor = Number(value);
	if (!Number.isSafeInteger(cursor) || cursor <= 0) {
		throw new Error('cursor must be "start" or a positive audit entry id');
	}
	return cursor;
}

function parseProjectionParam(url: URL): 'full' | 'summary' | undefined {
	const value = url.searchParams.get('projection');
	if (value === null) return undefined;
	if (value === 'full' || value === 'summary') return value;
	throw new Error('projection must be "full" or "summary"');
}

function parseCallPageSize(url: URL): number {
	return Math.min(Math.max(parseIntParam(url, 'pageSize') ?? 50, 1), 200);
}

function usesCursorPagination(url: URL): boolean {
	const pagination = url.searchParams.get('pagination');
	const hasCursor = url.searchParams.has('cursor');
	if (pagination !== null && pagination !== 'cursor' && pagination !== 'page') {
		throw new Error('pagination must be "page" or "cursor"');
	}
	if (pagination === 'page' && hasCursor) {
		throw new Error('cursor cannot be combined with pagination="page"');
	}
	return pagination === 'cursor' || (pagination === null && hasCursor);
}

function validateLegacyCallPageParams(url: URL): void {
	if (url.searchParams.has('projection') || url.searchParams.has('includeTotal')) {
		throw new Error('projection and includeTotal require cursor pagination');
	}
}

/** Reads analytics filters. Throws on malformed times. */
function parseAuditFilter(url: URL): AuditFilter {
	return {
		since: resolveTimeParam(optionalQueryParam(url, 'since')),
		until: resolveTimeParam(optionalQueryParam(url, 'until')),
		agent: optionalQueryParam(url, 'agent'),
		project: optionalQueryParam(url, 'project'),
		workspace: optionalQueryParam(url, 'workspace'),
		tool: optionalQueryParam(url, 'tool'),
		operation: optionalQueryParam(url, 'operation'),
		classification: optionalQueryParam(url, 'classification') as AuditFilter['classification'],
		decision: optionalQueryParam(url, 'decision') as AuditFilter['decision'],
		search: optionalQueryParam(url, 'search'),
	};
}

export function createUmbod(options: UmbodOptions): Umbod {
	const { manifest, onActivity, approvalPrompt } = options;
	const policyManager = options.policyManager ?? new PolicyManager(manifest);
	const configuredApprovalTimeoutMs = options.approvalTimeoutMs;
	const sessionLogSources = options.sessionLogSources ?? [{ agent: 'claude' }, { agent: 'codex' }];

	if (!options.auditLog && options.dbPath === undefined) {
		throw new Error('createUmbod requires either dbPath or auditLog');
	}

	const auditLog = options.auditLog ?? new AuditLogStore(options.dbPath as string, options.auditLogOptions);

	function publishEntry(call: ToolCall, result: EvaluationResult, status: PolicyStatus): ActivityEntry {
		const provenance = { policyHash: status.activeHash, policyGeneration: status.generation };
		const { entryId, approvalRequestId } = auditLog.append(call, result, provenance);
		const entry: ActivityEntry = { id: entryId, ...call, ...result, ...provenance, approvalRequestId };

		try {
			onActivity?.(entry);
		} catch (error: unknown) {
			logger.warn('activity listener threw', { error: errorMessage(error) });
		}

		return entry;
	}

	async function waitForApprovalResolution(
		approvalRequestId: number,
		approvalTimeoutMs: number
	): Promise<ApprovalDecision> {
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
		reason: string,
		approvalMethod: Manifest['policy']['approval_method'],
		approvalTimeoutMs: number
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
			return waitForApprovalResolution(approvalRequestId, approvalTimeoutMs);
		}

		// "web" (or no prompt wired up): wait for the DB record to be resolved externally
		return waitForApprovalResolution(approvalRequestId, approvalTimeoutMs);
	}

	async function authorize(call: ToolCall, callOptions: AuthorizeOptions = {}): Promise<AuthorizationResult> {
		const evaluation = policyManager.evaluate(call);
		const result = evaluation.result;
		const entry = publishEntry(call, result, evaluation.status);
		let decision: Exclude<ApprovalDecision, 'approve'>;

		if (result.decision !== 'approve') {
			decision = result.decision;
		} else if (!entry.approvalRequestId) {
			decision = 'block';
		} else if (callOptions.bypassApproval) {
			auditLog.resolveApprovalRequest(entry.approvalRequestId, 'approved');
			decision = 'allow';
		} else if (callOptions.approvalPrompt) {
			const prompted = await callOptions.approvalPrompt(call, result.reason);
			auditLog.resolveApprovalRequest(entry.approvalRequestId, decisionToApprovalStatus(prompted));
			decision = prompted === 'allow' ? 'allow' : 'block';
		} else {
			const resolved = await resolveApprovalDecision(
				entry.approvalRequestId,
				call,
				result.reason,
				evaluation.manifest.policy.approval_method,
				configuredApprovalTimeoutMs ?? evaluation.manifest.env.timeout * 1000
			);
			decision = resolved === 'allow' ? 'allow' : 'block';
		}

		return { entry, policyDecision: result.decision, decision };
	}

	// ── Route handlers ──────────────────────────────────────────────

	function handleHealth(): Response {
		return Response.json({
			status: 'ok',
			environment: policyManager.manifest.env.name,
			version: policyManager.manifest.env.version,
			policy: policyManager.status(),
		});
	}

	function handleManifest(): Response {
		const activeManifest = policyManager.manifest;
		return Response.json({
			env: activeManifest.env,
			policy: activeManifest.policy,
			rules: activeManifest.rules,
			structuredRules: activeManifest.structuredRules ?? [],
			guards: activeManifest.guards ?? [],
			workspaces: activeManifest.workspaces ?? [],
			tests: activeManifest.tests ?? [],
			policyStatus: policyManager.status(),
		});
	}

	function listPendingApprovals(): ReturnType<AuditLogStore['listPendingApprovals']> {
		return policyManager.manifest.policy.approval_method === 'cli' ? [] : auditLog.listPendingApprovals();
	}

	function handleApprovalAction(approvalId: number, action: string): Response {
		const status: 'approved' | 'denied' = action === 'approve' ? 'approved' : 'denied';
		const resolvedAt = new Date().toISOString();
		const resolved = auditLog.resolveApprovalRequest(approvalId, status, resolvedAt);

		return Response.json(
			{ ok: resolved, approvalRequestId: approvalId, status, resolvedAt: resolved ? resolvedAt : undefined },
			{ status: resolved ? 200 : 409 }
		);
	}

	function handleEvaluate(req: Request): Promise<Response> {
		return req
			.json()
			.then((call) => {
				const input = parseEvaluatePayload(call);
				const evaluation = policyManager.evaluate(input);
				const entry = publishEntry(input, evaluation.result, evaluation.status);

				return Response.json({ ok: true, entry });
			})
			.catch((error: unknown) => {
				logger.warn('failed to evaluate tool call', { error: errorMessage(error) });
				return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 });
			});
	}

	async function handlePolicySimulation(req: Request): Promise<Response> {
		try {
			const body = (await req.json()) as Record<string, unknown>;
			if (typeof body.candidate !== 'string' || !body.candidate.trim()) {
				throw new Error('candidate must be a non-empty TOML string');
			}
			const limit = body.limit === undefined ? 2000 : body.limit;
			if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
				throw new Error('limit must be an integer between 1 and 100000');
			}
			const candidate = parseManifestSource(body.candidate, 'dashboard candidate');
			return Response.json(simulatePolicy(policyManager.manifest, candidate, auditLog, { limit }));
		} catch (error: unknown) {
			return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 });
		}
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
			const evaluation = policyManager.evaluate(call);
			const result = evaluation.result;
			const entry = publishEntry(call, result, evaluation.status);
			let finalDecision = result.decision;

			if (result.decision === 'approve' && entry.approvalRequestId) {
				finalDecision = await resolveApprovalDecision(
					entry.approvalRequestId,
					call,
					result.reason,
					evaluation.manifest.policy.approval_method,
					configuredApprovalTimeoutMs ?? evaluation.manifest.env.timeout * 1000
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

	function handleCallExplorer(url: URL, filter: AuditFilter): Response {
		const pageSize = parseCallPageSize(url);
		if (usesCursorPagination(url)) {
			const projection = parseProjectionParam(url);
			return Response.json(
				auditLog.listRecentCursor(filter, {
					cursor: parseCursor(url),
					pageSize,
					includeTotal: parseBooleanParam(url, 'includeTotal', false),
					projection: projection ?? 'full',
				})
			);
		}
		validateLegacyCallPageParams(url);
		const page = Math.max(parseIntParam(url, 'page') ?? 1, 1);
		return Response.json(auditLog.listRecentPage(filter, page, pageSize));
	}

	function handleCallDetail(pathname: string): Response | undefined {
		if (!pathname.startsWith('/api/analytics/calls/')) return undefined;
		const idText = pathname.slice('/api/analytics/calls/'.length);
		if (!/^\d+$/.test(idText)) throw new Error('audit entry id must be a positive integer');
		const id = Number(idText);
		if (!Number.isSafeInteger(id) || id <= 0) throw new Error('audit entry id must be a positive integer');
		const entry = auditLog.getEntry(id);
		return entry === undefined
			? Response.json({ ok: false, error: `audit entry ${id} was not found` }, { status: 404 })
			: Response.json({ entry });
	}

	function handleAnalyticsSnapshot(url: URL, filter: AuditFilter): Response {
		return Response.json(
			computeAnalyticsSnapshot(auditLog, manifest, {
				since: filter.since,
				until: filter.until,
				agent: filter.agent,
				project: filter.project,
				workspace: filter.workspace,
				projection: parseProjectionParam(url),
				recentWindowDays: parseIntParam(url, 'recentDays'),
				topCommandsPerTool: parseIntParam(url, 'topCommands'),
				minOccurrences: parseIntParam(url, 'minOccurrences'),
				replayLimit: parseIntParam(url, 'replayLimit'),
			})
		);
	}

	function handleToolAnalytics(url: URL, filter: AuditFilter): Response {
		return Response.json(
			computeToolUsage(auditLog, manifest, {
				...filter,
				projection: parseProjectionParam(url),
				recentWindowDays: parseIntParam(url, 'recentDays'),
				topCommandsPerTool: parseIntParam(url, 'topCommands'),
			})
		);
	}

	function handleRuleAnalytics(url: URL, filter: AuditFilter): Response {
		return Response.json(
			analyzeRules(manifest, auditLog, {
				...filter,
				projection: parseProjectionParam(url),
				minOccurrences: parseIntParam(url, 'minOccurrences'),
			})
		);
	}

	function handleCoverageAnalytics(url: URL, filter: AuditFilter): Promise<Response> {
		const since = filter.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const sources = scopeCoverageSources(manifest, sessionLogSources, { ...filter, since });
		return computeCoverage(auditLog, sources, {
			...filter,
			since,
			heuristicWindowMs: parseIntParam(url, 'heuristicWindowMs'),
			gapLimit: parseIntParam(url, 'gapLimit'),
		})
			.then((report) => Response.json(report))
			.catch(analyticsError);
	}

	function dispatchAnalytics(url: URL, filter: AuditFilter): Response | Promise<Response> | undefined {
		const callDetail = handleCallDetail(url.pathname);
		if (callDetail) return callDetail;
		if (url.pathname === '/api/analytics/calls') return handleCallExplorer(url, filter);
		if (url.pathname === '/api/analytics/snapshot') return handleAnalyticsSnapshot(url, filter);
		if (url.pathname === '/api/analytics/tools') return handleToolAnalytics(url, filter);
		if (url.pathname === '/api/analytics/rules') return handleRuleAnalytics(url, filter);
		if (url.pathname === '/api/analytics/coverage') return handleCoverageAnalytics(url, filter);
		return undefined;
	}

	function handleAnalytics(url: URL): Response | Promise<Response> | undefined {
		if (!url.pathname.startsWith('/api/analytics/')) return undefined;

		try {
			return dispatchAnalytics(url, parseAuditFilter(url));
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

		if (url.pathname === '/api/policy/status') {
			return Response.json(policyManager.status());
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

		if (url.pathname === '/api/policy/simulate') {
			return handlePolicySimulation(req);
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
		get manifest() {
			return policyManager.manifest;
		},
		get policyStatus() {
			return policyManager.status();
		},
		auditLog,
		evaluate: (call) => policyManager.evaluate(call).result,
		authorize,
		resolveApproval: (approvalRequestId, status) => auditLog.resolveApprovalRequest(approvalRequestId, status),
		listPendingApprovals,
		analyticsSnapshot: (snapshotOptions) => computeAnalyticsSnapshot(auditLog, policyManager.manifest, snapshotOptions),
		reloadPolicy: (manifestPath) => policyManager.reload(manifestPath),
		fetch: handleFetch,
		close: () => auditLog.close(),
	};
}
