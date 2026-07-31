# umboðsmaðr

_The arbiter of policy within the autonomous realm._

Every agent has its own way of doing permissions. Or no way. What does it actually mean for an agent to have "permissions" anyway? Usually it means a config file nobody reads until something breaks, buried in a format slightly different from the last one.

`umbodsmadr` is a centralized policy enforcement engine for AI agents. Define policy once in `umbod.toml`, hook your agents in, and every one of them enforces the same rules from that point forward. Change the policy in one place, it ripples out everywhere.

No more config drift, no more guessing.

The CLI is `umbod`. Old Norse for "representative," composed of `umboð` (proxy, attorney, commission) and `maðr` (man), so, someone authorized to act on another's behalf.

## how it works

`umbod start` spins up a local HTTP server. `umbod configure` generates the hooks for your agents to route tool calls through it. Manually add those in, I'm not touching your files.

When a call comes in, the engine classifies it (readonly, destructive, external, stateful, unknown), matches it against your rules, and decides what to do. If it needs approval, the agent blocks and waits for you to say yes or no, either from the web dashboard or from the CLI. Everything gets logged to SQLite.

## the manifest

```toml
[env]
name = "dev"
version = "1.0.0"
timeout = 30

[policy]
default_unknown = "block"
approval_method = "web"  # or "cli" or "both"

[rules]
"git log *" = "allow"
"ls *" = "allow"
"rm *" = "approve"
"git push *" = "approve"
"* --force" = "approve"
# Hidden file blocking, matches on Bash and Tool calls
'/(^|\/)\.[^\s\/]+/' = "block"

[[workspaces]]
id = "client-production"
roots = ["/work/client-app", "C:\\work\\client-app"]
default_unknown = "block"

[workspaces.rules]
"git push *" = "block"
"terraform plan *" = "approve"
```

Rules are either wildcard patterns (`rm *`, `* --force`) or regex (`/^pattern$/flags`). First match wins. Anything unmatched falls back to `default_unknown`. Changing the manifest requires a restart.

The audit database lives next to the manifest as `umbod.envName.db`.

## workspaces

A workspace is a named policy scope. It can represent a repository, IDE workspace, client environment, container, or any other boundary meaningful to the host. It is not tied to a particular agent or application.

Embedded hosts can set `workspaceId` on a tool call. Generated hooks also read `workspace_id`, `workspaceId`, or `workspace.id` when the provider includes one. When no ID is supplied, Umbod uses `workingDirectory` and selects the workspace with the longest matching root.

Resolution is deterministic:

1. A known explicit workspace ID wins.
2. With no ID, or with an unknown ID, the longest matching filesystem root wins.
3. An unknown ID with no matching root is blocked.
4. With no ID and no matching root, global policy applies.

When an unknown ID resolves through cwd, Umbod records both the requested ID and the resolved workspace. If neither form of workspace identity resolves, Umbod fails closed instead of letting the call inherit global policy.

Workspace rules run before global rules, so they can deliberately make a global decision stricter or more relaxed. If neither layer matches, the workspace's `default_unknown` is used when present, otherwise the global default applies. `approval_method` remains global because it controls how the Umbod service obtains approvals.

Roots are optional. A host can use a purely conceptual workspace by sending its ID directly. Multiple absolute roots may be listed as aliases for native Windows, WSL, containers, or additional checkouts. Duplicate normalized roots are rejected, while nested roots are allowed and select the most specific workspace.

## agents

`umbod configure --agent <name>` generates the hook config and shell wrapper, written to `.umbod/` by default.

Supported agents: Claude Code, Cursor, Codex, Gemini CLI.

```bash
umbod configure --agent claude
umbod configure --agent cursor --output ~/hooks
umbod configure  # all of them
```

For Codex, append the generated `.umbod/codex.toml` snippet to `~/.codex/config.toml`. Keep the generated `.umbod/hook-codex.sh` in place; the TOML snippet points Codex at that script. On first launch after adding the hook, Codex will ask you to trust it before it runs.

Codex has its own hook timeout and does not currently expose a true "disabled" value. If `env.timeout = 0`, umbod keeps approval requests open indefinitely, but the generated Codex hook uses `timeout = 86400` as a practical outer limit. Do not change that to `timeout = 0`; Codex treats zero as an immediate timeout.

## environments

Swapping between setups is just pointing at a different manifest. Personal projects on loose policy, client work locked down, whatever you need.

```bash
umbod start --env ~/policies/personal.toml
umbod start --env ~/policies/work.toml
```

## dashboard

`http://localhost:9090`. Port 9090, because nine is the most sacred number in Norse mythology (Odin hung on Yggdrasil for nine days and nine nights).

Pending approvals, full audit log, active rules. Outcomes are labeled in theme: _Sanctioned_, _Outlawed_, _Vouched_, _Forbidden_, _In Moot_. Real-time updates via WebSocket.

## platform

Windows, and Linux (including WSL)

## install

Linux:

```bash
curl -fsSL https://github.com/kyle-undefined/umbodsmadr/releases/latest/download/install.sh | bash
```

Windows:

```powershell
irm https://github.com/kyle-undefined/umbodsmadr/releases/latest/download/install.ps1 | iex
```

## build

```bash
bun run typecheck
bun run test
bun run build
```

## embedding

The repo is a Bun workspace: `packages/core` (`@umbod/core`) holds the policy engine, audit log, hook adapters, and the API handler; `packages/cli` is the `umbod` binary on top of it. If you're building a Bun app and want the engine in-process instead of running the CLI, depend on core and mount it on the port your hooks point at:

```ts
import { createUmbod, loadManifest } from '@umbod/core';

const manifest = await loadManifest('umbod.toml');
const umbod = createUmbod({
	manifest,
	dbPath: 'umbod.dev.db',
	onActivity: (entry) => console.log(entry),
});

const result = await umbod.authorize({
	agent: 'my-host',
	tool: 'bash',
	command: 'git push origin main',
	workingDirectory: '/work/client-app',
	workspaceId: 'client-production',
	timestamp: new Date().toISOString(),
});

Bun.serve({ port: 9090, fetch: (req) => umbod.fetch(req) ?? new Response('not found', { status: 404 }) });
```

`umbod.fetch` serves the same `/health` and `/api/*` contract as the CLI server (minus the dashboard), so generated hooks work unchanged against either. Approvals surface through `listPendingApprovals()` / `resolveApproval()`, or pass `approvalPrompt` to wire them into your own UI.
