# 36 — External MCP servers into a launched session: a project's chosen servers ride the spec 34 injection seam

Issue #789, **slice A (injection), slice B (the cards editor), A2 (prune) and D (a static check per card), all built**. Status: **confirmed end to end — a
Claude/Haiku model turn chose, called and got the result of an injected external tool, and the cards-and-form editor
ships** (see "As built" and "Slice B"; plans: `docs/plans/789-external-mcp-injection/`, `docs/plans/789-slice-b-mcp-cards/` and
`docs/plans/789-detection/`, local). This is the inbound counterpart to [spec 34](34-switchboard-mcp-server.md) and
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
| D-A6 | Detection is **not** in slice A beyond what the launch can say for free (a skipped entry is logged). A reachability report needs a surface, and the surface is slice B / #790. **Superseded by "Slice D: static check" (D-D1 to D-D14): the surface exists since slice B, and the owner scoped detection to a static check.** | Planner recommendation (O5 confirms). |
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

"Supports" is for the injection slice. "Prune" is the answer of slice A2 (see "Slice A2: prune").

| Backend | Supports | Transports | Mechanism | `cwd` | Prune (A2) |
|---|---|---|---|---|---|
| Codex | yes (adds `'stdio'`; http already) | stdio, http | `-c mcp_servers.<n>.command/args/cwd`; env as `env_vars=["NAME"]` with the value in the returned `env`; http bearer as today; other http headers as `env_http_headers` | yes | declines |
| agy | yes (adds `'stdio'`) | stdio, http | the per-session plugin bundle of spec 34; `{command,args,env,cwd}` for stdio. The `type:'http'` key it writes today is **dropped** | yes | declines |
| Claude (terminal) | yes (flag flips) | stdio, http | `--mcp-config <file>`, a 0600 JSON `{"mcpServers":{…}}` under the binding dir, deleted on release | **no**: a row that needs one is declined with a log line | **yes**, `--strict-mcp-config` (drops the user's own servers: only ever an explicit per-project choice) |
| claude-native | **yes** (T10) | as Claude | the same `--mcp-config` file and flag as terminal Claude; the spawn gate now admits a transport backend declaring the quartet | no | **yes**, as Claude |
| Pi (terminal) | open (O1) | stdio | the existing resources-extension MCP section, or `.pi/mcp.json` | n/a | declines |
| pi-native | **yes** (O1) | stdio | as Pi — the session-resources MCP section it inherits; measured | n/a | declines |
| Hermes | **no, accepted gap** | n/a | no per-launch channel | n/a | declines |

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
Slice A2 is built for Claude and claude-native only: see "Slice A2: prune" at the end of this file.

## Detection (D-A6): deferred, argued (superseded by "Slice D: static check", at the end of this file)

Kept as the record of why slice A did not do it. A reachability report ("command found on PATH", "URL answers") has no place to be shown without the slice B surface.
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
declined** (D-S4): no per-launch channel exists. **claude-native** injects too (T10): the spawn gate admits a
transport backend that declares the quartet, and it reuses terminal Claude's `--mcp-config` file. **pi-native** injects
too — through the session-resources MCP section it inherits from terminal Pi (T9), stdio only, measured 2026-10-22 (the
external server starts as a child of the piped Pi).

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

**Codex inline-table header form, now confirmed** (demo instance, 2026-10-22): a project with an http entry
carrying a non-Authorization header (`X-Sample-Key: ${VAR}`) launched a real Codex session whose OS-level
child argv holds `-c "mcp_servers.web.env_http_headers={\"X-Sample-Key\"=\"WEB_MCP_HDR_X_SAMPLE_KEY\"}"` —
so the inline-table quoting survives ConPTY (the earlier G2 spawn had used a Bearer header only), and only
the env-var name is on argv, never the secret value. **G5 confirmed** (owner, 2026-10-22): the editor's
product text — the secrets sentence and the OAuth "not supported" note — stands as shipped; the Hermes and
`cwd` limits stay in this spec, not in the UI.

### Open points, resolved

| Point | State |
|---|---|
| O1 Pi channel | Shipped: the existing resources-extension section, stdio only. Never two clients over one entry. |
| O2 native drivers | **Both shipped** (T10). claude-native over its own `--mcp-config` (measured on a real piped spawn); pi-native through the session-resources MCP section it inherits from terminal Pi, stdio only (measured — the external server starts as a child of the piped Pi). |
| O3 editing surface | Shipped: one JSON text area in the project settings. The tabbed UI is slice B. |
| O4 prune (A2) | **Built as slice A2** for Claude and claude-native; slice A itself never prunes. See "Slice A2: prune". |
| O5 reachability detection | **Deferred in slice A** (a skipped entry is logged, nothing more); **superseded by "Slice D: static check"**, which decides it. |
| O6 `backends` filter | Shipped as data compared by the source. |
| O7 secrets in export | Shipped as D-S1: the list is dropped on settings import. The setting holds references, not values. |
| O8 OAuth http | Not covered; static headers and bearer tokens only. |
| O9 name clash with a user's own same-named entry | Unmeasured. Codex merges `mcp_servers.<n>` tables, so a hybrid is possible. A documented limit. |
| O10 same variable, two values (Codex) | The later entry is skipped with a log line. |

### Known low-severity gaps (editor)

Closed by slice B; kept as the record of what they were.

- L1: typing the literal `null` stored `null` rather than `[]`. The cards now show a "cannot show cards" state and open
  the JSON view; `check()` is unchanged, so a stored `null` still saves as an empty list.
- L2: a stored value that is not an array showed a blank text area. Now the same "cannot show cards" state.
- L3: the status-line colours were inline hex. Now theme classes (`.sv-mcp-problem` / `.sv-mcp-warning`).

### Follow-ups

T10 (native drivers), reachability detection (built as slice D, below), and the management surface
(slice B, below; plan `docs/plans/789-slice-b-mcp-cards/`, local).

## Slice B: cards and a form over the same list

Status: **built** (the decisions below are the owner's; the product text was owner-confirmed, G4, 2026-10-22). Slice B
changes only how the list is edited. It touches no injection code, no validator rule and no backend.

### What changes for the user

In the project settings, category "MCP servers", the JSON text area is no longer the first thing a user meets. The
category shows **one card per configured server**: its name, its transport (stdio or http), an on/off switch, and the
`backends` filter as chips (no chips means every backend). An **Add server** control opens a form ("Connect to a
custom MCP"); a card has an **Edit** and a **Remove** control that use the same form. Below the cards a closed
disclosure, **Edit as JSON**, holds today's text area: the advanced view, and the place to repair a stored value the
cards cannot show.

Nothing is written when a switch flips or a form closes. The settings window is a snapshot that applies its own Save
(`.claude/rules/renderer.md`, #146): the list is stored on Save, a refused entry blocks Save with the same sentence as
today, and a change takes effect on the next session started. Cancel discards.

### Decided

| | Decision | Why |
|---|---|---|
| D-B1 | **One data model, two views (W1).** Cards and the JSON text area read and write the same `externalMcpServers` value; there is no second setting and no second copy of the list. | Owner. Two stores would drift, and the validator, the reader and the settings-reference row stay as they are. |
| D-B2 | **The JSON view stays** as a disclosure: fields the form does not cover (`backends` edits beyond chips, future keys) and repair of a broken stored value. | Owner. A form can only show a list that parses; the text is the one view that can always be fixed. |
| D-B3 | **Scope is the MCP surface only.** No tabs for Plugins, Apps, Marketplace, no install or uninstall (#790), no skills (they keep their file model, design note H2/H3). | Owner; the reference's five-tab manager is not adopted. |
| D-B4 | **Per project only (H1).** No global or personal list. | Owner. |
| D-B5 | **Pruning a backend's defaults (A2) and reachability detection are not in slice B.** | Owner; unchanged from D-A4 and D-A6. |
| D-B6 | **Native-driver injection: both shipped (T10).** claude-native over `--mcp-config`; pi-native through the session-resources MCP section it inherits from terminal Pi (stdio only). The cards show the per-project set both now inject over the pipe. | Owner. |
| D-B7 | **One validator.** Every card operation and the form's result go through `validateExternalMcpServers` (`src/shared/external-mcp-validate.js`), the check the text area and the launch use. The form adds no rule of its own. | A second set of rules would accept what the launch then drops. |

### The card and form model

An entry is `{ name, transport, command?, args?, env?, cwd?, url?, headers?, enabled?, backends? }`. The form maps
the reference's fields onto it:

| Form field | Entry field | Note |
|---|---|---|
| Name | `name` | Required by the entry; the reference form has no such field. |
| Type: STDIO / Streamable HTTP | `transport`: `stdio` / `http` | Switching type drops the other side's fields, as the validator forbids both. |
| Command | `command` | stdio. |
| Arguments | `args` | stdio; one argument per line, never shell-split. |
| Environment variables | `env` (stdio) / `headers` (http) | name and value rows; a value may be a `${VAR}` reference. |
| Environment variable passthrough | `env` | A row `NAME` stored as `NAME: "${NAME}"`. No new field; the form shows an `env` row whose value is exactly its own `${NAME}` in this list. |
| Working directory | `cwd` | stdio. |
| URL | `url` | http. |
| Backends | `backends` | Chips; none selected stores no `backends` key. |
| On / off | `enabled` | A card switch only. |

**The text is the store; the cards are a projection.** The text area keeps its id and stays the value
`read()` checks, so Save, the refusal and the stored shape are what slice A shipped. A card operation parses the text,
changes one **raw** entry (never the validator's normalised copy, which adds defaults), writes the list back as the
same pretty JSON and redraws. A text edit redraws the cards when the text area loses focus. A list that is not valid
JSON, or not an array, shows no cards: the category says so, opens the JSON view and disables Add. An entry the
validator rejects still gets a card, with the reason on it, so it can be edited or removed.

The product text keeps the slice A sentences (secrets as `${VAR}` references, OAuth not supported). The Hermes and
`cwd` limits stay in this spec and not in the UI (the G5 decision), and the UI names no backend: the chips come from
the backend list main already serves, never from a table in the renderer (reflex 5).

### Out, explicitly

Tabs and the marketplace, install and uninstall (#790); skills; a global list; pruning (A2); reachability (a card
shows no "connected" light); native-driver injection (T10). Slice B closed the editor's low gaps L1 to L3.

### As built (slice B)

Shipped across `src/renderer/panels/settings-external-mcp.js` (the cards, the on/off switch, Remove, the inline
Add/Edit form and the closed "Edit as JSON" disclosure), `src/shared/external-mcp-form.js` (the form↔entry mapping
`entryToForm`/`formToEntry`), the nav count via `data-count-own` in `src/renderer/panels/settings-panel.js`, and the
`.sv-mcp-*` classes in `src/renderer/style.css`. The text area stays the store: a card or form operation parses the raw
list, changes one entry, writes pretty JSON back and redraws; nothing persists until the settings window's own Save,
which still refuses an invalid list with its reason. The backends chips come from `window.api.backends.list()` (enabled,
non-profile); an unknown stored id is kept and shown as such. The form checks the whole resulting list through
`validateExternalMcpServers` and refuses inline. Verified by `test/external-mcp-form.test.js` and the slice-B cases in
`test/settings-modules-smoke.test.js`, the full suite green, and a live click test on the demo (cards, type-switch,
inline reject, backend round-trip, nav count). Steps T1–T6, `docs/plans/789-slice-b-mcp-cards/` (local).

### As built (T10, claude-native)

The piped `claude-native` driver now injects a project's external MCP servers. The spawn gate
(`src/app/terminal/spawn.js`) dropped its `!backend.transport` clause, so a transport backend that declares the
injection quartet takes it; `claude-native` declares the quartet reusing terminal Claude's implementation (the 0600
`--mcp-config` file). The own server offers it nothing (no diff or discovery tools), so only the project's external
servers inject. `pi-native` keeps `providesMcpInjection: false` — it never used the quartet — and injects external
stdio servers through the session-resources MCP section it inherits from terminal Pi instead (see below).

Confirmed by a real measurement (2026-10-22): a piped Claude started with `claude-native`'s exact launch flags and a
`--mcp-config` holding a local stdio server had the server in its `system/init` as `local:connected` and the tool
`mcp__local__ping` beside the user's own servers; the CLI sent a `can_use_tool` request over the pipe
(`--permission-prompt-tool stdio` gates the injected tool, the approval-card path `claude-native` already uses), and
after allow the tool ran and returned its token. And through the app: a launched `claude-native` session carries
`--mcp-config <0600 file>` in its real `mode=rpc` argv, the file holding the project's stdio server.

**pi-native** needed no code: it forwards terminal Pi's `buildSessionResources`, and the session-resources spawn block
has no transport gate, so the project's external stdio servers reach its `--extension pi-resources-<tag>.ts` (the MCP
section) and the `SWITCHBOARD_PI_MCP_SERVERS` env the same way terminal Pi's do (T9). Measured 2026-10-22: a launched
pi-native session carries that extension, and the external `local` stdio server runs as a child of the piped Pi process
(its tools surface as `mcp__local__ping`). stdio only; http and `cwd` are dropped by name (O1). Step T10,
`docs/plans/789-external-mcp-injection/` (local).

## Slice A2: prune

Status: **built, Claude and claude-native only** (owner decision B). Prune is the opposite of injection: injection
adds servers to a launch, prune hides the CLI's own. It rides the same spawn seam but is a separate capability with
its own hook, because a backend can inject and not prune. Reflex 16 applies: this is a new user-visible control, so
the scope below is the owner's. Plan: `docs/plans/789-slice-a2-prune/` (local).

### What changes for the user

In the project settings, category "MCP servers", below the cards, one switch: **Start sessions with only this
project's MCP servers**. Off by default. When on, every Claude or claude-native session launched in this project
(new, resume, fork) starts with only the MCP servers Switchboard injected (`--mcp-config`). The user's own servers, a
project `.mcp.json`, plugin servers and claude.ai connectors are all hidden. Nothing is written to the CLI's own
configuration; the next session started after Save is affected, running sessions are not. The control lists, per
backend, what it does and shows a declining backend as "not applied".

### Decided

| | Decision | Why |
|---|---|---|
| D-P1 | **One coarse, explicit, per-project switch.** One meaning: this project's sessions start with only the servers Switchboard injected. | Owner. A per-server prune needs a server listing and uniform per-server support the CLIs lack. |
| D-P2 | **Default is no prune, byte for byte.** Prune runs only when the project's blob holds exactly `true`. Absent, `false`, a string or a number all mean an unchanged launch. | Blast-radius rule: a wrong prune silently removes a working tool. |
| D-P3 | **Scope B: only Claude and claude-native prune.** Codex, Pi, pi-native, agy and Hermes decline (capability `mcpPrune` = no). | Owner. See "Per-backend answer" for why each declines. |
| D-P4 | **The wording says what is dropped.** For Claude: every MCP server not given by Switchboard, including the user's own, a project `.mcp.json`, plugin servers and claude.ai connectors. The text comes from the capability note, not the renderer. | `--strict-mcp-config` is the sharpest case; a user must not discover it by a missing tool. |
| D-P5 | **The mechanism belongs in the backend's descriptor, not the core.** The core reads the setting, asks the hook and joins its args and env; it names no backend (reflex 5). | `.claude/rules/backends.md`: a capability is a declared hook, a decline is the honest default. |
| D-P6 | **A prune that cannot apply is a logged no-op, never a failed launch.** That includes a project whose servers for this backend all failed to reach the launch (an injection that threw or built nothing): the prune is skipped with a warning, because applying it would start the session with no MCP server at all, or with Switchboard's own server alone (spec 37, O5: only the project's servers are counted). A launch that got some of its servers is pruned. | Fail toward today's behaviour (D-P2). |

### Per-backend answer

| Backend | Prune | Mechanism / reason |
|---|---|---|
| Claude (terminal) | **yes** | `--strict-mcp-config` beside the injected `--mcp-config`. A launch flag: no file, no release half. |
| claude-native | **yes** | the same hook and flag, piped. |
| Codex | **declines** | Codex hides a server only by name (`-c mcp_servers.<n>.enabled=false`), which would need a reader for the user's `config.toml`. Out of scope B. |
| Pi (terminal) | **declines** | `--no-mcp` and `--exclude-tools` exist, but Pi's injected servers ride the same MCP channel (the resources extension), so "drop its own, keep ours" is not separable. |
| pi-native | **declines** | as Pi. |
| agy | **declines** | no per-launch channel. |
| Hermes | **declines** | no per-launch channel (D-S4). |

### Surface

Reuses slice B's styling and the settings screen's rules (`renderer.md`): the switch sits in the existing "MCP
servers" category, is stored by the window's own Save (the window is a snapshot, #146), and takes effect on the next
session. The per-backend lines come from the `backends-list` payload's capability answers (state and note), so the
renderer holds no backend name and no mechanism text.

### As built (A2)

- **The setting.** `externalMcpPrune`, a boolean on the project blob `project:<settingsOwnerPath>` (reflex 17), beside
  `externalMcpServers`. Not a `SETTING_DEFAULTS` key, no cascade, a worktree reads its project's. Read by
  `readExternalMcpPrune` in `src/app/external-mcp.js`, strict `=== true`. Dropped on settings import
  (`src/app/settings-transfer.js`): a settings file from someone else must not silently take tools from a project.
- **The hook.** Descriptor flag `providesMcpPrune` and `buildMcpPrune(...)` returning `{ args, env } | null`. No release
  hook: nothing is written to disk.
- **The core seam.** `src/app/mcp-prune.js` composes the backends' answers. `src/app/terminal/spawn.js` calls it after
  the injection block and **outside** the `providesMcpInjection` gate, so a project with zero external servers can
  still ask for a prune. The flag is read first, so a launch without it pays nothing. The injected server names are
  passed in, and so is how many of the project's enabled servers were meant for this backend
  (`externalServersFor` in `src/app/mcp-inject.js`, counted apart from the injection): servers wanted and none
  injected skips the prune (D-P6). Since spec 37 (O5) the guard counts only the injected names that came from the
  project's own list (`externalNames`), so Switchboard's own `switchboard` row cannot stand in for them.
- **The capability row.** `mcpPrune` in `src/backends/capabilities.js` (`declaredBy: 'providesMcpPrune'`) carries the
  per-backend note the switch renders.
- **The switch.** `src/renderer/panels/settings-external-mcp.js`, off by default, lists per backend what prune does.

Measured (T1): with `--strict-mcp-config`, a Claude/claude-native `system/init` `mcp_servers` shows **only** the
injected servers; the user's own servers and connectors (about two dozen on the measuring machine) are all gone. That
is the blast radius D-P4 warns about. Pi/pi-native: the flags exist, but injected servers share the channel, hence the
decline. Codex was dropped from scope before measuring. The T1 notes record no CLI version and, for Pi, no command;
the Claude behaviour was measured again live in T9 on 2.1.310 and is recorded in `docs/backend-formats.md`.

Method, reproducible: the claude-native stream harness (`claude -p --input-format stream-json ... --mcp-config <file>
--permission-prompt-tool stdio --model haiku`), run once with and once without `--strict-mcp-config`, comparing
`init.mcp_servers`.

Gates G2/G4 (T9): confirmed deterministically against the real `buildLaunch` + `composeMcpPrune` for both `claude`
and `claude-native`. With the project's `externalMcpPrune` on, the composed launch argv carries `--strict-mcp-config`
(appended after the model); with it off, `composeMcpPrune` returns `null` and the argv is byte-for-byte the base
launch, no flag. `test/mcp-prune.test.js` pins the off half for every terminal backend that declares the hook, with the
key absent and with it `false`.

Gates G2/G3/G5, live (T9, demo instance, terminal Claude, CLI 2.1.310 on Haiku, 2026-10-26). Two projects carried the
same injected stdio server (`injected`, one `ping` tool); the demo home's `.claude.json` carried one user-scope server
(`own-user`), and the account brought its claude.ai connectors. One project had `externalMcpPrune` on, the other off.

- **G2.** The OS-level child argv of the pruned session ends `--mcp-config <file> --strict-mcp-config --ide`; the
  control's ends `--mcp-config <file> --ide`. The flag reaches the CLI only where the project asked for it.
- **G3.** `/mcp` in the pruned session lists one server, `injected`. In the control it lists seven: `own-user`, the
  claude.ai connectors, and `injected`. A model turn in the pruned session called `injected`'s tool and received its
  token, so the injected server survives the prune end to end.
- **G5.** The `--ide` bridge is not an MCP config entry, so `--strict-mcp-config` leaves it alone: the app log shows
  `CLI connected` and `CLI initialized` for the pruned session, `/ide` names Switchboard as the connected IDE, and an
  edit in manual mode opened its diff in the app ("Opened changes in Switchboard"); accepting it wrote the file.

`claude-native` takes the same flag through the same hook. Its live effect is the T1 stream-harness measurement above;
it has no `--ide` bridge to check.

### Open points, resolved

| Point | State |
|---|---|
| O-P1 `ENABLE_CLAUDEAI_MCP_SERVERS=false` as a finer toggle | Not built; a later, finer control. |
| O-P2 setting shape | Shipped as the boolean. |
| O-P3 per-server prune | Not built; a later slice. |
| O-P4 Codex config reader | Moot: Codex declines in B. |
| O-P5 one boolean across backends | Accepted (owner). In B only the Claude family acts on it, so a mixed project prunes its Claude sessions alone. |
| O-P6 settings import | Dropped on import, as designed: a settings file from someone else must not take tools from a project. |
| O-P7 Pi mechanism | Declines: the flags exist, but Pi's injected servers share the channel its own use (T1). |
| `--ide` diff bridge and the injected `switchboard` server under `--strict-mcp-config` | Answered (gate G5, T9): the `--ide` bridge keeps working under prune; see "As built (A2)". For Claude that bridge IS the app's own server: the `diffTool`/`discoveryTools` toggles that would put a `switchboard` row into `--mcp-config` belong to Codex and agy only, so no Claude-family launch carries one for the prune to keep or drop. |

### Out, explicitly

Per-server prune; a connectors-only toggle; pruning Codex, Pi, pi-native, agy or Hermes; a server listing or
reachability detection; a global prune; anything written to a CLI's user configuration.

## Slice D: static check of a server entry (reachability detection)

Status: **built and click-tested** (owner scope E1 to E4, issue #789 comment of 2026-10-26; plan
`docs/plans/789-detection/`, local). Reflex 16 applies: it adds information to a surface that exists, not a new flow.
The files are named in "As built (slice D)" below.

### What changes for the user

In the project settings, category "MCP servers", each card gets a facts line, drawn when the editor opens and again
after a card changes. It says, **without starting anything**:

- **Command** (stdio): found (and where), not found, or not checked (a network path, an unreadable PATH directory, a
  command that holds an unset variable). Not found reads "would not start", never "skipped": the launch does not skip
  it, the CLI fails to start the server.
- **Variables**: every `${VAR}` in command, args, env, cwd, url and headers, with whether it is set. An unset one is named
  on the Variables line ("unset X"), and the Backends line says the backends do not take the entry because "a variable
  it needs is not set", which is what `externalServersSource` does at launch and only logs. A reference with a default
  reads "X (default used)".
- **Backends**: which enabled backends take this entry and, for each that does not, why (transport not taken, working
  directory not taken, no per-launch channel), plus the entry's own `enabled` and `backends` filter.

The card never says "works" or "connected": it says what a launch could use. Nothing is written, no process is
started, no request is sent, and no variable value, argument or header leaves main.

### Decided

| | Decision | Why |
|---|---|---|
| D-D1 | **Static check only.** No child process, no network request, no MCP `initialize`. Not an on-demand handshake and not status read back from live sessions (only claude-native reports one). | Owner (E1). A handshake runs the user's code and sends headers over the network: a separate decision. |
| D-D2 | **Three facts plus the launch's own skip reasons.** Command resolves; every `${VAR}` set; which backends take the entry. The skip reasons are the ones the launch already has: entry off, `backends` filter, unset variable, transport not taken, `cwd` not taken. | Owner (E1). The card and the launch log must tell the same story. |
| D-D3 | **Two neutral layers, neither tied to the card.** A generic PATH resolver (`resolveCommand`, no MCP knowledge) and an entry check (`checkEntries`: entries in, neutral facts out, plus the IPC). #790 reuses both: the resolver for `uv`, `uvx`, `pipx`, the entry check for "server present". | Owner (E4). #790's "detect first" must not grow a second detection. |
| D-D4 | **The resolver is the app's own.** src/app may not import the backends folder's `findOnPath` (the import direction in `.claude/rules/backends.md`), so the few lines are repeated, as the app's `closeProbeStdin` repeats the backends one (spec 9, decision 11). Same semantics: PATHEXT on Windows, first directory then first extension, a listing instead of a stat per name; asynchronous and bounded instead. | Owner (E2). |
| D-D5 | **Absence is the claim that needs the evidence** (`.claude/rules/backends.md`, #546). "Not found" only when every PATH directory was listed or does not exist (`ENOENT`, `ENOTDIR`) and none was skipped. A permission error, an I/O error, the time budget, a skipped network directory, a relative PATH entry: the answer is "not checked" with the reason. A name in a directory listing counts as found unless it is a directory (Windows app-execution aliases list but do not stat cleanly) or its `stat` answers `ENOENT` (a dangling link, a file gone since the listing). Off Windows a copy without an execute bit is passed over for a later executable one, as `execvp` does, and reported only when there is no other. A PATH set by the entry's own `env` or by the backend variables of a backend that takes the entry is not the PATH that was searched, so a miss then reads "not checked" (`path-overridden`). | Same file; one unlucky read must not tell a user their tool is missing. |
| D-D6 | **A network path is never touched.** Lexical, before any stat (`network-path`, #780): a command path on a share no project is on is "not checked"; PATH directories on such a share are skipped, which makes a miss "not checked". The predicate is main's `isForeignNetworkFile`, handed in at init so the module stays electron-free and db-free. | Touching one is an SMB connection to a host somebody else named. |
| D-D7 | **Environment for `${VAR}` (E3): the app's environment plus the global backend variables.** The app side is `process.env` copied the way spawn's `quietSessionEnv` copies it (so key case is as at launch); the backend side is each backend's `backendEnv.<id>` in the global blob. A variable is `app`, `backend-env` (for the named backends only), `default` (`${VAR:-x}`, checked before the next one), `declared-unresolved` (a backend variable whose value is a `$VAR` reference the app's environment cannot fill, so the launch drops it; the card says "without a usable value") or `unset`. The app and backend layers merge as spawn merges them, `{ ...app, ...backend }`, and a name is looked up exactly as `expand` looks it up. **Not considered:** project and template variables, backend base variables, secret materialisation. When the answer rests on that gap the card says "checked against the saved global variables". | Owner (E3), as the resources preview reads them. A claim of certainty here would be wrong in both directions. |
| D-D8 | **One rule for what a reference is.** `references(value)` is added beside `expand` in src/shared/env-expand.js and uses the same pattern; a test pins `references` against `expand`'s `missing` set. | Two scanners for `${VAR}` is how the card and the launch drift. |
| D-D9 | **One rule for what a launch skips.** The enabled and `backends` filter of `externalServersFor` becomes a function the check calls; the transport and `cwd` answer is a descriptor declaration `externalMcpTakes` (O-D1), pinned against the real emitters by a test. | Reflex 5, `.claude/rules/backends.md`: a capability is declared, not inferred in the core. |
| D-D10 | **Input is the editor's current list, unsaved.** The renderer sends the raw entries from the text area; main runs `validateExternalMcpServers`, caps count and string length, and gives a rejected entry no facts. The settings window is a snapshot (#146): the entries are the window's, the environment and the global variables are read live in main at the time of the check. Reruns: after the backend choices load on open, after a card operation, a form confirm or the text area losing focus, and on "Check again" (O-D4). A reply for an older request is dropped by sequence number. | The cards project the text (D-B1); a check of the saved list would lag what the user sees. |
| D-D11 | **The reply carries names, states and booleans, never values.** Variable names and where they were found; the resolved command path (the user's own machine, in the card's tooltip, O-D7); per-backend verdicts as `{ id, label, takes, reason code }`. No env, header or argument value, no error text: a thrown error is logged and the reply is a fixed sentence (`.claude/rules/main-process.md`, readable-error). The one exception: the resolved command path is the expanded command, so a `${VAR}` in `command` or `cwd` puts that variable's value (a path on the user's own machine) into the reply; it is shown only in the card tooltip (O-D7). | D-S2 extended to the status line. A test with sentinel secrets pins it. |
| D-D12 | **Per-backend verdicts are computed in main, from the registry.** The renderer maps reason codes to sentences and names no backend (reflex 5); labels come with the reply. `backends-list` is unchanged (O-D2). | One answer for acceptance, filter and `cwd`; a second one in the renderer is the #229 trap. |
| D-D13 | **Bounded cost.** One IPC per refresh for the whole list. One listing per PATH directory per refresh, shared by every entry, kept for a few seconds so a burst of edits does not re-walk. `fs.promises` only, a small fixed number of directories in flight, a total time budget after which the rest is "not checked: timed out". `stat` only for a candidate. The PATH walk measured 45-95 ms per backend on the main thread when it was synchronous (#722, #750); this one never blocks it. | The check runs on every card change. |
| D-D14 | **No new setting, no new environment variable.** `docs/settings-reference.md` is unchanged. | The check has no switch; it reads and shows. |

### Reuse by #790

`resolveCommand(name, { env, cwd })` answers `{ state: 'found' | 'missing' | 'unknown', resolved?, ext?, reason? }` for
a bare name or a path; a batch form shares one listing. `checkEntries(entries, context)` answers, per entry, the command
fact, the variable facts and the per-backend verdicts. #790 adds no PATH walk and no `${VAR}` reader of its own.

### Open points, decided

| | Open point | Decision |
|---|---|---|
| O-D1 | The owner named `acceptsMcpTransports` and `providesMcpInjection` as the source of "which backends accept the transport". Pi and pi-native declare `providesMcpInjection: false` and take stdio through the session-resources extension (T9, T10); read literally they would show "not accepted" beside a server they do run. | **Decided (owner, 2026-10-26), as recommended:** A new descriptor declaration `externalMcpTakes` (`{ transports, cwd }` or `null`), answered by every backend, with a test that the quartet backends agree with `acceptsMcpTransports` and that each answer matches what its emitter really drops. The plan builds on this. |
| O-D2 | The owner said the facts travel "through backends-list". With the verdict computed in main (D-D12) the payload need not change. | **Decided (owner, 2026-10-26), as recommended:** Leave `backends-list` alone. |
| O-D3 | Should the check also stat a stdio entry's `cwd`? A missing directory fails the server's start. The launch does not check it, and it is outside the three facts. | **Decided (owner, 2026-10-26), as recommended:** No. |
| O-D4 | A "Check again" control, so a user who installs `uvx` with the editor open does not have to edit a card to learn it. | **Decided (owner, 2026-10-26), as recommended:** Yes, one existing-style button; the check is cheap. |
| O-D5 | On Windows a command found only as `.cmd` or `.bat` (an npm shim): show the extension, or warn that some CLIs cannot start a shim without a shell? Not measured per CLI. | **Decided (owner, 2026-10-26), as recommended:** Show "found (.cmd)" with no warning; measure per CLI before any claim. |
| O-D6 | Cross-entry facts: a name clash with the user's own entry (O9) and two entries needing one variable with different values on Codex (O10). | **Decided (owner, 2026-10-26), as recommended:** Out of this slice; stay documented limits. |
| O-D7 | The resolved command path in the card tooltip. | **Decided (owner, 2026-10-26), as recommended:** Yes: it shows which of two installs wins, and it is the user's own machine. |

### Known limits

- A found command is not a working server: no `initialize`, no tool list, no version check.
- An http entry gets variable and backend facts only. Its URL is not resolved or requested.
- Project and template variables, and secrets that only spawn resolves, are outside the environment of D-D7.
- A relative PATH entry and a mapped drive letter that points at a share cannot be judged lexically: the first makes
  every miss "not checked", the second is read like a local drive. **Measured on the dev machine:** its PATH carries an
  unexpanded `%USERPROFILE%\…` entry, which is relative, so every miss there reads "not checked, PATH has a relative
  folder" and "would not start" never appears. That is D-D5 working as decided. A follow-up could resolve a relative
  entry against the server's working directory, which is what libuv (`search_path`) and `execvp` do, but Codex starts
  servers through Rust's `Command`, which no longer searches the working directory; so it would need a per-backend
  declaration of the lookup rule. A cheaper option is a reason of its own that names an unexpanded `%VAR%` folder.
- `${VAR}` in an arg is checked as a reference only, never as a file.
- An entry over the check's size caps is rejected before the duplicate-name pass; if a later entry shares its name, the
  check accepts the later one while the launch keeps the first. It needs an entry longer than the caps allow.
- A relative `cwd` is resolved against the project directory; with no project path it stays relative and the command
  reads "not checked".

### As built (slice D)

- **`src/shared/env-expand.js`**: `references(value)` beside `expand`, same pattern (D-D8).
- **`src/app/mcp-inject.js`**: `entryAppliesTo(entry, backend)`, the enabled-and-`backends` filter with its reason (D-D9);
  `externalServersFor` and the source call it. A `cwd` that expands to an empty string counts as no `cwd` for every
  emitter.
- **`src/app/path-resolve.js`**: `resolveCommand`, `resolveCommands`, `forgetListing` (D-D4, D-D5, D-D6, D-D13).
  Defaults: budget 2000 ms, 8 directories in flight, listing cache 5 s. Reason codes `network`, `unreadable`, `timeout`,
  `relative-path-entry`, `no-cwd`, `empty-name`.
- **`externalMcpTakes`** on every descriptor, forwarded by `profileToDescriptor`; `test/external-mcp-takes.test.js` pins
  it against the emitters. `cwd: false` means an entry with a `cwd` is not given at all.
- **`src/app/external-mcp-check.js`**: `checkEntries` and the IPC `external-mcp-check`, bound as
  `window.api.checkExternalMcp(projectPath, entries)`. The reply is `{ ok, results }`; a result is
  `{ index, name, enabled, transport, command, variables, takes, envGap }` or `{ index, rejected: true }`. `REASONS`
  holds the closed code sets, which the renderer maps one by one. Command codes add `unset-variable` and
  `path-overridden` to the resolver's; per-backend codes are `entry-disabled`, `backend-filter`, `unset-variable`,
  `transport`, `cwd`, `no-channel`. The list is checked for every enabled, ready, non-template backend.
- **The card** (`src/renderer/panels/settings-external-mcp.js`): up to three lines under the backend chips (command,
  variables, backends), the resolved path in the card's tooltip, and "Check again" beside "Add server", disabled while
  the JSON does not parse. Facts are keyed by the entry's own JSON, so a reply never lands on an entry that changed; a
  reply that arrives while the JSON text area has focus is kept and drawn on blur. A failed check keeps the last facts
  and says so; with none yet it says only that the check could not run.
- **Tests**: `test/path-resolve.test.js`, `test/external-mcp-check.test.js` (sentinel secrets, one `readdir` per
  directory for 40 entries on 100 directories, network paths never handed to `fs`), and
  `test/external-mcp-check-agreement.test.js`, which runs one fixture through the real `externalServersSource` +
  `composeMcpInjection` (Claude, claude-native, Codex, agy) and Pi's session-resources path, and compares every
  backend's verdict with what the launch kept or dropped.

**Measured (T6, dev machine, Windows, 93 PATH directories, 10 names, `scripts/measure-path-resolve.js`):** cold
13-27 ms with the machine otherwise idle, 243-661 ms while the test suite and other agents ran; from the cache 3-8 ms.
The walk is asynchronous and starts no process.

**Card against a real launch (G8, demo instance, 2026-10-26):** one project with six entries, launched on Claude
(Haiku) and Codex. No model turn was sent.

| Entry | Card: Claude | Launch: Claude `--mcp-config` | Card: Codex | Launch: Codex `-c mcp_servers` |
|---|---|---|---|---|
| stdio, command found | takes | given | takes | given |
| stdio, command not on PATH | takes | given | takes | given |
| stdio, unset `${VAR}` | not: unset variable | skipped (logged) | not: unset variable | skipped (logged) |
| http | takes | given | takes | given |
| stdio with `cwd` | not: `cwd` | not given | takes | given, with `cwd` |
| switched off | not: switched off | not given | not: switched off | not given |

**Click test (G6):** facts on open, after a toggle, after "Check again", and after six edits in quick succession (the
last list's facts win); an unset variable, a default, a backend that does not take http (Pi), one that does not take a
`cwd` (Claude); "Check again" disabled on invalid JSON; Cancel stores nothing; Save is not held up by a warning; both
consoles clean.
