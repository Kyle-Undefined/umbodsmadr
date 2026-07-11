import { homedir } from 'node:os';
import path from 'node:path';

import type { HookAdapter } from './base.ts';
import { buildCurlWrapperScript, buildPowerShellWrapperScript, normalizePayload } from '../hooks/adapter-utils.ts';

const DISABLED_TIMEOUT_FALLBACK_SECONDS = 86_400;

export const codexAdapter: HookAdapter = {
	id: 'codex',
	displayName: 'Codex',
	hookEvent: 'PreToolUse',
	supportedTools: ['bash', 'read', 'write', 'edit', 'apply_patch'],
	normalizePayload(payload) {
		return normalizePayload('codex', payload, {
			toolPaths: ['tool_name', 'toolName', 'tool'],
			commandPaths: [
				'tool_input.command',
				'tool_input.cmd',
				'arguments.command',
				'arguments.cmd',
				'command',
				'cmd',
				'input.command',
				'input.cmd',
			],
			inputValuePaths: [
				'tool_input.file_path',
				'tool_input.path',
				'tool_input.pattern',
				'arguments.file_path',
				'arguments.path',
				'input.file_path',
				'input.path',
			],
			argsPaths: ['arguments.args', 'argv', 'args'],
			workingDirectoryPaths: ['cwd', 'working_directory'],
			fallbackTool: 'bash',
			toolAliases: {
				exec_command: 'bash',
				shell: 'bash',
				apply_patch: 'edit',
				edit: 'edit',
				write: 'write',
				read: 'read',
				bash: 'bash',
			},
		});
	},
	install(options) {
		const isWindows = options.platform ? options.platform === 'windows' : process.platform === 'win32';
		const targetPath = isWindows ? path.win32 : path.posix;
		const targetHome = options.homeDir ?? homedir();
		const scriptFile = isWindows ? 'hook-codex.ps1' : 'hook-codex.sh';
		const scriptPath = targetPath.join(options.outputDir, scriptFile);
		const timeoutSeconds = options.timeoutSeconds === 0 ? DISABLED_TIMEOUT_FALLBACK_SECONDS : options.timeoutSeconds;
		const command = isWindows
			? `powershell.exe -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`
			: scriptPath;

		return {
			assets: [
				{
					relativePath: scriptFile,
					contents: isWindows
						? buildPowerShellWrapperScript(options.url, 'codex', 'codex')
						: buildCurlWrapperScript(options.url, 'codex', 'codex'),
					executable: !isWindows,
				},
			],
			config: {
				fileName: 'codex.toml',
				settingsPath: targetPath.join(targetHome, '.codex', 'config.toml'),
				contents:
					`[[hooks.PreToolUse]]\n` +
					`matcher = "*"\n\n` +
					`[[hooks.PreToolUse.hooks]]\n` +
					`type = "command"\n` +
					`command = ${JSON.stringify(command)}\n` +
					`timeout = ${timeoutSeconds}\n` +
					`statusMessage = "Checking umbod policy"\n`,
			},
		};
	},
};
