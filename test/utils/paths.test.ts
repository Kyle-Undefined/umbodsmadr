import { describe, expect, test } from 'bun:test';
import { resolveEnvPath, defaultDatabasePath } from '../../src/utils/paths.ts';
import path from 'node:path';

describe('resolveEnvPath', () => {
	test('defaults to umbod.toml in cwd', () => {
		const result = resolveEnvPath();
		expect(result).toBe(path.resolve('umbod.toml'));
	});

	test('resolves relative path', () => {
		const result = resolveEnvPath('./custom/manifest.toml');
		expect(result).toBe(path.resolve('./custom/manifest.toml'));
	});

	test('resolves absolute path as-is', () => {
		const result = resolveEnvPath('/etc/umbod/policy.toml');
		expect(result).toBe('/etc/umbod/policy.toml');
	});
});

describe('defaultDatabasePath', () => {
	test('colocates .db with manifest using env name', () => {
		expect(defaultDatabasePath('/home/user/project/umbod.toml', 'my-dev-env')).toBe(
			'/home/user/project/umbod.my-dev-env.db'
		);
	});

	test('works with nested paths', () => {
		expect(defaultDatabasePath('/etc/umbod/policies/work.toml', 'work')).toBe('/etc/umbod/policies/umbod.work.db');
	});
});
