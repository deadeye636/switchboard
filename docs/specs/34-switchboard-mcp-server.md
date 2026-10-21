# 34 — Switchboard as an MCP server for a session: one injection seam, one HTTP transport, one diff tool

Issues #333 (agy diff surface), #789 (inject MCP servers into launched sessions), with #507, #330 (Codex, see
"Codex (#330): launch overrides and an env-var token") and #790 as later phases. Status: **built and confirmed end to end (G2, agy 1.4.3)**. The core and the agy slice are built,
tested against a stand-in client, and confirmed in an interactive agy session: the tool surfaces, a proposed
`openDiff` opens in the file panel, accept/reject/edit answer the agent, and the user's shared
`~/.gemini/config/mcp_config.json` is byte-unchanged. The one cost is agy's own heavy permission prompting:
see "As built" and "Known limits".
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
it open for confirmation.

**Measured in T6 (Windows 11, loopback, `performance.now()` around `registerSession`, medians of repeated runs).**
The first bind — the one the first agy spawn pays, once per app instance — is ~330 ms (7 runs, 230–510 ms). A
later registration, every spawn after that, is ~0.02 ms (50 per run): a `crypto.randomBytes` token and a map
insert, with no bind and no network await. Read against the per-session WebSocket bridge this replaces, where
**every** session binds its own server, that per-session bind is ~4 ms (`startMcpServer`, lock-file write
included) — so the app-wide listener turns a ~4 ms-per-spawn cost into ~0.02 ms after one ~330 ms bind. The
~330 ms is Node/winsock first-`listen` warmup on this host, not HTTP-specific: the WebSocket bridge's first bind
shows the same ~250 ms, so the HTTP-specific cost to compare is the later-registration figure, not the first.

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
| Q1 | **(answered, see below)** **Is there a per-launch way to hand agy an MCP config** — a flag, an env variable, a project-scoped file, or only the shared `config/mcp_config.json` and `agy mcp add`? The measured candidates are a workspace plugin bundle carrying its own `mcp_config.json` and a flag in `agy --help` that this repo has not recorded. | D2 needs a channel that is not the shared file. If the only channel is the shared file, D2 cannot be met for agy and the slice stops. | T8, T10 |
| Q2 | **(answered)** Does agy's client speak **streamable HTTP**, legacy SSE, or both, and what URL path does it expect? #329's measured entry used a path ending in `/mcp/schema`, which may be a server-specific path or a convention. | The transport built in T6. | T6 shape, T8 |
| Q3 | **(answered)** Does agy send a configured `headers` map on every request, including a Bearer token, and which protocol version does it request? | The auth and `initialize` reply. | T6 |
| Q4 | **(open)** **How long will agy wait for a tool call?** A review can take minutes (the bridge allows ten). | A blocking `openDiff` that outlives the client's timeout is an error the user sees. If the timeout is short, the tool becomes two-phase (open returns a handle, a second call collects the answer) or uses a streamed response with keep-alives. | T7 |
| Q5 | **(answered)** Does a workspace plugin directory, if it is the channel, merge with the global servers or replace them, and does it show up in agy's plugin listing and in this app's resources panel? | Pollution of the user's project and of the listing built in #547/#611. | T8 |
| Q6 | **(answered)** Does agy accept an MCP server that is only present in a per-launch file when its trust prompt for servers differs by origin? The handshake has no origin-specific prompt; the tool-level approval friction that remains is an accepted limit — see #791 below. | A second prompt per session would make the offer unusable. | T8 |

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

