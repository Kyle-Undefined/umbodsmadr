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
```

Rules are either wildcard patterns (`rm *`, `* --force`) or regex (`/^pattern$/flags`). First match wins. Anything unmatched falls back to `default_unknown`. Changing the manifest requires a restart.

The audit database lives next to the manifest as `umbod.envName.db`.

## agents

`umbod configure --agent <name>` generates the hook config and shell wrapper, written to `.umbod/` by default.

Supported agents: Claude Code, Cursor, Codex, Gemini CLI.

```bash
umbod configure --agent claude
umbod configure --agent cursor --output ~/hooks
umbod configure  # all of them
```

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

Linux, including WSL.

## build

```bash
bun run typecheck
bun run test
bun run build
```
