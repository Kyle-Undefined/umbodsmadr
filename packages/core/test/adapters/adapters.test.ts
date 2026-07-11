import { describe, expect, test } from 'bun:test';
import { claudeAdapter } from '../../src/adapters/claude.ts';
import { cursorAdapter } from '../../src/adapters/cursor.ts';
import { codexAdapter } from '../../src/adapters/codex.ts';
import { geminiAdapter } from '../../src/adapters/gemini.ts';
import { adapters, findAdapterById, selectAdapters } from '../../src/adapters/index.ts';
import type { HookAdapter } from '../../src/adapters/base.ts';

// ── Adapter registry ─────────────────────────────────────────

describe('adapter registry', () => {
	test('all four adapters registered', () => {
		expect(adapters).toHaveLength(4);
		expect(adapters.map((a) => a.id)).toEqual(['claude', 'cursor', 'codex', 'gemini']);
	});

	test('findAdapterById returns correct adapter', () => {
		expect(findAdapterById('claude')).toBe(claudeAdapter);
		expect(findAdapterById('cursor')).toBe(cursorAdapter);
		expect(findAdapterById('codex')).toBe(codexAdapter);
		expect(findAdapterById('gemini')).toBe(geminiAdapter);
	});

	test('findAdapterById returns undefined for unknown', () => {
		expect(findAdapterById('vscode')).toBeUndefined();
	});

	test('selectAdapters with no arg returns all', () => {
		expect(selectAdapters()).toHaveLength(4);
	});

	test('selectAdapters with specific agent returns single', () => {
		expect(selectAdapters('claude')).toHaveLength(1);
		expect(selectAdapters('claude')[0]).toBe(claudeAdapter);
	});

	test('selectAdapters with unknown agent returns empty', () => {
		expect(selectAdapters('vscode')).toHaveLength(0);
	});
});

// ── Claude adapter ───────────────────────────────────────────

describe('claude adapter', () => {
	test('metadata', () => {
		expect(claudeAdapter.id).toBe('claude');
		expect(claudeAdapter.hookEvent).toBe('PreToolUse');
		expect(claudeAdapter.supportedTools).toContain('bash');
	});

	test('normalizes PreToolUse payload', () => {
		const call = claudeAdapter.normalizePayload({
			tool_name: 'Bash',
			tool_input: { command: 'git status' },
			cwd: '/home/user/project',
		});
		expect(call.agent).toBe('claude');
		expect(call.tool).toBe('bash');
		expect(call.command).toBe('git status');
		expect(call.workingDirectory).toBe('/home/user/project');
	});

	test('normalizes camelCase variant', () => {
		const call = claudeAdapter.normalizePayload({
			toolName: 'Read',
			tool_input: { file_path: '/tmp/file.txt' },
		});
		expect(call.tool).toBe('read');
		expect(call.command).toBe('read /tmp/file.txt');
	});

	test('install returns a WSL-aware command hook config', () => {
		const result = claudeAdapter.install({
			url: 'http://127.0.0.1:9090',
			outputDir: '/tmp/umbod',
			timeoutSeconds: 30,
		});
		expect(result.assets).toHaveLength(1);
		expect(result.assets[0].relativePath).toBe('hook-claude.sh');
		expect(result.assets[0].contents).toContain('/mnt/c/Windows/System32/curl.exe');
		expect(typeof result.config.contents).toBe('object');
		expect(result.config.contents).toHaveProperty('hooks');
		const hooks = (result.config.contents as Record<string, unknown>).hooks as Record<string, unknown>;
		expect(hooks).toHaveProperty('PreToolUse');
	});

	test('maps disabled umbod timeout to a long Claude hook timeout', () => {
		const result = claudeAdapter.install({
			url: 'http://127.0.0.1:9090',
			outputDir: '/tmp/umbod',
			timeoutSeconds: 0,
		});
		const hooks = (
			result.config.contents as {
				hooks: { PreToolUse: Array<{ hooks: Array<{ timeout: number }> }> };
			}
		).hooks;
		expect(hooks.PreToolUse[0]?.hooks[0]?.timeout).toBe(86_400);
	});
});

// ── Cursor adapter ───────────────────────────────────────────

describe('cursor adapter', () => {
	test('metadata', () => {
		expect(cursorAdapter.id).toBe('cursor');
		expect(cursorAdapter.hookEvent).toBe('preToolUse');
	});

	test('normalizes Cursor payload', () => {
		const call = cursorAdapter.normalizePayload({
			toolName: 'Bash',
			toolInput: { command: 'npm install' },
			workspaceRoot: '/home/user/workspace',
		});
		expect(call.agent).toBe('cursor');
		expect(call.tool).toBe('bash');
		expect(call.command).toBe('npm install');
		expect(call.workingDirectory).toBe('/home/user/workspace');
	});

	test('normalizes snake_case variant', () => {
		const call = cursorAdapter.normalizePayload({
			tool_name: 'Read',
			tool_input: {
				file_path: '/tmp/file.txt',
			},
		});
		expect(call.tool).toBe('read');
	});

	test('install generates shell wrapper and config', () => {
		const result = cursorAdapter.install({
			url: 'http://127.0.0.1:9090',
			outputDir: '/tmp/umbod',
			timeoutSeconds: 30,
		});
		expect(result.assets).toHaveLength(1);
		expect(result.assets[0].relativePath).toBe('hook-cursor.sh');
		expect(result.assets[0].executable).toBe(true);
		expect(typeof result.config.contents).toBe('object');
		expect(result.config.contents).toHaveProperty('hooks');
	});
});

// ── Codex adapter ────────────────────────────────────────────

