import type { ToolCall } from '../core/types.ts';

const DISABLED_HOOK_TIMEOUT_FALLBACK_SECONDS = 86_400;

/**
 * Agent hook schemas do not consistently support Umbod's `0 = disabled`
 * convention. Use a long finite timeout instead of sending an invalid zero.
 */
export function normalizeHookTimeoutSeconds(timeoutSeconds: number): number {
	return timeoutSeconds === 0 ? DISABLED_HOOK_TIMEOUT_FALLBACK_SECONDS : timeoutSeconds;
}

export interface GeneratedHookAsset {
	relativePath: string;
	contents: string;
	executable?: boolean;
}

export interface HookConfigTarget {
	fileName: string;
	settingsPath: string;
	contents: Record<string, unknown> | string;
}

export interface HookInstallOptions {
	url: string;
	outputDir: string;
	timeoutSeconds: number;
	/** Override artifact style when a host generates hooks for another OS. */
	platform?: 'posix' | 'windows';
	/** Override the target user's home directory in generated settings paths. */
	homeDir?: string;
}

export interface HookInstallResult {
	assets: GeneratedHookAsset[];
	config: HookConfigTarget;
}

export interface HookAdapter {
	id: string;
	displayName: string;
	hookEvent: string;
	supportedTools: string[];
	normalizePayload(payload: unknown): ToolCall;
	install(options: HookInstallOptions): HookInstallResult;
}
