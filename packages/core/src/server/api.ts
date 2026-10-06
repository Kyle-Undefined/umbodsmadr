import { findAdapterById } from '../adapters/index.ts';
import { analyzeRules } from '../analytics/rule-analysis.ts';
import { computeCoverage, scopeCoverageSources } from '../analytics/coverage.ts';
import { computeAnalyticsSnapshot } from '../analytics/snapshot.ts';
import { computeToolUsage } from '../analytics/tool-usage.ts';
import { simulatePolicy } from '../analytics/policy-simulation.ts';
import { generateStarterPolicyDraft, type StarterPolicyDraft } from '../analytics/starter-policy.ts';
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
import type {
	AuditCleanupExecution,
	AuditCleanupPreview,
	AuditRetentionPolicy,
	DatabaseCompactionResult,
	DatabaseMaintenanceStatus,
} from '../db/maintenance-types.ts';
import { toPermissionDecision } from '../hooks/adapter-utils.ts';
import { PolicyManager, type PolicyStatus } from '../policy/policy-manager.ts';
import { parseManifestSource } from '../config/manifest.ts';
import { runManifestTests } from '../policy/manifest-tests.ts';
import { lintPolicy, type PolicyLintFinding } from '../policy/policy-lint.ts';
import { resolveTimeParam } from '../utils/duration.ts';
import { errorMessage } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import type { SessionLogSource } from '../sessions/types.ts';
import { parseEvaluatePayload, resolveAgentId } from './parse.ts';
import { inferredOperation } from '../policy/operations.ts';
import { rememberedApprovalKey } from '../policy/remembered-approval.ts';

export interface ActivityEntry extends AuditEntry {
	id: number;
	approvalRequestId?: number;
}

export interface ApprovalResponse {
	decision: ApprovalDecision;
	/** Persist this approved request in Umbod's shared database. */
	persist?: 'always';
	/** User-authored guidance, not permission or a policy reason. */
	userFeedback?: string;
}

export type ApprovalPrompt = (call: ToolCall, reason: string) => Promise<ApprovalDecision | ApprovalResponse>;

// fallow-ignore-next-line complexity -- validates the backward-compatible approval envelope without treating persistence or feedback as permission.
function normalizeApprovalResponse(
	value: ApprovalDecision | ApprovalResponse
): ApprovalResponse & { decision: Exclude<ApprovalDecision, 'approve'> } {
	const decision = typeof value === 'string' ? value : value?.decision;
	return {
		decision: decision === 'allow' ? 'allow' : 'block',
		...(decision === 'allow' && typeof value === 'object' && value?.persist === 'always'
			? { persist: 'always' as const }
			: {}),
		...(typeof value === 'object' && value !== null && typeof value.userFeedback === 'string'
			? { userFeedback: value.userFeedback }
			: {}),
	};
}

export interface AuthorizeOptions {
	/** Per-call host approval UI. Overrides the prompt supplied to createUmbod. */
	approvalPrompt?: ApprovalPrompt;
	/** Treat an approve decision as allowed without prompting, while recording the resolution. */
	bypassApproval?: boolean;
}

export interface AuthorizationResult {
	/** Request-scoped user guidance. Returning this does not prove provider/model consumption. */
	userFeedback?: string;
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
	starterPolicyDraft(options?: { limit?: number; maxRules?: number }): StarterPolicyDraft;
	policyLint(): PolicyLintFinding[];
	databaseStatus(policy?: AuditRetentionPolicy): DatabaseMaintenanceStatus;
	previewDatabaseCleanup(policy: AuditRetentionPolicy): AuditCleanupPreview;
	executeDatabaseCleanup(previewReceipt: string): AuditCleanupExecution;
	compactDatabase(): DatabaseCompactionResult;
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

	function resolvePromptedApproval(
		id: number,
		call: ToolCall,
		response: ApprovalResponse
	): ApprovalResponse | undefined {
		try {
			const key = response.persist === 'always' ? rememberedApprovalKey(policyManager.manifest, call) : undefined;
			if (response.persist === 'always' && !key)
				throw new Error('Always requires an absolute working directory and a resolved workspace');
			const changed = auditLog.resolveApprovalRequest(
				id,
				decisionToApprovalStatus(response.decision),
				new Date().toISOString(),
				key ? { key, call } : undefined
			);
			return changed ? response : undefined;
		} catch (error: unknown) {
			const failure: ApprovalResponse = {
				decision: 'block',
				userFeedback: `Always approval could not be saved: ${errorMessage(error)}`,
			};
			return auditLog.resolveApprovalRequest(id, 'denied') ? failure : undefined;
		}
	}

