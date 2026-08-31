import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const cliPath = join(import.meta.dir, '..', 'src', 'cli.ts');
const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('CLI help', () => {
	for (const helpFlag of ['--help', '-h']) {
		test(`configure ${helpFlag} prints help without generating files`, () => {
			const cwd = mkdtempSync(join(tmpdir(), 'umbod-cli-help-'));
			tempDirectories.push(cwd);

			const result = Bun.spawnSync([Bun.argv[0] as string, 'run', cliPath, 'configure', helpFlag], { cwd });

			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString()).toContain('Usage:');
			expect(result.stdout.toString()).toContain('umbod configure');
			expect(result.stderr.toString()).toBe('');
			expect(existsSync(join(cwd, '.umbod'))).toBe(false);
		});
	}
});
