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
}

export interface ServerConfig {
	host: string;
	port: number;
}

export interface WorkspaceConfig {
	/** Opaque host-neutral policy scope identifier. */
	id: string;
	/** Optional absolute filesystem roots used when a caller does not provide workspaceId. */
	roots: string[];
	/** Workspace-specific fallback; inherits policy.default_unknown when omitted. */
	default_unknown?: ApprovalDecision;
	rules: Record<string, ApprovalDecision>;
}

export interface Manifest {
	env: EnvConfig;
	policy: PolicyConfig;
	rules: Record<string, ApprovalDecision>;
	/** Optional for compatibility with manifests created before workspace policy was introduced. */
	workspaces?: WorkspaceConfig[];
	server: ServerConfig;
}

export interface ToolCall {
	agent: string;
	tool: string;
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
	policyScope?: 'global' | 'workspace';
	resolvedWorkspaceId?: string;
	reason: string;
}

export interface AuditEntry extends ToolCall, EvaluationResult {
	id?: number;
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
