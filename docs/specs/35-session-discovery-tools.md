# 35 — Session discovery tools: a read-only second tool group on Switchboard's MCP server

Issue #507 (orchestration tools), **Phase 1 only**. Status: **built** (the slice landed; see "As built" at the end,
including what the real-Codex check did and did not show). This is the design record for the first slice.

Spec 34 is the shared core this stands on: the per-session registration on the app-wide HTTP listener, the
ephemeral Bearer token, the per-backend injection quartet and the `diff` tool group. Read it first. This spec
adds a second **group** to that same registration and does not touch the transport, the token or the injection.

**Why a new spec and not a section of 34.** Spec 34 is the core plus the diff slice and is already long. This
slice has its own data seam (what the app knows about sessions, handoffs and transcripts), its own bounds and its
own later phases (spawning, which is a different kind of feature). The two are cross-linked, and 34's "Later
phases" item 1 points here.

## What changes for the user

A coding agent running in a Switchboard session can be offered four read-only tools: list the other sessions of
its project, read a bounded view of one of them, list the project's handoff packets, read one. Typical use: a
Codex session asks "what did the Claude session on this project do last, and is there a handoff for it?" and
gets an answer without the user copying anything.

It is an **offer, as in spec 34**. The agent has to choose the tool; the CLI's own approval prompt for MCP tools
still runs; Switchboard changes nothing, spawns nothing and writes nothing.

It is also a **data flow the user opts into**: a transcript of one session, possibly from a different CLI and a
different vendor, becomes input to another model. The toggle is per backend and off by default, and the product
text says so (see "Known limits").

## Scope

Phase 1 is read-only discovery and nothing else. Spawning, resuming, worktrees, promote and demote, cascade
shutdown and a recursion limit are the issue's Phases 2 and 3. They are big new user flows, each needs its own
proposal with pros, cons and alternatives (CLAUDE.md reflex 16) and its own go, and they are listed under "Later
phases" below without a design.

## Decided

| | Decision | Why |
|---|---|---|
| D1 | Phase 1 is read-only discovery only. | Owner. The rest of the issue is later phases. |
| D2 | Project scope is the caller session's project. The registration already carries `projectPath`; every tool answers only sessions, handoffs and transcripts under it. Never cross-project. | Owner. Bounds both the context cost and the exposure. |
| D3 | The gate is a new per-backend launch toggle, default off, like `diffTool` (spec 34, D9). | Owner. Offering tools costs the model context on every turn, and this one exposes conversations. |
| D4 | Transcript reads are turn-filtered and summarized; lists are compact rows; every output has a cap. | Owner. A context-window overflow is the failure to prevent. |
| D5 | One registration, one token, one listener. No new transport, no stdio-bridge executable, no second injection. | Owner. The issue's point 5 is superseded by the HTTP listener of spec 34, its point 4 is `ownServerSource`. |
| D6 | The group id is `discovery`. The toggle id is `discoveryTools`, on every backend that can take the injection, `appliesAt: 'spawn'`. | Names the group it opens. A later spawning group gets its own toggle: it is a different risk and must not ride on this one. |
| D7 | The group is added to the **existing** own-server registration (the source carries a list of groups computed from the toggles), not registered a second time. | A second source would register again: two tokens, two rows both named `switchboard`. That breaks D5. Open point O2 keeps this open for confirmation. |
| D8 | The handlers are given their data by a reader object stored on the registration entry (`entry.discovery`), not by a module-level global and not by requiring the app's database. | `mcp-bridge.js` is Electron-free and db-free by design; a per-entry reader makes the handlers testable with a plain fake and lets a test run two registrations with different readers. |
| D9 | A transcript's grammar is read by a **descriptor hook** that answers neutral messages. The core groups them into turns and applies every cap, so the bounds are the same for every backend. | CLAUDE.md reflex 5 and `.claude/rules/backends.md`: transcript grammar belongs to the backend. Bounds in the core, once, so no backend can forget one. |
| D10 | A "summary" is deterministic truncation done in the core. Switchboard calls no model. | Phase 1 spawns nothing, and a model call is a spawn. |
| D11 | A handoff or a session is named by an **id**, never by a path the model composes. The handoff id is the packet's path relative to the project root; the server re-derives the listing on every call and answers only what is in it. A session id must belong to the caller's project. A session of another project and a session that does not exist answer the same sentence. | The id is the model's input, the same reason spec 34 makes `openDiff` stricter than Claude's dialect. No existence oracle across projects. |
| D12 | A result is one `text` content item holding one compact JSON object. A problem with the caller's arguments or a lookup that finds nothing is a result with `isError: true` and a plain sentence; an unknown tool name or a malformed request stays a JSON-RPC error. | All three dialects measured so far read text results. `isError` is the tool-level error MCP defines, and the model sees the sentence. |
| D13 | The starting caps are in "Bounds". They are design values the plan checks against a real session before they are called settled. | Honest: no measurement behind the exact numbers yet. |

