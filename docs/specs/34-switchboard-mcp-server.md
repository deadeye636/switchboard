# 34 — Switchboard as an MCP server for a session: one injection seam, one HTTP transport, one diff tool

Issues #333 (agy diff surface), #789 (inject MCP servers into launched sessions), with #507, #330 and #790 as
later phases. Status: **planned** (the plan is local; this file is the lasting record and is updated as steps land).
Background measurements: #329 (agy does not speak the Gemini companion protocol), #543 (agy's `mcp_config.json`
is listed as a resource).

## What changes for the user

An agy session can be offered a tool: "show the user this change, wait for accept, reject or an edited
version". The proposal opens in the file panel of the window that renders the session, the same review surface
Claude's `--ide` companion uses today, and the answer goes back to the agent as the tool result.

This is an **offer, not a redirect**. Claude's `--ide` sits in the edit path: the CLI's edit goes through the
IDE and the model has no say. An MCP tool is a catalogue entry the model has to choose. It can be nudged but not
enforced, and agy's own approval prompt keeps running in its terminal beside ours, so a second prompt sits next
to the first rather than replacing it. Diffs after a write are already covered for every backend by the VCS seam
(spec 15, #277); the only thing this adds is seeing a change **before** it lands. If that turns out not to be
worth it, the seam below is still what #789 needs.

## Two directions, one seam

| Direction | Issues | What it is |
|---|---|---|
| Switchboard is the server, the CLI calls it | #333, #330, #507 | Per-session registration of Switchboard's own endpoint; the issues differ only in the tool group exposed (diff surface vs orchestration) |
| Switchboard brokers external servers the CLI consumes | #789, #790 | A project's chosen servers are written into the CLI's MCP client config at launch; #790 helps install them |

Both end in the same act: **put an MCP server entry in front of one launched CLI without touching the user's
shared configuration.** That act is built once, as a descriptor capability, and the Switchboard-as-server core
is its first client. Switchboard's own server is not an addon in #790.

## The facts about the code (O3)

Read from `src/servers/mcp-bridge.js`, `src/app/terminal/spawn.js` and the Claude and agy descriptors.

1. **The wire is MCP's, the transport and dialect are Claude's.** Messages are JSON-RPC 2.0 with the standard
   `initialize`, `tools/list`, `tools/call` and `notifications/initialized` (lines 114-154); `initialize` answers
   protocol version `2025-03-26` (line 139). That envelope is reusable. What is Claude's:
   - the transport is a WebSocket with subprotocol `mcp` (lines 404-415) — not one of MCP's two standard
     transports (stdio, streamable HTTP);
   - discovery is a lock file in Claude's isolated `ide` directory (lines 424-439) and `--ide` on the command
     line (`src/app/terminal/spawn.js`, line 1137); the auth header is `x-claude-code-ide-authorization`
     (line 454);
   - the tools are Claude's: `openDiff` takes `old_file_path`, `new_file_path`, `new_file_contents`, `tab_name`
     (lines 59-70), `close_tab` closes by tab name, and the answer is a sentinel string `FILE_SAVED`, `TAB_CLOSED`
     or `DIFF_REJECTED` (lines 279-297).
2. **Everything behind the tool call is transport-free.** The pending-diff table, the ten-minute timeout, the
   window the review goes to, the answer path (`resolvePendingDiff`, `rejectPendingDiffsForWindow`,
   `shutdownMcpServer`) and the renderer's `mcpDiffResponse` binding know nothing about sockets. `sendResult`
   and `sendError` (lines 156-166) are the only places that write to a WebSocket.
3. **The bridge is Claude-only by a gate in the spawn path**: `isClaudeBinary` (line 1118) and the
   `mcpEmulation` option. A backend driven over a pipe never gets it (line 1118, and line 1115 gives the reason).
4. **agy's own side**, from the descriptor and measurements already in the repo: agy declines a CLI home
   variable (`src/backends/agy/index.js`, `cliHomeEnv`), buildLaunch is clean argv with no MCP flag, and its
   shared client config is `config/mcp_config.json` (`src/backends/agy/resources.js`, #543). #329 measured one
   working HTTP entry of the shape `{"mcpServers": {"<name>": {"serverUrl": "<url>", "headers": {…}}}}`.
   `docs/backend-formats.md` records that a plugin bundle can carry its own `mcp_config.json` and that agy finds
   workspace plugins by walking up from the working directory, and that `agy mcp add` exists (1.3.0).

**Consequence.** For agy the work is a second transport (streamable HTTP, POST) in front of the existing
request handling, a Bearer-token check, an agent-facing tool shape, and the injection. It is not a new
subsystem. Claude keeps its WebSocket path untouched.

## Decided

| | Decision | Why |
|---|---|---|
| D1 | Plan A builds the shared core and **one** slice: the injection capability (only the hook, not the per-project management screen of #789), registration for agy (#333), and the `openDiff` tool. | Owner scope. Everything else is in "Later phases". |
| D2 | The per-session config reaches the CLI through an **ephemeral per-spawn file**, merged beside and never into the user's `config/mcp_config.json`. | Owner (O4). CLAUDE.md reflex 11 exempts per-spawn files; writing the shared file would change every surface that reads the `.gemini` tree and would leave a dead port behind after a crash. |
| D3 | Injection is a **descriptor capability**; the core names no backend and has no `switch (backendId)`. | Reflex 5 and the design rule of `.claude/rules/backends.md`. |
| D4 | agy's diff surface is an offer. This spec states the limit above and the product text says it too; no AGENTS.md or system-prompt nudge is shipped in Plan A. | Reflex 16 and the research on #330/#333. |
| D5 | #790 follows flow **(b)**, a copy-the-command button, when it is built. Not built here. | Owner. |
| D6 | Order is fixed: the generic injection hook, then the agy registration, then the openDiff wiring. | Owner. |
| D7 | Claude is **not** moved onto the new seam in Plan A. `--ide` and the WebSocket bridge stay as they are. | A byte-identical Claude path is the safe default; the seam can carry Claude's external servers later (Later phases, item 4). |
| D8 | The file panel and `mcpDiffResponse` are reused as they are. Plan A adds no renderer control and no new IPC handler. | Reflex 4 and reflex 8; the answer path already exists (`src/main.js`, handler `mcp-diff-response`). |
| D9 | The agy `diffTool` launch option defaults **off**. | Owner (plan O2). Offering a tool costs model context every turn; opt-in keeps the default launch unchanged. |
| D10 | The `openDiff` schema is `filePath`, `newContent`, optional `tabName`, result `ACCEPTED` / `REJECTED` / `ACCEPTED_WITH_EDITS` + content. | Owner (plan O4). Agent-facing shape, not Claude's four-field dialect. |

## Granularity (O9): one listener per app, one registration per session

The owner's constraint is a server that is stable and fast. Three options were weighed against the code.

| | Per session (today's WebSocket bridge) | Per project | **One HTTP listener for the app, one registration per session (recommended)** |
|---|---|---|---|
| Startup on the spawn path | A bind per session, awaited before the CLI starts (`spawn.js`, line 1134) | A bind per project, plus a refcount | The first agy spawn binds once; later spawns only add a map entry |
| Ports | One per live session | One per project with a live session | One for the app instance (dynamic port 0, loopback only) |
| Identity of the caller | Implied by the socket | **Still needs the session**: pending diffs, the window and the re-key on fork are per session | The Bearer token names the session, so identity is explicit on every request |
| Lifecycle | Dies with the session | Needs a rule for when the last session leaves | Closed at app quit; a session registration is released on exit |
| Orphans | A listener per crashed session until the app exits | Same, longer-lived | None: no child process, one listener owned by the main process |
| Path identity | n/a | Inherits the junction/subst spelling class of bug (#245, #563, #566): two spellings of one project would get two instances | n/a, nothing is keyed on a path |

Per project is rejected: it keeps the per-session bookkeeping and adds a shared-lifetime problem on top. The
app-wide listener removes the per-spawn bind cost and the port count without sharing any session state.
The price is one shared failure domain, handled by: every request handler wrapped so a throw answers an error
and never closes the listener; a request body cap; loopback only; a bind failure degrades the spawn to "no
tool" with a warning and never fails the launch. The registration API (`registerSession`) hides the granularity,
so moving to another one later does not touch a descriptor or the spawn path.

This is a recommendation the plan builds on, not a decision the owner has made; Open point O1 in the plan keeps
it open for confirmation. The startup-cost figures are to be **measured** in T6 and written here; none is claimed now.

## The injection capability (the part of #789 that lands here)

A descriptor declares it, in the shape the other per-spawn features use (flag, build, release):

- `providesMcpInjection === true`, `buildMcpInjection({ dir, tag, cwd, servers, options, log })` and
  `releaseMcpInjection(cleanup, log)`. `servers` is a list of neutral rows
  `{ name, transport: 'http' | 'stdio', url, headers, command, args, env }`, the same neutral shape the
  "Resources from" seam uses for MCP servers (spec 31). The hook answers `{ args, env, cleanup } | null`.
  `null` is "this launch gets nothing", never an error.
- `acceptsMcpTransports: ['http'] | ['stdio'] | [...]`: a declaration, so the core drops a row the CLI cannot
  take and says so instead of writing a config the CLI will reject.
- A capability row (`mcpInject`) in the catalog that every backend answers, declining included, and forwarding
  in `profileToDescriptor` so a template on agy inherits it (`test/template-descriptor-shape.test.js`).
- A core module in `src/app/` composes the rows for one spawn from **sources**. Plan A has one source, "own
  server" (Switchboard's endpoint when the backend's option is on). #789 later adds the per-project source and the
  prune/override of a backend's defaults without touching a descriptor.
- The spawn path calls it once, next to the other per-spawn builders, as best-effort: a failure is a warning and
  the session starts without the tool. It does not apply to a backend driven over a pipe.

Per-spawn files go under the app's binding directory when the CLI can be pointed at a path, and are removed on
exit, on a failed spawn, and by a sweep at start-up for files whose recorded process is dead (the same rule
`cleanStaleLockFiles` applies to lock files).

## The diff tool for agy

- **Transport:** streamable HTTP, one endpoint, POST with a JSON-RPC body answered with one JSON object. Notifications
  get 202. GET answers 405. No server-to-client stream is offered in Plan A.
- **Auth:** `Authorization: Bearer <token>` on every request, compared in constant time, one token per session
  registration. A `Host` that is not the loopback address and port, or any `Origin` header, is refused. This is
  the DNS-rebinding guard the streamable-HTTP transport asks for.
- **Tool group `diff`:** one tool, `openDiff`, with an agent-facing schema (`filePath`, `newContent`, optional
  `tabName`) — not Claude's four-field shape. The description says in plain words that the file is **not**
  written, that the user may accept, reject or edit, and that the agent applies an accepted result with its own
  edit tool. The result is text: `ACCEPTED`, `REJECTED`, or `ACCEPTED_WITH_EDITS` followed by the final content.
  Switchboard never writes the file (reflex 11 is about files a CLI reads; the agent owns its edits).
- **Paths:** a relative `filePath` resolves against the session's project; a path outside the project (real-path
  containment, `src/app/path-containment.js`, reflex 13) or on a foreign network path (`refusePath`) is answered
  with an error. This is stricter than Claude's dialect on purpose: here the path is the model's, with no IDE
  protocol vouching for it.
- **Groups are data:** a registration names the groups it exposes. #507's orchestration tools become a second
  group on the same registration.

## Open questions that code cannot settle

Settled by T1 on a real agy, recorded in `docs/backend-formats.md`, and this section updated. No guess is built on.

| | Question | Why it matters | What it blocks |
|---|---|---|---|
| Q1 | **Is there a per-launch way to hand agy an MCP config** — a flag, an env variable, a project-scoped file, or only the shared `config/mcp_config.json` and `agy mcp add`? The measured candidates are a workspace plugin bundle carrying its own `mcp_config.json` and a flag in `agy --help` that this repo has not recorded. | D2 needs a channel that is not the shared file. If the only channel is the shared file, D2 cannot be met for agy and the slice stops. | T8, T10 |
| Q2 | Does agy's client speak **streamable HTTP**, legacy SSE, or both, and what URL path does it expect? #329's measured entry used a path ending in `/mcp/schema`, which may be a server-specific path or a convention. | The transport built in T6. | T6 shape, T8 |
| Q3 | Does agy send a configured `headers` map on every request, including a Bearer token, and which protocol version does it request? | The auth and `initialize` reply. | T6 |
| Q4 | **How long will agy wait for a tool call?** A review can take minutes (the bridge allows ten). | A blocking `openDiff` that outlives the client's timeout is an error the user sees. If the timeout is short, the tool becomes two-phase (open returns a handle, a second call collects the answer) or uses a streamed response with keep-alives. | T7 |
| Q5 | Does a workspace plugin directory, if it is the channel, merge with the global servers or replace them, and does it show up in agy's plugin listing and in this app's resources panel? | Pollution of the user's project and of the listing built in #547/#611. | T8 |
| Q6 | Does agy accept an MCP server that is only present in a per-launch file when its trust prompt for servers differs by origin? | A second prompt per session would make the offer unusable. | T8 |

### Q1 confirmed, 2026-10-20, agy 1.4.3 — a project-tree channel loads end to end

Measured with a real pty (switchboard's `node-pty`) running agy interactively in a probe project, against a
logging HTTP server. A per-launch channel that avoids the user's shared `~/.gemini/config/mcp_config.json`
**works**:

- The channel is a **workspace plugin bundle plus an explicit `.agents/plugins.json`**. A bare
  `.agents/plugins/<name>/{plugin.json, mcp_config.json}` is **not** auto-discovered on 1.4.3 — neither a
  headless `--print` turn nor an interactive pty session loaded it. Adding `.agents/plugins.json` with
  `{ "entries": [ { "path": ".agents/plugins" } ] }` (workspace-relative to the repo root, scanned one level
  deep per the shipped `json_configs.md`) made agy load it. `agy plugin validate` confirms the bundle shape
  (`mcpServers: 1`). It writes into the **project tree**, not the shared config — D2 is met, G3 applies.
- `agy mcp add` is the other channel but writes the **global** shared config (no scope flag), so it cannot
  meet D2. No MCP launch flag in `agy --help`; agy declines a home variable.

Because the load worked, Q2, Q3 and Q6 are answered in the same run:

- **Q2 (transport).** agy speaks **streamable HTTP** at exactly the configured URL path: `POST` for JSON-RPC,
  then a `GET` on the same path to open the stream. It also probes `GET /.well-known/oauth-protected-resource`
  and `.../oauth-protected-resource/<path>` (unauthenticated) — the transport in T6 must answer these (a 404
  is fine when no OAuth is offered). The opening request is a non-standard `server/discover` before
  `initialize`.
- **Q3 (headers, version).** agy sends the configured `headers` (the `Authorization: Bearer <token>`) on
  **every** `/mcp` request. Its `initialize` sends `clientInfo { name: "antigravity-client" }` and
  **`protocolVersion` `2025-11-25`** — newer than the bridge's `2025-03-26`, so the transport must negotiate
  the version rather than echo its own. Client capabilities include `elicitation` and `roots`.
- **Q6 (trust).** The server connected with no blocking trust prompt in the probe.

Still open: **Q4** (tool-call timeout — not exercised, no tool was called), and **Q5** (whether the
`plugins.json` entry pollutes agy's plugin listing or the app's resources panel). Both are cheap follow-ups on
the same harness. If a later finding shows the project-tree write is unacceptable, Plan A ends after the
injection capability and the HTTP transport, both tested against a stand-in client, and the owner decides
whether to proceed for agy (see "Later phases", item 5).

## Known limits to state in the product text

- The agent has to choose the tool. Switchboard cannot make it.
- agy's own approval prompt still runs in its terminal. There are two prompts for one change.
- Offering a tool costs the model context on every turn, so the option is a per-backend toggle in the launch
  options, applied at spawn, defaulting **off** (D9).
- A diff proposed for a file the agent then edits differently is not detected. The VCS seam shows what actually
  landed.

## Later phases

Numbered so they can be referred to. Each is its own plan with its own go.

1. **#507, orchestration tools.** A second tool group on the same registration: read-only discovery first (list
   sessions, read handoffs, turn summaries across backends), then headless spawn with completion tracking, then
   resume and live messaging. The issue's design points (worktree isolation, cascade shutdown, a depth limit,
   a policy gate for unattended permission prompts) are that plan's content. Its "universal stdio bridge" is
   to be reconsidered against the HTTP listener built here, and against the existing WebSocket bridge, before any
   executable is added.
2. **#330, Codex.** A second descriptor declaring the capability: Codex has a home variable and a
   project-scoped config file, so the isolation question has an answer there. Transport is the same HTTP
   listener; only the config writer (TOML) differs.
3. **#789, the per-project management screen.** The per-project source in the core module, prune and override of
   a backend's default servers, the settings surface (tabs, cards, toggles per the design note on the issue, two
   levels: installed globally and enabled per project). The hook it needs lands in this plan; the screen is a
   new user flow and starts with a proposal with pros, cons and alternatives (reflex 16).
4. **Claude on the seam.** Offer Claude external servers (and, if wanted, Switchboard's own endpoint through
   the standard transport next to `--ide`) through the same capability, by a launch flag instead of a config
   write. Needs its own measurement; D7 keeps it out of Plan A.
5. **agy without a per-launch channel.** Only if T1 answers Q1 negatively: a request to the agy project, or an
   owner decision to accept a shared-file registration with its caveats. Not a Plan A step.
6. **#790, the addon manager.** Flow (b): show the exact install command and a copy button, detect first
   (runtime present, server present). Depends on item 3. Flow (c), running the package manager, is a separate
   decision.
7. **A pre-write gate for backends that only support a pipe.** The structured runtimes (`claude-native`,
   `pi-native`) have their own approval cards; whether they would want an MCP diff tool is not asked here.
