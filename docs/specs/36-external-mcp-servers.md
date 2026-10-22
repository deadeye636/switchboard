# 36 — External MCP servers into a launched session: a project's chosen servers ride the spec 34 injection seam

Issue #789, **injection slice (A) only**. Status: **built; confirmed end to end — a Claude/Haiku model turn chose, called and got the result of an injected external tool** (see "As built"; plan: `docs/plans/789-external-mcp-injection/`,
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
stand-in cannot): the Codex quoting of an inline array through ConPTY is **measured** on a real spawn (spec 34 had confirmed only
`-c key="value"`); the inline-table form (`env_http_headers` / `http_headers`) did not appear in that spawn, whose http
entry used only a Bearer header, so it is still unexercised; and a clash between a project entry and a same-named entry in the user's own config is unmeasured on all three
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

Slice A is built: the setting, its validator, the source, four backend emitters and a JSON editor. On a real spawn
each CLI received the injection in its own mechanism; a model calling an external server's tool is **not yet
observed** (see "Verification state").

### What shipped

- **The setting.** `externalMcpServers` on the project blob, checked by `src/shared/external-mcp-validate.js`. The
  settings import **drops** it (D-S1): a settings file from someone else never brings a command to run.
- **The source.** `src/app/external-mcp.js` turns the list into neutral rows. It expands `${VAR}` against the session
  environment, skips an entry whose variable is unset (the log names the variable, never a value), honours `enabled`
  and the per-entry `backends` filter, and carries `cwd`.
- **Emitters.**
  - Codex: `-c mcp_servers.<n>.*` for command, args and `cwd`; env values travel in the child environment and are
    named by `env_vars`, http headers by `env_http_headers`.
  - agy: the 0600 per-session bundle, `{command,args,env,cwd}`; the `type` key it wrote for http is dropped.
  - Claude (terminal): a 0600 `--mcp-config` file, `type` always set, `cwd` declined with a log line,
    `--strict-mcp-config` never passed.
  - Pi: the resources-extension section (`SWITCHBOARD_PI_MCP_SERVERS`), stdio only; http entries and `cwd` are
    dropped. pi-native takes the same route.
- **The editor.** A JSON text area in the project settings, category "MCP servers" (`src/renderer/panels/settings-external-mcp.js`).
  A bad entry blocks Save with a sentence naming the field; a good list persists. Checked by hand in the running app.
- **No secret value on argv (D-S2).** Codex through environment variables, agy and Claude through their 0600 files, Pi
  through an environment variable it deletes after reading. `test/mcp-external-e2e.test.js` pins this across Codex,
  agy and Claude; a deliberate leak was confirmed to fail it.

### Reach

External servers reach Codex, agy, Claude (terminal) and Pi, plus pi-native through the resources path. **Hermes is
declined** (D-S4): no per-launch channel exists. **claude-native** and the rest of the native drivers are **deferred**
(T10, O2).

### Verification state

Verified by tests:

- The unit tests for the validator, the source and each emitter (`test/external-mcp.test.js`,
  `test/mcp-inject-external.test.js`) and the cross-backend e2e above. The full suite is green.
- The editor, in the running app.

Confirmed on a real spawn (demo instance, 2026-10-21, a project carrying a stdio entry with a secret
`env` value and an http entry with a Bearer header):

- **G2, Codex.** A launched Codex session carries the injection in its real argv:
  `-c "mcp_servers.files.args=[\"-y\",\"@sample/srv\"]"`, `-c "mcp_servers.files.env_vars=[\"API_KEY\"]"`,
  `-c "mcp_servers.web.bearer_token_env_var=\"WEB_MCP_TOKEN\""`. So the inline-array form **survives ConPTY**
  (the quoting that spec 34 left unmeasured), and no secret value is on argv — only the variable names are.
- **G3, Claude.** A launched Claude session carries `--mcp-config <file>`; the file holds
  `{mcpServers:{files:{type:'stdio',…,env:{API_KEY:…}},web:{type:'http',…,headers:{Authorization:…}}}}` —
  `type` on every entry, the secret values in the file, none on argv. (The 0600 mode applies on POSIX; on
  Windows the file sits under the user profile with its ACL — no POSIX mode to show.)
- **G4, agy.** A launched agy session writes the bundle `mcp_config.json` with the stdio and http entries
  and **no `type` key**; the secret values are in the bundle file, none on argv.

Each CLI received the config in its OWN native mechanism (Codex `-c`, Claude `--mcp-config`, agy's plugin
bundle), which is how each CLI is told about MCP servers — so it is consumed at launch.

**Confirmed by a real model turn** (demo instance, 2026-10-22): a Claude session on `claude-haiku`, in a
project carrying one local stdio server, chose and called that server's tool and received its result. The
session transcript holds `tool_use` for `mcp__local__ping` and the matching `tool_result` with the server's
token — so the injection reaches a model that actually uses an external tool, end to end, no longer only
inferred from the argv/file checks above. The project-trust dialog and the tool approval were answered by a
human at the TUI; the harness refuses to let an agent skip or pre-authorise either (`--dangerously-skip-permissions`,
a pre-seeded trust/allow, or an auto-submitted tool prompt all denied as "unsafe agent").

**Still unexercised:** the Codex inline-table header form (`env_http_headers` / `http_headers`). The G2 spawn
above used an http entry with a Bearer header only, so the inline-table quoting through ConPTY is not yet
measured. **G5** (the owner's confirmation of the product text) is open.

### Open points, resolved

| Point | State |
|---|---|
| O1 Pi channel | Shipped: the existing resources-extension section, stdio only. Never two clients over one entry. |
| O2 native drivers | **Deferred** (T10). claude-native and the native quartet wait for it; pi-native rides the Pi route. |
| O3 editing surface | Shipped: one JSON text area in the project settings. The tabbed UI is slice B. |
| O4 prune (A2) | **Deferred**, a separate slice. Slice A never prunes. |
| O5 reachability detection | **Deferred**; a skipped entry is logged, nothing more. |
| O6 `backends` filter | Shipped as data compared by the source. |
| O7 secrets in export | Shipped as D-S1: the list is dropped on settings import. The setting holds references, not values. |
| O8 OAuth http | Not covered; static headers and bearer tokens only. |
| O9 name clash with a user's own same-named entry | Unmeasured. Codex merges `mcp_servers.<n>` tables, so a hybrid is possible. A documented limit. |
| O10 same variable, two values (Codex) | The later entry is skipped with a log line. |

### Known low-severity gaps (editor)

- L1: typing the literal `null` stores `null` rather than `[]`. Benign, it reads as empty.
- L2: a stored value that is not an array shows a blank text area.
- L3: the status-line colours are inline hex, not theme variables.

### Follow-ups

T10 (native drivers), A2 (pruning a backend's defaults), reachability detection, and the tabbed management screen (slice B).
