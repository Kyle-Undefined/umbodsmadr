import { homedir } from 'node:os';
import path from 'node:path';

import type { HookAdapter } from './base.ts';
import { buildCurlWrapperScript, normalizePayload } from '../hooks/adapter-utils.ts';

export const codexAdapter: HookAdapter = {
	id: 'codex',
	displayName: 'Codex',
	hookEvent: 'PreToolUse',
	supportedTools: ['bash', 'read', 'write', 'edit'],
	normalizePayload(payload) {
		return normalizePayload('codex', payload, {
			toolPaths: ['tool_name', 'toolName', 'tool'],
			commandPaths: ['arguments.command', 'command', 'tool_input.command', 'input.command'],
			argsPaths: ['arguments.args', 'argv', 'args'],
			workingDirectoryPaths: ['cwd', 'working_directory'],
			fallbackTool: 'bash',
		});
	},
	install(options) {
		const scriptPath = path.join(options.outputDir, 'hook-codex.sh');

		return {
			assets: [
				{
					relativePath: 'hook-codex.sh',
					contents: buildCurlWrapperScript(options.url, 'codex'),
					executable: true,
				},
			],
			config: {
				fileName: 'codex.json',
				settingsPath: path.join(homedir(), '.codex', 'hooks.json'),
				contents: {
					hooks: {
						PreToolUse: [
							{
								matcher: '*',
								hooks: [
									{
										type: 'command',
										command: scriptPath,
									},
								],
							},
						],
					},
				},
			},
		};
	},
};
