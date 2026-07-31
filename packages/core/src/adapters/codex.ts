import { normalizeHookTimeoutSeconds, type HookAdapter } from './base.ts';
import { hookInstallScaffold } from './install.ts';
import { normalizePayload } from '../hooks/adapter-utils.ts';

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
		const { targetPath, targetHome, command, asset } = hookInstallScaffold(options, 'codex', 'codex');
		const timeoutSeconds = normalizeHookTimeoutSeconds(options.timeoutSeconds);

		return {
			assets: [asset],
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