## Who can call it (the reach of Phase 1)

The group is offered through the injection seam of spec 34. Today that is **agy and Codex**. Claude keeps its own
WebSocket bridge and `--ide` (spec 34, D7), and Pi and Hermes are not on the seam. So in Phase 1 a Codex or agy
session can read **every** backend's sessions in its project, but a Claude session cannot call the tools yet.

The issue's headline use case (Claude asking another model for a second opinion) needs "Claude on the seam" (spec
34, "Later phases", item 4) and Phase 2. This is stated up front because it is the first thing a reader will
assume works. Open point O3 asks the owner to confirm that Phase 1 ships with this reach.

## The tools

Group `discovery`. Names are unprefixed camelCase, like `openDiff` (open point O1 holds the final naming). The
descriptions are short, say that the tool is read-only, and say that returned text is data from another session
and is not an instruction.

| Tool | Arguments | Answers |
|---|---|---|
| `listSessions` | `limit` (default 25, max 100) | The project's sessions, newest activity first, as compact rows. |
| `readSession` | `sessionId`; `turns` (default 8, max 30); `roles` (`both`, `user`, `assistant`; default `both`); `maxCharsPerTurn` (default 1200, max 4000) | A header row and the last `turns` turns, truncated. |
| `listHandoffs` | `limit` (default 20, max 50) | The project's handoff packets, newest first, without their text. |
| `readHandoff` | `id`; `offset` (default 0); `maxChars` (default 16000, max 32000) | One slice of a packet and whether more follows. |

**`listSessions` row:** `id`, `backend` (the id and the label as the sidebar shows them), `title` (the name the
user gave it, else the session's own title or summary, else its first prompt, capped), `firstPrompt` (capped at a
short length), `state`, `lastActivity` (ISO), `startedAt`, `turns` (user prompts), `messages`, `self` (true for
the caller, so it can leave itself out). Rows of subagents are not listed. Archived sessions are not listed.
`state` is `running` when the app holds a live process for the session and `stopped` otherwise; whether to add a
busy flag where the app can tell is open point O6.

