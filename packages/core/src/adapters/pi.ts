import type { HookAdapter } from './base.ts';
import { authorizationFunction, extensionTarget } from './extension-utils.ts';
import { normalizePayload } from '../hooks/adapter-utils.ts';

export const piAdapter: HookAdapter = {
	id: 'pi',
	displayName: 'Pi',
	hookEvent: 'tool_call',
	supportedTools: ['bash', 'read', 'write', 'edit', 'grep', 'find', 'list'],
	normalizePayload(payload) {
		return normalizePayload('pi', payload, {
			toolPaths: ['tool_name', 'toolName', 'tool'],
			commandPaths: ['tool_input.command', 'input.command', 'command'],
			inputValuePaths: ['tool_input.path', 'tool_input.file_path', 'tool_input.pattern'],
			workingDirectoryPaths: ['cwd', 'working_directory'],
			fallbackTool: 'unknown',
		});
	},
	install(options) {
		const target = extensionTarget(options, 'pi');
		target.asset.contents = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

${authorizationFunction(options.url, 'pi', options.timeoutSeconds)}

export default function umbod(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const decision = await authorize({
			tool_name: event.toolName,
			tool_input: event.input,
			cwd: ctx.cwd,
			tool_use_id: event.toolCallId,
		});
		if (!decision.allowed) return { block: true, reason: decision.reason };
	});
}
`;

		return {
			assets: [target.asset],
			config: {
				fileName: 'pi.json',
				settingsPath: target.targetPath.join(target.targetHome, '.pi', 'agent', 'settings.json'),
				contents: { extensions: [target.assetPath] },
			},
		};
	},
};
