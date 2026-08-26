import { describe, expect, test } from 'bun:test';
import { parseEvaluatePayload, resolveAgentId } from '../../src/server/parse.ts';

// ── parseEvaluatePayload ─────────────────────────────────────

describe('parseEvaluatePayload', () => {
	test('parses valid payload', () => {
		const call = parseEvaluatePayload({
			agent: 'claude',
			tool: 'bash',
			command: 'git status',
			args: ['--short'],
			workingDirectory: '/home/user/project',
			workspaceId: 'client',
			inputs: { key: 'value' },
			timestamp: '2025-01-01T00:00:00.000Z',
		});

		expect(call.agent).toBe('claude');
		expect(call.tool).toBe('bash');
		expect(call.command).toBe('git status');
		expect(call.args).toEqual(['--short']);
		expect(call.workingDirectory).toBe('/home/user/project');
		expect(call.workspaceId).toBe('client');
		expect(call.inputs).toEqual({ key: 'value' });
		expect(call.timestamp).toBe('2025-01-01T00:00:00.000Z');
	});

	test('minimal payload (agent + tool + command)', () => {
		const call = parseEvaluatePayload({
			agent: 'test',
			tool: 'bash',
			command: 'ls',
		});

		expect(call.agent).toBe('test');
		expect(call.tool).toBe('bash');
		expect(call.command).toBe('ls');
		expect(call.args).toBeUndefined();
		expect(call.workingDirectory).toBeUndefined();
		expect(call.inputs).toBeUndefined();
		expect(call.timestamp).toBeDefined(); // auto-generated
	});

	test('does not trust operation metadata from the public evaluate payload', () => {
		const result = parseEvaluatePayload({
			agent: 'remote',
			tool: 'custom',
			command: 'run',
			operation: 'filesystem.read',
		});
		expect(result.operation).toBeUndefined();
	});

	test('rejects non-object payload', () => {
		expect(() => parseEvaluatePayload('not an object')).toThrow('invalid tool call payload');
		expect(() => parseEvaluatePayload(null)).toThrow('invalid tool call payload');
		expect(() => parseEvaluatePayload(42)).toThrow('invalid tool call payload');
	});

	test('rejects missing agent', () => {
		expect(() => parseEvaluatePayload({ tool: 'bash', command: 'ls' })).toThrow('missing agent');
	});

	test('rejects empty agent', () => {
		expect(() => parseEvaluatePayload({ agent: '  ', tool: 'bash', command: 'ls' })).toThrow('missing agent');
	});

	test('rejects missing tool', () => {
		expect(() => parseEvaluatePayload({ agent: 'test', command: 'ls' })).toThrow('missing tool');
	});

	test('rejects missing command', () => {
		expect(() => parseEvaluatePayload({ agent: 'test', tool: 'bash' })).toThrow('missing command');
	});

	test('rejects non-string-array args', () => {
		expect(() => parseEvaluatePayload({ agent: 'test', tool: 'bash', command: 'ls', args: [1, 2] })).toThrow(
			'args must be a string array'
		);
	});

	test('rejects non-string workingDirectory', () => {
		expect(() =>
			parseEvaluatePayload({
				agent: 'test',
				tool: 'bash',
				command: 'ls',
				workingDirectory: 42,
			})
		).toThrow('workingDirectory must be a string');
	});

	test('rejects non-string workspaceId', () => {
		expect(() =>
			parseEvaluatePayload({
				agent: 'test',
				tool: 'bash',
				command: 'ls',
				workspaceId: 42,
			})
		).toThrow('workspaceId must be a string');
	});

	test('rejects non-object inputs', () => {
		expect(() =>
			parseEvaluatePayload({
				agent: 'test',
				tool: 'bash',
				command: 'ls',
				inputs: 'not-an-object',
			})
		).toThrow('inputs must be an object');
	});

	test('rejects non-string timestamp', () => {
		expect(() =>
			parseEvaluatePayload({
				agent: 'test',
				tool: 'bash',
				command: 'ls',
				timestamp: 12345,
			})
		).toThrow('timestamp must be a string');
	});
});

// ── resolveAgentId ───────────────────────────────────────────

describe('resolveAgentId', () => {
	test('reads from x-umbod-agent header', () => {
		const req = new Request('http://localhost:9090/api/hooks', {
			headers: { 'x-umbod-agent': 'claude' },
		});
		const url = new URL(req.url);
		expect(resolveAgentId(req, url)).toBe('claude');
	});

	test('reads from query parameter', () => {
		const req = new Request('http://localhost:9090/api/hooks?agent=cursor');
		const url = new URL(req.url);
		expect(resolveAgentId(req, url)).toBe('cursor');
	});

	test('header takes precedence over query', () => {
		const req = new Request('http://localhost:9090/api/hooks?agent=cursor', {
			headers: { 'x-umbod-agent': 'claude' },
		});
		const url = new URL(req.url);
		expect(resolveAgentId(req, url)).toBe('claude');
	});

	test('returns undefined when neither is set', () => {
		const req = new Request('http://localhost:9090/api/hooks');
		const url = new URL(req.url);
		expect(resolveAgentId(req, url)).toBeUndefined();
	});

	test('trims whitespace from header', () => {
		const req = new Request('http://localhost:9090/api/hooks', {
			headers: { 'x-umbod-agent': '  claude  ' },
		});
		const url = new URL(req.url);
		expect(resolveAgentId(req, url)).toBe('claude');
	});

	test('ignores empty header', () => {
		const req = new Request('http://localhost:9090/api/hooks', {
			headers: { 'x-umbod-agent': '   ' },
		});
		const url = new URL(req.url);
		expect(resolveAgentId(req, url)).toBeUndefined();
	});
});
