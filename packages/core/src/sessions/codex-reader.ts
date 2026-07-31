import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { codexAdapter } from '../adapters/codex.ts';
import { isRecord } from '../utils/guards.ts';
import { jsonlRecords } from './jsonl.ts';
import { stringAt, timestampInSourceWindow } from './record-utils.ts';
import { sessionSourceMatchesCwd } from './source-filter.ts';
import type { SessionLogSource, SessionToolCall } from './types.ts';

function childDirectories(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(directory, entry.name));
}

function dayInSourceWindow(directory: string, source: SessionLogSource): boolean {
	const day = path.basename(directory);
	const month = path.basename(path.dirname(directory));
	const year = path.basename(path.dirname(path.dirname(directory)));
	const dayStart = `${year}-${month}-${day}T00:00:00.000Z`;
	const dayEnd = `${year}-${month}-${day}T23:59:59.999Z`;
	return !(source.since && dayEnd < source.since) && !(source.until && dayStart > source.until);
}

function sourceFiles(rootDir: string, source: SessionLogSource): string[] {
	const dayDirectories = childDirectories(rootDir).flatMap((year) =>
		childDirectories(year).flatMap((month) => childDirectories(month))
	);
	return dayDirectories
		.filter((day) => dayInSourceWindow(day, source))
		.flatMap((directory) =>
			readdirSync(directory, { withFileTypes: true })
				.filter((entry) => entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name))
				.map((entry) => path.join(directory, entry.name))
		);
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

interface CodexReaderState {
	sessionId?: string;
	cwd?: string;
	emittedCallIds: Set<string>;
}

interface RawCodexCall {
	rawToolName: string;
	input: Record<string, unknown>;
	toolUseId?: string;
}

interface ParsedCodexCall {
	raw: RawCodexCall;
	timestamp: string;
}

function updateSessionState(
	record: Record<string, unknown>,
	payload: Record<string, unknown> | undefined,
	state: CodexReaderState
): boolean {
	if (record.type !== 'session_meta' || !payload) return false;
	state.sessionId = stringAt(payload, 'id');
	state.cwd = stringAt(payload, 'cwd');
	return true;
}

function functionCall(payload: Record<string, unknown>): RawCodexCall | undefined {
	const rawToolName = stringAt(payload, 'name');
	return rawToolName
		? {
				rawToolName,
				input: parsedArguments(payload.arguments),
				toolUseId: stringAt(payload, 'call_id'),
			}
		: undefined;
}

function customToolCall(payload: Record<string, unknown>): RawCodexCall | undefined {
	const rawToolName = stringAt(payload, 'name');
	const customInput = stringAt(payload, 'input');
	return rawToolName
		? {
				rawToolName,
				input: customInput ? { command: customInput } : {},
				toolUseId: stringAt(payload, 'call_id') ?? stringAt(payload, 'id'),
			}
		: undefined;
}

function patchCompletionCall(payload: Record<string, unknown>, state: CodexReaderState): RawCodexCall | undefined {
	const toolUseId = stringAt(payload, 'call_id');
	return toolUseId && state.emittedCallIds.has(toolUseId)
		? undefined
		: { rawToolName: 'apply_patch', input: {}, toolUseId };
}

function rawCodexCall(
	record: Record<string, unknown>,
	payload: Record<string, unknown>,
	state: CodexReaderState
): RawCodexCall | undefined {
	if (record.type === 'response_item' && payload.type === 'function_call') return functionCall(payload);
	if (record.type === 'response_item' && payload.type === 'custom_tool_call') return customToolCall(payload);
	if (record.type === 'event_msg' && payload.type === 'patch_apply_end') return patchCompletionCall(payload, state);
	return undefined;
}

function sessionToolCall(raw: RawCodexCall, state: CodexReaderState, timestamp: string, file: string): SessionToolCall {
	const sessionId = state.sessionId as string;
	const normalized = normalizedCall(raw.rawToolName, raw.input, sessionId, state.cwd, raw.toolUseId);
	return {
		agent: 'codex',
		sessionId,
		toolUseId: normalized.toolUseId,
		tool: normalized.tool,
		rawToolName: raw.rawToolName,
		command: normalized.command,
		timestamp,
		cwd: state.cwd,
		sourceFile: file,
	};
}

function sessionContextIsEligible(source: SessionLogSource, state: CodexReaderState, timestamp: string): boolean {
	if (!state.sessionId) return false;
	if (!sessionSourceMatchesCwd(source, state.cwd)) return false;
	return timestampInSourceWindow(timestamp, source);
}

function parsedCall(record: unknown, source: SessionLogSource, state: CodexReaderState): ParsedCodexCall | undefined {
	if (!isRecord(record)) return undefined;
	const payload = isRecord(record.payload) ? record.payload : undefined;
	if (updateSessionState(record, payload, state)) return undefined;
	const timestamp = stringAt(record, 'timestamp');
	if (!timestamp) return undefined;
	if (!payload) return undefined;
	if (!sessionContextIsEligible(source, state, timestamp)) return undefined;
	const raw = rawCodexCall(record, payload, state);
	return raw ? { raw, timestamp } : undefined;
}

export async function* readCodexSessionToolCalls(source: SessionLogSource): AsyncGenerator<SessionToolCall> {
	const rootDir = source.rootDir ?? path.join(homedir(), '.codex', 'sessions');
	for (const file of sourceFiles(rootDir, source)) {
		const state: CodexReaderState = { emittedCallIds: new Set<string>() };
		for await (const record of jsonlRecords(file)) {
			const parsed = parsedCall(record, source, state);
			if (!parsed) continue;
			yield sessionToolCall(parsed.raw, state, parsed.timestamp, file);
			if (parsed.raw.toolUseId) state.emittedCallIds.add(parsed.raw.toolUseId);
		}
	}
}
