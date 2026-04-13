import { homedir } from 'node:os';
import path from 'node:path';

import type { HookAdapter } from './base.ts';
import { buildCurlWrapperScript, buildPowerShellWrapperScript, normalizePayload } from '../hooks/adapter-utils.ts';

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
		const isWindows = process.platform === 'win32';
		const scriptFile = isWindows ? 'hook-codex.ps1' : 'hook-codex.sh';
		const scriptPath = path.join(options.outputDir, scriptFile);
		const command = isWindows
			? `powershell.exe -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`
			: scriptPath;

		return {
			assets: [
				{
					relativePath: scriptFile,
					contents: isWindows
						? buildPowerShellWrapperScript(options.url, 'codex')
						: buildCurlWrapperScript(options.url, 'codex'),
					executable: !isWindows,
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
										command,
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
