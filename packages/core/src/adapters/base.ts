import type { ToolCall } from '../core/types.ts';

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
