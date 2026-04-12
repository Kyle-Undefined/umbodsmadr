import { homedir } from 'node:os';
import path from 'node:path';

import type { HookAdapter } from './base.ts';
import { buildCurlWrapperScript, normalizePayload } from '../hooks/adapter-utils.ts';

export const geminiAdapter: HookAdapter = {
	id: 'gemini',
	displayName: 'Gemini CLI',
	hookEvent: 'BeforeTool',
	supportedTools: ['bash', 'read', 'write', 'edit', 'list', 'grep'],
	normalizePayload(payload) {
		return normalizePayload('gemini', payload, {
			toolPaths: ['tool_name', 'original_request_name', 'toolName', 'tool'],
			commandPaths: ['tool_input.command', 'tool_input.shell_command', 'command'],
			inputValuePaths: [
				'tool_input.file_path',
				'tool_input.paths',
				'tool_input.old_file_path',
				'tool_input.new_file_path',
				'tool_input.dir_path',
				'tool_input.pattern',
				'tool_input.path',
				'tool_input.relative_workspace_path',
			],
			argsPaths: ['tool_input.paths', 'argv', 'args'],
			workingDirectoryPaths: ['tool_input.dir_path', 'cwd', 'working_directory'],
			fallbackTool: 'unknown',
			toolAliases: {
				run_shell_command: 'bash',
				read_file: 'read',
				read_many_files: 'read',
				list_directory: 'list',
				grep_search: 'grep',
				search_file_content: 'grep',
				write_file: 'write',
				replace: 'edit',
			},
		});
	},
	install(options) {
		const scriptPath = path.join(options.outputDir, 'hook-gemini.sh');

		return {
			assets: [
				{
					relativePath: 'hook-gemini.sh',
					contents: buildCurlWrapperScript(options.url, 'gemini', 'gemini'),
					executable: true,
				},
			],
			config: {
				fileName: 'gemini.json',
				settingsPath: path.join(homedir(), '.gemini', 'settings.json'),
				contents: {
					hooks: {
						BeforeTool: [
							{
								matcher: '*',
								hooks: [
									{
										name: 'umbod-gemini',
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
