import { homedir } from 'node:os';
import path from 'node:path';

import type { HookAdapter } from './base.ts';
import { buildCurlWrapperScript, normalizePayload } from '../hooks/adapter-utils.ts';

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
		const scriptPath = path.join(options.outputDir, 'hook-cursor.sh');

		return {
			assets: [
				{
					relativePath: 'hook-cursor.sh',
					contents: buildCurlWrapperScript(options.url, 'cursor', 'cursor'),
					executable: true,
				},
			],
			config: {
				fileName: 'cursor.json',
				settingsPath: path.join(homedir(), '.cursor', 'hooks.json'),
				contents: {
					version: 1,
					hooks: {
						preToolUse: [{ command: scriptPath, failClosed: true }],
					},
				},
			},
		};
	},
};
