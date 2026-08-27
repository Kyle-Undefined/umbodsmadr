import type { HookAdapter } from './base.ts';
import { authorizationFunction, extensionTarget } from './extension-utils.ts';
import { normalizePayload } from '../hooks/adapter-utils.ts';

export const opencodeAdapter: HookAdapter = {
	id: 'opencode',
	displayName: 'OpenCode',
	hookEvent: 'tool.execute.before',
	supportedTools: ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'list'],
	normalizePayload(payload) {
		return normalizePayload('opencode', payload, {
			toolPaths: ['tool_name', 'toolName', 'tool'],
			commandPaths: ['tool_input.command', 'input.command', 'command'],
			inputValuePaths: ['tool_input.file_path', 'tool_input.path', 'tool_input.pattern'],
			workingDirectoryPaths: ['cwd', 'directory', 'working_directory'],
			fallbackTool: 'unknown',
			toolAliases: { apply_patch: 'edit' },
		});
	},
	install(options) {
		const target = extensionTarget(options, 'opencode');
		target.asset.contents = `import type { Plugin } from "@opencode-ai/plugin";

${authorizationFunction(options.url, 'opencode', options.timeoutSeconds)}

export const UmbodPlugin: Plugin = async ({ directory }) => ({
	"tool.execute.before": async (input, output) => {
		const decision = await authorize({
			tool_name: input.tool,
			tool_input: output.args,
			cwd: directory,
			session_id: input.sessionID,
			tool_use_id: input.callID,
		});
		if (!decision.allowed) throw new Error(decision.reason);
	},
});
`;

		return {
			assets: [target.asset],
			config: {
				fileName: 'opencode.json',
				settingsPath: target.targetPath.join(target.targetHome, '.config', 'opencode', 'opencode.json'),
				contents: { plugin: [target.assetPath] },
			},
		};
	},
};