**Q5 answered — no pollution.** `agy plugin list` in the probe project returns "No plugins installed." / `[]`:
a `plugins.json`-declared plugin is not shown there (that listing is `agy plugin import`'s). And this app's
agy resource lister is global-only by design — the workspace `.agents/` walk is deliberately not implemented
(`src/backends/agy/resources.js`, the `plugins-directory` note) — so the project `plugins.json` entry does not
surface in the resources panel either.

**Q4 not measured, and it exposed a transport fact that changes T6.** With a stub returning the tool in
`server/discover` and `tools/list`, agy completed the handshake (`server/discover`, `initialize`, a GET on
`/mcp`, `notifications/initialized`, `tools/list`) but the **tool never surfaced to the model** — it answered
"I do not have access to an MCP tool named …", and no `tools/call` was ever sent. The stub answered the
`tools/list` POST with a JSON body and closed the GET stream empty. The strong reading is that agy's
**streamable-HTTP client expects request results on the opened GET SSE stream**, not (only) as the POST
response body — so Q1's confirmation covers the connection and the handshake, **not** tool exposure. T6 must
implement a proper streamable-HTTP server: deliver each response as an SSE event on the GET stream, answer
`server/discover` with the tool manifest, and 404 the OAuth well-known probes. The tool-call timeout (Q4,
blocking vs. two-phase `openDiff`) is only measurable against that conformant server — defer it to the T10
end-to-end run / the G2 click test, not a stub.

### Tool surfacing probed, 2026-10-20 — not reproduced in a scripted launch (O-T6c / O-ISO)

Two further probes drove a real agy under a pty against logging servers:

- **Transport flavour does not change the outcome.** A server that answered every request as an SSE event
  (`event: message`, the streamable-HTTP "server upgrades the POST" shape) completed the same handshake as the
  earlier JSON-on-POST stub — `server/discover`, `initialize`, a GET on `/mcp`, `tools/list` — and in **both**
  the model reported no such tool and no `tools/call` was ever sent. So POST-body vs. SSE is not observable at
  the tool level here; both are viable for the handshake.
- **A known-good server does not surface either.** A reference `@modelcontextprotocol/server-filesystem`
  (stdio) declared through the same workspace plugin produced the same result: the model answered NOTOOL and
  never read the marker file. So the failure is **not** this spec's stub — no MCP tool, stub or reference,
  reached the model in the launch used.

The launch used was `agy -i "<prompt>" --mode auto` driven over a pty with blind Enter presses — **not** how
Switchboard spawns agy (a fully interactive TUI). Two causes remain and a scripted probe cannot separate them:
agy may not expose MCP tools in this mode at all, or a per-server trust/enable step is going unanswered (Q6).
The decisive test is a human-interactive agy session in Switchboard where a trust prompt can be answered —
which is exactly **G2**.

**Consequence for the build (owner decision O-BUILD-standin).** T5–T7 are built and tested **against a
stand-in client**, as this plan always intended — they do not depend on agy surfacing the tool, and the
HTTP listener also serves #507 and #330. The HTTP transport supports **both** a JSON POST-body reply and an
SSE reply, since agy accepted both handshakes. **G2 has since confirmed** (2026-10-20, agy 1.4.3) that a
real agy calls the tool and the diff round-trip works when `diffTool` is set through the Configure dialog;
the scripted "not reproduced" was a test-setup gap (the option was never set), not an agy limitation. See
the "Confirmed by G2" note under "As built".

If a later finding shows the project-tree write is unacceptable, Plan A ends after the injection capability and
the HTTP transport, both tested against a stand-in client, and the owner decides whether to proceed for agy
(see "Later phases", item 5).

### Build gaps (as-built)

- **G1 — orphaned bundles are reclaimed on the next build in the project, not by a start-up sweep.** agy's
  `buildMcpInjection` writes a per-session bundle under `<project>/.agents/plugins/switchboard-<unique>/` and
  removes it on clean exit (`releaseMcpInjection`). A force-killed run (e.g. `npm run stop:dev`) never reaches
  release, so its bundle — a 0600 token file and its dir — would linger. Rather than a cross-backend start-up
  hook that would have to enumerate every project (a new contract for a low-impact leak: the token points at
  a dead loopback listener), `buildMcpInjection` runs `sweepStaleBundles([cwd])` on the project it is about to
  write into, so a dead sibling is reclaimed the next time agy launches there — where it matters, with no boot
  cost. `sweepStaleBundles` stays exported for a wider sweep if one is ever wanted.

### As built

What landed, by module:

- `src/app/mcp-inject.js` — the core that composes rows and calls a backend's hook (T2), wired into the spawn
  path in `src/app/terminal/spawn.js` (T4). The descriptor quartet and the `mcpInject` capability row are
  described in `.claude/rules/backends.md`; every backend answers it.
- `src/servers/mcp-bridge.js` — request handling split from the WebSocket write, registry shared by both
  transports (T5); the group table holds Claude's five tools and the new `diff` group (T7).
- `src/servers/mcp-http.js` — the app-wide listener and `registerSession` (T6). It replies as a JSON body or
  as an SSE event, because agy completed the handshake with both. The figures for the first bind and a later
  registration are in "Granularity", measured in T6; nothing new is measured here.
- `src/backends/agy/mcp-inject.js` — the workspace plugin bundle and `.agents/plugins.json` entry, with
  `acceptsMcpTransports: ['http']` (T8); the `diffTool` launch option, off by default (T9). The bundle
  holds an `{ type: 'http', url, headers }` entry.
- agy's answer in the capability matrix is **`limited`**: the connection and handshake are measured, the
  tool reaching the model is not. Test coverage is `test/mcp-http.test.js`, `test/mcp-diff-group.test.js`,
  `test/agy-mcp-inject.test.js` and `test/mcp-agy-diff-e2e.test.js`, all against a stand-in client playing
  the CLI.

**Confirmed by G2, 2026-10-20, agy 1.4.3.** The scripted launches never produced a `tools/call` because
`diffTool` was never set — a plain launch sends no default, so the option reached the spawn as `undefined`
and nothing was injected (not a leak; the "defaults are never sent" rule). Set through the Configure dialog
it arrives, and an interactive agy session then: registered the session on the HTTP listener, wrote the
bundle under `<project>/.agents/plugins/switchboard-*`, showed the `switchboard` server with `openDiff` in
agy's `/mcp`, opened a proposed diff in the file panel, and returned `ACCEPTED` / `REJECTED` /
`ACCEPTED_WITH_EDITS` to the agent. The shared `~/.gemini/config/mcp_config.json` stayed byte-unchanged
throughout. So the scripted "not reproduced" was a test-setup gap, not an agy limitation.

**Still open.** Q4 (how long agy waits for a tool call, so whether `openDiff` must become two-phase) can only
be answered against a real agy calling the tool. `openDiff` currently blocks until the user answers or the
ten-minute cap passes.

**#791, agy's approval friction — accepted limit, 2026-10-21.** G2 measured agy prompting many times before
it would call `openDiff`. The investigation found no per-plugin or per-project trust that Switchboard could
set to reduce it. agy's only pre-approval for MCP tools is `permissions.allow` with `mcp(server/tool)` in the
user-global `~/.gemini/antigravity-cli/settings.json`; an `alwaysAllow`/`autoApprove` field in the plugin
bundle or `mcp_config.json` is undocumented and is reported as ignored. Writing to the global settings would
touch the user's shared config — the one thing the diff channel is built to avoid — and would need a fixed
server name, since ours carries a per-session tag. So the friction stays agy's own and is recorded as a limit
in the product text above. #791 is closed on this basis.

## Codex (#330): launch overrides and an env-var token

Status: **specified, not built.** Same feature family as the agy slice, so it lives in this spec. The value
question (a change seen before it lands, against the VCS seam of spec 15) is settled by the agy slice having
shipped; it is not reopened here.

**What changes for the user.** A second per-backend toggle, `diffTool`, on Codex, default **off** (D9), offering
only `openDiff`. Same bridge, same HTTP listener, same file-panel review, same accept / reject / edit answer.
The limits under "Known limits" apply to Codex unchanged: an offer, not a redirect, and Codex's own approval
prompt keeps running in its terminal.

**The channel: `-c` overrides, no file.** Measured against codex-cli 0.162.1 (backend-format-expert run): Codex
resolves a streamable-HTTP MCP server purely from launch `-c key=value` overrides, so nothing is written to disk
— not to `$CODEX_HOME/config.toml`, not to a project `.codex/config.toml`, not to an ephemeral file. The keys,
under the table `mcp_servers.<name>`, with `<name>` the neutral row's name (`switchboard`):

| Key | Value | Why |
|---|---|---|
| `mcp_servers.switchboard.url` | the listener URL, as a TOML string | the endpoint (`http://127.0.0.1:<port>/mcp`) |
| `mcp_servers.switchboard.bearer_token_env_var` | `"SWITCHBOARD_MCP_TOKEN"` | names the env var Codex reads the Bearer token from |

`startup_timeout_sec`, `tool_timeout_sec` and `enabled` exist and are not set by the first slice (see O2 below
on the timeout). A `-c` value is one argv token (spawn mode `argv`, no shell), and the TOML string quotes are
part of the token. Inline tables such as `http_headers={…}` are reachable the same way and are **not used**.

**Why no file (D2 still holds).** D2 asked for a channel that is not the user's shared config and that leaves
nothing behind after a crash. A launch override is that channel at its limit: it lives and dies with the
process. Consequences, all of which are deletions against the agy slice: no real release work, no cleanup
object, no stale-bundle sweep (agy's G1), no owner-record file, no safe-write question (reflex 11 never comes
up). Codex' home variable (`cliHomeEnv`) is not involved, so the isolation rule is met without it — the earlier
framing that Codex needs a per-session home or a project config file is superseded.

**Token decision (settled): an env var, not a literal header.** The composer hands every backend the same
neutral row `{ name: 'switchboard', transport: 'http', url, headers: { Authorization: 'Bearer <token>' } }`.
Codex' `buildMcpInjection` reads the Bearer token out of that header and answers
`{ args: [-c url…, -c bearer_token_env_var…], env: { SWITCHBOARD_MCP_TOKEN: <token> }, cleanup: null }`. The seam
already passes `built.args` and `built.env` through (`src/app/mcp-inject.js`) and the spawn path merges the env
below the user's and a template's variables (`src/app/terminal/spawn.js`). The reason for the env var: argv is
visible in the process list to every local user, an environment is not. A row without a Bearer header gets a
URL-only entry, and a row whose header is any other shape is skipped with a log line — the hook never writes a
secret into argv.

**Capability.** `acceptsMcpTransports: ['http']`, `providesMcpInjection: true`, `buildMcpInjection`, and a
`releaseMcpInjection` that does nothing. The no-op is there because the parity guard requires the whole quartet
of a backend that claims the capability (`test/backend-parity.test.js`) and a half-declared quartet is what the
guard exists to refuse; the hook answers `cleanup: null`, so the composer never calls it with anything to remove.
The source's own `release`, which drops the token registration and rejects open diffs, still runs through the
composer. The
`mcpInject` capability row moves from `no` to the same answer agy gives; which of `limited` or `yes` is O1. A
template on Codex inherits the quartet through `profileToDescriptor`, which already forwards whatever the base
declares.

**Settled by the findings above, not open:** the channel (`-c`, no file), the token delivery (env var), the
transport (`http` only), the absence of any cleanup work, the toggle (per-backend `diffTool`, default off), and that
the bridge, the listener and the `diff` group are untouched.

**Open (see the plan):** O1 the capability state, O2 the tool-call timeout, O3 the `-c` argv token through
node-pty on Windows, O4 a clash with a user's own `switchboard` server entry. None blocks the first steps.

## Known limits to state in the product text

- The agent has to choose the tool. Switchboard cannot make it.
- agy's own approval prompt still runs in its terminal, and in practice agy prompts **heavily** before it
  will call an MCP tool — measured in G2 as many prompts for one `openDiff`, well beyond the "two prompts for
  one change" the first draft assumed. The diff round-trip works, but the agent-side approval friction is agy's
  and Switchboard cannot remove it without writing to the user's shared config (#791, resolved as an accepted
  limit — see below).
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
2. **#330, Codex.** Specified in "Codex (#330): launch overrides and an env-var token" above; not built yet.
   It needs no config writer after all: Codex takes the whole registration as `-c` launch overrides, so the
   first reading here (a TOML config writer) is superseded.
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