describe('codex adapter', () => {
	test('metadata', () => {
		expect(codexAdapter.id).toBe('codex');
		expect(codexAdapter.hookEvent).toBe('PreToolUse');
	});

	test('normalizes Codex payload', () => {
		const call = codexAdapter.normalizePayload({
			tool_name: 'Bash',
			tool_input: { command: 'cargo build' },
			cwd: '/home/user/rust-project',
		});
		expect(call.agent).toBe('codex');
		expect(call.tool).toBe('bash');
		expect(call.command).toBe('cargo build');
		expect(call.workingDirectory).toBe('/home/user/rust-project');
	});

	test('falls back to bash when no tool_name', () => {
		const call = codexAdapter.normalizePayload({
			arguments: { command: 'echo hi' },
		});
		expect(call.tool).toBe('bash');
	});

	test('normalizes Codex apply_patch as edit', () => {
		const call = codexAdapter.normalizePayload({
			hook_event_name: 'PreToolUse',
			tool_name: 'apply_patch',
			tool_input: { command: '*** Begin Patch\n*** End Patch' },
			cwd: '/home/user/project',
		});
		expect(call.tool).toBe('edit');
		expect(call.command).toBe('*** Begin Patch\n*** End Patch');
		expect(call.workingDirectory).toBe('/home/user/project');
	});

	test('install generates shell wrapper', () => {
		const result = codexAdapter.install({
			url: 'http://127.0.0.1:9090',
			outputDir: '/tmp/umbod',
			timeoutSeconds: 30,
		});
		expect(result.assets).toHaveLength(1);
		expect(result.assets[0].relativePath).toBe('hook-codex.sh');
		expect(result.assets[0].executable).toBe(true);
		expect(result.config.fileName).toBe('codex.toml');
		expect(result.config.settingsPath).toContain('.codex/config.toml');
		expect(result.config.contents).toContain('[[hooks.PreToolUse]]');
		expect(result.config.contents).toContain('timeout = 30');
		expect(result.config.contents).toContain('statusMessage = "Checking umbod policy"');
	});

	test('maps disabled umbod timeout to long Codex hook timeout', () => {
		const result = codexAdapter.install({
			url: 'http://127.0.0.1:9090',
			outputDir: '/tmp/umbod',
			timeoutSeconds: 0,
		});
		expect(result.config.contents).toContain('timeout = 86400');
	});
});

// ── Gemini adapter ───────────────────────────────────────────

describe('gemini adapter', () => {
	test('metadata', () => {
		expect(geminiAdapter.id).toBe('gemini');
		expect(geminiAdapter.hookEvent).toBe('BeforeTool');
	});

	test('normalizes Gemini payload with tool aliases', () => {
		const call = geminiAdapter.normalizePayload({
			tool_name: 'run_shell_command',
			tool_input: { command: 'ls -la' },
			cwd: '/home/user',
		});
		expect(call.agent).toBe('gemini');
		expect(call.tool).toBe('bash'); // run_shell_command → bash
		expect(call.command).toBe('ls -la');
	});

	test('maps read_file to read', () => {
		const call = geminiAdapter.normalizePayload({
			tool_name: 'read_file',
			tool_input: { file_path: '/tmp/file.txt' },
		});
		expect(call.tool).toBe('read');
	});

	test('maps grep_search to grep', () => {
		const call = geminiAdapter.normalizePayload({
			tool_name: 'grep_search',
			tool_input: { pattern: 'TODO', path: '/home/user/project' },
		});
		expect(call.tool).toBe('grep');
	});

	test('maps write_file to write', () => {
		const call = geminiAdapter.normalizePayload({
			tool_name: 'write_file',
			tool_input: { file_path: '/tmp/out.txt' },
		});
		expect(call.tool).toBe('write');
	});

	test('maps replace to edit', () => {
		const call = geminiAdapter.normalizePayload({
			tool_name: 'replace',
			tool_input: { file_path: '/tmp/file.txt' },
		});
		expect(call.tool).toBe('edit');
	});

	test('install generates gemini shell wrapper', () => {
		const result = geminiAdapter.install({
			url: 'http://127.0.0.1:9090',
			outputDir: '/tmp/umbod',
			timeoutSeconds: 30,
		});
		expect(result.assets).toHaveLength(1);
		expect(result.assets[0].relativePath).toBe('hook-gemini.sh');
		expect(result.assets[0].executable).toBe(true);
	});
});

// ── Shared install behavior ──────────────────────────────────

describe('adapter install', () => {
	const allAdapters: HookAdapter[] = [claudeAdapter, cursorAdapter, codexAdapter, geminiAdapter];

	for (const adapter of allAdapters) {
		test(`${adapter.id} install returns config with fileName and settingsPath`, () => {
			const result = adapter.install({
				url: 'http://127.0.0.1:9090',
				outputDir: '/tmp/umbod',
				timeoutSeconds: 30,
			});
			expect(result.config.fileName).toBeDefined();
			expect(result.config.settingsPath).toBeDefined();
			expect(['object', 'string']).toContain(typeof result.config.contents);
		});

		test(`${adapter.id} can generate POSIX artifacts from a Windows host`, () => {
			const result = adapter.install({
				url: 'http://127.0.0.1:9090',
				outputDir: '~/.umbod',
				timeoutSeconds: 30,
				platform: 'posix',
				homeDir: '~',
			});
			expect(result.assets[0]?.relativePath).toEndWith('.sh');
			expect(result.assets[0]?.contents).toStartWith('#!/usr/bin/env sh');
			expect(JSON.stringify(result.config.contents)).toContain('~/.umbod/');
			expect(result.config.settingsPath).not.toContain('\\');
		});
	}
});
