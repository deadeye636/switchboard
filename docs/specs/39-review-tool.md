# 39 — The review tool: one agent asks another backend for a read-only second opinion

Issue #507 (orchestration tools), **Phase 2, slice 2b**. Status: **built** (planned 2026-10-27, built 2026-10-29). "As built" paragraphs
mark where the build differs from the design; the last section says what is where and what the click test showed, and
which measurements were not run. "Verified" means read in the
code on that date, "Unverified" means it needs a measurement or a closer read, and the
plan says where.

Spec 34 is the shared core (the app-wide HTTP listener, one registration and one Bearer token per session, the injection
quartet). Spec 35 added the read-only `discovery` group, spec 37 made it reachable from Claude and claude-native and
recorded the owner's proposal for this slice under its "Later phases". Read those first; this spec adds a **third tool
group**, `review`, and the first tool that **starts a session**. It adds no transport, no token and no injection.

## What changes for the user

A Claude or claude-native session can be offered two tools, `startReview` and `reviewResult`. The agent calls
`startReview` with a target backend (for example `pi-native`) and a prompt ("review the change in the file I just
edited for races"). Switchboard starts a real session of that backend in the same project folder, on a pipe, with no tab, sends the
prompt as one turn, and answers the caller at once with an id. The caller polls `reviewResult(id)`; while the review runs
it answers "running", when the turn ends it answers the text.

The user sees:

- **A toggle**, `reviewTools`, on the Configure dialog and the backend defaults of the backends that may call
  (O3). **Off by default**, like `discoveryTools`. The text names the cost and the data flow (see "Cost and privacy").
- **A sidebar row** for the review session, nested under the caller's row, marked as a review. It is an ordinary
  session row: it can be opened, read, stopped, archived. There is no tab and no pop-up.
- **No prompts.** The review session is read-only and every approval it asks is refused by the app (see "Read-only"),
  so nothing waits for the user and nothing is added to the attention inbox.

It is an **offer, as in specs 34, 35 and 37**: the caller's model has to choose the tool, and the caller's own permission
rules for an MCP tool still apply. Unlike the discovery tools it **spends tokens on a second vendor's account and runs a
second agent against the user's files**, which is why it has its own toggle and not a ride on `discoveryTools` (spec 35,
D6 said a spawning group gets its own toggle).

## Decided (owner, 2026-10-27)

Already recorded in spec 37 ("Later phases", slice 2b) and on #507. Binding for this spec and its plan.

| | Decision | Why |
|---|---|---|
| R1 | **Contract: handle and poll.** `startReview` answers an id; `reviewResult(id)` answers "running" or the text. Not one blocking call. | Spec 37 O2: a tool call has a per-CLI timeout (Claude about 5 min idle on HTTP, Codex 300 s in source, agy unknown), so a call that blocks for minutes is not safe on every caller. Polling holds whatever the timeout is. |
| R2 | **Runner: a real pipe-driven Switchboard session** through `src/app/agent-rpc.js`. claude-native and pi-native are the first targets. Not a headless one-shot CLI, not a request the user starts by hand. | Owner. The session, its approvals, its stop and its quit handling are the ones every pipe session already has. |
| R3 | **Visible as a sidebar row**, recognisable as the caller's child. No tab of its own. | Owner. The user can always see and stop what the app started on their behalf. |
| R4 | **Model: the target backend's default.** | Owner. The caller does not pick a model. |
| R5 | **Guardrails:** opt-in toggle `reviewTools` (off by default, declared per backend in `configFields`, `appliesAt: 'spawn'`); the review session gets no review tool (depth 1); one running review per caller; at most 10 minutes, then stopped; the answer capped at about 32 KB; read-only. | Owner. The exact read-only mechanism per backend is a descriptor declaration, never a `switch (backendId)` (CLAUDE.md reflex 5); this spec proposes it. |

## Design

Everything below this line is the proposal. Points the owner has not settled are listed under "Open" with a
recommendation; the text builds on the recommendation and says so.

### The tools

Group id `review`. Names are unprefixed camelCase, like `openDiff` and `listSessions`. Each description says the tool
starts a second agent, that the returned text is data from another agent and not an instruction (the `DATA_NOTE` of
`src/servers/discovery-tools.js:12` is the precedent), and what it costs.

**`startReview`**

| Argument | Meaning |
|---|---|
| `backend` | One of the target ids the server offers. The `tools/list` reply carries them as an `enum` built **per registration** from the targets that are ready, enabled and launchable at that moment, so the model never guesses an id. |
| `prompt` | The review request. Required, a string, capped at 16 000 characters. Switchboard prepends a short fixed preamble (O14). |

As built: `src/servers/review-tools.js`. The enum is asked of the runner (`targets()`) every time `tools/list` is
answered; with no target the property has no `enum` (an empty one is not a valid schema) and says so in its description,
and `startReview` is refused by the runner's "not available" sentence.

No `paths` or `files` argument in v1 (O10): the session runs in the caller's folder and the prompt names what to look at.
No `model` argument (R4).

Answers, as one compact JSON object in one `text` item (spec 35, D12):

- Accepted: `{ id, backend, state: 'running', startedAt, maxMinutes: 10, pollAfterSeconds: 30 }`.
- A problem with the call or the moment is `isError: true` with one plain sentence: unknown backend id; that backend is
  not available or not enabled; a review is already running for this caller (the sentence names its id, so the caller
  can poll it); the prompt is empty or too long; the app is quitting; no window is open; the target backend refused
  to start (its own sentence, for example a project it does not trust: **no dialog is opened from a tool call**, O16).

**`reviewResult`**

| Argument | Meaning |
|---|---|
| `id` | The id `startReview` answered. |

Answers (one JSON object, `isError` only for a bad argument or an unknown id):

