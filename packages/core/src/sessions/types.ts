export type SessionAgent = 'claude' | 'codex';

export interface SessionToolCall {
	agent: SessionAgent;
	sessionId: string;
	/** Per-call correlation id: "toolu_…" for Claude, "call_…" for Codex. */
	toolUseId?: string;
	/** Canonicalized umbod tool name (bash/read/write/edit/…). */
	tool: string;
	/** Tool name as recorded in the transcript (Bash / exec_command / apply_patch / …). */
	rawToolName: string;
	/** Normalized like the hook path produces, so it can be compared to audit_log.command. */
	command: string;
	timestamp: string;
	cwd?: string;
	sourceFile: string;
	/** Claude only: call came from a subagent transcript. */
	isSubagent?: boolean;
}

export interface SessionLogSource {
	agent: SessionAgent;
	/** Defaults to ~/.claude/projects or ~/.codex/sessions. Embedders (Hlid) can point elsewhere. */
	rootDir?: string;
	/** Filter to sessions whose cwd matches this absolute path. */
	project?: string;
	/** Filter to sessions whose cwd is within one of these absolute roots. */
	projectRoots?: string[];
	/** Always exclude sessions whose cwd is within one of these roots. */
	projectRootExclusions?: string[];
	/**
	 * Additional host-neutral scope boundary. Calls must match both this layer
	 * and projectRoots when both are present.
	 */
	scopeProjectRoots?: string[];
	/**
	 * Roots owned by competing scopes. The most-specific matching scope root or
	 * competing root wins.
	 */
	competingProjectRoots?: string[];
	since?: string;
	until?: string;
	/** Claude only: include subagent transcripts. Default true. */
	includeSubagents?: boolean;
}
