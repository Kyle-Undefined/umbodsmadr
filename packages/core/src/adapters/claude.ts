import { normalizeHookTimeoutSeconds, type HookAdapter } from './base.ts';
import { hookInstallScaffold } from './install.ts';
import { normalizePayload } from '../hooks/adapter-utils.ts';

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
		const { targetPath, targetHome, command, asset } = hookInstallScaffold(options, 'claude', 'codex');
		const timeoutSeconds = normalizeHookTimeoutSeconds(options.timeoutSeconds);
		return {
			assets: [asset],
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
