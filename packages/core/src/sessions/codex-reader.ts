import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { codexAdapter } from '../adapters/codex.ts';
import { isRecord } from '../utils/guards.ts';
import { jsonlRecords } from './jsonl.ts';
import type { SessionLogSource, SessionToolCall } from './types.ts';

function stringAt(value: unknown, key: string): string | undefined {
	return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

function sourceFiles(rootDir: string, source: SessionLogSource): string[] {
	if (!existsSync(rootDir)) return [];
	const files: string[] = [];
	for (const year of readdirSync(rootDir, { withFileTypes: true })) {
		if (!year.isDirectory()) continue;
		for (const month of readdirSync(path.join(rootDir, year.name), { withFileTypes: true })) {
			if (!month.isDirectory()) continue;
			for (const day of readdirSync(path.join(rootDir, year.name, month.name), { withFileTypes: true })) {
				if (!day.isDirectory()) continue;
				const dayStart = `${year.name}-${month.name}-${day.name}T00:00:00.000Z`;
				const dayEnd = `${year.name}-${month.name}-${day.name}T23:59:59.999Z`;
				if ((source.since && dayEnd < source.since) || (source.until && dayStart > source.until)) continue;
				const dir = path.join(rootDir, year.name, month.name, day.name);
				for (const entry of readdirSync(dir, { withFileTypes: true })) {
					if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(path.join(dir, entry.name));
				}
			}
		}
	}
	return files;
}

function parsedArguments(value: unknown): Record<string, unknown> {
	if (typeof value !== 'string') return isRecord(value) ? value : {};
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function normalizedCall(
	rawToolName: string,
	input: Record<string, unknown>,
	sessionId: string,
	cwd: string | undefined,
	toolUseId: string | undefined
) {
	return codexAdapter.normalizePayload({
		tool_name: rawToolName,
		arguments: input,
		tool_input: input,
		cwd,
		session_id: sessionId,
		call_id: toolUseId,
	});
}

export async function* readCodexSessionToolCalls(source: SessionLogSource): AsyncGenerator<SessionToolCall> {
	const rootDir = source.rootDir ?? path.join(homedir(), '.codex', 'sessions');
	for (const file of sourceFiles(rootDir, source)) {
		let sessionId: string | undefined;
		let cwd: string | undefined;
		const emittedCallIds = new Set<string>();
		for await (const record of jsonlRecords(file)) {
			if (!isRecord(record)) continue;
			const timestamp = stringAt(record, 'timestamp');
			const payload = isRecord(record.payload) ? record.payload : undefined;
			if (record.type === 'session_meta' && payload) {
				sessionId = stringAt(payload, 'id');
				cwd = stringAt(payload, 'cwd');
				continue;
			}
			if (!timestamp || !sessionId || !payload || (source.project && cwd !== source.project)) continue;
			if (source.since && timestamp < source.since) continue;
			if (source.until && timestamp > source.until) continue;

			let rawToolName: string | undefined;
			let input: Record<string, unknown> = {};
			let toolUseId: string | undefined;
			if (record.type === 'response_item' && payload.type === 'function_call') {
				rawToolName = stringAt(payload, 'name');
				input = parsedArguments(payload.arguments);
				toolUseId = stringAt(payload, 'call_id');
			} else if (record.type === 'response_item' && payload.type === 'custom_tool_call') {
				rawToolName = stringAt(payload, 'name');
				const customInput = stringAt(payload, 'input');
				input = customInput ? { command: customInput } : {};
				toolUseId = stringAt(payload, 'call_id') ?? stringAt(payload, 'id');
			} else if (record.type === 'event_msg' && payload.type === 'patch_apply_end') {
				rawToolName = 'apply_patch';
				toolUseId = stringAt(payload, 'call_id');
				// Modern rollouts record both the originating custom_tool_call and
				// its completion event. The latter is only a fallback for older logs.
				if (toolUseId && emittedCallIds.has(toolUseId)) continue;
			}
			if (!rawToolName) continue;
			const normalized = normalizedCall(rawToolName, input, sessionId, cwd, toolUseId);
			yield {
				agent: 'codex',
				sessionId,
				toolUseId: normalized.toolUseId,
				tool: normalized.tool,
				rawToolName,
				command: normalized.command,
				timestamp,
				cwd,
				sourceFile: file,
			};
			if (toolUseId) emittedCallIds.add(toolUseId);
		}
	}
}
