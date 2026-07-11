import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { claudeAdapter } from '../adapters/claude.ts';
import { isRecord } from '../utils/guards.ts';
import { jsonlRecords } from './jsonl.ts';
import type { SessionLogSource, SessionToolCall } from './types.ts';

function projectDirectory(rootDir: string, project: string): string {
	return path.join(rootDir, project.replaceAll(/[/.]/g, '-'));
}

function eligibleFile(file: string, source: SessionLogSource): boolean {
	const stat = statSync(file);
	if (source.since && stat.mtimeMs < new Date(source.since).getTime()) return false;
	return true;
}

function stringAt(value: unknown, key: string): string | undefined {
	return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

function contentItems(record: Record<string, unknown>): unknown[] {
	const message = record.message;
	return isRecord(message) && Array.isArray(message.content) ? message.content : [];
}

export async function* readClaudeSessionToolCalls(source: SessionLogSource): AsyncGenerator<SessionToolCall> {
	const rootDir = source.rootDir ?? path.join(homedir(), '.claude', 'projects');
	const directories = source.project
		? [projectDirectory(rootDir, source.project)]
		: existsSync(rootDir)
			? readdirSync(rootDir, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => path.join(rootDir, entry.name))
			: [];

	for (const directory of directories) {
		if (!existsSync(directory)) continue;
		const files = readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
			.map((entry) => ({ file: path.join(directory, entry.name), isSubagent: false }));
		if (source.includeSubagents !== false) {
			for (const sessionDir of readdirSync(directory, { withFileTypes: true })) {
				const subagentDir = path.join(directory, sessionDir.name, 'subagents');
				if (!sessionDir.isDirectory() || !existsSync(subagentDir)) continue;
				for (const entry of readdirSync(subagentDir, { withFileTypes: true })) {
					if (entry.isFile() && entry.name.endsWith('.jsonl')) {
						files.push({ file: path.join(subagentDir, entry.name), isSubagent: true });
					}
				}
			}
		}

		for (const { file, isSubagent } of files) {
			if (!eligibleFile(file, source)) continue;
			for await (const record of jsonlRecords(file)) {
				if (!isRecord(record) || record.type !== 'assistant') continue;
				const timestamp = stringAt(record, 'timestamp');
				const sessionId = stringAt(record, 'sessionId');
				if (!timestamp || !sessionId) continue;
				const cwd = stringAt(record, 'cwd');
				if (source.project && cwd !== source.project) continue;
				if (source.since && timestamp < source.since) continue;
				if (source.until && timestamp > source.until) continue;
				for (const item of contentItems(record)) {
					if (!isRecord(item) || item.type !== 'tool_use') continue;
					const rawToolName = stringAt(item, 'name');
					if (!rawToolName) continue;
					const input = isRecord(item.input) ? item.input : {};
					const normalized = claudeAdapter.normalizePayload({
						tool_name: rawToolName,
						tool_input: input,
						cwd,
						session_id: sessionId,
						tool_use_id: stringAt(item, 'id'),
					});
					yield {
						agent: 'claude',
						sessionId,
						toolUseId: normalized.toolUseId,
						tool: normalized.tool,
						rawToolName,
						command: normalized.command,
						timestamp,
						cwd,
						sourceFile: file,
						isSubagent,
					};
				}
			}
		}
	}
}
