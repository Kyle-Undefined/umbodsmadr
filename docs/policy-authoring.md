# Policy authoring and migration

Umbod's old string rules still work, so there is no giant migration hiding in here. Structured policy just gives you much better ways to say what you actually mean, especially once paths and compound shell commands get involved. Move rules over as you touch them.

## Evaluation order

The order matters, especially with workspace rules in the mix. Umbod checks a call like this:

1. Global `[[guard]]` entries.
2. Matching `[[workspaces.guard]]` entries.
3. Matching `[[workspaces.rule]]` entries and then legacy `[workspaces.rules]`.
4. Global `[[rule]]` entries and then legacy `[rules]`.
5. Workspace and global classification defaults.

Guards are block-only. A workspace rule cannot weaken a global guard, which is the whole point of having them. Inside a structured-rule list, higher `priority` runs first, then manifest order breaks a tie.

## Structured selectors

```toml
[[rule]]
id = "repository-edits"
decision = "allow"
tools = ["edit", "write", "apply_patch"]
paths_all = ["/home/me/development/**", 'C:\Users\me\development\**']
classifications = ["stateful"]
reason = "normal edits inside development repositories"
```

Selector kinds are ANDed by default, while values inside one selector are ORed. That sounds more complicated than it is: the example above needs the right tool, path, _and_ classification, but any listed tool can satisfy `tools`. `requires_any = true` ORs selector kinds, so use it only when each selector can justify the decision on its own. `requires_all = true` spells out the default and cannot be combined with `requires_any`.

Here is the full set:

- `tools`: normalized tool names such as `bash`, `read`, `edit`, or `apply_patch`.
- `commands`: the complete normalized invocation. This preserves legacy whole-command matching behavior.
- `components_any`: at least one parsed shell component must match one listed pattern.
- `components_all`: every parsed shell component must match at least one listed pattern. It does not mean every listed pattern must occur.
- `compound`: require (`true`) or reject (`false`) a multi-component shell command.
- `paths`: at least one extracted affected path must match.
- `paths_all`: every extracted affected path must match. Prefer this for edit/write allowances.
- `classifications`: `readonly`, `stateful`, `destructive`, `external`, or `unknown`.
- `agents`, `workspaces`, and `operations`: normalized agent identity, effective workspace ID, and canonical operation.

Patterns are either wildcard patterns or regex literals such as `/^git status(?:\s|$)/i`. Structured rules have stable `id` values, optional `reason` and `priority`, and optional lifecycle controls: `mode = "enforce" | "warn" | "observe"`, `expires_at`, and `max_uses`.

## Safe shell rules

Here is the big trap with old whole-command rules. A prefix glob can swallow the rest of a compound command:

```toml
[rules]
"git diff *" = "allow" # also matches: git diff --check && git commit -m test
```

The component-aware version says what we meant in the first place:

```toml
[[rule]]
id = "standalone-git-diff"
decision = "allow"
tools = ["bash"]
components_all = ["git diff", "git diff *"]
compound = false
```

For a guard or approval that should notice a dangerous component anywhere in a chain, use `components_any`:

```toml
[[guard]]
id = "destructive-git"
components_any = ["git reset --hard *", "git clean -fd*"]
```

Umbod understands common pipelines and `&&`/`;` chains without splitting quoted separators. If the shell syntax gets weird or ambiguous, it falls back to `unknown`. It does not try to be clever with command substitution, flow control, interpreter execution, or broken quoting, because guessing there would be worse.

## Affected paths

Umbod pulls affected paths from provider-native fields and arrays, multi-file edit payloads, `apply_patch` headers, and shell redirections it can parse reliably. The simulation drill-down shows the normalized path, read/write access, and where it came from.

For write boundaries, `paths_all` is the meat and potatoes. Every extracted target has to stay inside:

```toml
[[rule]]
id = "workspace-writes"
decision = "allow"
tools = ["edit", "write", "apply_patch"]
paths_all = ["/home/me/project/**", 'C:\Users\me\project\**']
```

List Windows paths in TOML literal strings (`'...'`) to avoid escaping backslashes, or double every backslash in a basic string. A workspace may list both native Windows and WSL roots:

```toml
[[workspaces]]
id = "project"
roots = ["/mnt/c/Users/me/project", 'C:\Users\me\project']
```