	function publishEntry(call: ToolCall, result: EvaluationResult, status: PolicyStatus): ActivityEntry {
		const provenance = { policyHash: status.activeHash, policyGeneration: status.generation };
		const { entryId, approvalRequestId } = auditLog.append(call, result, provenance);
		const entry: ActivityEntry = {
			id: entryId,
			...call,
			...result,
			...provenance,
			approvalRequestId,
		};

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
				logger.warn('approval request timed out', {
					approvalRequestId,
					timeoutMs: approvalTimeoutMs,
				});
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
	): Promise<ApprovalResponse> {
		if (approvalPrompt && approvalMethod === 'cli') {
			// Prompt only: resolve the DB record directly from the prompt's answer
			const response = normalizeApprovalResponse(await approvalPrompt(call, reason));
			return (
				resolvePromptedApproval(approvalRequestId, call, response) ?? {
					decision: await waitForApprovalResolution(approvalRequestId, approvalTimeoutMs),
				}
			);
		}

		if (approvalPrompt && approvalMethod === 'both') {
			let winningResponse: ApprovalResponse | undefined;
			let finished = false;
			// Both: prompt runs in background and resolves the DB; polling is the gate
			void approvalPrompt(call, reason)
				.then((value) => {
					if (finished) return;
					const response = normalizeApprovalResponse(value);
					winningResponse = resolvePromptedApproval(approvalRequestId, call, response);
				})
				.catch((error: unknown) => {
					logger.warn('failed to resolve prompted approval request', {
						approvalRequestId,
						error: errorMessage(error),
					});
				});
			try {
				const decision = await waitForApprovalResolution(approvalRequestId, approvalTimeoutMs);
				return winningResponse ?? { decision };
			} finally {
				finished = true;
			}
		}

		// "web" (or no prompt wired up): wait for the DB record to be resolved externally
		return { decision: await waitForApprovalResolution(approvalRequestId, approvalTimeoutMs) };
	}

