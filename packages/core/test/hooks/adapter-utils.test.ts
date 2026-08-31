import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	normalizePayload,
	toPermissionDecision,
	buildCurlWrapperScript,
	buildPowerShellWrapperScript,
} from '../../src/hooks/adapter-utils.ts';

// ── normalizePayload ─────────────────────────────────────────

describe('normalizePayload', () => {
	const baseOptions = {
		toolPaths: ['tool_name', 'toolName'],
		commandPaths: ['tool_input.command', 'command'],
		argsPaths: ['args'],
		workingDirectoryPaths: ['cwd'],
		inputValuePaths: ['tool_input.file_path'],
		fallbackTool: 'unknown',
	};

	test('extracts tool from first matching path', () => {
		const call = normalizePayload('test', { tool_name: 'bash' }, baseOptions);
		expect(call.tool).toBe('bash');
	});

	test('falls back to second tool path', () => {
		const call = normalizePayload('test', { toolName: 'read' }, baseOptions);
		expect(call.tool).toBe('read');
	});

	test('uses fallbackTool when no tool found', () => {
		const call = normalizePayload('test', {}, baseOptions);
		expect(call.tool).toBe('unknown');
	});

	test('extracts command from nested path', () => {
		const call = normalizePayload('test', { tool_input: { command: 'git status' } }, baseOptions);
		expect(call.command).toBe('git status');
	});

	test('builds command from args when no explicit command', () => {
		const call = normalizePayload('test', { tool_name: 'bash', args: ['git', 'status'] }, baseOptions);
		expect(call.command).toBe('git status');
	});

	test('builds command from inputValuePaths when no command or args', () => {
		const call = normalizePayload(
			'test',
			{ tool_name: 'read', tool_input: { file_path: '/tmp/file.txt' } },
			baseOptions
		);
		expect(call.command).toBe('read /tmp/file.txt');
	});

	test('sets agent from parameter', () => {
		const call = normalizePayload('claude', { tool_name: 'bash' }, baseOptions);
		expect(call.agent).toBe('claude');
	});

	test('extracts working directory', () => {
		const call = normalizePayload('test', { tool_name: 'bash', cwd: '/home/user' }, baseOptions);
		expect(call.workingDirectory).toBe('/home/user');
	});

	test('extracts a host-provided generic workspace id', () => {
		const call = normalizePayload('test', { tool_name: 'bash', workspace: { id: 'strict-project' } }, baseOptions);
		expect(call.workspaceId).toBe('strict-project');
	});

	test('preserves full payload as inputs', () => {
		const payload = { tool_name: 'bash', tool_input: { command: 'ls' }, extra: 'data' };
		const call = normalizePayload('test', payload, baseOptions);
		expect(call.inputs).toEqual(payload);
	});

	test('wraps non-object payload', () => {
		const call = normalizePayload('test', 'not-an-object' as unknown, baseOptions);
		expect(call.inputs).toEqual({ raw: 'not-an-object' });
	});

	test('tool aliases are applied', () => {
		const call = normalizePayload(
			'test',
			{ tool_name: 'run_shell_command' },
			{
				...baseOptions,
				toolAliases: { run_shell_command: 'bash' },
			}
		);
		expect(call.tool).toBe('bash');
	});

	test('tool name is lowercased', () => {
		const call = normalizePayload('test', { tool_name: 'Bash' }, baseOptions);
		expect(call.tool).toBe('bash');
	});

	test('derives canonical operations from adapter-owned tool normalization', () => {
		const call = normalizePayload('test', { tool_name: 'Read', command: '/work/file' }, baseOptions);
		expect(call.operation).toBe('filesystem.read');
	});

	test('derives provider-neutral git, package, and redirection operations', () => {
		expect(normalizePayload('test', { tool_name: 'bash', command: 'git commit -m test' }, baseOptions).operation).toBe(
			'git.commit'
		);
		expect(normalizePayload('test', { tool_name: 'bash', command: 'npm publish' }, baseOptions).operation).toBe(
			'package.publish'
		);
		expect(normalizePayload('test', { tool_name: 'bash', command: 'printf ok > ./out' }, baseOptions).operation).toBe(
			'filesystem.write'
		);
		expect(
			normalizePayload('test', { tool_name: 'bash', command: 'git diff --check && git commit -m test' }, baseOptions)
				.operation
		).toBe('git.commit');
	});

	test('timestamp is auto-generated', () => {
		const call = normalizePayload('test', { tool_name: 'bash' }, baseOptions);
		expect(call.timestamp).toBeDefined();
		expect(() => new Date(call.timestamp)).not.toThrow();
	});
});

// ── toPermissionDecision ─────────────────────────────────────

