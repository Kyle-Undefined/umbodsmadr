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

[policy.defaults]
readonly = "allow"
stateful = "approve"
destructive = "approve"
external = "approve"
unknown = "block"

[rules]
"git log *" = "allow"
"ls *" = "allow"
"rm *" = "approve"
"git push *" = "approve"
"* --force" = "approve"
# Hidden file blocking, matches on Bash and Tool calls
'/(^|\/)\.[^\s\/]+/' = "block"

[[guard]]
id = "credentials"
paths = ["**/.env", "**/id_ed25519", "**/*.pem"]

[[rule]]
id = "repository-reads"
decision = "allow"
tools = ["read", "grep", "glob"]
paths = ["/work/client-app/**"]
classifications = ["readonly"]
reason = "normal repository read"

[[workspaces]]
id = "client-production"
roots = ["/work/client-app", "C:\\work\\client-app"]
default_unknown = "block"

[workspaces.defaults]
readonly = "allow"
stateful = "approve"

[workspaces.rules]
"git push *" = "block"
"terraform plan *" = "approve"

[[workspaces.guard]]
id = "no-force-push"
commands = ["git push --force *"]

[[workspaces.rule]]
id = "normal-edits"
decision = "allow"
tools = ["edit", "write", "apply_patch"]
paths = ["/work/client-app/**"]
```

Legacy `[rules]` entries remain supported as wildcard patterns (`rm *`, `* --force`) or regex (`/^pattern$/flags`). Structured `[[rule]]` entries have stable IDs and may select `tools`, `commands`, `paths`, `classifications`, and `agents`. Selector kinds are ANDed; values within one selector are ORed. Structured rules run in manifest order before the legacy table in the same scope.

`[[guard]]` and `[[workspaces.guard]]` entries are block-only invariants. Global guards run first and cannot be relaxed by workspace policy; workspace guards run next, followed by workspace rules, global rules, and classification defaults. Guards may omit `decision`; when present it must be `"block"`. A directory-wide `grep` or `glob` uses `default_unknown` instead of a permissive readonly default whenever a blocking hidden-path rule may apply, because the search may expose a protected target. Changing the manifest still requires a restart.

`[policy.defaults]` provides fallbacks for `readonly`, `stateful`, `destructive`, `external`, and `unknown` calls. When the table is absent, legacy readonly auto-allow behavior is preserved. `policy.default_unknown` remains a compatibility fallback and may be omitted only when `policy.defaults.unknown` is set. Workspace defaults override matching classifications; a workspace `default_unknown` retains its legacy precedence for classifications omitted from that workspace table, followed by the global classification default and global `default_unknown`.

The audit database lives next to the manifest as `umbod.envName.db`.

### policy simulation

Replay historical audit calls through both the current and a candidate manifest without activating the candidate or writing to the audit database:

```bash
umbod policy simulate ./candidate.toml \
  --env ./umbod.toml \
  --since 30d \
  --limit 2000 \
  --fail-on blocked-to-allow \
  --fail-on unresolved-workspace
```

Use `--all` for an explicitly unbounded replay, `--database` to select a different audit database, and `--json` for the complete report. Available failure checks are `blocked-to-allow`, `approve-to-allow`, `previously-denied-to-allow`, `unresolved-workspace`, and `truncated`. Stored historical outcomes, freshly replayed baseline decisions, and candidate decisions remain separate in the report.

## workspaces

A workspace is a named policy scope. It can represent a repository, IDE workspace, client environment, container, or any other boundary meaningful to the host. It is not tied to a particular agent or application.

Embedded hosts can set `workspaceId` on a tool call. Generated hooks also read `workspace_id`, `workspaceId`, or `workspace.id` when the provider includes one. When no ID is supplied, Umbod uses `workingDirectory` and selects the workspace with the longest matching root.

Resolution is deterministic:

1. A known explicit workspace ID wins.
2. With no ID, or with an unknown ID, the longest matching filesystem root wins.
3. An unknown ID with no matching root is blocked.
4. With no ID and no matching root, global policy applies.

When an unknown ID resolves through cwd, Umbod records both the requested ID and the resolved workspace. If neither form of workspace identity resolves, Umbod fails closed instead of letting the call inherit global policy.

Workspace rules run before global rules, so they can deliberately make a global decision stricter or more relaxed. If neither layer matches, Umbod uses the classification-specific and compatibility fallback order documented above. `approval_method` remains global because it controls how the Umbod service obtains approvals.

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

For a host that only reads analytics, initialize or migrate the database once through `createUmbod` or `AuditLogStore`, then open a reader that cannot write:

```ts
import { createAnalyticsReader } from '@umbod/core';

const analytics = createAnalyticsReader({ dbPath: 'umbod.dev.db', manifest });
const snapshot = analytics.snapshot({ projection: 'summary' });
const calls = analytics.listCalls(
	{ search: 'git status' },
	{ pageSize: 25, projection: 'summary', includeTotal: false }
);
const detail = calls.entries[0] ? analytics.getCall(calls.entries[0].id) : undefined;
analytics.close();
```

The reader does not create or migrate databases. Its `revision()` value is only comparable across reads from that same open reader. Cache keys must also include the manifest and query options.

If a writable Umbod instance and an analytics reader will be active together, opt the writer into WAL with `auditLogOptions: { journalMode: 'wal' }`. The CLI server does this automatically. WAL is persistent, so embedded hosts must opt in deliberately.

The embedded API keeps numbered, full-entry call pages as its default. Consumers can opt into the lean path with `/api/analytics/calls?pagination=cursor&cursor=start&projection=summary&includeTotal=0`, load one full entry from `/api/analytics/calls/:id`, or fetch both summary reports from `/api/analytics/snapshot?projection=summary`.