Umbod normalizes separators and uses the right case behavior for each platform. A Windows root does not magically grant the matching `/mnt/c` path, though. List every host alias you actually use.

## Canonical operations

Operations let rules stay provider-neutral. Umbod currently figures out:

- `filesystem.read`, `filesystem.search`, `filesystem.edit`, `filesystem.write`
- `git.read`, `git.commit`, `git.push`, `git.pull`, `git.fetch`, `git.reset`, `git.clean`, `git.checkout`
- `network.fetch`, `network.search`, `network.publish`
- `package.modify`, `package.publish`
- `vault.read`, `vault.write`

For a compound shell call, the strictest recognized operation wins. Public `/api/evaluate` input cannot claim a trusted operation for itself. Umbod figures that out server-side. An embedded trusted host can supply a canonical dotted operation ID when its native metadata knows more.

## Defaults, guards, and modes

I would use explicit classification defaults for a new manifest. It is much easier to read later:

```toml
[policy.defaults]
readonly = "allow"
stateful = "approve"
destructive = "approve"
external = "approve"
unknown = "block"
```

`policy.default_unknown` remains a compatibility alias. Omitting `[policy.defaults]` preserves legacy readonly auto-allow behavior. Reading a sensitive file can still be observational, so place credential and secret boundaries in global guards before relying on readonly defaults.

`observe` records a trace without changing the decision. `warn` enforces its configured decision and marks the result. `max_uses` is counted within one active compiled-policy generation; a process restart or genuinely new activation starts a generation.

## Tests, lint, and simulation

Manifest tests are optional. Validation works fine without them, but tests pin down what you meant once the rules start moving around. A couple of good boundary cases save a surprising amount of head scratching later.

```toml
[[test]]
id = "status-allowed"
call = { agent = "fixture", tool = "bash", command = "git status" }
expect = "allow"

[[test]]
id = "compound-status-not-covered"
call = { agent = "fixture", tool = "bash", command = "git status && git commit -m test" }
expect = "approve"
```

The normal review loop is pretty small:

```bash
umbod policy lint ./candidate.toml --fail-on-warnings
umbod policy test ./candidate.toml
umbod policy simulate ./candidate.toml --env ./umbod.toml --limit 2000
```

Lint catches compound-consuming allow globs, shadowed or duplicate structured rules, workspace rules that preempt stricter ordinary global rules, and mutation commands covered only by permissive defaults. Warnings stay advisory in `policy test`. Use `policy lint --fail-on-warnings` when automation should fail on them.

Simulation is read-only. It gives you candidate totals, transitions, newly covered and still-unmatched calls, per-rule coverage, real examples, parsed components, paths, operations, and why something did not match. `--all` walks every eligible row in bounded keyset batches. That can be slower, of course, but it is there when you want the real release-gate pass instead of a sample.

The active-policy HTTP lint endpoint is `GET /api/policy/lint`; `GET /api/policy/draft?limit=2000&maxRules=25` returns a draft and metadata. Candidate simulation is `POST /api/policy/simulate` with `{ "candidate": "<TOML>", "limit": 2000 }`, or `{ "candidate": "<TOML>", "all": true }`. These routes are read-only and follow the same local-server authentication boundary described in the README; an embedding host must authenticate remote consumers.

Starting fresh? Umbod can build a conservative draft from calls it has already seen:

```bash
umbod policy draft --env ./umbod.toml --limit 2000 --max-rules 25 > candidate.toml
```

The draft never assumes repeated approval means permanent intent. That would be a pretty wild leap. Read it, add regression tests, lint it, and simulate it before activation.

## Upgrade checklist

1. Copy the active manifest to a candidate file.
2. Run lint before changing anything and record the existing warnings.
3. Move sensitive-path and irreversible-operation blocks into global guards.
4. Replace narrow shell allow globs with component selectors and `compound = false`.
5. Replace broad edit-tool allowances with `paths_all` boundaries.
6. Add classification defaults and regression tests for important allow, approve, and block decisions.
7. Run tests and a 2,000-call simulation; inspect candidate totals and drill-down examples.
8. Run an `--all` simulation for the final release gate when the database size permits.
9. Save and activate only the exact candidate content that passed review.

None of this executes tool calls. Simulation and drafting read audit history, but they do not mutate it. And that's about it, really.
