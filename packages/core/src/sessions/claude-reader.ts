import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { claudeAdapter } from '../adapters/claude.ts';
import { isRecord } from '../utils/guards.ts';
import { jsonlRecords } from './jsonl.ts';
import { stringAt, timestampInSourceWindow } from './record-utils.ts';
import { sessionSourceMatchesCwd } from './source-filter.ts';
import type { SessionLogSource, SessionToolCall } from './types.ts';

function projectDirectory(rootDir: string, project: string): string {
	return path.join(rootDir, project.replaceAll(/[/.]/g, '-'));
}

function eligibleFile(file: string, source: SessionLogSource): boolean {
	const stat = statSync(file);
	if (source.since && stat.mtimeMs < new Date(source.since).getTime()) return false;
	return true;
}

function contentItems(record: Record<string, unknown>): unknown[] {
	const message = record.message;
	return isRecord(message) && Array.isArray(message.content) ? message.content : [];
}

interface ClaudeTranscriptFile {
	file: string;
	isSubagent: boolean;
}

interface ClaudeRecordContext {
	timestamp: string;
	sessionId: string;
	cwd?: string;
}

function projectDirectories(rootDir: string, source: SessionLogSource): string[] {
	return source.project
		? [projectDirectory(rootDir, source.project)]
		: existsSync(rootDir)
			? readdirSync(rootDir, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => path.join(rootDir, entry.name))
			: [];
}

function directTranscriptFiles(directory: string): ClaudeTranscriptFile[] {
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
		.map((entry) => ({ file: path.join(directory, entry.name), isSubagent: false }));
}

function subagentTranscriptFiles(directory: string): ClaudeTranscriptFile[] {
	const files: ClaudeTranscriptFile[] = [];
	for (const sessionDir of readdirSync(directory, { withFileTypes: true })) {
		const subagentDir = path.join(directory, sessionDir.name, 'subagents');
		if (!sessionDir.isDirectory() || !existsSync(subagentDir)) continue;
		for (const entry of readdirSync(subagentDir, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith('.jsonl')) {
				files.push({ file: path.join(subagentDir, entry.name), isSubagent: true });
			}
		}
	}
	return files;
}

function transcriptFiles(directory: string, includeSubagents: boolean): ClaudeTranscriptFile[] {
	const files = directTranscriptFiles(directory);
	return includeSubagents ? files.concat(subagentTranscriptFiles(directory)) : files;
}

function recordContext(
	record: unknown,
	source: SessionLogSource
): { record: Record<string, unknown>; context: ClaudeRecordContext } | undefined {
	if (!isRecord(record) || record.type !== 'assistant') return undefined;
	const timestamp = stringAt(record, 'timestamp');
	const sessionId = stringAt(record, 'sessionId');
	if (!timestamp || !sessionId || !timestampInSourceWindow(timestamp, source)) return undefined;
	const cwd = stringAt(record, 'cwd');
	if (!sessionSourceMatchesCwd(source, cwd)) return undefined;
	return { record, context: { timestamp, sessionId, cwd } };
}

function toolCall(
	item: unknown,
	context: ClaudeRecordContext,
	file: string,
	isSubagent: boolean
): SessionToolCall | undefined {
	if (!isRecord(item) || item.type !== 'tool_use') return undefined;
	const rawToolName = stringAt(item, 'name');
	if (!rawToolName) return undefined;
	const input = isRecord(item.input) ? item.input : {};
	const normalized = claudeAdapter.normalizePayload({
		tool_name: rawToolName,
		tool_input: input,
		cwd: context.cwd,
		session_id: context.sessionId,
		tool_use_id: stringAt(item, 'id'),
	});
	return {
		agent: 'claude',
		sessionId: context.sessionId,
		toolUseId: normalized.toolUseId,
		tool: normalized.tool,
		rawToolName,
		command: normalized.command,
		timestamp: context.timestamp,
		cwd: context.cwd,
		sourceFile: file,
		isSubagent,
	};
}

function recordToolCalls(
	record: unknown,
	source: SessionLogSource,
	file: string,
	isSubagent: boolean
): SessionToolCall[] {
	const parsed = recordContext(record, source);
	if (!parsed) return [];
	return contentItems(parsed.record).flatMap((item) => {
		const call = toolCall(item, parsed.context, file, isSubagent);
		return call ? [call] : [];
	});
}

export async function* readClaudeSessionToolCalls(source: SessionLogSource): AsyncGenerator<SessionToolCall> {
	const rootDir = source.rootDir ?? path.join(homedir(), '.claude', 'projects');
	for (const directory of projectDirectories(rootDir, source)) {
		if (!existsSync(directory)) continue;
		const files = transcriptFiles(directory, source.includeSubagents !== false);
		for (const { file, isSubagent } of files) {
			if (!eligibleFile(file, source)) continue;
			for await (const record of jsonlRecords(file)) {
				yield* recordToolCalls(record, source, file, isSubagent);
			}
		}
	}
}
