import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { adapters } from '../../src/adapters/index.ts';

for (const agent of ['opencode', 'pi']) {
	for (const mode of ['feedback', 'legacy-deny', 'allow', 'malformed', 'http', 'transport', 'timeout']) {
		test(`${agent} generated extension: ${mode}`, async () => {
			const reason = 'Policy reason\n\nUser feedback:\nUse "read" 雪 🦉 $HOME $(bad) `bad` ; & | \\';
			const server = Bun.serve({
				port: 0,
				async fetch() {
					if (mode === 'timeout') await Bun.sleep(100);
					if (mode === 'malformed') return new Response('{"permissionDecision":"allow"');
					return Response.json(
						{
							permissionDecision: mode === 'allow' ? 'allow' : 'deny',
							...(mode === 'feedback' ? { permissionDecisionReason: reason } : {}),
						},
						{ status: mode === 'http' ? 500 : 200 }
					);
				},
			});
			const url = `http://127.0.0.1:${server.port}`;
			if (mode === 'transport') server.stop(true);
			const directory = await mkdtemp(path.join(tmpdir(), 'umbod-extension-'));
			try {
				const asset = adapters
					.find((a) => a.id === agent)!
					.install({ url, timeoutSeconds: mode === 'timeout' ? 0.01 : 2, outputDir: directory }).assets[0];
				const file = path.join(directory, asset.relativePath);
				await writeFile(file, asset.contents);
				const module = await import(pathToFileURL(file).href);
				let invoke: () => Promise<unknown>;
				if (agent === 'opencode') {
					const plugin = await module.UmbodPlugin({ directory });
					invoke = () =>
						plugin['tool.execute.before'](
							{ tool: 'bash', sessionID: 'one', callID: 'same' },
							{ args: { command: 'git push' } }
						);
				} else {
					let callback!: (event: unknown, ctx: unknown) => Promise<unknown>;
					module.default({
						on: (_event: string, handler: typeof callback) => {
							callback = handler;
						},
					});
					invoke = () =>
						callback({ toolName: 'bash', input: { command: 'git push' }, toolCallId: 'same' }, { cwd: directory });
				}
				if (mode === 'allow') expect(await invoke()).toBeUndefined();
				else if (agent === 'opencode') await expect(invoke()).rejects.toThrow(mode === 'feedback' ? reason : /Umbod/);
				else {
					const result = await invoke();
					expect(result).toMatchObject({
						block: true,
						reason: mode === 'feedback' ? reason : expect.stringContaining('Umbod'),
					});
				}
			} finally {
				server.stop(true);
				await rm(directory, { recursive: true, force: true });
			}
		});
	}
}
