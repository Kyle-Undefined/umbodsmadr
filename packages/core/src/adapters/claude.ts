import { homedir } from 'node:os';
import path from 'node:path';

import type { HookAdapter } from './base.ts';
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
		return {
			assets: [],
			config: {
				fileName: 'claude.json',
				settingsPath: path.join(homedir(), '.claude', 'settings.json'),
				contents: {
					hooks: {
						PreToolUse: [
							{
								matcher: '*',
								hooks: [
									{
										type: 'http',
										url: `${options.url.replace(/\/+$/, '')}/api/hooks`,
										headers: {
											'x-umbod-agent': 'claude',
										},
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
