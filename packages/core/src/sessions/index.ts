import { readClaudeSessionToolCalls } from './claude-reader.ts';
import { readCodexSessionToolCalls } from './codex-reader.ts';
import type { SessionLogSource, SessionToolCall } from './types.ts';

export async function* readSessionToolCalls(sources: SessionLogSource[]): AsyncGenerator<SessionToolCall> {
	for (const source of sources) {
		if (source.agent === 'claude') yield* readClaudeSessionToolCalls(source);
		else yield* readCodexSessionToolCalls(source);
	}
}

export type { SessionLogSource, SessionToolCall } from './types.ts';
