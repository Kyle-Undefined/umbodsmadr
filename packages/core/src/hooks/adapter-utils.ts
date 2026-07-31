import type { ApprovalDecision, ToolCall } from '../core/types.ts';
import { isRecord } from '../utils/guards.ts';

interface NormalizeOptions {
	toolPaths: string[];
	commandPaths: string[];
	argsPaths?: string[];
	workingDirectoryPaths?: string[];
	inputValuePaths?: string[];
	fallbackTool?: string;
	toolAliases?: Record<string, string>;
}

function readPath(payload: unknown, dottedPath: string): unknown {
	let current: unknown = payload;

	for (const segment of dottedPath.split('.')) {
		if (!isRecord(current) || !(segment in current)) {
			return undefined;
		}

		current = current[segment];
	}

	return current;
}

function firstString(payload: unknown, paths: string[]): string | undefined {
	for (const dottedPath of paths) {
		const value = readPath(payload, dottedPath);
		if (typeof value === 'string' && value.trim().length > 0) {
			return value;
		}
	}

	return undefined;
}

function allStrings(payload: unknown, paths: string[]): string[] {
	const results: string[] = [];
	for (const dottedPath of paths) {
		const value = readPath(payload, dottedPath);
		if (typeof value === 'string' && value.trim().length > 0) {
			results.push(value);
		}
	}
	return results;
}

function firstStringArray(payload: unknown, paths: string[]): string[] | undefined {
	for (const dottedPath of paths) {
		const value = readPath(payload, dottedPath);
		if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
			return value;
		}
	}

	return undefined;
}

function normalizeServerUrl(serverUrl: string): string {
	const parsed = new URL(serverUrl);

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`unsupported server URL protocol: ${parsed.protocol}`);
	}

	return parsed.toString().replace(/\/$/, '');
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function canonicalizeToolName(tool: string, toolAliases?: Record<string, string>): string {
	const toolLower = tool.toLowerCase();
	if (!toolAliases) return toolLower;
	return toolAliases[toolLower] ?? toolLower;
}

export function normalizePayload(agent: string, payload: unknown, options: NormalizeOptions): ToolCall {
	const rawTool = firstString(payload, options.toolPaths) ?? options.fallbackTool ?? 'unknown';
	const tool = canonicalizeToolName(rawTool, options.toolAliases);
	const args = options.argsPaths ? firstStringArray(payload, options.argsPaths) : undefined;
	const explicitCommand = firstString(payload, options.commandPaths);

	let command: string;
	if (explicitCommand) {
		command = explicitCommand;
	} else if (args && args.length > 0) {
		command = args.join(' ');
	} else {
		const inputValues = options.inputValuePaths ? allStrings(payload, options.inputValuePaths) : [];
		command = inputValues.length > 0 ? `${tool} ${inputValues.join(' ')}` : tool;
	}

	return {
		agent,
		tool,
		command,
		args,
		workingDirectory: options.workingDirectoryPaths ? firstString(payload, options.workingDirectoryPaths) : undefined,
		workspaceId: firstString(payload, ['workspace_id', 'workspaceId', 'workspace.id']),
		inputs: isRecord(payload) ? payload : { raw: payload },
		timestamp: new Date().toISOString(),
		sessionId: firstString(payload, ['session_id', 'sessionId', 'thread_id']),
		toolUseId: firstString(payload, ['tool_use_id', 'toolUseId', 'call_id']),
	};
}

export type CurlWrapperHookTarget = 'codex' | 'cursor' | 'gemini' | 'generic';

function buildCurlPreamble(url: string, agent: string): string {
	return `#!/usr/bin/env sh
set -eu
R=$(mktemp) && trap 'rm -f "$R"' EXIT
CURL=curl
if [ -x /mnt/c/Windows/System32/curl.exe ] && grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  CURL=/mnt/c/Windows/System32/curl.exe
fi
C=$("$CURL" -sS -o "$R" -w '%{http_code}' --connect-timeout 5 \\
  -X POST ${shellQuote(url)} \\
  -H 'content-type: application/json' \\
  -H ${shellQuote('x-umbod-agent: ' + agent)} \\
  --data-binary @-)
`;
}

