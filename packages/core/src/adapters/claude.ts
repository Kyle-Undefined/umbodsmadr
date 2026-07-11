import { homedir } from 'node:os';
import path from 'node:path';

import { normalizeHookTimeoutSeconds, type HookAdapter } from './base.ts';
import { buildCurlWrapperScript, buildPowerShellWrapperScript, normalizePayload } from '../hooks/adapter-utils.ts';

export const claudeAdapter: HookAdapter = {
	id: 'claude',
	displayName: 'Claude',
	hookEvent: 'PreToolUse',
	supportedTools: ['bash', 'read', 'write', 'edit'],
	normalizePayload(payload) {
		return normalizePayload('claude', payload, {
			toolPaths: ['tool_name', 'toolName', 'tool'],
			commandPaths: ['tool_input.command', 'toolInput.command', 'command', 'input.command'],
			inputValuePaths: ['tool_input.file_path', 'tool_input.pattern', 'tool_input.path'],
			argsPaths: ['args', 'argv'],
			workingDirectoryPaths: ['cwd', 'working_directory'],
			fallbackTool: 'unknown',
		});
	},
	install(options) {
		const isWindows = options.platform ? options.platform === 'windows' : process.platform === 'win32';
		const targetPath = isWindows ? path.win32 : path.posix;
		const targetHome = options.homeDir ?? homedir();
		const scriptFile = isWindows ? 'hook-claude.ps1' : 'hook-claude.sh';
		const scriptPath = targetPath.join(options.outputDir, scriptFile);
		const timeoutSeconds = normalizeHookTimeoutSeconds(options.timeoutSeconds);
		const command = isWindows
			? `powershell.exe -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`
			: scriptPath;
		return {
			assets: [
				{
					relativePath: scriptFile,
					contents: isWindows
						? buildPowerShellWrapperScript(options.url, 'claude', 'codex')
						: buildCurlWrapperScript(options.url, 'claude', 'codex'),
					executable: !isWindows,
				},
			],
			config: {
				fileName: 'claude.json',
				settingsPath: targetPath.join(targetHome, '.claude', 'settings.json'),
				contents: {
					hooks: {
						PreToolUse: [
							{
								matcher: '*',
								hooks: [
									{
										type: 'command',
										command,
										timeout: timeoutSeconds,
										statusMessage: 'Checking umbod policy',
										failClosed: true,
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
