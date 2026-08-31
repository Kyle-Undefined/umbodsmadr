import { normalizeHookTimeoutSeconds, type HookAdapter } from './base.ts';
import { buildCurlWrapperScript, buildPowerShellWrapperScript, normalizePayload } from '../hooks/adapter-utils.ts';

function integrationGuide(url: string): string {
	const endpoint = `${url.replace(/\/$/, '')}/api/hooks`;
	return `# Umbod custom-agent integration

Use this kit when an agent is not one of Umbod's built-in adapters. ACP by itself does not define a pre-tool hook, so connect this at the agent's native callback that runs before a tool executes and can block it.

## Command hook

Configure the agent to send its pre-tool JSON payload to one of these commands on stdin:

- POSIX/WSL, from the generated directory: \`./hook-other.sh\`
- Windows, from the generated directory: \`powershell.exe -NonInteractive -ExecutionPolicy Bypass -File ".\\hook-other.ps1"\`

Exit code 0 means allow. Any other exit code means deny. The wrappers fail closed if Umbod cannot be reached or returns anything except an explicit allow.

The payload should provide as many of these fields as the agent exposes:

\`\`\`json
{
  "tool_name": "bash",
  "tool_input": { "command": "git status" },
  "cwd": "/path/to/workspace",
  "workspace_id": "optional-workspace",
  "session_id": "optional-session",
  "tool_use_id": "optional-call-id"
}
\`\`\`

Umbod also accepts \`toolName\`, \`tool\`, \`input\`, \`command\`, \`working_directory\`, and camelCase identity fields.

## Native extension callback

For an agent with a JavaScript or TypeScript extension API, call Umbod directly before execution:

\`\`\`ts
const response = await fetch(${JSON.stringify(endpoint)}, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-umbod-agent": "other",
  },
  body: JSON.stringify({
    tool_name: toolName,
    tool_input: input,
    cwd,
    session_id: sessionId,
    tool_use_id: toolCallId,
  }),
});

if (!response.ok) throw new Error(\`Umbod returned HTTP \${response.status}\`);
const decision = await response.json();
if (decision.permissionDecision !== "allow") {
  throw new Error(decision.reason ?? "Blocked by Umbod policy");
}
\`\`\`

Do not treat request failures, malformed responses, or timeouts as approval. If the agent cannot block from its callback, that callback is observational only and is not a safe enforcement integration.
`;
}

export const otherAdapter: HookAdapter = {
	id: 'other',
	displayName: 'Custom agent',
	hookEvent: 'native pre-tool callback',
	supportedTools: [],
	normalizePayload(payload) {
		return normalizePayload('other', payload, {
			toolPaths: ['tool_name', 'toolName', 'tool', 'name'],
			commandPaths: ['tool_input.command', 'toolInput.command', 'input.command', 'arguments.command', 'command'],
			inputValuePaths: [
				'tool_input.file_path',
				'tool_input.path',
				'tool_input.pattern',
				'toolInput.filePath',
				'toolInput.path',
				'input.file_path',
				'input.path',
			],
			argsPaths: ['args', 'argv'],
			workingDirectoryPaths: ['cwd', 'working_directory', 'workingDirectory', 'workspaceRoot'],
			fallbackTool: 'unknown',
			toolAliases: { apply_patch: 'edit', run_shell_command: 'bash', read_file: 'read', write_file: 'write' },
		});
	},
	install(options) {
		const timeoutSeconds = normalizeHookTimeoutSeconds(options.timeoutSeconds);
		return {
			assets: [
				{
					relativePath: 'hook-other.sh',
					contents: buildCurlWrapperScript(options.url, 'other', timeoutSeconds, 'generic'),
					executable: true,
				},
				{
					relativePath: 'hook-other.ps1',
					contents: buildPowerShellWrapperScript(options.url, 'other', timeoutSeconds, 'generic'),
				},
			],
			config: {
				fileName: 'other.md',
				settingsPath: 'the custom agent native pre-tool hook or extension configuration',
				contents: integrationGuide(options.url),
			},
		};
	},
};
