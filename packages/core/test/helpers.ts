import type { Manifest, ToolCall } from '../src/core/types.ts';

export function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
	return {
		agent: 'test',
		tool: 'bash',
		command: 'git status',
		timestamp: '2025-01-01T00:00:00.000Z',
		...overrides,
	};
}

export function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
	return {
		env: { name: 'test', version: '1.0.0', timeout: 5 },
		policy: { default_unknown: 'block', approval_method: 'web' },
		rules: {},
		workspaces: [],
		server: { host: '127.0.0.1', port: 9090 },
		...overrides,
	};
}
