# 37 — Claude on the seam: Claude and claude-native can call the `discovery` tool group

Issue #507 (orchestration tools), **Phase 2, slice 2a**. Status: **planned, not built.** This is the design record
written before the build; the "As built" section is added when the gates in the plan have run.

Spec 34 is the shared core (the per-session registration on the app-wide HTTP listener, the Bearer token, the
injection quartet). Spec 35 is the `discovery` group this slice makes reachable from Claude. Spec 36 wired Claude's
`--mcp-config` file for a project's external servers and the `--strict-mcp-config` prune. Read those first; this
spec adds no transport, no token and no tool.

## What changes for the user

A Claude session (terminal, or the piped `claude-native`) can be offered the four read-only discovery tools
(`listSessions`, `readSession`, `listHandoffs`, `readHandoff`) that agy and Codex sessions can already be offered.
The offer is a new launch toggle, `discoveryTools`, **off by default**, on the Configure dialog and the backend
defaults of both Claude backends. With it on, Claude sees the tools as `mcp__switchboard__*`.

It stays an **offer, as in specs 34 and 35**: the model has to choose the tool, Claude's own approval prompt for an
MCP tool still runs (a card on `claude-native`, the CLI's prompt in a terminal), and nothing is written or spawned.

This is the first half of the issue's headline case, a Claude session reading what another backend did in the same
project. The second half, Claude asking another backend for a second opinion, is slice 2b (below).

## Decided

| | Decision | Why |
|---|---|---|
| W1 | Phase 2 starts with this slice, "Claude on the seam". A narrow read-only spawn tool (working name `runReview`) is slice 2b and is not designed here. | Owner. Reach first, then spawn, each with its own go. |
| E2 | Claude reaches the group through the **existing injection seam**: a `--mcp-config` file with an `http` row and a Bearer header to the app-wide listener. The group is **not** added to the `--ide` WebSocket bridge. | Owner. Claude Code's documentation lists only two model-visible tools for the built-in `ide` server and says nothing on filtering extra IDE tools; `claude-native` runs without `--ide`, so adding the group to the bridge could not reach it; the `mcp__switchboard__*` path is the documented one and matches spec 35 D5 and D7 (one registration, one token, one listener). |
| E2a | The shape is a `discoveryTools` toggle (default off, `appliesAt: 'spawn'`) on `src/backends/claude/index.js` and `src/backends/claude-native/index.js`. `diffTool` is **not** declared on the Claude family; diffs stay on `--ide`. | Owner. A second diff path for Claude would be a second place to review one edit. |
| E2b | No new core code is expected for the reach, and no `switch (backendId)` (CLAUDE.md reflex 5). The plan verifies this and says so if it is wrong. The core changes are the D-P6 guard (O5), the filter that feeds it (O8) and the declared-toggle check (O9). | Owner. Everything the group needs is already on the seam (see "What the code already does"). |
| E6 | Pi is out of this slice. It is its own later slice whose first step is measurement M7. | Owner. Pi's descriptors have `providesMcpInjection: false` and its own MCP section is stdio only. |
| E7 | Live measurements M1 to M5 are acceptance gates, run after the build, on the demo instance with the smallest model, settings restored afterwards. | Owner. See "Measurements". |
| O8 | "Reached the launch" means handed to the emitter and taken by it. `composeMcpInjection` applies the backend's `externalMcpTakes` (spec 36, slice D) to the project's rows before the emitter, declining a stdio row with a `cwd` the backend does not take, and drops any row whose url or command is empty. `externalNames` counts only what is left. | Owner. Claude's emitter declined such rows itself, after the count, so a project whose only entry had a `cwd` still pruned down to `switchboard`. Applying the declaration the static check already uses keeps one rule for the card and the launch, without changing every emitter's answer. |
| O9 | The spawn block opens a tool group only for a toggle the backend **declares** in its `configFields`. A stored `diffTool: true` under Claude's defaults (an import, a hand edit, a template over Claude) opens nothing. | Owner. `spawnOptionsFor` layers stored options without asking the descriptor, and a `diff` group on terminal Claude would sit beside `--ide`, which carries diffs too. |
| O5 | The D-P6 guard counts only the project's **external** servers that reached the launch, not the own `switchboard` row. Fixed in this slice. | Owner. Spec 36's D-P6 says a project whose servers for the backend all failed to reach the launch is not pruned; with `discoveryTools` on, the own row would otherwise satisfy the guard and the session would start with `switchboard` alone. |

## What the code already does (verified)

- Both Claude descriptors declare `providesMcpInjection: true`; Claude's `acceptsMcpTransports` is
  `['stdio', 'http']` (`src/backends/claude/index.js`), and `claude-native` forwards the whole quartet
  (`src/backends/claude-native/index.js`). The injection gate in `src/app/terminal/spawn.js` has no transport
  clause since #789 T10, so a piped Claude takes part.
- `spawn.js` builds the group list from the options (`diffTool` gives `diff`, `discoveryTools` gives `discovery`)
  and hands it to `ownServerSource` in `src/app/mcp-inject.js`, which answers one `http` row named `switchboard`
  with the Bearer header, or `[]` when the backend does not accept `http` or no group is on.
- The Claude emitter (`src/backends/claude/mcp-inject.js`) writes `{ "type": "http", url, headers }` into a 0600
  per-spawn file and passes it as `--mcp-config <file>`; the token is in the file, never on argv. It does not pass
  `--strict-mcp-config`.
- The listener (`src/servers/mcp-http.js`) already answers a notification with 202, a `GET` stream request without a
  405, and the OAuth protected-resource probe; it has been measured against Codex and agy only. Whether Claude's
  own MCP client is satisfied is what M1 answers.
- `--ide` registers under the name `ide`, the seam under `switchboard`. Under `--strict-mcp-config` the `--ide`
  connection survives (measured on Claude Code 2.1.310, `docs/backend-formats.md`).
- A template over Claude inherits the base's `configFields`, so it gets the toggle without a forward; the quartet is
  already forwarded in `profileToDescriptor`. The plan confirms this with the template tests rather than assuming it.

## The gate

`discoveryTools` is declared once on Claude and `claude-native` takes it from Claude's `configFields`, the way it
takes `worktree` and `chrome` today. The description names what Claude-specific the user must know: the tools are
offered over an MCP server beside the `--ide` bridge; what an agent reads may come from sessions of any backend in
the project, so another vendor's conversation reaches Anthropic's model (open point O4 is the wording).

A plain launch sends no default for a spawn-applied option, so the tests that turn it on set it explicitly (the agy
finding of spec 34). With the toggle off, or absent, a Claude launch's argv and env are **byte-identical** to
today's; a differential test pins it (spec 35 G2 did the same for Codex).

## Name coexistence and the prune

- `ide` and `switchboard` do not clash. M2 shows both connected in one session and a diff still arriving through
  `--ide`.
- A project with `externalMcpPrune` on passes `--strict-mcp-config`. The injected row lives in the `--mcp-config`
  file, which that flag keeps, so `switchboard` survives and the user's own servers are dropped as before (M4).
- **The D-P6 guard is not external-only, which the brief for this slice assumed.** `composeMcpPrune` in
  `src/app/mcp-prune.js` skips the prune when the project wants servers (`wantedServers > 0`) and the injection
  produced no name. `names` is every injected row (`src/app/mcp-inject.js`), the own row included. So with
  `discoveryTools` on, a project whose external servers all failed to inject would still prune, and the session would
  then have `switchboard` and nothing else. Decided (O5): the guard counts only the external names, so that launch
  starts without the prune and logs the D-P6 warning. The prune itself still receives every injected name, so a
  pruned launch keeps `switchboard`.
- A user-scope entry already named `switchboard` is spec 36's O9 (name clash). M5 measures which one wins; nothing is
  decided unless it breaks.

## Measurements (acceptance gates, after the build)

Run on the demo instance, the smallest Claude model, settings restored afterwards. They check the flow, not the
answer.

| | What | Records |
|---|---|---|
| M1 | Terminal Claude, toggle on: `/mcp` shows `switchboard` connected over http with the Bearer header; `mcp__switchboard__listSessions` is callable. | The approval prompt text; whether Claude's client needed anything the listener does not answer. |
| M2 | M1 with `--ide`: `ide` and `switchboard` both connected; a diff still goes through `--ide`. | Coexistence. |
| M3 | `claude-native`: `system/init.mcp_servers` shows `switchboard` connected; a call arrives as a `can_use_tool` approval card. | The card as the user sees it. |
| M4 | M1 with `--strict-mcp-config` (project `externalMcpPrune` on) and no external server: `switchboard` survives, the user's servers are dropped. | Prune coexistence. |
| M5 | A user-scope entry already named `switchboard`. | Which wins (spec 36 O9). |

`readOnlyHint` (spec 35 O7) may be measured alongside M1: set it in a throwaway build and see whether Claude skips
its prompt. It is a measurement, not a change to ship.

## Known limits

- The agent has to choose the tool, and the CLI's own approval prompt still runs. Whether to allow-list
  `mcp__switchboard__*` is open point O3; it is not on by default.
- **Cross-vendor flow, now from Claude's side.** A Claude session reading a Codex or agy transcript sends that text
  to Anthropic. The toggle is off by default and the text says so.
- A transcript is untrusted input to the model that reads it (spec 35, R2). Nothing sanitizes it.
- Claude re-keys its session id on `/clear` and on a fork (spec 13). The discovery reader is built at launch with the
  launch-time id (spec 35, L1), so `self` in `listSessions` can mislabel the caller's own row on Claude more often
  than on Codex or agy. Cosmetic: project scope is enforced on the registration's `projectPath`, not on the id. Open
  point O6.
- Pi and Hermes still cannot call the tools.

## Open

Numbered, stable. The plan carries the same list; an answered point says so.

1. **O1 `readOnlyHint`** (spec 35 O7). Set it in `tools/list` or not, and whether Claude then skips its prompt.
   Unmeasured; M1 may measure it. Recommendation: measure, decide after.
2. **O2 Tool-call timeout** (spec 35 O2). Claude's per-call timeout against the bridge's blocking cap. Not blocking 2a
   (the four tools answer quickly); it matters for 2b.
3. **O3 Approval allow-listing.** `--allowedTools` for `mcp__switchboard__*`, so a read-only call needs no prompt.
   Recommendation: not by default; an owner decision once M1 and M3 show how heavy the prompt is.
4. **O4 Configure text.** Wording of the cross-vendor note on Claude, where the flow is "other backends' transcripts
   go to Anthropic". Recommendation: reuse spec 35's sentence and name the vendor direction.
5. **O5 D-P6 with the own row.** **Answered (owner): count external names only, fixed in this slice** (see
   "Decided" and "Name coexistence and the prune").
6. **O6 `self` after a re-key.** Let the reader take the caller's current id, or accept spec 35's L1.
   Recommendation: accept for 2a and record; it is cosmetic and the fix touches the reader's construction.
8. **O8 What counts as reached.** **Answered (owner): the core applies `externalMcpTakes` before the emitter** (see
   "Decided"). Known and older than this slice: the static check says an entry whose command or url expands to
   nothing is taken, while the launch drops it; the card and the launch disagree there.
9. **O9 A stored toggle the backend does not declare.** **Answered (owner): it opens no group** (see "Decided").
7. **O7 Restricted mode.** `claude --restricted` ignores settings files; whether it also changes how a
   `--mcp-config` file is read is unmeasured (it is a Claude option the terminal backend offers). Recommendation:
   note it in the product text only if a cheap check shows an effect.

## Later phases

Not designed here. Each is its own plan with its own go.

- **Slice 2b, `runReview`.** A narrow read-only spawn tool: one turn on a pipe-driven backend, read-only, shared
  cwd, asynchronous with polling, depth at most one. Needs its own proposal (CLAUDE.md reflex 16).
- **Pi on the seam.** Its own slice. First step is measurement M7: `pi mcp --help`, is there a per-launch config
  path, and does an http server take a header? Pi's own MCP section (`src/backends/pi/mcp-section.js`) is stdio
  only today.
- Worktrees, promote and demote, messaging, resume, cascade shutdown stay later phases (spec 35, "Later phases").