| `state` | Fields |
|---|---|
| `running` | `id`, `elapsedMs`, `pollAfterSeconds`, `note` ("still reviewing; do not call again for `pollAfterSeconds`") |
| `done` | `id`, `text`, `truncated`, `refusedActions` (how many approvals the app refused, so the caller knows the reviewer wanted to do more than it was allowed), `sessionId` (the review session's current id, so `readSession` can read it when discovery is on), `elapsedMs` |
| `failed` | `id`, `reason` (a fixed sentence: the session could not start, the process ended before it answered, the turn ended without a reply), `sessionId` when one exists |
| `timeout` | `id`, `reason`, and whatever text had already been written, `truncated`; `sessionId` |
| `stopped` | `id`, `reason` ("the review session was stopped", "the calling session ended", "the app is quitting"), `sessionId` |

How long a result is kept (O6): **in memory, per registration, the last 8 results, dropped when the registration is
released (the caller's session ends) or after one hour**, whichever is first. The review session's own transcript is the
durable copy. An id that is gone answers one fixed sentence, the same one for an id that never existed (no existence
oracle, as in spec 35 D11).

The answer text is the **last assistant text of the turn**, capped at 32 768 code points (O21), so an emoji or a
surrogate pair is never split, with a marker naming how many characters were left out and `truncated: true`. Head and
tail are kept as in spec 35's cap (two thirds head, one third tail; the conclusion of a review is at the end). The cutter
is `cutText` in `src/session/turn-view.js`, exported for the runner since T5; the marker sits outside the cap. In UTF-8
the answer is at most four times the cap for exotic text and close to 32 KB for ordinary text.

### The runner: how the core does it

A new module under `src/app/` (the review runner), Electron-free and db-free like `src/app/discovery-reader.js`
(`.claude/rules/main-process.md` lists the pattern): a factory over plain dependencies, one runner per registration, handed
to the bridge as `entry.review` exactly as `entry.discovery` is. Module-level state is only a small registry of running
reviews for the app-wide cap (O8). It names no backend. Rows below were verified on 2026-10-27.

**1. Start a session with no window and no tab.**
`openTerminal(sessionId, projectPath, isNew, sessionOptions)` is exported (`src/app/terminal/spawn.js`) and is a plain
async function, not tied to a renderer call. The renderer is only the usual caller (`src/renderer/app.js:1565`), and it
also injects a pending sidebar row before the call, which the runner cannot do (see "The sidebar row"). It does need the
main window to exist: `spawn.js:295` answers `{ ok: false, error: 'no window' }` without one, which the runner turns
into the "no window is open" sentence. The runner mints the session id (a UUID, as the renderer does), calls `openTerminal`
with `isNew = true`, the caller's `projectPath` and `sessionOptions = { backendId, ...profile.options, reviewTools: false,
spawnedBy: <caller> }`, and gets back the PTY-shaped process of `src/app/agent-rpc.js`. The spawn path then does what it
does for any pipe session: the trust gate (`trustBeforeStart`), the runtime extension, the `ctx.startAgentProcess` call
(`spawn.js:1350`), `activeSessions.set` (`spawn.js:1450`), the timeline record, the exit handler that releases everything
(`spawn.js:1842` and neighbours). Nothing is duplicated.

`sessionOptions` last wins over the stored defaults (`spawnOptionsFor`, `spawn.js:279-291`: global, then project, then the
session's), so a user's stored `permissionMode` or `approvalGate` cannot undo the read-only profile where that merge is
read (pi-native's gate is applied through the runtime extension, which gets it). `buildLaunch` does not read the merge at
all: it gets `sessionOptions` as sent, so claude-native's `permissionMode` reaches the argv from the profile alone, and no
stored option the launch reads (a `model`, `promptSuggestionsOff`) reaches a review (Verified in T1, item 4, corrected).

**2. Send one turn.** After the observer below is attached, `agentRpc.sendTurn(sessionId, { text })`
(`src/app/agent-rpc.js`) writes the prompt as a turn. The runner sends it with the id the session holds at that moment
and keeps the **session object** afterwards, not the id: pi-native adopts the runtime's own id after the start
(`adoptIdentity`, `agent-rpc.js:378`), so the id may change. `_terminalTag` is stable across re-keys (`agent-rpc.js:108`).

**3. Detect the end of the turn.** `agent-rpc.js` already tracks busy and idle in `handleOp` (`case 'busy'`, lines
713-738) and reports them through `ctx.deliverBindSignal` (`report`, line 601). The core has **no subscription seam** for
another module. This spec adds one, small and backend-blind: `agentRpc.observe(sessionId, observer)` stores
`state.observer` on the session's state (the state lives on the pty object, `stateFor`, `agent-rpc.js:152`, so it survives a
re-key), and `handleOp` calls it at three places:

- `busy`: `observer.onBusy(busy)`. The runner ignores an idle edge until it has seen a busy edge (the write of a turn is
  followed by `agent_start`/`system/init` some time later; an early idle would end the review before it began).
  As built (T5 verifier F2): the idle edge carries the turn's outcome, `observer.onBusy(false, outcome)`. The decoder puts an
  optional `outcome` on its `busy: false` op: `'stopped'` when a Stop ended the turn, `'failed'` when it ended in an error,
  absent when it ended on its own. claude-native reads a Stop from the `interrupt` it saw go out (`noteSent`); the
  "keep planning" answer the runner gives a plan ask also interrupts, and that is no Stop. Any other result that is not
  `success` is `failed`, a turn limit (`error_max_turns`) included, so a review cut off that way returns no text. pi-native reads the run's last
  assistant `stopReason` (`aborted`, `error`). A turn the user stopped ends the review as `stopped` ("the review session
  was stopped") and its text is not returned, so narration written before the Stop never reads as `done`.
- `append`: `observer.onEntry(entry, text)`, `text` being the backend's `assistantTextOf(entry)`, so the runner can keep
  the last assistant text.
- `ask`: `observer.onAsk(request)` **before** `autoAnswer` (`agent-rpc.js:772-773`), see "Read-only".

and `observer.onExit()` from the child's exit path. The observer is optional and one per state; a session without one behaves
byte-for-byte as before (a differential test pins that).

**4. Read the final assistant text.** The entries `handleOp` forwards (`append`) are the app's neutral entries, but the
core must not read a backend's grammar (spec 35 D9, reflex 5). claude-native does **not** declare `lastReplyCommand`
(verified: no match in `src/backends/claude-native/`), pi-native does (`src/backends/pi-native/index.js:151`), so that hook
cannot be the one road. The proposal is one optional `rpc` hook, **`assistantTextOf(entry)`** → string or `null`, declared by
claude-native and pi-native in their own folders; `agent-rpc.js` hands its answer to the observer with each finished
entry, and the runner keeps the last one (`rec.lastText`). A backend that declares no `assistantTextOf` is not a review target (see "Targets").

**5. Stop the session.** When the turn has ended and the text is read, or on a timeout, the runner stops the session the
way the `stop-session` handler does (`src/main.js`, now `src/app/terminal/stop-session.js`): set `session.exited`, record the timeline line, `session.pty.kill()`.
The proposal moves those four lines into a function in `src/app/terminal/` that the handler and the runner share (the
handler stays in `main.js` as a grandfathered handler; reflex 4 forbids a *new* one, and this adds none). A killed process
keeps the session's transcript, so the row stays and can be resumed by the user like any stopped session. The
runner's launch carries the marker (`sessionOptions.spawnedBy`) and the link is stored (`session_meta.spawnedBy`); after
T8 a resume did not read the link back, so a resumed review row could be offered the review tools itself.
**Decided (owner, 2026-10-29): a resume reads it back.** `openTerminal` reads `session_meta.spawnedBy` for a resume that is not a fork
(`ctx.getSpawnedBy`), so a resumed review row gets no group of the app's own server, whatever the user's stored toggles
say, and keeps its link (`_spawnedBy`). It is **not** silenced: `_review` (no attention, see below) is set only for the
runner's own launch. A resume is the user opening the row, in whichever view `openerFor` picks, and a terminal view has
attention paths of its own (the attention hook, the OSC edges) that the pipe gate does not reach, so a silent resume would
have been a promise only half kept. A resume the backend cannot honour ("started a new one instead") runs under the same
row id and reads the same link. A fork of a review row is a new session and reads nothing. `test/spawn-review.test.js`
pins the three cases.

**6. Keep it as a sidebar row linked to the caller.** See the next section.

**The 10-minute cap** runs from the moment `startReview` is accepted, so session start-up (Pi may take up to
`STARTUP_TIMEOUT_MS`, 120 s, `agent-rpc.js:80`) is inside it. At the cap the runner calls `agentRpc.abortTurn`
(`abortTurn` in `agent-rpc.js`), reads what text exists, marks the review `timeout`, and stops the session. The timer is `unref`'d and
cleared on every terminal state.

**Depth 1** is enforced three times: (a) the review session is launched with `reviewTools: false` **and** a
structural `spawnedBy` marker in `sessionOptions`; `spawn.js` never adds the `review` group when the marker is present, so a
stored `reviewTools: true` in the user's backend defaults opens nothing (the same shape as spec 37 O9); (b) the review session
gets **no** own-server registration at all, not even `discovery` (O12), so there is no tool surface to recurse through;
(c) `startReview` refuses when the runner's own caller is a review session (`callerIsReview`), as defence in depth.
As built: (a) and (b) are one check in the spawn block's group list (`src/app/terminal/spawn.js`, the MCP injection), so no
runner is ever built for a review session and (c) is never reached from the app; `test/spawn-review.test.js` pins it. The
session object carries `_review` and `_spawnedBy`. Releasing the caller's registration releases its runner (O7), in
`ownServerSource`'s release, also when the registration itself never came about.

**One review per caller.** The runner instance is per registration, which is per session (`registerSession`,
`src/servers/mcp-http.js:322`). A second `startReview` while one runs is refused with the running id. Beyond that a small
app-wide cap (O8) keeps three callers from starting a dozen agents.

**Caller identity.** The bridge entry holds the caller's id (`entry.sessionId`, `mcp-bridge.js:655-670`, re-keyed by
`rekeyMcpServer`), and the project (`entry.projectPath`). The token names the entry (spec 34), so the caller cannot ask for
another caller's review: `reviewResult` looks the id up in **this runner's** map only. The runner is built in
`spawn.js` with `{ projectPath, callerTag: terminalTag }` (the runner needs no caller backend); the live caller id is resolved
lazily from `activeSessions` by `_terminalTag`, as `agent-rpc.js` does in `findSession` (line 111), because a Claude
`/clear` re-keys the id (spec 37 O6).

#### Verified in T1 (2026-10-27, read in the code; no run)

1. **The `append` entry.** claude-native: one `append` per CLI `assistant` line, `{ type: 'assistant', uuid, timestamp,
   message }` with `message.content` an array of blocks (`src/backends/claude-native/rpc-protocol.js:308-315`, `:603`).
   One turn produces several such entries, and one that carries only `tool_use` blocks has no text, so the runner keeps the
   **last non-empty** text, not the last entry. pi-native: one `append` per finished `message_end`, `{ type: 'message',
   message: { role, content } }` with text blocks `{ type: 'text', text }`; a tool result is also drawn under role `user`, so
   `assistantTextOf` must test `message.role === 'assistant'` (`src/backends/pi/transcript-view.js:106-119`, `:158-167`,
   `src/backends/pi-native/rpc-protocol.js:156-160`). A streamed turn is a `partial` op first, never an `append`, so the
   observer's `onEntry` sees finished entries only. One `assistantTextOf` per backend is enough. Still unverified, needs a
   live run (M3): whether a claude-native subagent line reaches `append` as an `assistant` entry of its own.
2. **A main-started row.** `src/app/live-sessions.js:60-88` lists every non-exited session in `activeSessions` and the
   renderer invents a pending row from it (`syntheticSessionRow`, `src/renderer/app.js:1198-1208`), but only inside
   `loadProjects` (`app.js:1365-1411`). `spawn.js` sends no `projects-changed` (no match), so the row appears at the next
   push, which for a Pi review is the first assistant reply. The snapshot carries neither `spawnedBy` nor a kind, so the
   synthetic row could not be nested. Timing of the real push: still unverified, needs a live run (M5).
3. **Attention.** The raising happens in the renderer, from two sends to the main window made in the `deliver` closure of
   `deliverBindSignal` (`src/app/hooks.js:341-371`): `cli-busy-state` (`:346`) and, for `needs-attention`, `attention-signal`
   (`:348`); the timeline send is `:359`. `agent-rpc.js` reaches it only through `ctx.deliverBindSignal`
   (`src/app/agent-rpc.js:603-617`). A refused ask never calls `report('waiting')`, so only busy and idle remain. The gate
   belongs in that closure, keyed on the session found by id or `realSessionId` in `ctx.activeSessions`
   (the lookup `hooks.js:201` uses). Whether the renderer chimes on a bare `cli-busy-state` idle edge: moot, the gate sends
   no edge to the window at all; the click raised no attention (see "As built").
4. **Main-side options cascade.** There is one, as a backstop: `spawnOptionsFor` (`src/app/terminal/spawn.js:279-291`)
   merges global, project and session options. It does not read a template's own options. **Corrected after T5 (verifier
   F3):** `openTerminal` calls it for every spawn-applied hook (the session resources, the MCP injection, the prompt
   templates, the prune, the runtime extension) and for the `appliedOptions` it hands `agent-rpc.js`, but **not** for the
   launch: `buildLaunch` gets the session options as they were sent
   (`launchOptions`, `spawn.js:901` and `:928`; the renderer resolves the cascade before it opens a session). So a stored
   `model` never reaches a review's argv, and neither does any other stored option `buildLaunch` reads (claude-native's
   `promptSuggestionsOff`, for one). The empty `model` the runner sends is kept anyway: it keeps the backstop's merged
   copy, which `appliedOptions` and the extension see, in line with the argv. `test/review-runner.test.js` runs each
   target's real `buildLaunch` on the runner's options: no `--model` for either, `--permission-mode plan` for
   claude-native. Whether the CLI then runs its own default model is the first real launch (M1/M4).
5. **A cutter.** `cutText(text, cap)` exists in `src/session/turn-view.js:31-38` (head two thirds, tail one third, marker
   "[... N characters omitted ...]" outside the cap) but was **not exported** when T1 read it. It counts **code points**,
   not UTF-8 bytes. **Since T5** it is exported for the runner, and O21 took code points as the cap's unit.
6. **Re-key sites.** Two copies, not one. `applyRekey` (`src/session/session-transitions.js:380-412`) moves the map key,
   the MCP server (`:385`), the backend overlay (`:387`), `copyOpener` (`:389`), the detach registration (`:392`) and the
   timeline (`:398`). Identity adoption has its own inline copy (`src/watch/adopt.js:198-223`: `copyOpener` `:205`,
   timeline `:215`). `copyOpener` is wired into both through `src/main.js:182`, `:2185` and `:2258`. Any new per-session
   row follows both, or a Pi/Codex/agy re-key drops it.
7. **Quit-guard.** `runningSessions` (`src/app/quit-guard.js:14-20`) counts every non-exited entry of `activeSessions`, so a
   running review is counted as a session and not named; a stopped review has `exited` set and is not counted.
8. **No view.** `openTerminal` needs only the main window (`spawn.js:295`). `sendOp` skips a destroyed window
   (`src/app/agent-rpc.js:161-167`) and the renderer drops an `agent-event` for a session with no mounted entry
   (`src/renderer/session/conversation-view.js:2651-2652`; it still sets the activity clock for the id, harmless).
   Console cleanliness under a real review: clean in the click test (see "As built").

### Targets and the read-only profile

Which backends can be reviewed, and how each is made read-only, is a **descriptor declaration**. One optional hook,
**`reviewProfile()`**, answers `{ options: { <key>: value } } | null`:

- `null` is "this backend cannot be a review target" (declared on purpose, never a fake). A backend that returns
  non-null must also declare `rpc.assistantTextOf` and a `transport`; the review runner's target list checks all
  three and offers only backends that pass **and** are ready, enabled, launchable and not templates.
- `options` are launch options merged over the stored defaults for the review session only, and are the whole of the
  backend-specific knowledge.

| Backend | Proposed `reviewProfile().options` | What stops a write | Verified | Unverified |
|---|---|---|---|---|
| `claude-native` | `{ permissionMode: 'plan', promptSuggestionsOff: true }` (`--permission-mode plan`, no `--prompt-suggestions`) | Claude's plan mode; no suggested next prompt, since a review is one turn (owner, after T5's F3). Anything it still asks about arrives as an `approval` ask and is refused. | `plan` is in `PERMISSION_MODES` (`claude-native/index.js:36`); approvals come over `--permission-prompt-tool stdio` (line 129); refusing is `answerCommand(.., { cancelled: true })` (`rpc-protocol.js:1279-1340`) | Whether a user's own `permissions.allow` rule (for example `Bash(*)`) lets a write through plan mode **without an ask**; whether the model ends in `ExitPlanMode` with its review as the plan (O11). Measurements M2, M3; M3 answered (assistant text), the allow rule not tried (see "As built"). |
| `pi-native` | `{ approvalGate: true }` | The approval gate: `bash`, `powershell`, `edit`, `write` and `subagent` are gated by name (`runtime-extension.js:68`), MCP tools and taken-over commands too (`index.js:48-52`). The session starts in mode `ask` (`launchMode`, line 180). Every ask is refused. | The gate exists and is on by default; its answers are the app's (`approvals.js:101`) | That the gate covers every tool a review could use to write. Spec 30 says plainly the gate is "a convenience, not a security boundary". Measurement M4. |

**Honest wording.** "Read-only" here means *the agent is asked to, and the CLI's own mode or gate refuses the actions it
can see*. It is not a sandbox. The toggle text and the tool description say so (see "Cost and privacy"), as spec 30 does.

**Both backends need a trusted project.** pi-native declares `trustBeforeStart` (`pi-native/index.js:113`) and the spawn path
refuses an untrusted project; claude-native asks the trust question itself (spec 32). A tool call must not open a dialog, so
`startReview` answers the refusal sentence (O16).

### Read-only enforcement and the prompt deadlock

A pipe session that asks for an approval waits for a card nobody sees: the review has no tab, and the ask would also raise
`report('waiting')` into the attention inbox (`agent-rpc.js:778`). That is the deadlock, and the policy is:

> **Every `ask` of a review session is answered by the app, at once, with a refusal, before any card is drawn and
> before `autoAnswer` runs.** The review continues; the agent sees a refusal and goes on reading. The count of refusals is
> reported as `refusedActions`.

Mechanics: `observer.onAsk(request)` returns `{ cancelled: true }`; `agent-rpc.js` writes
`rpc.answerCommand(request.id, answer, request)` exactly as `autoAnswer` does (lines 679-681) and returns without
`sendOp`/`report`. It applies to every ask kind: approvals, `questions` (claude-native answers an unanswered question with
a deny, `rpc-protocol.js:1289-1291`), and `plan`. Policy before `autoAnswer` on purpose: an allow remembered for the
project (`approval-memory.js`) must not unlock a write in a review. A review session also writes **nothing** to
`approval-memory`: refusals have no `approvalRecord`.

For a `plan` ask (claude-native in plan mode finishing with `ExitPlanMode`, `rpc-protocol.js:818-819`) the answer is the
backend's "keep planning" deny with `interrupt: true` (`rpc-protocol.js:1314-1318`), which ends the turn. The ask carries the
plan markdown. If the model finished its review *inside* that plan (O11), the runner takes `request.plan` as the result text
when no plain assistant text follows. The preamble tells the agent to answer in its reply and not to call `ExitPlanMode`.

An ask arriving **after** the runner marked the review finished is moot: the session is being stopped.

### The sidebar row

What exists today, verified:

- `session_cache.parentSessionId` is **Claude's subagent link** (`src/db/migrations.js:112-121`); a row with it is a
  subagent transcript, hidden from the top level (`src/index/projects-view.js:356`) and drawn nested by
  `src/renderer/shell/sidebar-subagents.js`. A review is not a subagent, and reusing the field would hide the row or
  claim a transcript relation that does not exist.
- `session_cache.lineageParentId` + `lineageKind` is **continuation** (`/clear`, fork): the face row walks *up* its chain
  and folds ancestors under it (`docs/specs/13-session-lineage.md`, "Sidebar rendering"). A review has the opposite shape
  (the caller is the long-lived head), so reusing it would fold the caller under the review.
- `session_meta` holds what the **user or the app decided** about a session (`name`, `starred`, `archived`, `opener`),
  apart from what the scanner derived (`.claude/rules/db.md`). `opener` has the closest precedent: written by the spawn path
  after a successful launch (`spawn.js` near 1815-1822, under the id the session holds then), copied on a re-key by
  `copyOpener` (`src/db/meta-store.js`, called from `src/session/session-transitions.js:389`), and read into the
  sidebar payload by `src/index/projects-view.js:317-321`.

Proposal (O1): add `session_meta.spawnedBy TEXT` (the caller's session id) and `session_meta.spawnKind TEXT` (`'review'`),
a new **append-only** migration (CLAUDE.md reflex 3), a setter written after a successful spawn, a copy on re-key for the
review row, and **a move on re-key for rows that name the re-keyed id as their parent** (a caller that `/clear`s keeps its
children). The projects payload carries `spawnedBy`/`spawnKind`; the renderer draws the row **nested under the caller's
row** with the existing caret affordance and a small "review" mark, and falls back to an ordinary top-level row when the caller
is not in the payload (archived, other project view, deleted), so a link that went stale never hides a session.

As built (the data half): the appended migration adds both columns,
`src/db/meta-store.js` has `setSpawnedBy`, `getSpawnedBy` and `rekeySpawnLinks`, and the runner writes the link through
`ctx.linkSession` under the id the review session holds when it is written. Both re-key paths (`applyRekey` in
`src/session/session-transitions.js` and the adoption in `src/watch/adopt.js`) call `rekeySpawnLinks` beside `copyOpener`:
the child's link is copied (never over one the new id has), and every row naming a re-keyed caller is moved. The same
two paths move `_spawnedBy` on the live children's session objects. `src/index/projects-view.js` stamps `spawnedBy` /
`spawnKind` from the `getAllMeta()` it already reads, and `src/app/live-sessions.js` carries them from the session object
for a row that has no transcript yet. `test/session-spawned-by.test.js` runs the store against `node:sqlite` with the real
schema and migrations.

As built (the row): `nestReviews` in `src/renderer/shell/sidebar-state.js` decides which rows nest, in
`processProjectSessions`, before the sort and the split; `appendReviewChildren` in `src/renderer/shell/sidebar-subagents.js`
draws a caret ("N reviews", the existing `.sidebar-children-caret`) and the review rows, which are ordinary session rows with
a "Review" pill. A review nests only when it and its caller are single rows in the list; a caller filtered away, folded
into a slug group or not in the payload leaves an ordinary top-level row. Not while searching. The fold defaults open,
its closed state is a localStorage set read on every build, and a closed fold hides only rows with nothing running; a
running review also makes its caller's item running, so the caller is never folded behind "N older" (#598). The push
(O2) is the existing `projects-changed`, sent by the runner once its session started; the renderer's `loadProjects` reads
`getLiveSessions` and `syntheticSessionRow` copies `spawnedBy` / `spawnKind`. No new preload binding.
The caller's item carries its reviews' ids, so a caller folded behind "N older" whose review is open still has its rows
built (session navigation and the grid read the sidebar's rows). A review row takes its own subagent tree. Like the
subagent tree, nested reviews are not counted in "N older" and "Archive all older" does not reach them. A caller in a
slug group never takes children, so its reviews stay top-level rows. A closed review fold keeps a row shown that is
`.review-running` (stamped at build: a live pty or a pending launch) or `.has-running-pty` (kept by the status patch
between renders); a running review's own subagent tree is hidden while the fold is closed (accepted).
`test/sidebar-review-nesting.test.js` pins it; the click on the demo instance confirmed nesting, the fold across a render
and a running review shown while folded.

**A row the renderer did not start.** The renderer normally injects a pending row before `openTerminal` returns
(`src/renderer/app.js:1535-1562`); a session started from main has no such row until the scan finds its transcript.
claude-native writes on the first turn (fast); pi-native writes a Pi session file only once there is an assistant reply
(`pi-native/index.js:120-122`), so a Pi review that dies early would leave no row at all. Proposal (O2): main sends the
main window one push (`review-session-started`, a `webContents.send` with a preload `on…` binding, **not** an IPC handler)
carrying `{ sessionId, projectPath, backendId, spawnedBy }`, and the renderer injects the same pending row it injects
for its own launches. Verified in T1 (item 2): `src/app/live-sessions.js` makes a live main-started session known to the
renderer, but only when the renderer reloads its projects, and nothing triggers that at spawn; the snapshot carries no
parent link. So the push stays (O2), and it can be the existing `projects-changed` plus a snapshot that carries
`spawnedBy`/`spawnKind`, with no new preload binding. How late the scan alone is: needs a live run (M5).

**No attention.** A review session goes busy then idle on its own. Left alone, its idle edge reaches the attention path
(`deliverBindSignal`) as "an agent finished" for a session the user did not start. The session carries a `_review` flag set
at spawn and the attention path (notifications, inbox, chime, badge) drops its signal; the timeline still records it.
Verified in T1 (item 3): the choke point is the `deliver` closure inside `deliverBindSignal` (`src/app/hooks.js:341-371`),
which makes the two sends the renderer raises attention from; the timeline send stays.

As built: `deliverBindSignal` skips its window sends (`cli-busy-state`, `attention-signal`, the subagent edges too) for a
live session whose entry, found by id or by `realSessionId`, carries `_review`, and still hands every edge to the
timeline. Keyed on the session's flag, never on a backend. `_review` is set only on the runner's launch, which is always
a pipe session (both targets are runtime-driven), and a pipe session's busy, idle and waiting reach the window through
this one delivery; the attention hook already drops attention for a session with a `transport`. The gate does not cover
the terminal paths (the attention hook for a terminal session, the OSC edges in `spawn.js`), which no `_review` session
takes. A review session the user opens and types into while it runs stays silent; the flag belongs to the session. The
row shows no busy indicator (accepted). `test/review-attention.test.js` pins it. Whether the renderer raises anything
from another path is the click (M5).

### Cost and privacy

The review is a **second model call on the target vendor's account**, started on the user's behalf, in the user's folder.
What leaves the machine: the caller's prompt (written by the caller's model, which has read the user's conversation), and
every file in the folder the reviewing agent chooses to read, to the **target backend's vendor**. This is the same shape as
spec 35's cross-vendor flow, one step stronger: there the *caller* read another vendor's transcript; here another vendor's
agent reads the user's *files*. Same-vendor targets (claude-native calling claude-native) send nothing new beyond a second
session's cost (O4).

The toggle text (the Configure dialog, `configFields` description; the settings-reference row repeats it):

> Offers two tools that let this agent ask another backend's agent for a review: `startReview` and `reviewResult`. When the
> agent uses them, Switchboard starts a session of that backend in this folder, as a row in the sidebar under this one, sends it
> the agent's prompt, and gives the answer back. The prompt and any file of this project that the other agent reads go to
> that backend's vendor, and the run uses that backend's account and quota. The other agent runs read-only (Claude's plan mode,
> Pi's approval gate; Switchboard refuses every action it asks about), one review at a time, for at most 10 minutes. Read-only
> is enforced by those modes, not by a sandbox. It is an offer: the agent has to choose the tool, and its own permission rules still apply.

Off by default; no confirm dialog (spec 35 O10 precedent, O17).

### Quit, close and shutdown

- **App quit.** The review session is in `activeSessions` with a pid, so the existing teardown finds and stops it
  (`session-shutdown.js`, `.claude/rules/main-process.md` "Quitting WAITS"); the quit-guard's list of running sessions counts
  it. The runner adds nothing to the teardown. It marks its running reviews `stopped` ("the app is quitting") from
  `getAppQuitting()` / the observer's `onExit`, never touches the database after `closeDb()` (the #76 class: a flag checked
  synchronously before any continuation), and its timers are `unref`'d and cleared.
- **The user stops or closes the review session.** The observer's `onExit` fires; the review becomes `stopped` ("the review
  session was stopped") unless a result was already read. The row stays. A user who opens the row and types into it joins the
  conversation; the runner reads only the first turn and ignores the rest (note, not a guard).
- **The caller ends.** The caller's registration is released (`registerSession.release`, `mcp-http.js:337`; the release runs
  from the spawn exit handler, `spawn.js:1842`). Proposal (O7): the runner stops its running review and marks it `stopped`
  ("the calling session ended"). Nobody will read the answer, and it is the only place a child could outlive its parent. This
  is a narrow slice of the "cascade shutdown" that spec 35 lists as a later phase; the result and the row stay.
- **A caller `/clear` or fork** re-keys the caller; the registration and the runner survive (`rekeyMcpServer`), and the
  `spawnedBy` link is moved with the id.

## What this spec does not do

No headless one-shot runner, no resume of a review by the runner (a user may resume the row, see "The runner"), no second turn into a review (one turn, then stop), no model argument,
no `paths` argument, no streaming of partial text to the caller, no worktree isolation (the review shares the folder; a
read-only agent does not need one), no cost aggregation, no promote/demote to a tab, no backend other than claude-native
and pi-native as a target in this slice, no new IPC handler in `src/main.js` (reflex 4: the runner is an `src/app/` module
wired through `ctx`), no backend id outside its own folder (reflex 5: `reviewProfile` and `assistantTextOf` are descriptor
declarations, the target list comes from the registry), and no new stored setting beyond the per-backend `reviewTools` option
(reflex 9: its rows go into `docs/settings-reference.md` in the step that adds it; the caps are constants, not settings).

## Known limits to state in the product text

- The agent has to choose the tool, and the caller's own permission rules still apply (in claude-native each call arrives as an
  approval card; spec 37 M3).
- **Read-only is a request enforced by the CLI's mode or gate, not a sandbox.** A user's own allow rules in the target CLI
  may widen what it does without asking (Unverified, M2).
- The answer is another model's text: untrusted input to the caller (spec 35 R2). The tool descriptions say it is data;
  nothing sanitizes it.
- The reviewer reads the folder, so secrets in it can reach the target vendor.
- One review at a time per caller, at most 10 minutes, about 32 KB back. A very long review is cut.
- `pollAfterSeconds` is a hint: a model may poll anyway, and each poll is a tool call on the caller's account.

## Open

Numbered, stable. The plan carries the same list; an answered point says so.

**Answered (owner, 2026-10-27): every point below as recommended (O1 to O20).** O2 was built as the push (a
`projects-changed` once the review is linked), and M3 showed a claude-native review ending in assistant text, so O11's
plan branch is the fallback only; O15 takes the CLI's own default (no `model` sent).
O21 was added by T1 and is answered as recommended too (owner, 2026-10-27): the cap counts code points, through the
exported `cutText`.

1. **O1 The parent/child link.** New `session_meta.spawnedBy` + `spawnKind` (recommended), reuse `lineageParentId` with a
   new kind (renders the caller as the review's ancestor, wrong), reuse `parentSessionId` (hides the row, wrong), or a
   live-only map in main (lost on restart, so the nesting disappears for a finished review). Recommendation: the
   `session_meta` columns with a re-key copy and move; a stale link falls back to a top-level row.
2. **O2 How the row appears.** A one-way push to the main window that injects a pending row (recommended), or wait for the
   scan. Recommendation: the push, if the M5 measurement shows the scan alone is late or absent (pi-native writes its file only
   after a reply).
3. **O3 Which backends declare `reviewTools` (may call).** Recommendation: Claude and claude-native only (the issue's
   headline case, and the two that can already call discovery). Codex and agy can take the group later by declaring the
   toggle; each needs its own real-model check. Pi and Hermes cannot call (no injection).
4. **O4 May a caller review with its own backend?** Recommendation: yes. It is listed like any target; the wording
   already says the data goes to "that backend's vendor", which for the same vendor adds only the second session's cost.
5. **O5 What a refused action does to the review.** Recommendation: refuse and continue; report the count as `refusedActions`;
   the 10-minute cap bounds a reviewer that insists. The alternative (fail on the first ask) would turn a plan-mode quirk
   into a failed review.
6. **O6 How long a result is kept.** Recommendation: in memory, the last 8 per registration, until release or one hour; the
   transcript is the durable copy. Alternative: persist results in the database (new table, new privacy surface), not
   recommended.
7. **O7 Caller exit with a review running.** Recommendation: stop the review and keep the row. Alternative: let it finish
   (a child outliving its parent; the answer is never read).
8. **O8 An app-wide cap on running reviews.** Recommendation: 3, over all callers, with its own sentence. Without it three
   callers start three agents each on their own cap-of-one.
9. **O9 Long-poll (`waitSeconds` on `reviewResult`).** Recommendation: not in v1. A wait is a blocking call again, and agy's
   tool timeout is unknown (spec 37 O2). `pollAfterSeconds` is the hint instead.
10. **O10 A `paths` argument on `startReview`.** Recommendation: none. The prompt can name files; an argument the app must
    validate (containment, network paths) is more surface for no gain over prose.
11. **O11 `ExitPlanMode` as the final answer on claude-native.** If measurement M3 shows the model ends its review as a plan,
    take `request.plan` as the result when no assistant text follows (recommended), or tell the model not to and fail the review
    when it does anyway. Depends on M3.
12. **O12 Groups on the review session.** Recommendation: none, not even `discovery`. A reviewer that reads other sessions
    widens the data flow and the depth question for no stated need.
13. **O13 No window.** `openTerminal` refuses without a main window (`spawn.js:295`). Recommendation: answer a plain sentence;
    do not change `openTerminal` for a case the app cannot show anyway.
14. **O14 A fixed preamble.** Recommendation: Switchboard prepends a short fixed English preamble to the caller's prompt
    ("You are doing a read-only review for another agent. Do not edit files or run commands that change anything. Answer in your
    reply, not by planning or calling tools that write. Be concise: the answer is cut at about 32 KB."). It is visible in the row as
    the first turn. Alternative: send the prompt as written (a model that does not know it is read-only will try to write and be
    refused, wasting turns).
15. **O15 Model.** Decided as the target's default (R4). Open sub-point: "default" is the CLI's own default (recommended: the
    review sends no `model` option) or the user's configured default for that backend. T1 read the main-side backstop
    (`spawnOptionsFor`, `spawn.js:279-291`) as applying the stored `model` to the launch; T5's verifier (F3) found that
    `buildLaunch` never gets its merge, so the CLI's own default runs without help. The runner still sends an explicit
    empty `model` for the merged copy; see Verified in T1, item 4.
16. **O16 Untrusted project at the target.** pi-native refuses to start in a project it does not trust. Recommendation: `startReview`
    answers the refusal sentence ("trust this project for Pi in Switchboard first"); no dialog from a tool call.
17. **O17 A confirm dialog when the toggle is turned on.** Recommendation: text only, as spec 35 O10.
18. **O18 A review row after it finishes.** Recommendation: it stays as an ordinary session (nested under the caller, archivable
    by the user); no auto-archive, no auto-delete.
19. **O19 Attention suppression.** Recommendation: a `_review` flag on the session that the attention path honours; the
    timeline keeps the record. Without it the user gets "agent finished" for work they did not start.
20. **O20 The preamble and the toggle text are English**, and the tool's returned `note` and error sentences are fixed English
    (reflex 7). No open question; listed so a translation request has an ID.
21. **O21 What "about 32 KB" counts.** R5 says about 32 KB; the only cutter in the tree (`cutText`, `turn-view.js:31-38`)
    counts code points. Recommendation: export `cutText` and cap at 32 768 code points (never splits a character, one
    cutter instead of two; the UTF-8 size is at most four times that for exotic text, typically close to 32 KB). Alternative:
    a byte-bounded cutter in the runner, which spec text above literally says.

## Measurements (acceptance gates, after the build)

Run on the demo instance, **the smallest model of each backend that has one** (Haiku for Claude; the smallest Pi offers for
Pi), settings restored afterwards. They check the flow, not the answer quality. Model choice for the review itself is the
target's default (R4); a test run names the cheaper model in the target's launch for the test only and says so in the report.

| | What | Records |
|---|---|---|
| M1 | claude-native caller with `reviewTools` on: `tools/list` shows `startReview`/`reviewResult` with an `enum` of targets; a call arrives as an approval card. | The card as the user sees it; the schema as Claude defers it behind `ToolSearch` (spec 37 M3). |
| M2 | A claude-native review in plan mode, asked to "create a file": no file appears. Repeat with a user-level `permissions.allow` rule for the writing tool. | Whether plan mode refuses without an ask; whether an allow rule opens the hole. |
| M3 | A claude-native review that ends: assistant text, or `ExitPlanMode`? | Which ask/entry carries the final text (O11). |
| M4 | A pi-native review asked to run a shell command and to edit a file; every ask is refused, no card, no inbox entry. | Gate coverage; `refusedActions`; the idle edge. |
| M5 | The sidebar: the row appears at once, nested under the caller, marked as a review; the caller's re-key (`/clear`) keeps the nesting; stop from the sidebar gives `stopped`. | Whether the push of O2 is needed. |
| M6 | Quit with a review running: the process is gone, no database write after close, the caller's next launch shows the row as stopped. | The quit path. |
| M7 | A review that never finishes (a prompt that makes the agent loop): `timeout` at 10 minutes with partial text, session stopped. Run with the cap shortened by a test seam, not by waiting. | The cap. |

## As built

Built 2026-10-29 on `main`, in the commits after `1d5b4095` (this spec's plan) up to the one that adds this section. The sections above carry
an "As built" paragraph where the build differs from the design or adds to it; this one lists what is where and what the
click test showed.

**Where it is.**

- `src/app/agent-rpc.js`: `observe(sessionId, observer)`; the idle edge carries the turn's `outcome`.
- Both runtime-driven backends: `rpc.assistantTextOf`, the `outcome` on `busy: false`, and `reviewProfile()`
  (claude-native `permissionMode: 'plan'` and `promptSuggestionsOff: true`; pi-native `approvalGate: true`). Every other
  backend answers `null`. `src/backends/review-targets.js` decides what is offered.
- `src/app/review-runner.js`: the runner, one per registration. `src/app/terminal/stop-session.js`: the stop it shares
  with the user's Stop.
- `src/servers/review-tools.js`: the tool group; the bridge and the HTTP registration pass it through.
- `src/app/terminal/spawn.js`: the `reviewTools` gate (Claude and claude-native), depth 1 from `spawnedBy` or the stored
  link on a resume, `_review` and `_spawnedBy` on the session.
- `session_meta.spawnedBy` / `spawnKind` (one appended migration), kept across re-keys from both ends.
- `src/app/hooks.js`: no attention for a `_review` session.
- The sidebar: `nestReviews` (`src/renderer/shell/sidebar-state.js`) and `appendReviewChildren`
  (`src/renderer/shell/sidebar-subagents.js`).

**The open points.** O1 to O21 were answered as recommended (owner, 2026-10-27), with two later owner decisions: a resume
of a review row reads the stored link back (no own-server group, not silenced), and claude-native's profile turns prompt
suggestions off.

**The click test** (2026-10-29, demo instance, Haiku for every Claude turn, smallest Pi model in Pi's settings, all
restored afterwards):

- M1: passed. The toggle is in claude-native's Configure dialog, styled like its neighbours, off. With it on, the caller
  loaded `startReview` / `reviewResult` through `ToolSearch` and each call came as an approval card.
- Pi target: the first call was refused with the untrusted-project sentence (O16) before the project was trusted for Pi.
  After that the review session started and its model call failed on the demo's copied Pi login; the runner answered
  `failed` ("The review turn ended without a reply."), which is the failed-call path working. A successful Pi review
  (M4) was not run, because refreshing that login would have shared a refresh token with the user's real Pi home.
- claude-native target: launched with `--permission-mode plan`, no `--model`, no `--prompt-suggestions`. `reviewResult`
  answered `done` with the reply after about nine seconds, the session was stopped, and the caller reported the answer.
- M2 in part: a review asked to create a file and run a redirecting shell command wrote nothing and made no tool call;
  the model refused on its own, so `refusedActions` was 0 and the refusal path was not exercised live. A user-level
  allow rule was not tried.
- M5: the review row appeared under its caller with the Review pill and raised no attention; the caller was the only
  inbox entry.
- M3: the claude-native review ended in assistant text, not `ExitPlanMode`.
- Not run: terminal Claude's Configure dialog (only claude-native's was opened), a live `reviewResult` answering
  running and a live second `startReview` (the caller polled after the short reviews had ended), opening a review row
  while it ran, stop from the sidebar during a run, stopping the caller during a run (the review finished before the
  click), `/clear` of the caller with a live child, M6 (quit with a review running), and M7 (there is no seam to shorten
  the 10-minute cap). The unit and end-to-end tests cover the logic of each; the live behaviour is not measured.
- `drive-app.js console` was clean after every step (verbose lines only).
- Read in the screenshots and corrected afterwards (#800): the caller's conversation view seemed to stop drawing later
  turns. It was the demo window being covered by another window, which turns `document.hidden` on; the view then
  keeps arriving entries and draws them when the window is shown again (#723). Not a defect, and unrelated to the
  failed-auth turn before it. A screenshot of a covered window shows that deferred state.
