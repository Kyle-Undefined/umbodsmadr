import type { HookAdapter } from './base.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { cursorAdapter } from './cursor.ts';
import { geminiAdapter } from './gemini.ts';

export const adapters: HookAdapter[] = [claudeAdapter, cursorAdapter, codexAdapter, geminiAdapter];

/** Returns all adapters, or only those matching the given agent id. */
export function selectAdapters(agent?: string): HookAdapter[] {
	if (!agent) {
		return adapters;
	}

	return adapters.filter((adapter) => adapter.id === agent);
}

/** Returns the adapter for the given agent id, or undefined if not found. */
export function findAdapterById(agent: string): HookAdapter | undefined {
	return adapters.find((adapter) => adapter.id === agent);
}
