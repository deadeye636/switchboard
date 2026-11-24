# 49 — Codex driven through app-server, not through a terminal

Issue #734. Status: **planned**, nothing built. This file is the design record written before the build: the requirement, the
owner's decisions, what the existing code forces, the protocol mapping, and what is still open. The plan with its steps is
local (`docs/plans/734-codex-native/`); what lasts goes here, with an "As built" banner when the build diverges.

What was measured about the protocol is in `docs/backend-formats.md`, Codex section: "Driving a thread over app-server (#734)",
"The app-server daemon and a held thread (#759)", "Agents, approvals and compaction in the rollout (#826)" and "How long Codex'
cache holds (#734)". This spec builds on those and does not re-derive them. The two pipe-driven backends it follows are
spec 30 (Pi) and spec 32 (Claude); where the mechanism is theirs, this spec points there.

## What changes for the user

A `Codex (GUI)` backend beside the terminal Codex. It starts the `codex` the user installed as `codex app-server` (JSON-RPC
over JSONL on stdio), draws the conversation in the conversation view and sends turns, steers, stops and answers over the same
pipe. The terminal backend stays. Any Codex session opens in either view: the row stays Codex's (same store, same parser, same
resources and trust answers), and a marker in the rollout says where the thread was started, which decides the default view.
No login flow and no token: the installed CLI is signed in or it says so in its own words.

## Requirement (the issue body, condensed)

Keep the terminal backend; reuse the Codex store, parser, resources, trust and row ownership; new, resumed and forked threads;
streamed messages and tool activity; plans; image input; steering; stopping; held prompts; history; command and file-change
approvals; user questions where the protocol exposes them; initialisation and the thread/turn lifecycle as descriptor hooks with
no Codex id or grammar in the core or the renderer; a reliable transport marker with a fall back to the terminal backend; a
measured minimum version with regression coverage against the generated, version-specific schema; the measured limitations and
the deliberate differences from the TUI documented. From the #828 addendum: `idleMaintenance()` answered, warm turn and
compaction over app-server and never through a PTY.

## Decisions

