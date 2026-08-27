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
operations = ["filesystem.read"]
workspaces = ["client-production"]
requires_all = true # set requires_any = true to OR selector kinds
priority = 10
reason = "normal repository read"
mode = "enforce" # or "warn" / "observe"
expires_at = "2030-01-01T00:00:00Z"
max_uses = 20

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

Legacy `[rules]` entries remain supported as wildcard patterns (`rm *`, `* --force`) or regex (`/^pattern$/flags`). Structured `[[rule]]` entries have stable IDs and may select `tools`, `commands`, `paths`, `classifications`, `agents`, trusted canonical `operations`, and effective `workspaces`. Selector kinds are ANDed by default; set `requires_any = true` to OR them. Values within one selector are always ORed. Higher `priority` runs first, with manifest order breaking ties. Structured rules run before the legacy table in the same scope. Adapter-derived operations include `filesystem.read`, `filesystem.search`, `filesystem.edit`, `filesystem.write`, `network.fetch`, and `network.search`; embedded hosts may supply their own canonical dotted operation IDs. Public `/api/evaluate` callers cannot self-assert trusted operation metadata. Audit entries record both the stable rule ID and the selector kinds that matched.

`[[guard]]` and `[[workspaces.guard]]` entries are block-only invariants. Global guards run first and cannot be relaxed by workspace policy; workspace guards run next, followed by workspace rules, global rules, and classification defaults. Guards may omit `decision`; when present it must be `"block"`. A directory-wide `grep` or `glob` uses `default_unknown` instead of a permissive readonly default whenever a blocking hidden-path rule may apply, because the search may expose a protected target.

Structured rules and guards default to `mode = "enforce"`. `warn` enforces the decision while marking the result and reason as a warning; `observe` appears in policy traces without affecting the decision. `expires_at` removes a rule from consideration at that instant. `max_uses` limits enforcement within one active compiled policy generation; unchanged saves keep the counter, while a real activation or process restart begins a new generation.

`[policy.defaults]` provides fallbacks for `readonly`, `stateful`, `destructive`, `external`, and `unknown` calls. When the table is absent, legacy readonly auto-allow behavior is preserved. `policy.default_unknown` remains a compatibility fallback and may be omitted only when `policy.defaults.unknown` is set. Workspace defaults override matching classifications; a workspace `default_unknown` retains its legacy precedence for classifications omitted from that workspace table, followed by the global classification default and global `default_unknown`.

The audit database lives next to the manifest as `umbod.envName.db`.

While `umbod start` is running, saved manifest changes are reloaded automatically. Umbod reads, parses, validates, and compiles the complete candidate before atomically activating it. A failed reload retains the previous policy. `/health` and `/api/manifest` expose `sourceHash`, `activeHash`, `loadedAt`, `generation`, and reload status, and each new audit row records the active policy hash and generation that produced its decision.

Common shell pipelines and `&&`/`;` chains are tokenized without splitting quoted separators. Every component is classified and the strictest classification wins (`destructive`, then `external`, `stateful`, and `readonly`). Unsupported or ambiguous syntax such as command substitution, shell flow control, interpreter execution, or malformed quoting is classified as `unknown` and follows the configured unknown default.

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

Use `--all` for an explicitly unbounded replay, `--database` to select a different audit database, and `--json` for the complete report. Full replay uses stable keyset batches rather than retaining the entire audit table in memory, but it can still take materially longer than the default 2,000-call sample. Available failure checks are `blocked-to-allow`, `approve-to-allow`, `previously-denied-to-allow`, `unresolved-workspace`, and `truncated`. Stored historical outcomes, freshly replayed baseline decisions, and candidate decisions remain separate in the report.

For a release-gating replay across every eligible audit record:

```bash
umbod policy simulate ./candidate.toml \
  --env ./umbod.toml \
  --all \
  --fail-on blocked-to-allow \
  --fail-on previously-denied-to-allow \
  --fail-on unresolved-workspace
```

Manifests may carry executable policy fixtures:

```toml
[[test]]
id = "status-is-readable"
call = { agent = "fixture", tool = "bash", command = "git status" }
expect = "allow"
```

Run them with `umbod policy test ./umbod.toml`; any mismatch exits with status 2.

Rule analytics label rules with no historical match as `never_observed` rather than “dead.” Suggestions calculate approval purity and minimum evidence from resolved approvals only, report pending and stale-pending requests separately, and require double the configured evidence, zero denials, and zero pending requests before proposing a permanent allow for destructive calls.

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

Supported agents: Claude Code, Cursor, Codex, Gemini CLI, OpenCode, and Pi. Use `other` to generate a portable integration kit for another agent with an enforceable native pre-tool callback.

```bash
umbod configure --agent claude
umbod configure --agent cursor --output ~/hooks
umbod configure --agent opencode
umbod configure --agent pi
umbod configure --agent other
umbod configure  # all of them
```

OpenCode and Pi use their native extension APIs because ACP itself does not define a pre-tool policy hook. Add the generated OpenCode plugin entry to `~/.config/opencode/opencode.json`, or the generated Pi extension entry to `~/.pi/agent/settings.json`. Their generated extensions fail closed when Umbod denies a call or cannot be reached.

`umbod configure --agent other` generates POSIX/WSL and PowerShell wrappers plus `other.md`, which contains the normalized payload contract and a direct TypeScript integration example. Use it only with a callback that can prevent execution; an after-tool or notification-only callback cannot enforce policy.

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

Pending approvals, full audit log, structured and legacy rules, active policy generation/reload health, rule analytics, and per-call policy provenance. Outcomes are labeled in theme: _Sanctioned_, _Outlawed_, _Vouched_, _Forbidden_, _In Moot_. Real-time updates use WebSocket with a reconnect refresh of policy status.

The visible Policy Studio loads the active TOML source and supports an edit → validate/test → simulate → save-and-activate workflow. The default replay evaluates the latest 2,000 eligible audit calls; **All records (slow)** performs a full keyset-batched replay for release gating. Both modes are read-only and retain bounded representative examples for transition, safety, coverage, and per-rule drill-downs. Truncated samples are labeled explicitly, while a full replay reports the complete eligible-call count. Activation remains disabled until that exact editor content and selected replay mode pass parsing, compilation, embedded tests, and simulation. Saving uses a source hash to reject stale editors, a same-directory atomic file replacement, rollback on activation failure, and the normal atomic policy reload. Bootstrap fields that require a process restart cannot be changed in Studio.

Use the CLI simulator for custom filters, unbounded replay, JSON output, and CI-style failure checks.

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