	// fallow-ignore-next-line complexity -- ordered policy, remembered-grant and approval resolution gates retain block precedence and atomic persistence.
	async function authorize(call: ToolCall, callOptions: AuthorizeOptions = {}): Promise<AuthorizationResult> {
		const normalizedCall = call.operation ? call : { ...call, operation: inferredOperation(call.tool, call.command) };
		const evaluation = policyManager.evaluate(normalizedCall);
		const key = rememberedApprovalKey(evaluation.manifest, normalizedCall);
		const result =
			evaluation.result.decision === 'approve' && key && auditLog.hasRememberedApproval(key)
				? {
						...evaluation.result,
						decision: 'allow' as const,
						reason: 'Allowed by a remembered Umbod approval',
					}
				: evaluation.result;
		const entry = publishEntry(normalizedCall, result, evaluation.status);
		let response: ApprovalResponse;

		if (result.decision !== 'approve') {
			response = { decision: result.decision };
		} else if (!entry.approvalRequestId) {
			response = { decision: 'block' };
		} else if (callOptions.bypassApproval) {
			auditLog.resolveApprovalRequest(entry.approvalRequestId, 'approved');
			response = { decision: 'allow' };
		} else if (callOptions.approvalPrompt) {
			response = normalizeApprovalResponse(await callOptions.approvalPrompt(normalizedCall, result.reason));
			response = resolvePromptedApproval(entry.approvalRequestId, normalizedCall, response) ?? {
				decision: await waitForApprovalResolution(
					entry.approvalRequestId,
					configuredApprovalTimeoutMs ?? evaluation.manifest.env.timeout * 1000
				),
			};
		} else {
			response = await resolveApprovalDecision(
				entry.approvalRequestId,
				normalizedCall,
				result.reason,
				evaluation.manifest.policy.approval_method,
				configuredApprovalTimeoutMs ?? evaluation.manifest.env.timeout * 1000
			);
		}

		return {
			entry,
			policyDecision: evaluation.result.decision,
			...normalizeApprovalResponse(response),
		};
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
			{
				ok: resolved,
				approvalRequestId: approvalId,
				status,
				resolvedAt: resolved ? resolvedAt : undefined,
			},
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

	// fallow-ignore-next-line complexity -- one read-only request boundary keeps candidate and replay validation atomic.
	async function handlePolicySimulation(req: Request): Promise<Response> {
		try {
			const body = (await req.json()) as Record<string, unknown>;
			if (typeof body.candidate !== 'string' || !body.candidate.trim()) {
				throw new Error('candidate must be a non-empty TOML string');
			}
			if (body.all !== undefined && typeof body.all !== 'boolean') {
				throw new Error('all must be a boolean');
			}
			const all = body.all === true;
			if (all && body.limit !== undefined) {
				throw new Error('policy simulation accepts either all or limit, not both');
			}
			const limit = body.limit === undefined ? 2000 : body.limit;
			if (!all && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100_000)) {
				throw new Error('limit must be an integer between 1 and 100000');
			}
			const candidate = parseManifestSource(body.candidate, 'dashboard candidate');
			return Response.json({
				...simulatePolicy(
					policyManager.manifest,
					candidate,
					auditLog,
					all ? { all: true } : { limit: limit as number }
				),
				manifestTests: runManifestTests(candidate),
			});
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
			const result = await authorize(call);

			const body = {
				permissionDecision: toPermissionDecision(result.decision),
				policyDecision: result.policyDecision,
				policyReason: result.entry.reason,
				...(result.userFeedback !== undefined ? { userFeedback: result.userFeedback } : {}),
				permissionDecisionReason:
					result.decision === 'block' && result.userFeedback !== undefined
						? `${result.entry.reason}\n\nUser feedback:\n${result.userFeedback}`
						: result.entry.reason,
				hookSpecificOutput: {
					hookEventName: adapter.hookEvent,
				},
			};

			// Successful hooks respond 200; the selected wire format carries the decision.
			if (url.searchParams.get('format') === 'command-v1') {
				return new Response(
					body.permissionDecision === 'allow'
						? 'umbod-hook-v1 allow'
						: `umbod-hook-v1 deny ${JSON.stringify(body.permissionDecisionReason).replaceAll('\u007f', '\\u007f')}`,
					{ headers: { 'content-type': 'text/plain; charset=utf-8' } }
				);
			}
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

	function sameOriginMaintenanceMutation(req: Request): Response | undefined {
		const origin = req.headers.get('origin');
		if (origin !== null && origin !== new URL(req.url).origin) {
			return Response.json({ ok: false, error: 'cross-origin database maintenance is not allowed' }, { status: 403 });
		}
		return undefined;
	}

	function retentionFromRecord(body: Record<string, unknown>): AuditRetentionPolicy {
		if (typeof body.olderThanDays !== 'number') throw new Error('olderThanDays must be a number');
		if (body.preservePendingApprovals !== undefined && body.preservePendingApprovals !== true) {
			throw new Error('preservePendingApprovals must be true');
		}
		return { olderThanDays: body.olderThanDays, preservePendingApprovals: true };
	}

	// fallow-ignore-next-line complexity -- one bounded mutation router keeps origin, body, receipt, and execute gates together.
	async function handleDatabasePost(req: Request, url: URL): Promise<Response> {
		try {
			const forbidden = sameOriginMaintenanceMutation(req);
			if (forbidden) return forbidden;
			const body = (await req.json()) as Record<string, unknown>;
			if (url.pathname === '/api/database/cleanup/preview') {
				return Response.json(auditLog.previewCleanup(retentionFromRecord(body)));
			}
			if (url.pathname === '/api/database/cleanup') {
				if (body.execute !== true) throw new Error('cleanup execution requires execute: true');
				if (typeof body.previewReceipt !== 'string') throw new Error('previewReceipt must be a string');
				if (body.olderThanDays !== undefined && typeof body.olderThanDays !== 'number') {
					throw new Error('olderThanDays must be a number');
				}
				return Response.json(
					auditLog.executeCleanup({
						previewReceipt: body.previewReceipt,
						olderThanDays: body.olderThanDays as number | undefined,
						execute: true,
					})
				);
			}
			if (url.pathname === '/api/database/compact') {
				if (body.execute !== true) throw new Error('database compaction requires execute: true');
				return Response.json(auditLog.compactDatabase({ execute: true }));
			}
			return Response.json({ ok: false, error: 'database maintenance route not found' }, { status: 404 });
		} catch (error: unknown) {
			const message = errorMessage(error);
			return Response.json({ ok: false, error: message }, { status: message.includes('stale') ? 409 : 400 });
		}
	}

	function handleDatabaseRoute(req: Request, url: URL): Response | Promise<Response> | undefined {
		if (!url.pathname.startsWith('/api/database/')) return undefined;
		if (url.pathname === '/api/database/status' && req.method === 'GET') {
			try {
				const value = url.searchParams.get('olderThanDays');
				return Response.json(auditLog.databaseStatus(value === null ? undefined : { olderThanDays: Number(value) }));
			} catch (error: unknown) {
				return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 });
			}
		}
		if (req.method === 'POST') return handleDatabasePost(req, url);
		return Response.json({ ok: false, error: 'method not allowed' }, { status: 405, headers: { allow: 'GET, POST' } });
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
		if (url.pathname === '/api/policy/lint') {
			return Response.json({ findings: lintPolicy(policyManager.manifest) });
		}
		if (url.pathname === '/api/policy/draft') {
			try {
				return Response.json(
					generateStarterPolicyDraft(auditLog, {
						limit: parseIntParam(url, 'limit'),
						maxRules: parseIntParam(url, 'maxRules'),
						name: `${policyManager.manifest.env.name}-draft`,
					})
				);
			} catch (error: unknown) {
				return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 });
			}
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
		const databaseRoute = handleDatabaseRoute(req, url);
		if (databaseRoute) return databaseRoute;
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
		starterPolicyDraft: (draftOptions) =>
			generateStarterPolicyDraft(auditLog, {
				...draftOptions,
				name: `${policyManager.manifest.env.name}-draft`,
			}),
		policyLint: () => lintPolicy(policyManager.manifest),
		databaseStatus: (policy) => auditLog.databaseStatus(policy),
		previewDatabaseCleanup: (policy) => auditLog.previewCleanup(policy),
		executeDatabaseCleanup: (previewReceipt) => auditLog.executeCleanup({ previewReceipt, execute: true }),
		compactDatabase: () => auditLog.compactDatabase({ execute: true }),
		reloadPolicy: (manifestPath) => policyManager.reload(manifestPath),
		fetch: handleFetch,
		close: () => auditLog.close(),
	};
}