Owner (2026-11-24, on #734):

| | Decision | Why |
|---|---|---|
| E1 | **Route A.** `agent-rpc.js` gains backend-declared bootstrap hooks and a per-spawn protocol instance; the Codex adapter performs `initialize`/`initialized`, `thread/start`, `thread/resume`, `thread/fork` and maps app-server requests and notifications onto the existing neutral operations. Codex grammar only in the codex-native folder. No separate driver. | One conversation implementation (queue, attach, approvals, busy state, shutdown) instead of a third transport contract. |
| E2 | **The marker is `threadSource: "switchboard"`**, persisted as `thread_source` in the rollout's `session_meta`. It records where a thread was *started*: a native thread continued in a terminal still reopens in the conversation view, and either view can open it. A fork sends `threadSource` again. | Measured: our own free-text value, in the first line the scanner already reads, kept by every resume path, not inherited by `thread/fork`. `source` is `vscode` for every app-server thread and `originator` names the creating client, so neither can be the marker. |
| E3 | **Fixed floor 0.144.0.** An older installed Codex falls back to the terminal backend with a clear message. A turn the server refuses (`model_not_found`, "requires a newer version of Codex") is shown as a readable message. | Measured: the schema alone passes from 0.140.0, but a turn completes only from 0.144.0, the first version that offers a model the server still serves; the floor is set server-side and will rise. |
| D1 | Deferred to the build, decided in step T14 and recorded here: `maxRefreshMs` for `idleMaintenance()` (25 minutes fits one sample per gap: hit at 30 minutes, miss at 60) and whether to repeat the cache measurement. | Owner, on the measurement comment. |

Planner (reversible; each is argued where it is used):

| | Choice | Why |
|---|---|---|
| P1 | History comes from app-server, not from the rollout: resume with `excludeTurns: true`, then page `thread/turns/list` and `thread/items/list`. One mapper turns a `ThreadItem` into a conversation entry, live and for history. | 0.171.0 marks full-history hydration deprecated. The rollout is a second grammar (`response_item`), and a second mapper is how a live session and its history start to differ. |
| P2 | One `codex app-server` child per session, started with no daemon flags, and the backend never relies on or leaves a daemon. | The TUI's resume path uses a detached daemon (#759) that survives a quit; the native child is a plain pipe child the quit path already stops (`.claude/rules/main-process.md`, "Quitting WAITS"). |
| P3 | The launch decision (resume, fork, session id, options) reaches the protocol instance through a neutral field of what `buildLaunch` answers, handed on by the spawn path. The core reads it as opaque. | `buildLaunch` has no place in its argv for a thread id: the protocol, not the command line, carries it. |
| P4 | The busy edge is `turn/started` and the idle edge is `turn/completed` (which carries the status and the error), not `thread/status/changed`. **Measured (T1, O3): holds** for plain, interrupted, steered, failed and compaction turns; `thread/status/changed` (`active`) comes just before `turn/started` and (`idle`) just before `turn/completed`. | A compaction's measured order puts `thread/status/changed` (idle) before `turn/completed`; the turn's outcome (`completed`, `interrupted`, `failed`) is only on the latter. |
| P5 | The core's held queue (#702) holds a follow-up; a steer is `turn/steer`. | The core already holds prompts sent while a turn runs; app-server has no follow-up request. **Measured (T1, O3): stands** — no `thread/queue/changed` was sent in any run, and a steer lands inside the running turn. |

## What the existing code forces (verified for this spec)

1. **The `rpc` half is a static object shared by every spawn, and its commands are stateless functions.** `start()` calls
   `rpc.createDecoder({ cwd })` once per session (`src/app/agent-rpc.js:280`) and every request builder is called with an id
   only (`request(rpc.abortCommand)`, `src/app/agent-rpc.js:1231`; `rpc.sendCommand({ id, text, mode, ... })`,
   `src/app/agent-rpc.js:1279`). Codex needs state between them: `turn/steer` must send `expectedTurnId` and `turn/interrupt`
   a `turnId`, both known only from the stream, and a thread id the server generates. Hence E1's
   per-spawn instance.
2. **Nothing can happen before the handshake, and the core starts talking at once.** `start()` ends with `followIdentity()` and
   `followContext()` (`src/app/agent-rpc.js:1534`), and `request()` writes immediately (`src/app/agent-rpc.js:420`). A
   runtime that must be initialised first needs a gate in front of `request()` and a failure path when the handshake fails.
   `start()` requires only `createDecoder` and `responseOf` of the half (`src/app/agent-rpc.js:249`).
3. **The session id is the runtime's.** Claude takes `--session-id`; Codex generates the thread id. The core already
   follows a runtime-named id through `adoptIdentity` (`src/app/agent-rpc.js:455`, an `identity` op or `stateCommand`), so a
   new session re-keys once at bootstrap, as pi-native does (spec 30, "State and identity").
4. **Responses and server requests share one stream.** `responseOf(msg)` decides what answers a request of the core
   (`src/app/agent-rpc.js:1158`). JSON-RPC server requests (approvals, questions) carry `id` and `method`; a response has no
   `method`. The half must not read a server request as the answer to a client request that happens to have the same id.
5. **A server request must always get an answer.** Codex waits on it. The decoder returns ops only, so an unsupported server
   request (account token refresh, attestation, dynamic tool call, legacy approvals) needs a way to write a JSON-RPC error
   back: the instance needs the core's `write`.
6. **The conversation's history is asked of the runtime through one request** (`messagesCommand`, `src/app/agent-rpc.js:1597`)
   or read from a file (`entriesFromTranscript`, `src/app/agent-rpc.js:1658`). Paging `thread/turns/list` and
   `thread/items/list` is several requests, so it needs a third form (see "The seam").
7. **Codex has no conversation normaliser.** `normalizeTranscriptEntries` exists for Claude and Pi
   (`src/backends/claude-native/index.js:364`, `src/backends/pi-native/index.js:271`); the Codex descriptor declares none (no
   hit in `src/backends/codex/`). The conversation view draws Claude-shaped entries (text, `tool_use`, `tool_result`;
   `src/backends/pi/transcript-view.js:1`), so the ThreadItem mapper is new work in the codex-native folder, not reuse.
8. **The parser does not yet record how a thread was driven.** `src/backends/codex/parser.js` reads `thread_source` only to drop
   a guardian review or a subagent rollout (`src/backends/codex/parser.js:193`); an unfamiliar value passes, which is what the
   marker relies on. No `transport` field is on the Codex row, and `PARSER_SCHEMA_VERSION` is 11
   (`src/backends/codex/parser.js:45`). `backends.openerFor` hands a row to a driver whose `transcriptsOf` is the owner and whose
   `transport` equals `row.transport` (`src/backends/index.js:426`).
9. **The executable.** The spawn path starts a pipe child without a shell and refuses what it cannot start directly
   (`src/app/terminal/spawn.js:1509`; `resolveArgvExecutable` answers `null` for an npm `.cmd` shim, `src/main.js:1476`).
   Codex installed through npm on Windows is exactly that shim (`codex.cmd` → a Node entry → the native `codex.exe` inside a
   platform package). claude-native refuses a shim for the same reason (`src/backends/claude-native/index.js:93`). This is
   unsolved for Codex (O1); T1 measured that the native binary and the Node entry both start `app-server` directly.
10. **Idle maintenance is declined today** (`idleMaintenance: () => null`, `src/backends/codex/index.js:333`; capability row
    `src/backends/codex/index.js:381`). The hook and the `rpc` half's `maintenanceCommand` and `usageOf` are spec 45's.

## Row ownership and reopening

The rule is spec 30's and spec 32's: two backends over one store cannot both own a row, so the row stays Codex's and how it was
started is a field of its own. The driver declares `transcriptsOf: 'codex'` and a `transport`, and declares no discovery, no
parser and none of the live-record hooks.

- **The marker.** `thread/start` and `thread/fork` send `threadSource: "switchboard"`. The Codex parser sets `row.transport`
  when `thread_source` is that value (a small marker module in the Codex folder spells it once, beside the reader, as
  Claude's and Pi's do), bumping `PARSER_SCHEMA_VERSION`. The parse state keeps it, so an append does not lose it.
- **What it means (E2).** "Started natively", not "driven natively right now". A terminal resume appends to the same rollout and
  leaves the marker (measured), so a thread started here and continued in the TUI still opens in the conversation view; the
  user can pick the terminal per session (#670), which is stored in `session_meta.opener` and wins over the marker.
- **The other direction.** A thread started in the TUI has no marker and opens in the terminal; the user can still open it in
  the conversation view by choice. Resume over app-server needs no marker.
- **A fork.** `thread/fork` does not inherit the marker, so the adapter sends it again. A fork made by the TUI's `codex fork`
  is not ours: it writes `thread_source: "user"` (measured, O7) and opens in the terminal.
- **Switched off or missing.** `openerFor` hands a marked row to the driver only while it can launch; otherwise the row goes
  back to the terminal Codex, which reads the same rollout. The spawn path's launch overlay records the driver and
  `rowOwnerOf` turns it into the owner before the stamp (`src/backends/index.js:505`), so nothing outside the Codex folder
  names either id.

## The protocol mapping

Wire facts measured on 0.171.0 (`docs/backend-formats.md`): no `jsonrpc` member, `initialized` is a notification with only a
`method`, no `--stdio`. The names below are 0.171.0's; the regression coverage (below) is what keeps them honest per version.

| Core operation (neutral) | Codex app-server |
|---|---|
| Start of the child | `codex app-server` (plain; on Windows through whatever O1 decides) |
| Bootstrap | `initialize` with `clientInfo`, then the `initialized` notification, then `thread/start` or `thread/resume` (`excludeTurns: true`) or `thread/fork`; answers the thread id for the `identity` op |
| New thread | `thread/start { cwd, model?, approvalPolicy?, sandbox?, threadSource: "switchboard", config? }` |
| Resume | `thread/resume { threadId, excludeTurns: true, model?, approvalPolicy?, sandbox? }`; the answer's `thread.path` can carry the `\\?\` prefix and is normalised before any comparison |
| Fork | `thread/fork { threadId, threadSource: "switchboard", excludeTurns: true }` |
| Send a prompt | `turn/start { threadId, input: [{type:'text'|'localImage'...}], model?, effort? }`; the answer is the turn, the stream carries the rest |
| Steer | `turn/steer { threadId, expectedTurnId, input }` with the turn id the instance holds |
| Follow-up while busy | held by the core (P5), sent as a `turn/start` when idle |
| Stop | `turn/interrupt { threadId, turnId }`; the turn ends `interrupted` and the decoder marks `outcome: 'stopped'` |
| Busy and idle | `turn/started` and `turn/completed` (P4, O3) |
| Streamed text, reasoning, tool activity | `item/agentMessage/delta`, `item/reasoning/*`, `item/started` and `item/completed` for `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`, `plan` and the others; one mapper for these and for items paged from history (P1) |
| Context fill, usage, cache figures | `thread/tokenUsage/updated` (`last`, `total`, `modelContextWindow`); `usageOf` answers per call from `last` |
| Command approval | server request `item/commandExecution/requestApproval` → an `ask` op; the answer `{ decision: accept | acceptForSession | decline | cancel }` goes back under the server's request id |
| File-change approval | `item/fileChange/requestApproval`, same decisions |
| Permission request, MCP elicitation | `item/permissions/requestApproval`, `mcpServer/elicitation/request` → asks; exact card shape decided in T9 |
| User question | `item/tool/requestUserInput` → a questions ask; `serverRequest/resolved` closes an ask answered elsewhere. Sent only on a plan-mode turn, which needs `capabilities.experimentalApi` at `initialize` (measured, O6) |
| Unsupported server request | `account/chatgptAuthTokens/refresh`, `attestation/generate`, `item/tool/call`, legacy approvals: answered with a JSON-RPC error so Codex does not hang; the backend touches no login |
| Compaction | `thread/compact/start` answers `{}`, then a turn (`turn/started`, a `contextCompaction` item, `turn/completed`) |
| Models | `model/list` for the picker |
| Notices | `warning`, `deprecationNotice`, `configWarning`, `error` become notices; a refused turn's error becomes the readable message of E3 |

Plans (`item/plan/delta`, `turn/plan/updated`, the `plan` item) are drawn as the plan entry the view already knows; Codex has
no plan-approval step, so no approval card is raised for one (O9).

## The seam in agent-rpc (neutral, first, on its own)

Everything here is added to `src/app/agent-rpc.js` and read there before any backend declares it
(`.claude/rules/backends.md`, "A runtime-driven backend keeps its translator and nothing the core already has";
`test/runtime-backends.test.js` fails an `rpc` key the core does not read). Every addition is optional, and a half that
declares none of it behaves byte for byte as before.

- **A per-spawn instance.** The half may declare `createInstance(spawn)`; the core calls it once in `start()` and lays the
  answer over the half: the instance's own members win, every other key reads the half (as built in T2, `instanceOf` in
  `src/app/agent-rpc.js`). The answer must be a plain object — a class instance keeps its methods on its prototype, where
  the copy does not reach, so it is refused — and capability keys the view reads off the declared half (`imageInput`,
  `shellLines`) stay the half's. `spawn` is `{ cwd, env, options, appliedOptions, forkFrom, init, link }`, with
  `link = { write, request }`: the core's own, so a line the instance writes still goes through `noteSent` and the
  closed-stdin guard, and answers "not running" until the session runs.
- **A bootstrap.** The instance may declare `bootstrap(link)`, a Promise. Until it settles, `request()` waits; the handshake's
  own requests use the link and bypass the gate. A refusal or a timeout ends the session with a notice in the backend's words
  (the child is stopped through the ordinary kill, so the exit handler and the tab's end-of-session path run unchanged). What it
  answers may carry `{ sessionId, notices }`: the id goes through `adoptIdentity`.
- **Opaque launch data.** `buildLaunch` may answer an `init` object the spawn path hands to `startAgentProcess` and the core
  hands to `createInstance`. The core reads nothing in it (P3).
- **Server requests.** The instance may write a reply through `link.write` (an error for an unsupported request); an ask is
  answered through the existing `answerCommand(id, answer, ask)`, which receives the ask and writes under the server's id.
- **Paged history.** A third form beside `messagesCommand` and `entriesFromTranscript`: `loadEntries(link, { cwd })`, a Promise
  of the entries, called by `attach` (`src/app/agent-rpc.js:1594`). The sequence contract of `attachFromTranscript` applies
  (entries sent recently that the history lacks, and keys for ops the snapshot already holds).

What the seam must not change is shown by the existing suites: `test/agent-rpc*.test.js`, `test/claude-native-rpc.test.js` and
`test/runtime-backends.test.js`, and a real turn on claude-native (Haiku) and pi-native (Haiku 4.5) after the step.

## Launch, version and fallback

- **Executable.** O1. Whatever it decides, the start path starts something it can stop with the process-tree kill, and the
  quit path reaches it. A bare program name never goes with a project as `cwd` (CLAUDE.md reflex 10,
  `test/no-bare-exe-in-cwd.test.js`).
- **Version gate.** As claude-native's (`src/backends/claude-native/version.js`): checked only when a session is about to start
  (`probe({ launch: true })`), asynchronous, cached by the binary, an unreadable version does not refuse. The floor is a constant
  of 0.144.0 (E3). Below it the backend is not launchable: `probe` says "Codex (GUI) needs Codex 0.144.0 or newer; X is
  installed", the row opens in the terminal Codex (`openerFor` and `launchableIds`), and the New Session picker shows the
  reason. A floor that rises is a one-line change and a changed sentence.
- **Server-side refusals.** A turn that fails with a model or version error is surfaced as the CLI's own message plus a short
  line naming the installed version, never swallowed into "the session did not answer".
- **Trust.** Print mode in Claude skips the trust dialog, so claude-native declares `trustBeforeStart`
  (`src/backends/claude-native/index.js:256`). App-server silently ignores a project's own Codex configuration in a folder the
  home's config does not mark trusted (measured, O2), so the backend declares the gate, which fails closed.
- **One writer per thread (#759).** App-server refuses a resume of a thread another client holds (`already has an active
  writer`). The backend words that for the user ("This conversation is open in another app") and offers a retry; it never
  starts a daemon of its own. The hold is short after a TUI ends (measured).

## What the descriptor forwards and what it declares itself

As claude-native does (`src/backends/claude-native/index.js:213`): the store, parser version, trust answer, skills and resource
listing, plugin and app listings, changelog and the other answers about Codex's store and format are Codex's, forwarded.
`transcriptsOf: 'codex'`, `transport`, `modeLabel: 'GUI'`, `trustBeforeStart`, `supportsFork: true`, an `rpc` half, `probe` with
the launch check, and a `configFields` subset taken from Codex's own (model, effort, approval, sandbox first; each other field
only after it was measured on app-server, as claude-native did in #685, O4). The `sharedResources` offer stays with the
terminal backend (one source, not two). A template does not inherit the driver (the existing `NOT_INHERITED` mechanism). The
capability rows answer per backend, `limited` with a note where the driver changes the answer.

## Idle maintenance (the #828 requirement)

`idleMaintenance()` answers, with spec 45's neutral shape: `{ cacheClass, maxRefreshMs, warm: true, compact: true, callsCold: true }`.

- **A miss can be called.** `thread/tokenUsage/updated.last` carries `inputTokens` (which includes the cached part, measured)
  and `cachedInputTokens`, and the measured miss read 0. `usageOf` maps it to the core's `{ input, read, write }` with `input` the
  uncached part, so spec 45's hit rule (read against the previous prompt) applies unchanged. `callsCold` is true with the
  capability row `limited`: one sample per gap, one model, one account.
- **`maxRefreshMs`.** Hit at 30 minutes, miss at 60, one sample each; 25 minutes is the value that fits. Decided in T14 (D1) and
  recorded here, with whether to repeat the measurement.
- **The warm turn** is a `turn/start` of the backend's fixed sentence, as claude-native's and pi-native's are worded in their
  folders. **The compaction** is `thread/compact/start`: it answers `{}` at once and then runs as a turn, so `endsBy: 'idle'`,
  `confirmedBy: 'compacted'` where the decoder sends that op when the `contextCompaction` item completes (the `thread/compacted`
  notification and `ContextCompactedNotification` exist in the schema and were not seen, so nothing depends on them).
  `answerStartsTurn` answers true for both.
- Both go over the pipe through the core's maintenance gate; no PTY path exists.

## Deliberate differences from the TUI

Stated now, confirmed at the end of the build: no TUI-only commands or key handling; approvals are cards, not the TUI's
dialogs; no `/resume` picker inside the session; the app's own held queue stands in for the TUI's input buffering; an agent
spawned by Codex shows as the parent's tool activity (the child rollouts stay dropped from the sidebar, `docs/backend-formats.md`);
no auto-review (`approvals_reviewer`) card for the guardian's verdict unless the protocol sends one (O3); skills, slash commands
and the `!` shell line are not in the first stage (O10, O11). Each limitation found while building is added here at the line.

## Regression coverage against the version-specific schema

The issue asks for it; the design is two layers, both in the suite.

1. **A committed extract** of the generated schema for the floor and the newest measured version (method names, required and
   known fields, the enum values the adapter relies on, `ThreadSource`'s type). Produced by a script from
   `codex app-server generate-json-schema` (no account, no turn; `scripts/measure-codex-app-server-schema.js` is its
   ancestor and holds the same list of what the backend needs, which the new script replaces so there is one list). Every
   request the adapter builds is checked against it: required fields present, no field the schema does not have, no method
   the version lacks; every notification and server request the decoder handles is a name in the version's schema; every
   server request of the schema is either handled or answered with an error.
2. **A live check** that generates the schema of the installed Codex when one is present and runs the same assertions, skipped
   (with a stated reason) when none is installed or it is older than the floor. It is how a new Codex release is checked against
   the adapter before a user meets it.

`scripts/measure-codex-app-server.js` stays the way to re-measure turns; a version that moves the floor is a re-run of both.

## Open

Numbered and stable; none is decided by this spec.

- **O1 — launching on Windows.** The default npm install is a shim the spawn path cannot start. Options: resolve the native
  binary inside the platform package from the shim's location (skips the wrapper's environment handling and may miss its PATH
  addition for bundled tools); run the Node entry of the shim with `node` on PATH (keeps the wrapper; needs Node); `cmd.exe /d /c`
  (one more process, argument quoting). Measure each against the process-tree stop and the wrapper's environment, then decide
  (T1, T5).
  **Measured (T1, 2026-11-24), decision still T5:** read from the 0.171.0 source, the npm package's `bin/codex.js` resolves
  `@openai/codex-<platform>/vendor/<target triple>/bin/codex.exe` and starts it with two added variables only,
  `CODEX_MANAGED_PACKAGE_ROOT` and `CODEX_MANAGED_BY_<package manager>` (`NPM` for npm; update hints); it changes no `PATH`.
  Measured: the native binary and the Node entry run with this Node both start `app-server` without a shell and answer
  `initialize`, and both end when stdin closes; by hand, a plain kill of the Node wrapper and a process-tree kill each left no
  `codex.exe` behind. `docs/backend-formats.md`.
- **O2 — trust.** Does app-server honour a project's own configuration, hooks and MCP servers in an untrusted folder?
  Decides whether `trustBeforeStart` stays.
  **Measured (T1):** no. A project `.codex/config.toml` was ignored in a folder the home's config did not mark trusted, without
  any prompt or notice, and read once `[projects.'<dir>'] trust_level = "trusted"` was there. So the trust gate stays: without
  it a project's own settings silently do not apply. Hooks and MCP servers were not tested separately.
- **O3 — turn edges and queues.** The busy/idle edge for a normal turn, an interrupt and a steer; `thread/queue/changed`; whether
  `thread/status/changed` ever outlives `turn/completed`; the shape of an error turn. Decides P4 and P5.
  **Measured (T1):** every turn — plain, interrupted, steered, failed, compaction — ends with `thread/status/changed` (`idle`)
  immediately followed by `turn/completed`, which alone carries the outcome (`completed`, `interrupted`, `failed`) and the
  error (`message`, `codexErrorInfo`, `additionalDetails`, `misalignment`); P4 holds. A failed turn passes through
  `thread/status/changed` `systemError` and an `error` notification first. A steer is answered with `{ turnId }` and shows as a
  second `userMessage` item inside the same turn; a steer naming another turn, or with no turn running, is refused (`expected
  active turn id …`, `no active turn to steer`). An interrupt is answered `{}`; the agent message it cut off gets no
  `item/completed`. No `thread/queue/changed` was sent in any run, so P5 (the core holds follow-ups) stands.
- **O4 — which Codex options a native session takes.** `profile`, `search`, `oss`, `addDirs`, `configOverrides` against the
  `config` object and per-turn fields; MCP injection (`-c` overrides before `app-server`) and the discovery, review and task tool
  groups. First stage offers model, effort, approval and sandbox only; the rest are measured one by one.
  **Measured (T1), one part:** `-c key=value` placed before `app-server` takes effect (`-c model=…` set the model a
  `thread/start` without `model` reported).
- **O6 — `experimentalApi`.** Whether the user-question request needs the capability at `initialize`, and what else it turns on.
  **Measured (T1):** it needs more than the capability. `item/tool/requestUserInput` came only on a turn sent with the
  experimental `collaborationMode: { mode: "plan", settings: { model, reasoning_effort } }`, and that field is refused without
  the capability ("turn/start.collaborationMode requires experimentalApi capability"). Without plan mode the model did not ask,
  with or without the capability. So user questions are a plan-mode feature on an experimental API; what else the capability
  turns on was not listed. The request carries `questions` (`id`, `header`, `question`, `options`, `isOther`, `isSecret`),
  `isBlocking`, `autoResolutionMs`, `itemId`, `threadId`, `turnId`; the thread status meanwhile is `active` with
  `waitingOnUserInput`; the answer `{ answers: { <id>: { answers: [<label>] } } }` was accepted.
- **O7 — marker after a TUI fork** of a native thread (unmeasured; the documented limitation is that it opens in the terminal).
  **Measured (T1):** a TUI `codex fork` of a marked thread writes `thread_source: "user"`, with `forked_from_id` set and
  `originator` and `source` copied. It is not a native thread and opens in the terminal, as documented.
- **O8 — the retry and wording of the one-writer conflict.**
  **Measured (T1):** a `thread/resume` while another app-server process has the thread loaded is refused with code `-32600`,
  "thread <id> already has an active writer", also after that process's turn had ended and it only kept the thread loaded
  (`hold`). By hand: a TUI that had only resumed (no turn sent) did not block it; after TUI sessions through the managed daemon
  a resume was refused once and passed a few minutes later, so when the daemon lets go was not pinned down (#759 measured the
  TUI's own hold at up to 15 s). Wording and retry are still T11.
- **O9 — plans.** How a Codex plan item and its updates are drawn, with no approval step. (T1 found that a plan mode exists,
  as the experimental `collaborationMode: plan` on `turn/start`; what it emits besides user questions was not measured.)
- **O10 — skills and `/` commands in the composer** (`skills/list`), later stage.
- **O11 — the `!` shell line** (`thread/shellCommand` exists in 0.171.0), later stage.
- **O12 — image input form.** A `localImage` path needs a per-turn temporary file (an ephemeral per-spawn file, CLAUDE.md
  reflex 11 exemption); `image` may take a URL form. Measure which the server accepts.
  **Measured (T1):** both. A turn with `{ type: "localImage", path }` and one with `{ type: "image", url: "data:image/png;base64,…" }`
  each completed on a 1x1 PNG. How each is stored in the rollout and returned by `thread/items/list` was not measured (T8/T12).

(O5 was the owner's deferred item and is D1 above.)

## Known limitations (to carry into the as-built record)

The floor is a fixed number against a server that retires models, so it will rise. The cache bound is one sample per gap on one
model. A native thread continued in the TUI is a thread two clients take turns on, never at once (one writer). History through
app-server depends on the paging requests of the installed version, so the floor also bounds them.
