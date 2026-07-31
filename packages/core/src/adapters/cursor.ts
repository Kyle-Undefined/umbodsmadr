import type { HookAdapter } from './base.ts';
import { hookInstallScaffold } from './install.ts';
import { normalizePayload } from '../hooks/adapter-utils.ts';

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
		const { targetPath, targetHome, command, asset } = hookInstallScaffold(options, 'cursor', 'cursor');

		return {
			assets: [asset],
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
