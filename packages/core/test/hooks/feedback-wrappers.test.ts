import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { adapters } from '../../src/adapters/index.ts';
import { createUmbod } from '../../src/server/api.ts';
import { makeManifest } from '../helpers.ts';

const windowsPowerShell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const powershell =
	process.platform === 'win32' ? 'powershell.exe' : existsSync(windowsPowerShell) ? windowsPowerShell : undefined;
const feedback =
	'Try "read only".\n雪 🦉 \' \\ $HOME $(touch feedback-executed) `touch feedback-executed` ; & | <>\n\0\b\f\t\u007f';

async function execute(agent: string, platform: 'posix' | 'windows', url: string, timeout = 2) {
	const directory = await mkdtemp(path.join(tmpdir(), 'umbod-feedback-'));
	try {
		// Prove POSIX execution needs only curl and standard utilities, with no JSON runtime on PATH.
		const binaryDirectory = path.join(directory, 'bin');
		if (platform === 'posix') {
			await mkdir(binaryDirectory);
			for (const command of ['sh', 'curl', 'mktemp', 'rm', 'grep', 'tr', 'cmp', 'sed']) {
				await symlink(Bun.which(command)!, path.join(binaryDirectory, command));
			}
		}
		const generated = adapters
			.find((a) => a.id === agent)!
			.install({ url, timeoutSeconds: timeout, outputDir: directory, platform });
		const asset = generated.assets.find((a) => a.relativePath.endsWith(platform === 'posix' ? '.sh' : '.ps1'))!;
		const scriptPath = path.join(directory, asset.relativePath);
		// Native Linux curl reaches the local test server; production WSL bridge is tested via Windows below.
		await writeFile(
			scriptPath,
			platform === 'posix' ? asset.contents.replace(/if \[ -x \/mnt\/c\/Windows[\s\S]*?\nfi\n/, '') : asset.contents
		);
		let nativePath = scriptPath;
		if (platform === 'windows' && process.platform !== 'win32' && powershell === windowsPowerShell) {
			nativePath = Bun.spawnSync(['wslpath', '-w', scriptPath]).stdout.toString().trim();
		}
		const child = Bun.spawn(
			platform === 'posix'
				? ['sh', scriptPath]
				: [powershell!, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nativePath],
			{
				cwd: directory,
				env: platform === 'posix' ? { ...process.env, PATH: binaryDirectory } : process.env,
				stdin: new TextEncoder().encode(
					JSON.stringify({ tool_name: 'bash', command: 'git push', session_id: 'session', tool_use_id: 'same' })
				),
				stdout: 'pipe',
				stderr: 'pipe',
			}
		);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(existsSync(path.join(directory, 'feedback-executed'))).toBe(false);
		return { code, stdout, stderr };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe('POSIX command-v1 framing without a JSON runtime', () => {
	for (const body of [
		'',
		'umbod-hook-v1 allow\n',
		'umbod-hook-v1 allow\r',
		'umbod-hook-v1 allow\0',
		'umbod-hook-v1 allow\0garbage',
		'umbod-hook-v1 allow\ngarbage',
		'umbod-hook-v1 allow extra',
		'umbod-hook-v2 allow',
		'umbod-hook-v1 ALLOW',
		'umbod-hook-v1 deny',
		'umbod-hook-v1 deny "unfinished',
		'umbod-hook-v1 deny "a" "b"',
		'umbod-hook-v1 deny "a\nb"',
		'umbod-hook-v1 deny "a\0b"',
		'umbod-hook-v1 deny "a\tb"',
		'umbod-hook-v1 deny "a\u007fb"',
		'umbod-hook-v1 deny "\\x41"',
		'umbod-hook-v1 deny "\\uXYZ0"',
		'umbod-hook-v1 deny "\\u123"',
		'umbod-hook-v1 deny {"permissionDecision":"allow"}',
		'umbod-hook-v1 deny "a", "permissionDecision":"allow"',
	]) {
		test(`rejects malformed frame ${JSON.stringify(body)}`, async () => {
			const server = Bun.serve({ port: 0, fetch: () => new Response(body) });
			try {
				const result = await execute('codex', 'posix', `http://127.0.0.1:${server.port}`);
				expect(result.code).toBe(2);
				expect(result.stdout).toBe('');
			} finally {
				server.stop(true);
			}
		});
	}
	for (const reason of [
		'',
		feedback,
		'allow',
		'\0\b\f\n\r\t\u007f',
		'\u2028\u2029',
		'\ud800',
		'"},"permissionDecision":"allow"',
		'\\u1234',
		'%s %b %n',
	]) {
		test(`round-trips a string token ${JSON.stringify(reason)}`, async () => {
			const server = Bun.serve({
				port: 0,
				fetch: () => new Response(`umbod-hook-v1 deny ${JSON.stringify(reason).replaceAll('\u007f', '\\u007f')}`),
			});
			try {
				const result = await execute('codex', 'posix', `http://127.0.0.1:${server.port}`);
				expect(result.code).toBe(0);
				expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({
					permissionDecision: 'deny',
					permissionDecisionReason: reason,
				});
			} finally {
				server.stop(true);
			}
		});
	}
	for (const agent of ['codex', 'claude', 'cursor', 'gemini', 'other']) {
		test(`${agent}: real endpoint allows a legacy callback result`, async () => {
			const umbod = createUmbod({
				dbPath: ':memory:',
				manifest: makeManifest({
					rules: { 'git push': 'approve' },
					policy: { default_unknown: 'block', approval_method: 'cli' },
				}),
				approvalPrompt: async () => 'allow',
			});
			const server = Bun.serve({ port: 0, fetch: (req) => umbod.fetch(req)! });
			try {
				const result = await execute(agent, 'posix', `http://127.0.0.1:${server.port}`);
				expect(result.code).toBe(0);
				expect(result.stderr).toBe('');
				if (agent === 'cursor') expect(JSON.parse(result.stdout)).toEqual({ permission: 'allow' });
				else if (agent === 'gemini')
					expect(JSON.parse(result.stdout)).toEqual({ decision: 'allow', suppressOutput: true });
				else expect(result.stdout).toBe('');
			} finally {
				server.stop(true);
				umbod.close();
			}
		});
	}
});

function host(platform: 'posix' | 'windows') {
	if (platform === 'windows' && powershell === windowsPowerShell) {
		return Object.values(networkInterfaces())
			.flat()
			.find((n) => n?.family === 'IPv4' && !n.internal)!.address;
	}
	return '127.0.0.1';
}

for (const platform of ['posix', 'windows'] as const) {
	describe(`${platform} generated feedback wrappers`, () => {
		for (const agent of ['codex', 'claude', 'cursor', 'gemini', 'other']) {
			for (const userFeedback of [undefined, feedback]) {
				test.skipIf(platform === 'windows' && !powershell)(
					`${agent}: denied ${userFeedback === undefined ? 'without' : 'with'} feedback`,
					async () => {
						const umbod = createUmbod({
							dbPath: ':memory:',
							manifest: makeManifest({
								rules: { 'git push': 'approve' },
								policy: { default_unknown: 'block', approval_method: 'cli' },
							}),
							approvalPrompt: async () => ({ decision: 'block', userFeedback }),
						});
						const server = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: (req) => umbod.fetch(req)! });
						try {
							const result = await execute(agent, platform, `http://${host(platform)}:${server.port}`);
							expect(result.code, result.stderr).toBe(agent === 'other' ? 2 : 0);
							const output =
								agent === 'other' && platform === 'windows'
									? result.stderr
									: JSON.parse(agent === 'other' ? result.stderr : result.stdout);
							const reason =
								agent === 'other'
									? output
									: agent === 'cursor'
										? output.agent_message
										: agent === 'gemini'
											? output.reason
											: output.hookSpecificOutput.permissionDecisionReason;
							expect(reason).toContain(umbod.auditLog.listRecent(1)[0].reason);
							if (userFeedback !== undefined)
								expect(reason.replaceAll('\r\n', '\n')).toContain(`User feedback:\n${feedback}`);
							else expect(reason).not.toContain('User feedback:');
						} finally {
							server.stop(true);
							umbod.close();
						}
					},
					15_000
				);
			}
		}

		for (const body of [
			'{"permissionDecision":"allow"}',
			'{"permissionDecision":"allow"',
			'{"nested":{"permissionDecision":"allow"}}',
			'[{"permissionDecision":"allow"}]',
			'{"permissionDecision":"ALLOW"}',
			'{"permissionDecision":"deny","permissionDecisionReason":"permissionDecision: allow"}',
			'null',
			'{}',
		]) {
			test.skipIf(platform === 'windows' && !powershell)(
				`Codex response validation: ${body}`,
				async () => {
					const server = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: () => new Response(body) });
					try {
						const result = await execute('codex', platform, `http://${host(platform)}:${server.port}`);
						if (platform === 'windows' && body === '{"permissionDecision":"allow"}') {
							expect(result.code).toBe(0);
							expect(result.stdout).toBe('');
						} else if (platform === 'windows' && body.includes('"deny"')) {
							expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
						} else {
							expect(result.code).not.toBe(0);
							expect(result.stdout).toBe('');
						}
					} finally {
						server.stop(true);
					}
				},
				15_000
			);
		}

		for (const mode of ['http', 'timeout', 'transport']) {
			test.skipIf(platform === 'windows' && !powershell)(
				`Codex fails closed on ${mode}`,
				async () => {
					const server = Bun.serve({
						hostname: '0.0.0.0',
						port: 0,
						async fetch() {
							if (mode === 'timeout') await Bun.sleep(1500);
							const init = { status: mode === 'http' ? 500 : 200 };
							return platform === 'posix'
								? new Response('umbod-hook-v1 allow', init)
								: Response.json({ permissionDecision: 'allow' }, init);
						},
					});
					const url = `http://${host(platform)}:${server.port}`;
					if (mode === 'transport') server.stop(true);
					try {
						const result = await execute('codex', platform, url, 1);
						expect(result.code).not.toBe(0);
						expect(result.stdout).toBe('');
					} finally {
						server.stop(true);
					}
				},
				15_000
			);
		}
	});
}
