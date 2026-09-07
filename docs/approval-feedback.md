# Approval feedback

Hosts can return either a legacy decision or a structured response from both the instance-level `approvalPrompt` and the per-call `authorize(..., { approvalPrompt })` callback:

```ts
import type { ApprovalPrompt, ApprovalResponse } from '@umbod/core';

const approvalPrompt: ApprovalPrompt = async (call, policyReason) => {
	const answer = await showApproval(call, policyReason); // Your host's UI
	return {
		decision: answer.allowed ? 'allow' : 'block',
		userFeedback: answer.feedback, // Optional string; preserve user text verbatim
	} satisfies ApprovalResponse;
};
```

`ApprovalResponse` is `{ decision: ApprovalDecision; userFeedback?: string }`. Legacy promises resolving to `"allow"`, `"block"`, or `"approve"` still work. As before, only `"allow"` approves; an unresolved `"approve"` fails closed. Feedback cannot select or change a decision. Policy blocks do not call the prompt, and approval bypass does not override blocks.

`authorize` returns the original `policyDecision`, resolved `decision`, original policy reason at `entry.reason`, and optional raw `userFeedback`. Embedded hosts must map that result to their provider's native denial contract for the same operation. Returning `userFeedback` to a host is not delivery to a provider.

For `POST /api/hooks`, the response contains:

```json
{
	"permissionDecision": "deny",
	"policyDecision": "approve",
	"policyReason": "Matched approval rule",
	"userFeedback": "Read the file before editing it.\nKeep the existing API.",
	"permissionDecisionReason": "Matched approval rule\n\nUser feedback:\nRead the file before editing it.\nKeep the existing API.",
	"hookSpecificOutput": { "hookEventName": "PreToolUse" }
}
```

The policy reason and raw user text remain separate. `permissionDecisionReason` is a presentation field: on denial, it appends the exact text under `User feedback:`. Without feedback it retains the policy reason. Feedback on an allowed result is returned to the host/API but is **not forwarded by the denial adapters**. No permission or tool input is rewritten from feedback.

Feedback lives in the requesting promise, not a session/tool lookup or global cache. The `both` method retains feedback only when that prompt wins the atomic database resolution. External resolutions and timeouts return no prompt feedback; late callbacks cannot attach feedback to later calls. Feedback is not persisted in the audit database. The decision-only `resolveApproval` API and HTTP approval-action endpoints do not accept feedback; hosts needing feedback must use `approvalPrompt`.

Existing timing semantics remain: `web`/`both` use the configured approval timeout; direct CLI and per-call prompts remain host-controlled and must implement their own timeout/cancellation if needed. A rejected direct prompt rejects `authorize` and produces a non-success hook response. Transport cancellation does not cancel an already pending approval or create a new feedback delivery channel. A hook response lost after an approval cannot be claimed as delivered.

## Adapter contracts

| Adapter          | Denial mechanism                                                                                        | Delivery boundary                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex            | Exit 0, `hookSpecificOutput.permissionDecision: "deny"` and `permissionDecisionReason` for `PreToolUse` | Returned through the [Codex hook contract](https://developers.openai.com/codex/hooks); only provider-supported hooked operations                                 |
| Claude           | Same nested `PreToolUse` denial fields, exit 0                                                          | Denial reason is [shown to Claude](https://code.claude.com/docs/en/hooks#pretooluse-decision-control)                                                            |
| Cursor           | Exit 0, `permission: "deny"`, `agent_message` and `user_message`                                        | [Agent-visible denial field](https://cursor.com/docs/hooks); exit 0 lets Cursor parse the JSON denial                                                            |
| Gemini           | Exit 0, `decision: "deny"`, `reason`                                                                    | [BeforeTool tool error](https://geminicli.com/docs/hooks/reference/#beforetool)                                                                                  |
| OpenCode         | Throw `Error(permissionDecisionReason)` from `tool.execute.before`                                      | [Native blocking plugin callback](https://opencode.ai/docs/plugins/#env-protection); provider owns propagation of the thrown error                               |
| Pi               | Return `{ block: true, reason: permissionDecisionReason }` from `tool_call`                             | [Native extension block result](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md#tool_call)                                |
| Custom (`other`) | Exit 2 with denial text on stderr, or use the documented native callback                                | **Agent-visible delivery is unsupported until the custom host explicitly forwards stderr/error text.** ACP alone supplies no generic pre-tool feedback mechanism |

These are contract-level returns, not proof that a model consumed or followed the feedback. Unsupported provider versions, operations outside installed hooks, disabled/untrusted hooks, and custom hosts that discard error text are outside this delivery guarantee. No session-wide message injection is used as a substitute.

## Installation and validation

Existing generated hooks/extensions must be regenerated with the updated core (`umbod configure --agent <agent>`) and the installed assets replaced at the paths referenced by the provider configuration. Updating the server package alone cannot repair old wrappers that hardcode denial messages or old extensions that read the wrong response field. Reload/restart providers as required to load regenerated extensions. No automatic repair of existing hook installations occurs.

POSIX/WSL command wrappers use curl and standard POSIX utilities (`sh`, `mktemp`, `rm`, `grep`, `tr`, `cmp`, and `sed`). They do not require jq, Python, Node, or Bun. PowerShell uses its built-in JSON parser and curl.exe, supports Windows PowerShell 5.1, and explicitly uses UTF-8. Neither path evaluates response text as code. Both retain the five-second connection timeout and the configured overall transport timeout (86400-second wrapper fallback for timeout zero).

POSIX wrappers request `POST /api/hooks?format=command-v1`. The server returns a UTF-8 text response, without a terminating newline, containing exactly `umbod-hook-v1 allow` or `umbod-hook-v1 deny ` followed by one JSON-encoded string. The server escapes ASCII DEL as `\u007f` in addition to JSON's standard escapes. The wrapper rejects literal ASCII control bytes, extra lines, and unknown frames, and validates the complete JSON string token before inserting it into a fixed provider denial envelope with `printf`. Text inside the reason can never become a permission decision or shell code. No general JSON parser is implemented in shell.

The default hook JSON response remains unchanged for Windows, extensions, and embedded consumers. New POSIX wrappers need a server supporting `command-v1`; an older server's JSON response is rejected with an explicit protocol failure rather than falling back to unsafe decision matching. Upgrade the server before replacing POSIX wrappers.

For custom (`other`) wrappers, a valid POSIX denial writes the JSON-encoded string to stderr, preserving every character without a decoder dependency. A custom host must JSON-decode that string and forward it to its agent. Windows writes plain denial text. Transport/protocol failures write diagnostics instead of a feedback string; do not claim these as feedback delivery.

Regression tests execute generated POSIX and Windows assets against HTTP servers, including the real core authorization endpoint, and dynamically load generated OpenCode/Pi extensions. POSIX execution tests restrict PATH to the listed utilities, proving no JSON runtime is needed. They cover malformed frames, control bytes, and exact text round-trips. Windows execution tests run on Windows or WSL with Windows PowerShell available; otherwise they are explicitly skipped. These tests verify returned provider fields, not live model consumption.
