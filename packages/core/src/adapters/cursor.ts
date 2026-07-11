import { homedir } from 'node:os';
import path from 'node:path';

import type { HookAdapter } from './base.ts';
import { buildCurlWrapperScript, buildPowerShellWrapperScript, normalizePayload } from '../hooks/adapter-utils.ts';

export const cursorAdapter: HookAdapter = {
	id: 'cursor',
	displayName: 'Cursor',
	hookEvent: 'preToolUse',
	supportedTools: ['bash', 'read', 'write', 'edit'],
	normalizePayload(payload) {
		return normalizePayload('cursor', payload, {
			toolPaths: ['toolName', 'tool_name', 'tool'],
			commandPaths: ['toolInput.command', 'tool_input.command', 'command', 'input.command'],
			inputValuePaths: [
				'toolInput.file_path',
				'toolInput.filePath',
				'toolInput.pattern',
				'toolInput.path',
				'tool_input.file_path',
				'tool_input.pattern',
				'tool_input.path',
			],
			argsPaths: ['argv', 'args'],
			workingDirectoryPaths: ['cwd', 'workspaceRoot', 'working_directory'],
			fallbackTool: 'unknown',
		});
	},
	install(options) {
		const isWindows = options.platform ? options.platform === 'windows' : process.platform === 'win32';
		const targetPath = isWindows ? path.win32 : path.posix;
		const targetHome = options.homeDir ?? homedir();
		const scriptFile = isWindows ? 'hook-cursor.ps1' : 'hook-cursor.sh';
		const scriptPath = targetPath.join(options.outputDir, scriptFile);
		const command = isWindows
			? `powershell.exe -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`
			: scriptPath;

		return {
			assets: [
				{
					relativePath: scriptFile,
					contents: isWindows
						? buildPowerShellWrapperScript(options.url, 'cursor', 'cursor')
						: buildCurlWrapperScript(options.url, 'cursor', 'cursor'),
					executable: !isWindows,
				},
			],
			config: {
				fileName: 'cursor.json',
				settingsPath: targetPath.join(targetHome, '.cursor', 'hooks.json'),
				contents: {
					version: 1,
					hooks: {
						preToolUse: [{ command, failClosed: true }],
					},
				},
			},
		};
	},
};
