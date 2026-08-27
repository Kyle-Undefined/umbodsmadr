export type ApprovalDecision = 'allow' | 'block' | 'approve';

export type ApprovalMethod = 'web' | 'cli' | 'both';

export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export type CallClassification = 'readonly' | 'destructive' | 'external' | 'stateful' | 'unknown';

export interface EnvConfig {
	name: string;
	version: string;
	timeout: number;
}

export interface PolicyConfig {
	default_unknown: ApprovalDecision;
	approval_method: ApprovalMethod;
	/** Optional classification-specific defaults. Missing entries use default_unknown. */
	defaults?: Partial<Record<CallClassification, ApprovalDecision>>;
}

export interface ServerConfig {
	host: string;
	port: number;
}

export interface AuditConfig {
	/** Default used by explicit maintenance preview commands; never schedules deletion by itself. */
	retentionDays?: number;
	/** Default for an explicitly requested post-cleanup compaction step. */
	compactAfterCleanup?: boolean;
}

export interface StructuredRuleSelectors {
	/** Match any listed tool name. */
	tools?: string[];
	/** Match any listed command pattern using Umbod's existing glob/regex syntax. */
	commands?: string[];
	/** Match when at least one parsed shell component matches a listed pattern. */
	componentsAny?: string[];
	/** Match when every parsed shell component matches at least one listed pattern. */
	componentsAll?: string[];
	/** Restrict a shell rule to compound or single-component invocations. */
	compound?: boolean;
	/** Match any listed operation target path using Umbod's existing glob/regex syntax. */
	paths?: string[];
	/** Match only when every extracted affected path matches a listed pattern. */
	pathsAll?: string[];
	/** Match any listed classifier result. */
	classifications?: CallClassification[];
	/** Match any listed agent name. */
	agents?: string[];
	/** Match a trusted canonical host operation ID. */
	operations?: string[];
	/** Match the effective resolved workspace ID. */
	workspaces?: string[];
}

export interface AffectedPath {
	path: string;
	access: 'read' | 'write' | 'delete' | 'unknown';
	source: 'provider-input' | 'apply-patch' | 'shell-redirection' | 'command';
}

export interface StructuredRule extends StructuredRuleSelectors {
	id: string;
	decision: ApprovalDecision;
	reason?: string;
	mode?: 'enforce' | 'warn' | 'observe';
	expiresAt?: string;
	maxUses?: number;
	selectorMode?: 'all' | 'any';
	priority?: number;
}

export interface PolicyGuard extends StructuredRuleSelectors {
	id: string;
	/** Guards are invariants and may only block. */
	decision: 'block';
	reason?: string;
	mode?: 'enforce' | 'warn' | 'observe';
	expiresAt?: string;
	maxUses?: number;
	selectorMode?: 'all' | 'any';
	priority?: number;
}

export interface ManifestPolicyTest {
	id?: string;
	call: Omit<ToolCall, 'timestamp'> & { timestamp?: string };
	expect: ApprovalDecision;
}

export interface WorkspaceConfig {
	/** Opaque host-neutral policy scope identifier. */
	id: string;
	/** Optional absolute filesystem roots used when a caller does not provide workspaceId. */
	roots: string[];
	/** Workspace-specific fallback; inherits policy.default_unknown when omitted. */
	default_unknown?: ApprovalDecision;
	/** Workspace classification defaults; missing entries inherit the workspace alias, then global defaults. */
	defaults?: Partial<Record<CallClassification, ApprovalDecision>>;
	rules: Record<string, ApprovalDecision>;
	/** Ordered structured rules evaluated before this workspace's legacy rule table. */
	structuredRules?: StructuredRule[];
	/** Block-only workspace invariants evaluated after global guards. */
	guards?: PolicyGuard[];
}

export interface Manifest {
	env: EnvConfig;
	policy: PolicyConfig;
	rules: Record<string, ApprovalDecision>;
	/** Ordered structured rules evaluated before the legacy global rule table. */
	structuredRules?: StructuredRule[];
	/** Block-only global invariants that workspace policy cannot relax. */
	guards?: PolicyGuard[];
	/** Optional for compatibility with manifests created before workspace policy was introduced. */
	workspaces?: WorkspaceConfig[];
	tests?: ManifestPolicyTest[];
	server: ServerConfig;
	audit?: AuditConfig;
}

export interface ToolCall {
	agent: string;
	tool: string;
	/** Trusted canonical host/adaptor operation ID. */
	operation?: string;
	command: string;
	args?: string[];
	workingDirectory?: string;
	/** Explicit host-selected policy scope. Opaque to Umbod. */
	workspaceId?: string;
	inputs?: Record<string, unknown>;
	timestamp: string;
	sessionId?: string;
	toolUseId?: string;
}

export interface EvaluationResult {
	decision: ApprovalDecision;
	classification: CallClassification;
	matchedRule?: string;
	matchedRuleMode?: 'enforce' | 'warn';
	matchedSelectors?: string[];
	policyScope?: 'global' | 'workspace';
	resolvedWorkspaceId?: string;
	reason: string;
}

export interface AuditEntry extends ToolCall, EvaluationResult {
	id?: number;
	policyHash?: string;
	policyGeneration?: number;
	approvalStatus?: ApprovalStatus;
	approvalResolvedAt?: string;
}

/** An audit entry read back from persistent storage. */
export interface StoredAuditEntry extends AuditEntry {
	id: number;
}

export interface ApprovalRequest {
	id: number;
	auditLogId: number;
	status: ApprovalStatus;
	createdAt: string;
	resolvedAt?: string;
	entry: AuditEntry;
}

export interface StartOptions {
	envPath?: string;
	port?: number;
	host?: string;
}

export interface ConfigureOptions {
	agent?: string;
	outputDir?: string;
	url?: string;
}

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 9090;
