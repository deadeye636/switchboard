# 36 — External MCP servers into a launched session: a project's chosen servers ride the spec 34 injection seam

Issue #789, **injection slice (A) only**. Status: **designed, not built** (plan: `docs/plans/789-external-mcp-injection/`,
local). This is the inbound counterpart to [spec 34](34-switchboard-mcp-server.md) and
[spec 35](35-session-discovery-tools.md): there Switchboard is the server and the CLI calls it; here the user
names servers that exist elsewhere (an `uvx <server>` stdio launch, an HTTP endpoint) and Switchboard puts them in
front of one launched CLI. The tabbed management screen of the issue's design note (tabs, cards, toggles, the
"custom MCP" form) is **slice B**, a separate proposal (CLAUDE.md reflex 16). Install and uninstall of a server is #790.

Why a new spec and not an extension of 34: spec 34 is the record of the shared core and the agy/Codex diff tool,
and its "Later phases" item 3 already earmarked this work. The second consumer (35) got its own file; this is the
third consumer and it adds a new source, a setting, and three new backend emitters. One file per consumer keeps each
"as built" section about one thing. Spec 34's item 3 and 4 point here.

## What changes for the user

A project can carry a list of external MCP servers. Every session launched in that project on a backend that can take
them is started with those servers configured, for that launch only. Nothing is written to the user's own CLI
configuration (`~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/config/mcp_config.json`). The same list serves
every backend; a backend that cannot take a given server says so in the log and the session starts without it.

In slice A there is no management screen. The list is a project setting (see O3 in the plan for how a user edits it).

## Decided

| | Decision | Why |
|---|---|---|
| D-A1 | Injection slice only. No tabbed UI, no install/uninstall. | Owner. The screen is a new user flow (reflex 16); install is #790. |
| D-A2 | Per-project scope. A project decides its set; nothing is a global write to a CLI config. | Owner, design note H1. "Installed globally" is #790; "enabled per project" is this. |
| D-A3 | A server reaches a CLI through the per-launch channel each backend already has or measured: Codex `-c` overrides, an agy plugin bundle, a Claude `--mcp-config` file, Pi's resources extension. Never the user's global file. | Owner; spec 34 D2. |
| D-A4 | Pruning a backend's default servers is a **separate follow-up slice** (A2), not a step here. See "Prune". | Planner recommendation (open point O4 confirms). |
| D-A5 | Reference, never bundle. Switchboard ships no server; an entry names a command or URL the user installed. | Owner (licensing). |
| D-A6 | Detection is **not** in slice A beyond what the launch can say for free (a skipped entry is logged). A reachability report needs a surface, and the surface is slice B / #790. | Planner recommendation (O5 confirms). |
| D-S1 | **The list lives in the app's settings, never in a file of the repository.** | A stdio entry is a command run at launch. Claude's checked-in `.mcp.json` needs a per-user approval for exactly this reason (`src/backends/claude/mcp-servers.js`, header). Anybody who writes the repository would otherwise run a command on every teammate's machine. |
| D-S2 | **No secret value on any argv.** Codex: values travel in the child's environment and are named on argv (`env_vars`, `env_http_headers`, `bearer_token_env_var`). Claude: a 0600 file, never inline JSON. agy: the 0600 bundle file. | Argv is visible to every local user; an environment and a 0600 file are not. A security requirement, not a nicety (spec 34, Codex token decision). |
| D-S3 | The composer is **unchanged in behaviour**. It already filters rows by `acceptsMcpTransports` and asks `buildMcpInjection` (`src/app/mcp-inject.js`, lines 87-95). The work is one new source plus per-backend emit. | Reflex 5; spec 34 D3. |
| D-S4 | Hermes stays declined: its MCP configuration lives only in the Hermes home and no per-launch channel exists. **Accepted gap**, recorded in the table. | Measured by the backend-format review; writing the home would change the user's shared config. |

## The neutral row

Unchanged from spec 34 except one optional field:

`{ name, transport: 'stdio' | 'http', command, args, env, cwd?, url, headers }`

`isRow` (`src/app/mcp-inject.js`, lines 17-20) already admits both transports and `command/args/env`; only `cwd` is new
and only the emitters read it. `listSharedMcpServers` (`src/backends/claude/mcp-servers.js`, lines 97-111) already emits
the stdio shape with `${VAR}` expanded, minus `cwd`. A row is **expanded before it reaches the composer**: the source
resolves `${VAR}` and `${VAR:-default}` against the session's own environment, so an emitter never sees a reference.
A variable with no value and no default skips that entry with a log line naming the variable (the same rule as
`missingEnv` in the Claude lister: do not start a server with an empty credential).

## The setting

Project blob `project:<settingsOwnerPath>` (reflex 17), key `externalMcpServers`, an array of entries. Read straight from the
project blob the way `spawnOptionsFor` reads `backendDefaults` (`src/app/terminal/spawn.js`, line 277); it is **not** a
`SETTING_DEFAULTS` key, so it does not cascade and a worktree reads its project's. A worktree has no list of its own.