describe('toPermissionDecision', () => {
	test('allow → allow', () => {
		expect(toPermissionDecision('allow')).toBe('allow');
	});

	test('block → deny', () => {
		expect(toPermissionDecision('block')).toBe('deny');
	});

	test('approve → deny', () => {
		expect(toPermissionDecision('approve')).toBe('deny');
	});
});

// ── buildCurlWrapperScript ───────────────────────────────────

describe('buildCurlWrapperScript', () => {
	test('generic wrapper has correct shebang and structure', () => {
		const script = buildCurlWrapperScript('http://127.0.0.1:9090', 'test', 30);
		expect(script).toStartWith('#!/usr/bin/env sh');
		expect(script).toContain('set -eu');
		expect(script).toContain('curl');
		expect(script).toContain('http://127.0.0.1:9090/api/hooks');
		expect(script).toContain('x-umbod-agent: test');
		expect(script).toContain('permissionDecision');
		expect(script).toContain('--connect-timeout 5 --max-time 30');
		expect(script).toContain('exit 0');
		expect(script).toContain('exit 2');
	});

	test('cursor wrapper emits permission JSON', () => {
		const script = buildCurlWrapperScript('http://127.0.0.1:9090', 'cursor', 30, 'cursor');
		expect(script).toContain('"permission":"allow"');
		expect(script).toContain('"permission":"deny"');
		expect(script).toContain('x-umbod-agent: cursor');
	});

	test('gemini wrapper emits decision JSON', () => {
		const script = buildCurlWrapperScript('http://127.0.0.1:9090', 'gemini', 30, 'gemini');
		expect(script).toContain('"decision":"allow"');
		expect(script).toContain('"decision":"deny"');
		expect(script).toContain('suppressOutput');
	});

	test('codex wrapper emits PreToolUse hookSpecificOutput deny JSON', () => {
		const script = buildCurlWrapperScript('http://127.0.0.1:9090', 'codex', 30, 'codex');
		expect(script).toContain('"hookSpecificOutput"');
		expect(script).toContain('"hookEventName":"PreToolUse"');
		expect(script).toContain('"permissionDecision":"deny"');
		expect(script).toContain('x-umbod-agent: codex');
	});

	test('normalizes server URL', () => {
		const script = buildCurlWrapperScript('http://127.0.0.1:9090/', 'test', 30);
		// Trailing slash should be stripped in the URL
		expect(script).toContain('http://127.0.0.1:9090/api/hooks');
		expect(script).not.toContain('http://127.0.0.1:9090//api/hooks');
	});

	test('rejects invalid protocol', () => {
		expect(() => buildCurlWrapperScript('ftp://127.0.0.1:9090', 'test', 30)).toThrow('unsupported server URL protocol');
	});

	test('represents approval timeouts greater than five seconds', () => {
		expect(buildCurlWrapperScript('http://127.0.0.1:9090', 'test', 45)).toContain('--connect-timeout 5 --max-time 45');
	});
});

describe('buildPowerShellWrapperScript', () => {
	test('uses curl connection and overall timeouts without Invoke-WebRequest', () => {
		const script = buildPowerShellWrapperScript('http://127.0.0.1:9090', 'test', 45);
		expect(script).toContain('Get-Command curl.exe -ErrorAction Stop');
		expect(script).toContain('--connect-timeout 5 --max-time 45');
		expect(script).not.toContain('Invoke-WebRequest');
		expect(script).toContain('$process.StandardInput.Write($body)');
		expect(script).toContain('x-umbod-agent: test');
		expect(script).toContain('exit 2');
	});
});

describe('generated wrapper execution', () => {
	test('allows a response that remains pending longer than five seconds', async () => {
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				expect(request.headers.get('content-type')).toBe('application/json');
				expect(request.headers.get('x-umbod-agent')).toBe('test');
				expect(await request.text()).toBe('{"tool_name":"bash"}');
				await Bun.sleep(5_100);
				return Response.json({ permissionDecision: 'allow' });
			},
		});
		const directory = await mkdtemp(path.join(tmpdir(), 'umbod-wrapper-'));
		const scriptPath = path.join(directory, 'hook.sh');
		const script = buildCurlWrapperScript(`http://127.0.0.1:${server.port}`, 'test', 8).replace(
			`if [ -x /mnt/c/Windows/System32/curl.exe ] && grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  CURL=/mnt/c/Windows/System32/curl.exe
fi
`,
			''
		);

		try {
			await writeFile(scriptPath, script);
			await chmod(scriptPath, 0o700);
			const process = Bun.spawn([scriptPath], {
				stdin: new TextEncoder().encode('{"tool_name":"bash"}'),
				stdout: 'pipe',
				stderr: 'pipe',
			});
			expect(await process.exited).toBe(0);
			expect(await new Response(process.stdout).text()).toBe('');
		} finally {
			server.stop(true);
			await rm(directory, { recursive: true, force: true });
		}
	}, 10_000);
});