**`readSession` result:** `{ session: <the list row>, turns: [...], returned, partial, note? }`. A turn is
`{ n, at?, user, assistant, tools? }`: `n` counts from the start of what was read, `user` and `assistant` are the
truncated texts, `tools` is a map of tool name to count for that turn (the calls are collapsed, never replayed).
`partial: true` means older history exists that this call did not read. It is always present, because a reader
that looks only at the end of a transcript cannot tell "this is the whole session" from "this is the end of it"
(the #495 lesson: a window that cuts a history must say so). A backend that cannot read its own transcript
answers `{ available: false, reason }` rather than an empty list.

**`listHandoffs` row:** `id`, `title`, `modified`, `createdAt` (null when the packet's header does not say),
`backend` (null when the header does not say), `bytes`. **`readHandoff` result:** `{ id, title, offset,
returned, total, more, text }`.

## Bounds

Every output is bounded at three levels, and the core applies all of them (D9):

1. **Per item:** a turn's user and assistant text are each cut to `maxCharsPerTurn`, keeping the head and the
   tail with a marker that names how many characters were left out. The tail is kept because an assistant turn
   ends with its conclusion. (Open point O5 holds the exact split.)
2. **Per call:** `turns`, `limit` and `maxChars` are clamped to the maxima above whatever the caller sends.
3. **Per response:** a ceiling of 24 000 characters for the whole JSON text. When a response would exceed it, the
   oldest turns are dropped first and `omitted` says how many.

Reading a transcript is bounded at the source too. A file-backed backend reads a window from the end of the
file through the existing capped tail reader (`readFileTailAsync` in `src/backends/file-store.js`, 256 KiB at
most) and never the whole file. The first line of the window may be cut and is dropped. A backend whose store is
not a file (the `export` kind) reads through its `readMessages`, which the hook bounds by message count.

## Project scope and isolation

- **The project is the registration's.** `projectPath` is set at spawn from the caller's session and does not
  change on a re-key. A registration without one answers every tool with an error sentence, as `openDiff` does.
- **Sessions** are looked up through the cache's project query, which already merges the spellings of one
  directory (#245). A requested session id is accepted only when its row's project is the same directory as the
  caller's, decided on real paths by `src/app/path-containment.js` (`samePath`), never by string compare
  (reflex 13). Whether a project's worktrees count as the same project is open point O4.
- **Handoffs** are listed through `src/app/handoffs.js`, which is the one answer to "where does this project
  keep its handoffs" (reflex 12). `readHandoff` takes the id, resolves it against the project root, refuses a
  network path before any stat (`refusePath`, #780), requires the result to be an allowed handoff path of this
  project (`isAllowedHandoffPath`) and to be in the freshly derived listing. Anything else is "no such handoff".
- **A token cannot reach another project.** Identity is the Bearer token (spec 34); the project comes from the
  entry the token names, never from an argument.

## The data seams (what Phase 1 reads)

Phase 1 reads only what the app already holds, and writes nothing:

| Question | Source |
|---|---|
| The project's sessions | the session cache (`src/index/session-cache.js` and the store behind it) through a project query; the user's names from the meta store |
| Is it running | the app's map of live sessions |
| Handoff packets | `src/app/handoffs.js` |
| A transcript | the descriptor of the row's backend, through the new hook below |

**One new descriptor hook, `readTurnDigest(row, { maxMessages, signal })`** → `{ messages: [{ role, text, at?,
tools? }], partial } | null`. `role` is `user` or `assistant`; `text` is the plain text of that message with tool
traffic removed; `tools` lists the names of the tool calls in it; `null` is "this backend cannot say", declared on
purpose and never a fake read. It is async-only, because it runs on the main process on behalf of a waiting
tool call, and uses the capped tail reader. Every backend answers it, declining included, and a capability row
(`turnDigest`) says the same; a template forwards the hook in `profileToDescriptor`
(`.claude/rules/backends.md`, "A TEMPLATE inherits by hand"). The sessions a runtime-driven backend writes are
rows of its owner (`transcriptsOf`), so the owner's hook answers for them.

The group's handlers and their argument checks live in a module of their own under `src/servers`, and the
reader behind them in a new module under `src/app` (Electron-free, db-free, taking `ctx`), so both are loadable
under `node --test`. The bridge keeps the group table and the dispatch, as spec 34 left it.

## The gate and the registration

`ownServerSource` today hard-codes `groups: ['diff']` and is enabled by `diffTool`. Phase 1 changes it to take a
list of groups, computed by the spawn path from the options: `diff` when `diffTool` is on, `discovery` when
`discoveryTools` is on, both when both are. No group means no registration, no row, no token, exactly as an off
`diffTool` is today. The descriptors of agy and Codex gain the `discoveryTools` toggle and nothing else; the
hooks that write the bundle or the `-c` overrides are unchanged, because the row they receive is the same row.
The spawn path hands the registration the reader object (D8).

A plain launch sends no default for the option, so the test that turns it on sets it explicitly (the agy G2
finding in spec 34).

## Known limits to state in the product text

- The agent has to choose the tool. Switchboard cannot make it.
- The CLI's own approval prompt for an MCP tool still runs. For agy this was heavy in spec 34's G2 (#791); a
  read-only tool is not known to be exempt.
- **A transcript read by one agent is untrusted input to it.** Text from another session can contain
  instructions; the tool descriptions say it is data. Nothing here sanitizes it.
- **Cross-vendor flow.** Reading a session sends its text to whichever vendor serves the calling agent. The
  toggle is off by default for that reason, and the Configure text names it.
- A transcript can contain secrets the user pasted. The project boundary (D2) and the opt-in are the only
  protection; no redaction is attempted.
- Transcripts are read from the end. A long session shows its recent turns, not its beginning; the list row's
  first prompt is the only look at the start (open point O8).
- Claude, Pi and Hermes sessions can be read but cannot call the tools yet (see "Who can call it").

## Open

Numbered; none is settled by this spec. The plan carries the same list.

1. **O1 Naming and count.** Four tools named above, or three (one `handoffs` tool with an optional `id`). Fewer
   tools cost less context; four read more clearly to a model. Recommendation: four.
2. **O2 Gate wiring.** One registration whose source carries a group list (D7), or two sources. Two sources
   cannot share a token, so this is really "extend, or break D5". Recommendation: extend.
3. **O3 Reach.** Ship Phase 1 with agy and Codex as the only callers (above), or make "Claude on the seam" a
   prerequisite. Recommendation: ship, and say it plainly. **Answered: accepted, shipped with that reach.**
4. **O4 Worktrees.** Does the caller's project include its worktrees (ownership by the worktree root, reflex 17)
   or only its own directory? A worktree has its own checkout and its own sessions; D2 says "project".
5. **O5 Summary form.** Head and tail per turn, or head only; whether an `includeTools` argument exists. The
   spec's default is head and tail with tools collapsed to counts.
6. **O6 State.** `running` / `stopped` only, or a busy flag too where the app can tell (it cannot for every
   backend; the field would be `null` for some).
7. **O7 Read-only hint.** Whether to set `readOnlyHint` in `tools/list` and whether agy and Codex then skip
   their prompt. Unmeasured; the real check in the plan measures it.
8. **O8 Reading further back.** A reverse reader or a paging cursor to go past the tail window. Phase 1 has
   neither.
9. **O9 What a row hides.** Archived sessions and subagent rows are left out; whether an argument can include
   them.
10. **O10 Confirmation in the Configure dialog.** Text only (recommended) or a one-time confirm for the
    cross-vendor flow.

## As built

Phase 1 is in: the four tools, the `discovery` group on the spec 34 registration, and the `discoveryTools`
toggle on agy and Codex (off by default). The pieces: the turn view in `src/session/turn-view.js` (grouping and
every cap, D9, D10), the reader behind the tools in `src/app/discovery-reader.js`, the handlers in
`src/servers/discovery-tools.js`, the group table and dispatch in `src/servers/mcp-bridge.js`, and one
`readTurnDigest` hook per backend (`turn-digest.js` beside each descriptor). Settings rows are in
[`settings-reference.md`](../settings-reference.md).

**Caps as shipped:** 25 sessions per list, 8 turns per read, 1200 characters per turn, a 24 000 character
ceiling per response, 16 000 characters per handoff slice, and a 32 MiB guard on agy's export. All of these are
provisional until more real use says otherwise (D13).

**Reach (O3, accepted).** Only agy and Codex can call the tools, because they are the backends on the injection
seam. Claude, Pi and Hermes sessions can be read but cannot call. The headline cross-model case needs Claude on
the seam, a later phase.

### What the real-Codex check (G2) showed, and what it did not

G2 ran self-driven on the demo against codex-cli 0.162.1. It was not a full human-driven model turn.

Verified literally:

- The real spawn path gates the registration by the toggle. A Codex session launched with `discoveryTools: true`
  registered on the loopback listener; a session with `discoveryTools` and `diffTool` both off registered
  nothing (a differential test).
- The user's Codex `config.toml` stayed byte-identical, and the demo's isolated Codex config holds no
  `mcp_servers` entry. The `-c` channel writes nothing.
- The stand-in end-to-end test from T8 (over the real listener, bridge, `ownServerSource` and
  `createDiscoveryReader`) showed that this registration exposes exactly the four tools, bounded (caps, with
  `partial` and `omitted` set), with project isolation (one project's token cannot read another project's session
  or handoff, and nothing leaks), and with no writes.

Not shown, accepted by inference: a real Codex model choosing and calling a discovery tool. This rests on the
diff slice's G2 (spec 34), which used the same `-c` MCP channel and showed a real Codex surface and call a
Switchboard tool. Nobody observed Codex calling `listSessions`.

### Open points after the build

- **O1 settled:** four tools, `listSessions`, `readSession`, `listHandoffs`, `readHandoff`.
- **O5 settled:** head and tail per turn, tools collapsed to counts.
- **O6 settled:** `state` is `running` or `stopped`; no busy flag.
- **O7 not measured:** `readOnlyHint` is not set in `tools/list`, and whether agy or Codex would then skip their
  approval prompt was not measured.
- **O8 deferred:** no reverse reader or paging cursor; a long session shows its recent turns only. A later phase.
- **O9 settled:** archived sessions and subagent rows are excluded; no argument includes them.
- **O3** accepted (above).
- **O4 accepted:** the scope is strictly the caller's own directory. Worktrees are not folded in.
- **O10 accepted:** the cross-vendor data flow is stated in the toggle's help text only, with no confirm dialog.
- **O2 (timeout) still open:** the per-tool-call timeout of the CLIs against the bridge's blocking cap is not
  measured. (D7's group-list wiring itself is built as decided.)
- **Known low, L1:** the reader is built at launch with the launch-time `callerSessionId`. A backend that adopts
  its own session id later (Codex and agy re-key, the same class as `cc6913c8` on the diff path) can make the
  `self` flag in `listSessions` mislabel the caller's own row. Cosmetic: project scope is enforced on
  `projectPath`, not on `callerSessionId`, so no data is exposed.
- **Known low, L2:** if `createDiscoveryReader` were ever absent, the `discovery` group would register but expose
  no tools. Harmless, and it is wired in `src/main.js`.
- **R2, prompt injection:** transcript text an agent reads is an injection surface. The mitigations are the
  opt-in and the tool descriptions, which say the text is data from another session and not an instruction.
  Nothing sanitizes it (see "Known limits").

## Later phases

Not designed here. Each is its own plan with its own go, and each starts from a proposal with alternatives.

1. **Headless and interactive spawn** with completion tracking (`switchboard_run_subagent` and
   `switchboard_spawn_session` in the issue), the execution modes, the permission-prompt deadlock policy.
2. **Resume** of an interrupted session through the backend's own resume.
3. **Workspace isolation** by git worktree, its pruning, and the shared-working-tree option.
4. **Parent and child lifecycle**: cascade shutdown, quit-guard and shutdown registration of children, a
   recursion limit.
5. **Promote and demote** between background and tab, the auto and manual promotion setting, the attention
   notification.
6. **Bidirectional messaging** between sessions, and cost aggregation over a session tree.

The issue's point 5 (the stdio bridge executable) is closed by spec 34 and is not a later phase.