Entry: `{ name, transport, command?, args?, env?, cwd?, url?, headers?, enabled?, backends? }`.
`enabled` defaults true. `backends` is an optional list of backend ids the entry applies to; it is **data** compared by
the source, not a branch in the core (O6 in the plan). `env` and `headers` values are strings that may hold `${VAR}`.

**Secrets.** The setting is stored in the database and travels in a settings export. It therefore holds references
(`${GITHUB_TOKEN}`), not values. The validator cannot tell a literal secret from a literal path, so the product text
says so and the export/import handling is an open point (O7). The name is validated like Codex's table key
(`[A-Za-z0-9_-]+`) and `switchboard` is reserved for the own server.

## Per-backend table

"Supports" is for the injection slice. "Prune" is the launch-only mechanism the follow-up slice would use.

| Backend | Supports | Transports | Mechanism | `cwd` | Prune (follow-up) |
|---|---|---|---|---|---|
| Codex | yes (adds `'stdio'`; http already) | stdio, http | `-c mcp_servers.<n>.command/args/cwd`; env as `env_vars=["NAME"]` with the value in the returned `env`; http bearer as today; other http headers as `env_http_headers` | yes | `-c mcp_servers.<n>.enabled=false` |
| agy | yes (adds `'stdio'`) | stdio, http | the per-session plugin bundle of spec 34; `{command,args,env,cwd}` for stdio. The `type:'http'` key it writes today is **dropped** | yes | none clean per launch (gap) |
| Claude (terminal) | yes (flag flips) | stdio, http | `--mcp-config <file>`, a 0600 JSON `{"mcpServers":{…}}` under the binding dir, deleted on release | **no**: a row that needs one is declined with a log line | `--strict-mcp-config` (drops the user's own servers: only ever an explicit per-project choice), `ENABLE_CLAUDEAI_MCP_SERVERS=false` |
| claude-native | open (O2) | as Claude | the same file; blocked today by the spawn gate | no | as Claude |
| Pi (terminal) | open (O1) | stdio | the existing resources-extension MCP section, or `.pi/mcp.json` | n/a | `--exclude-tools`, `--no-mcp` |
| pi-native | open (O1, O2) | as Pi | as Pi | n/a | as Pi |
| Hermes | **no, accepted gap** | n/a | no per-launch channel | n/a | none (gap) |

Facts that bound this table (measured on current CLIs by the backend-format review; the plan's G-gates re-check what a
stand-in cannot): the Codex quoting of an inline array or table through ConPTY is **unmeasured** (spec 34 confirmed only
`-c key="value"`), and a clash between a project entry and a same-named entry in the user's own config is unmeasured on all three
(Codex merges `mcp_servers.<n>` tables key by key, so a stdio entry over a user's http entry of one name could yield a hybrid;
O9).

## Pi: the version fact and the duplicate-tools risk

Pi 1.1.0 ships a **built-in MCP client**. `src/backends/pi/mcp-section.js`, line 4, still says "Pi has no MCP client
(0.84.4 and 0.85.1 ...)" and is **stale**; plan step T8 corrects the comment and `docs/backend-formats.md`. The section
exists for "Resources from" (#633) and starts stdio servers inside Pi's resources extension. Two clients in one session
(Pi's own and our section) can register the same tool twice. Rule for this slice: **never run two clients over the same
entry**. Which channel carries external entries is open (O1). The recommendation is the existing section, stdio only
for the first slice, because it is shipped, tested and already keeps secrets off disk (one environment variable the
section deletes after reading, `mcp-section.js` lines 10-13).

## Prune (D-A4): a follow-up slice, argued

Pruning removes tools a user already has. Injection only adds. The two differ in blast radius (a wrong injection adds a
server; a wrong prune silently takes a working tool away), in mechanism (five different launch-only switches, two
backends with none) and in surface (the user must see what is pruned, which is a screen). `--strict-mcp-config` is the
sharpest case: it drops every server not in the file, including the user's own. So slice A **never prunes**, and the
Claude emitter must not pass `--strict-mcp-config`. The mechanisms are listed in the table so slice A2 starts from them.

## Detection (D-A6): deferred, argued

A reachability report ("command found on PATH", "URL answers") has no place to be shown without the slice B surface.
App code may not import a backend folder's PATH helper (the import direction in `.claude/rules/backends.md`), and
a probe must close stdin and never assert absence from a failure (the same file, "A probe goes through
`src/backends/cli-probe.js`"). What slice A does give for free: an entry the launch had to skip (missing variable,
transport or `cwd` the backend cannot take, a name collision) is logged at `info` with the reason.

## Known limits

- The agent has to choose the tool, as in spec 34. A server costs model context on every turn and startup time; the
  per-entry `enabled` flag is the control.
- Hermes gets nothing. Pi and the piped drivers wait on the open points.
- Two servers that need the same environment variable name with different values cannot share one Codex launch (the
  variable is one slot in the CLI's environment). The later entry is skipped with a log line (O10).
- HTTP servers that need an OAuth login are not covered (O8); static headers and bearer tokens are.

## As built

Nothing yet. This section is filled in the last plan step (T12).