export function buildCurlWrapperScript(
	serverUrl: string,
	agent: string,
	hookTarget: CurlWrapperHookTarget = 'generic'
): string {
	const url = normalizeServerUrl(serverUrl) + '/api/hooks';
	const preamble = buildCurlPreamble(url, agent);

	if (hookTarget === 'cursor') {
		return (
			preamble +
			`case "$C" in
  2*)
    if grep -Eq '"permissionDecision"[[:space:]]*:[[:space:]]*"allow"' "$R"; then
      printf '%s\\n' '{"permission":"allow"}'
      exit 0
    fi
    ;;
esac
printf '%s\\n' '{"permission":"deny","user_message":"Blocked by umbod policy.","agent_message":"This tool call was denied by the umbod policy engine. See the umbod dashboard for the matched rule and reason."}'
cat "$R" >&2
exit 2
`
		);
	}

	if (hookTarget === 'gemini') {
		return (
			preamble +
			`case "$C" in
  2*)
    if grep -Eq '"permissionDecision"[[:space:]]*:[[:space:]]*"allow"' "$R"; then
      printf '%s\\n' '{"decision":"allow","suppressOutput":true}'
      exit 0
    fi
    printf '%s\\n' '{"decision":"deny","reason":"Blocked by umbod policy. See the umbod dashboard for the matched rule and reason.","suppressOutput":true}'
    exit 0
    ;;
esac
printf '%s\\n' 'umbod hook request failed.' >&2
cat "$R" >&2
exit 2
`
		);
	}

	if (hookTarget === 'codex') {
		return (
			preamble +
			`case "$C" in
  2*)
    if grep -Eq '"permissionDecision"[[:space:]]*:[[:space:]]*"allow"' "$R"; then
      exit 0
    fi
    if grep -Eq '"permissionDecision"[[:space:]]*:[[:space:]]*"deny"' "$R"; then
      printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by umbod policy. See the umbod dashboard for the matched rule and reason."}}'
      exit 0
    fi
    ;;
esac
printf '%s\\n' 'umbod hook request failed.' >&2
cat "$R" >&2
exit 2
`
		);
	}

	return (
		preamble +
		`case "$C" in
  2*)
    if grep -Eq '"permissionDecision"[[:space:]]*:[[:space:]]*"allow"' "$R"; then exit 0; fi
    ;;
esac
cat "$R" >&2
exit 2
`
	);
}

function psQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function buildPsPreamble(url: string, agent: string): string {
	return `$body = [Console]::In.ReadToEnd()
try {
    $r = Invoke-WebRequest -Method POST -Uri ${psQuote(url)} \`
        -Headers @{ 'content-type' = 'application/json'; 'x-umbod-agent' = ${psQuote(agent)} } \`
        -Body $body -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) {
        $json = $r.Content | ConvertFrom-Json
`;
}

export function buildPowerShellWrapperScript(
	serverUrl: string,
	agent: string,
	hookTarget: CurlWrapperHookTarget = 'generic'
): string {
	const url = normalizeServerUrl(serverUrl) + '/api/hooks';
	const preamble = buildPsPreamble(url, agent);

	if (hookTarget === 'cursor') {
		return (
			preamble +
			`        if ($json.permissionDecision -eq 'allow') {
            Write-Output '{"permission":"allow"}'
            exit 0
        }
    }
} catch {}
Write-Output '{"permission":"deny","user_message":"Blocked by umbod policy.","agent_message":"This tool call was denied by the umbod policy engine. See the umbod dashboard for the matched rule and reason."}'
exit 2
`
		);
	}

	if (hookTarget === 'gemini') {
		return (
			preamble +
			`        if ($json.permissionDecision -eq 'allow') {
            Write-Output '{"decision":"allow","suppressOutput":true}'
            exit 0
        }
        Write-Output '{"decision":"deny","reason":"Blocked by umbod policy. See the umbod dashboard for the matched rule and reason.","suppressOutput":true}'
        exit 0
    }
} catch {}
[Console]::Error.WriteLine('umbod hook request failed.')
exit 2
`
		);
	}

	if (hookTarget === 'codex') {
		return (
			preamble +
			`        if ($json.permissionDecision -eq 'allow') {
            exit 0
        }
        if ($json.permissionDecision -eq 'deny') {
            Write-Output '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by umbod policy. See the umbod dashboard for the matched rule and reason."}}'
            exit 0
        }
    }
} catch {}
[Console]::Error.WriteLine('umbod hook request failed.')
exit 2
`
		);
	}

	return (
		preamble +
		`        if ($json.permissionDecision -eq 'allow') { exit 0 }
    }
} catch {}
exit 2
`
	);
}

export type PermissionDecision = 'allow' | 'deny';

export function toPermissionDecision(decision: ApprovalDecision): PermissionDecision {
	if (decision === 'allow') return 'allow';
	return 'deny';
}
