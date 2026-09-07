import type { ApprovalDecision, ToolCall } from '../core/types.ts';
import { isRecord } from '../utils/guards.ts';
import { inferredOperation } from '../policy/operations.ts';

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
		operation: inferredOperation(tool, command),
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

function buildCurlPreamble(url: string, agent: string, timeoutSeconds: number): string {
	return `#!/usr/bin/env sh
set -eu
R=$(mktemp) && trap 'rm -f "$R"' EXIT
CURL=curl
if [ -x /mnt/c/Windows/System32/curl.exe ] && grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  CURL=/mnt/c/Windows/System32/curl.exe
fi
C=$("$CURL" -sS -o "$R" -w '%{http_code}' --connect-timeout 5 --max-time ${timeoutSeconds} \\
  -X POST ${shellQuote(url)} \\
  -H 'content-type: application/json' \\
  -H ${shellQuote('x-umbod-agent: ' + agent)} \\
  --data-binary @-)
`;
}

export function buildCurlWrapperScript(
	serverUrl: string,
	agent: string,
	timeoutSeconds: number,
	hookTarget: CurlWrapperHookTarget = 'generic'
): string {
	const url = normalizeServerUrl(serverUrl) + '/api/hooks?format=command-v1';
	const preamble = buildCurlPreamble(url, agent, timeoutSeconds);

	const allowOutput =
		hookTarget === 'cursor'
			? '{"permission":"allow"}'
			: hookTarget === 'gemini'
				? '{"decision":"allow","suppressOutput":true}'
				: '';
	const denyOutput =
		hookTarget === 'codex'
			? '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}'
			: hookTarget === 'cursor'
				? '{"permission":"deny","user_message":%s,"agent_message":%s}'
				: hookTarget === 'gemini'
					? '{"decision":"deny","reason":%s,"suppressOutput":true}'
					: '%s';
	// One JSON string token, never arbitrary JSON or shell code.
	const denialPattern = String.raw`umbod-hook-v1 deny "([^"\\[:cntrl:]]|\\(["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
	return (
		preamble +
		`# command-v1 is exactly one line without a newline terminator.
# The server JSON-encodes the reason; only a validated string token reaches printf.
case "$C" in
  2[0-9][0-9])
    if LC_ALL=C tr -d '\\000-\\037\\177' < "$R" | cmp -s - "$R"; then
      if LC_ALL=C grep -Eq '^umbod-hook-v1 allow$' "$R"; then
        ${allowOutput ? `printf '%s\\n' '${allowOutput}'` : ':'}
        exit 0
      fi
      if LC_ALL=C grep -Eq ${shellQuote('^' + denialPattern + '$')} "$R"; then
        REASON=$(sed 's/^umbod-hook-v1 deny //' "$R")
        printf '${denyOutput}\\n' "$REASON" ${hookTarget === 'cursor' ? '"$REASON"' : ''} ${hookTarget === 'generic' ? '>&2' : ''}
        exit ${hookTarget === 'generic' ? 2 : 0}
      fi
    fi
    ;;
esac
printf '%s\\n' 'umbod hook request failed (transport or invalid command-v1 response); feedback delivery unavailable.' >&2
exit 2
`
	);
}

function psQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function buildPsPreamble(url: string, agent: string, timeoutSeconds: number): string {
	return `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$body = [Console]::In.ReadToEnd()
$responsePath = [System.IO.Path]::GetTempFileName()
try {
    $curlPath = (Get-Command curl.exe -ErrorAction Stop).Source
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $curlPath
    $startInfo.Arguments = ${psQuote('-sS -o "')} + $responsePath + ${psQuote(`" -w "%{http_code}" --connect-timeout 5 --max-time ${timeoutSeconds} -X POST "${url}" -H "content-type: application/json" -H "x-umbod-agent: ${agent}" --data-binary "@-"`)}
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'curl.exe failed to start' }
    $statusTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $process.StandardInput.BaseStream.Write($bodyBytes, 0, $bodyBytes.Length)
    $process.StandardInput.Close()
    $process.WaitForExit()
    $status = $statusTask.Result
    $curlError = $errorTask.Result
    if ($process.ExitCode -ne 0) { throw "curl.exe failed: $curlError" }
    if ($status -match '^2[0-9][0-9]$') {
        $json = Get-Content -Raw -Encoding UTF8 -LiteralPath $responsePath | ConvertFrom-Json
        if ($json -isnot [System.Management.Automation.PSCustomObject] -or $json.permissionDecision -isnot [string] -or $json.permissionDecision -cnotin @('allow', 'deny')) { throw 'invalid hook response' }
        $reason = 'Blocked by Umbod policy.'
        if ($json.permissionDecisionReason -is [string]) { $reason = $json.permissionDecisionReason }
`;
}

export function buildPowerShellWrapperScript(
	serverUrl: string,
	agent: string,
	timeoutSeconds: number,
	hookTarget: CurlWrapperHookTarget = 'generic'
): string {
	const url = normalizeServerUrl(serverUrl) + '/api/hooks';
	const preamble = buildPsPreamble(url, agent, timeoutSeconds);

	const allowOutput =
		hookTarget === 'cursor'
			? `Write-Output '{"permission":"allow"}'`
			: hookTarget === 'gemini'
				? `Write-Output '{"decision":"allow","suppressOutput":true}'`
				: '';
	const denyOutput =
		hookTarget === 'codex'
			? `@{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $reason } } | ConvertTo-Json -Depth 4 -Compress`
			: hookTarget === 'cursor'
				? `@{ permission = 'deny'; user_message = $reason; agent_message = $reason } | ConvertTo-Json -Compress`
				: hookTarget === 'gemini'
					? `@{ decision = 'deny'; reason = $reason; suppressOutput = $true } | ConvertTo-Json -Compress`
					: `[Console]::Error.WriteLine($reason)`;
	return (
		preamble +
		`        if ($json.permissionDecision -ceq 'allow') {
            ${allowOutput}
            exit 0
        }
        ${denyOutput}
        exit ${hookTarget === 'generic' ? 2 : 0}
    }
} catch { [Console]::Error.WriteLine($_.Exception.Message) } finally { Remove-Item -LiteralPath $responsePath -Force -ErrorAction SilentlyContinue }
[Console]::Error.WriteLine('umbod hook request failed; feedback delivery unavailable.')
exit 2
`
	);
}

export type PermissionDecision = 'allow' | 'deny';

export function toPermissionDecision(decision: ApprovalDecision): PermissionDecision {
	if (decision === 'allow') return 'allow';
	return 'deny';
}
