# 46 — Session flow (the Flow tab)

Issue: #826. Status: **planned, nothing built**. This file is the design record written before the build: the owner's
decisions, what each backend can answer according to the measurements on the issue, the neutral shape, where the work runs, and
what is still open. When a phase lands, "As built" and "Known gaps" are corrected in place.

Measured formats are not repeated here; they live in `docs/backend-formats.md` (the #826 subsections for Claude, Codex and Pi)
and `docs/specs/28-session-health.md` (the Codex compaction marker). Anything this spec states that no measurement covers is
marked **not measured**.

## What it does

A session does a lot between two prompts. The timeline viewer (#302) gains a second tab, **Flow**, next to **Events**. Flow draws
the session as a **lane graph**: time runs down, every session or agent has a column (a lane), a row is a moment. Steps are the
session start, instruction files, prompts, thinking, tool calls and results, output, interrupts and compactions. A spawn opens a
lane to the right of its parent, a return joins back. Context evidence sits on the model-request checkpoints, with its basis
stated. The diagram can be exported (JSON first, then SVG, PDF, Mermaid).

It reads the transcript, not the pipe, so it works for terminal and native sessions alike. Events (the lifecycle record in
`src/app/timeline.js`, table `session_timeline`) is untouched.

## Owner decisions (binding, from the issue; not re-decided here)

| ID | Decision | Reason given |
|---|---|---|
| E1 | A second tab "Flow" in the existing timeline viewer, beside "Events". | One entry point that exists; the lifecycle record and the recap stay untouched. A rebuilt timeline (W2) would keep the old list anyway for agy and Hermes; a view of its own (W3) means two buttons for "what happened". |
| E2 | Snapshot plus an explicit Refresh. Live tail is a later extension. | One coherent multi-file graph and one coherent export while parent and child transcripts may still grow. The viewer may say newer data exists and refreshes once when the session ends. |
| E3 | Export order: neutral JSON, then SVG and a paginated PDF, Mermaid last. | The SVG export is a separate complete static materialisation of the neutral model; PNG is out (`capturePage` sees only the visible area). |
| E4 | Obsolete with E1. | |
| E5 | Lifecycle markers (`needs-attention`, `stopped`, `forked`) from Events appear in Flow, in a later review step, without merging the two sources. | |
| Layout | A lane graph, no layout engine: column = lane, row = moment. Spawns and returns run in the gap between two rows. | A table cannot show nesting or parallel agents; a free flowchart needs auto-layout, loses the time axis, and its diamonds decide nothing in a session. |
| Screen | The review revision narrowed "SVG": the screen may be virtualised HTML cards with an SVG connector layer. SVG export is separate. | Accessibility, text layout, scale. |
| PDF | Explicit pagination with repeated lane headers, then `webContents.printToPDF`. A new IPC handler in an `src/app/` module (reflex 4). | One tall SVG does not page-break inside cards. |
| Evidence | Four bases: `measured`, `estimated`, `included`, `unknown`. A difference between request checkpoints is never assigned to one step. | The transcripts measure request input at checkpoints, not each step's contribution. |
| O4 (destructive commands) | A conservative built-in pattern list per backend descriptor (`Bash` Claude, `exec` Codex, `bash` Pi). Heuristic, labelled so. User extensions are later and need a bounded safe pattern language in `docs/settings-reference.md`. | No CLI marks a command as dangerous itself. |
| Pi approvals | Terminal Pi has no approval step: the start node says so once. pi-native refusals are in the transcript, allows are not. | `docs/backend-formats.md`. |
| Scope | Cross-backend child sessions (#804, #806, #809) are not in the first version; the neutral shape reserves a session reference. | Their durable parent link does not exist yet. |
| Toolbar | A "View timeline" button in the terminal-header toolbar directly left of "View messages" (`terminal-messages-btn`), with the clock icon of `session-timeline-btn`. | Today only the session sidebar row reaches the timeline. |

## The neutral shape: `FlowSnapshot` (versioned)

The renderer, the exports and the tests see only this. No vendor record, no vendor field name, leaves a descriptor folder. It is
JSON-serialisable (it crosses a worker boundary and is exported), and it carries `schemaVersion`; a reader of a newer version
declines rather than guesses.

```
FlowSnapshot {
  schemaVersion: 1,
  snapshotId,                 // opaque; identifies this read
  fingerprint,                // per source file: size + mtime + a hash of the first and last chunk; see "Staleness"
  capabilities: {             // each is yes | partial | no, with a limitation id when not yes
    agents, instructionFiles: 'perFile' | 'block' | 'none', contextCheckpoints, permissionMode,
    approvals, compaction, interrupt, destructivePatterns, timestamps
  },
  limitations: [{ id, text }],   // plain sentences the Flow tab shows; never an empty banner
  lanes: [Lane], steps: [Step],
  nextCursor: null | string,   // reserved; the first version returns one page (see O5)
  complete: boolean            // false when a cap truncated the read; a limitation says so
}
Lane { id, parentLaneId, depth, label, kind: 'main' | 'agent' | 'collapsedCall' | 'session',
       spawnAnchor: { laneId, stepId }, returnAnchor: null | { laneId, stepId },
       summaryOnly: boolean,      // a Pi subagent: one node, no steps
       sessionRef: null }         // reserved for #804/#806
Step { id, laneId, ordinal, turn, kind, label, ts: null | number,
       parentStepId?,             // optional: an instruction file names its start step; must name a step of the snapshot
       source: { sourceId, line, byteOffset },  // sourceId is opaque; no path leaves main
       checkpoint: null | { input: Evidence, window: Evidence, model },
       tokens: null | Evidence,   // only where the transcript measures one value for THIS step
       flags: [Flag],
       detail: {} }               // key/value rows for the detail panel
Evidence { value, unit, basis: 'measured' | 'estimated' | 'included' | 'unknown', note }
Flag { axis: 'risk' | 'outcome' | 'attention' | 'lifecycle', code, why, evidence: 'structured' | 'heuristic' }
```

Rules the shape carries:

- **Ordinal and causal links are authoritative; timestamps are optional.** A row never claims a duration the transcript does not
  give. Stable step IDs derive from the lane and the source identity (line number plus byte offset, kept in clear), never from the
  rendered array index.
- **A checkpoint is the only place a lane's fill is measured**: Claude `message.usage` (`input_tokens` + `cache_read_input_tokens`
  + `cache_creation_input_tokens`), Codex `token_count.info.last_token_usage` with `model_context_window`, Pi `usage`
  (`input` + `cacheRead` + `cacheWrite`). The window is the model's window for that request. The reader never subtracts two
  checkpoints and gives the difference to a step.
- **Instruction files** are child entries of the start step. Per-file size is characters; the token figure is `estimated`
  (about characters / 4) and says so. Where a backend only has one block (Codex), the share stays one cumulative start
  contribution with basis `included`. The start total is the first request's measured input; files do not claim to add up to it.
- **Before a terminal session has made its first request the start total is `unknown`.** A native backend may declare a measured
  baseline (see O8); the first version declares none.
- **Flags are facts on separate axes** and may coexist on one step (an escalated, medium-risk, allowed call that then fails
  carries four). A flag says why it exists and whether its evidence is structured or heuristic. Only a structured `outcome`
  says whether a call ran.
- **Compaction** is a step with before and after: "before" is the last non-zero request input ahead of it, "after" is the next
  non-zero input. Never the summarising call's own usage (Pi `compaction.usage`, Codex `latest_token_usage_record`).

### The vocabulary, as built

The module is `src/shared/flow-snapshot.js` (pure, no fs, path, DOM or crypto). Since T8 the renderer loads it too: it has a `<script>` tag in `index.html` and a
`script-order.json` entry, and `.claude/rules/renderer.md` "`src/shared/`" names the Flow pair, so it is a regular shared module
(the temporary exception of T3-T7 is gone). The body is wrapped, so a classic-script load adds one global (`FlowSnapshot`) and none of its
helper names; in main and a worker it is `require()`d.

Its sibling `src/shared/flow-layout.js` (T7: pure layout and collapse, one global `FlowLayout`) is the renderer's since T8
(`session/flow-view.js`) and main's once the exports (T18-T20) lay out a full snapshot there. The two are the Flow pair
for that rule's list. Collapse state uses prototype-free maps read through own-property checks, so a lane or group id such as
`constructor` is an ordinary key.

- `FLOW_SCHEMA_VERSION` is `1`. `validateSnapshot` declines any other version (older or newer) with an error and checks nothing
  else; it never throws and answers `{ ok, errors }`.
- Step kinds: `start`, `instructions`, `prompt`, `thinking`, `tool`, `output`, `interrupt`, `compaction`, `mode`, `agent`,
  `checkpoint`, `event`.
- Lane kinds: `main`, `agent`, `collapsedCall`, `session`.
- Evidence bases: `measured`, `estimated`, `included`, `unknown`.
- Flag axes: `risk`, `outcome`, `attention`, `lifecycle`. Flag evidence: `structured`, `heuristic`.
- Capability ids: `agents`, `instructionFiles`, `contextCheckpoints`, `permissionMode`, `approvals`, `compaction`, `interrupt`,
  `destructivePatterns`, `timestamps`. Every id is present in a snapshot.
- A capability entry is `{ state, limitationId }`. `state` is `yes`, `partial` or `no`; for `instructionFiles` it is `perFile`,
  `block` or `none` instead. **A capability that is not fully there (`partial`, `no`, and for `instructionFiles` anything but
  `perFile`) carries a `limitationId` naming an entry of `limitations`**, and `validateSnapshot` enforces it; a `limitationId`
  that names nothing is invalid in any state. `emptyFlowSnapshot` with no limitations supplies one (`nothing-read`).
- The stable step id (`flowStepId(laneId, source, part)`) is built in clear from the lane id, the source id, line, byte offset and
  the step's index within its line (`part`, for a line that yields several steps): unique by construction, no hash, no path.
- `validateSnapshot` also enforces: a step's `source` has only `sourceId`, `line` and `byteOffset` (no path leaves main);
  `label` is a string and `turn` is null or a number; a lane's `parentLaneId`, `spawnAnchor` and `returnAnchor` point at lanes and
  steps that exist; step ids, lane ids and limitation ids are unique. It is one pass, and it reports at most the first 50 problems
  plus a note that more were omitted.

## The descriptor hook and what each backend answers

One hook family, read by the core and answered (or declined) by every descriptor (`.claude/rules/backends.md`, "THE DESIGN RULE").
The hook is split so the part that runs off the main thread is pure:

```
sessionFlow(row) -> null | { capabilities, limitations, sources: [{ sourceId, role, laneHint, file }] }
   // cheap, in main: resolves the files (the row's transcript, and child transcripts where the backend has them).
   // null = this backend has no usable flow reader (or no row at all); Flow is disabled and Events stays.
   // A supporting backend whose row names no transcript file yet answers its capabilities with `sources: []`:
   // main then answers a snapshot with `complete: false` and the limitation `no-transcript` ("Nothing has been written
   // for this session yet."), never `null`.
readSessionFlow(sources, { signal, limit, cursor }) -> FlowSnapshot
   // pure: only file reads and parsing, no Electron, no db, loadable in a worker thread.
```

As built: `sessionFlow` is synchronous because `transcriptPathFor` only joins strings. Any future filesystem work (a stat, a
readdir) makes the hook async; it must never do sync fs. Each descriptor requires its reader lazily inside `readSessionFlow`, so
loading the registry loads no reader (`test/flow-snapshot.test.js`); `src/backends/flow-stub.js` answers an empty snapshot until a
real reader replaces it (Codex and Pi still use it; Claude's reader is built, see "Claude reader, as built" below), with the same capabilities the descriptor's `sessionFlow` answered (both come from one function, pinned in
`test/backend-parity.test.js`). A real reader lives in `<backend folder>/flow-reader.js`. The native drivers (`claude-native`, `pi-native`) forward their owner's two functions, as they do
`transcriptPathFor`. The cheap shared pieces are in `src/backends/flow-hook.js`.

A capability row `sessionFlow` is added to `src/backends/capabilities.js` (group `sessions`), every descriptor answers it, and
`test/backend-parity.test.js`, `test/backend-capabilities.test.js` and the template shape test pin each answer (see O3 for how a
template inherits it). A `limited` answer carries a note naming the missing half.

What each backend can answer, from the measurements on the issue (second to fourth comments; **not re-measured for this spec**):

| | Claude | Codex | Pi |
|---|---|---|---|
| Answer | `yes` | `limited` | `limited` |
| Lanes | main plus `subagents/agent-<id>.jsonl`, joined by the meta file's `toolUseId` or the `agentId` in the parent's `toolUseResult`; depth 1 in practice | child rollouts; `source.subagent.thread_spawn` states `depth` and `agent_path`; parent side `spawn_agent`, `wait_agent`, `wait`, `send_message`; `inter_agent_communication_metadata` marks a turn another agent started | single lane; the app's `subagent` call is one collapsed node (call plus the one summary line), never a lane, and Pi nesting cannot be shown. No built-in subagents. |
| Instruction files | per file (`attachment` `instructions` `files[]`, characters) | one block (`# AGENTS.md instructions for <dir>`); `included` | per file from `sections.project_context` (`<project_instructions path>`), **Pi 1.1.0 and newer only**; older sessions store no system message, so the start step lists none and a limitation says why |
| Checkpoints | `message.usage`; window from the model | `token_count.info.last_token_usage` + `model_context_window`; skip the `input_tokens: 0` record after a compaction | `message.usage` |
| Permission mode | `permissionMode` per user line; `mode` line | `turn_context`: `approval_policy`, `sandbox_policy` | none in a terminal session; pi-native gate refusals only |
| Compaction | `compact_boundary` (`preTokens`/`postTokens` per the issue table) | the `compacted` line (`window_number`), then the zero record, then the next real one | `compaction` with `tokensBefore` |
| Interrupt | `[Request interrupted by user]` | `event_msg` `turn_aborted` (no `task_complete` follows) | aborted turn (zero-usage record, spec 28) |
| Blocked / denied | hook block text (`PreToolUse:<Tool> hook error: BLOCKED`), `Permission for this action was denied`, `hook_cancelled` | escalation in the call (`sandbox_permissions: require_escalated`); guardian verdict; a sandbox block only as a failed command (**heuristic**) | pi-native refusal: `toolResult` `isError` with the gate's own reason text (matched exactly); an allow leaves no trace |
| Destructive-command patterns | on `Bash` input | on the `exec` input | on `bash` input |

Honest declines, to be kept as `null` or `partial` and documented in the descriptor:

- **Codex** user denial in the TUI: **not measured**. Guardian `deny` outcome: **not measured** (only `allow`; a raised
  `risk_level` is no refusal, only `outcome` says whether the call ran). Hook blocks: **not measured**. A guardian verdict is
  matched to the n-th escalated call by order and confirmed by command text; there is no call id.
- **Pi** hook blocks and a terminal approval: none exist. pi-native "asked and allowed" needs the app's own record, which the
  first version does not read.
- **Claude** `command_permissions` (`allowedTools`) is drawn as a special event "skill granted tools", never as risk.
- **Hermes and agy** answer `no` (`null` from `sessionFlow`); Flow is disabled, Events stays.
- Claude per-line **timestamps** per step: **not verified here**; the shape treats `ts` as optional for every backend.

Native drivers (`claude-native`, `pi-native`) read through the owner of the transcript (`transcriptsOf`, resolved the way the
other transcript hooks are); they implement no reader of their own and do not widen the answer.

## Where parsing runs

- **On demand, never in the session-cache parser.** The cache parser keeps retained incremental state for list rows; the flow
  reader shares none of it (req. 9). The lifecycle record behind Events is not read.
- **Off the main thread, cancellable.** A short-lived `worker_threads` Worker (`src/workers/flow-worker.js`) per Refresh, started
  and terminated by `src/app/session-flow.js`. Termination is the cancel; a second Refresh by the same window for the same session cancels the first.
  The worker resolves the backend by id through the registry (the way `index-worker.js` does), streams each file line by line,
  and returns one `FlowSnapshot`. Recommendation and alternatives: O1.
- **File fingerprints.** The snapshot records the main transcript's size, mtime and a hash of its first 4 KB (`fingerprint`, no path). The cheap `status` call (main thread, `fs.promises` only) compares them: one `stat`, and a 4 KB read only when size or mtime moved and the file did not shrink. If the file shrank or its head changed the answer is `rewritten`, and the next Refresh is a full rebuild; there is no incremental append in the first version. No trailing hash is read on a poll.
- **Caps.** The reader stops at a step cap and sets `complete: false` with a limitation. The number is measured on the largest
  local transcripts in the first reader step, not guessed (O5).
- **Paths.** The renderer sends a session id, never a path. Main resolves the sources from the cached row. There is no containment check on that path, on purpose: it is not input (it comes from the backend's `sessionFlow(row)` applied to a row main cached itself) and a guard would have no root to compare against; any future path that DOES come from outside decides on real paths through `src/app/path-containment.js` (reflex 13). Exports never contain raw vendor records; instruction
  files appear only as project-relative or `~` labels, but tool arguments (files read, commands run) may name paths, hence the
  export warning.
- **Probes.** The structure-only probes are kept under `scripts/` (see the plan, T1) and listed in `docs/settings-reference.md`.

### Main side and worker, as built (T6)

`src/app/session-flow.js` answers three IPC calls, all keyed by the asking window and the session (a detached window loads the same
shell, so closing the viewer in one window must not cancel another's read): `get-session-flow`, `cancel-session-flow`,
`get-session-flow-status`. Details that are decisions:

- **Answers.** `getSessionFlow` answers a snapshot, or `null` only for a backend that declines (`sessionFlow` absent or null). Every
  failure is a snapshot with `complete: false` and a limitation of this module's own: `no-transcript` (the backend supports a flow
  but the row names no file yet), `session-unknown`, `worker-timeout`, `worker-memory`, `worker-crashed`, `read-cancelled`. A raw
  error message never leaves main. The renderer keeps its previous good snapshot when an answer's only news is `read-cancelled`.
- **Status words.** `unchanged | grew | rewritten | unknown` (`unknown`: no read by this window yet, an unknown session, a source that cannot be stat-ed).
- **Worker.** One per request, `resourceLimits` 256 MB old / 32 MB young generation, a 30 s wall-clock timeout (`unref`), a generation counter
  per window and session dropping stale replies, `terminateAll()` in the quit teardown before the database closes. The worker loads the backend registry
  (about 170 ms measured) and then only the one backend's reader.
- **The window hint.** Main resolves the session's context window as the health badge does (`src/index/context-window.js`) and passes it
  to the worker; the reader prefers it (`estimated`, "from the session's settings"), the model name is the fallback. On this request
  path the hint uses only the descriptor's `contextWindowAsync` (Claude: the settings files through `fs.promises`); a backend without
  one gets no hint, because its plain hook may read files synchronously (Pi's model catalog does). So no synchronous file read
  blocks the main thread. Known gap: the hint is the session's current window and is applied to every checkpoint that fits in it,
  so a session that switched to a 1M variant halfway reads its early checkpoints against the 1M window.
- **No source path in any answer** (a deep scan in `test/session-flow.test.js`); `sources` stay in main. Tool labels may carry the
  tool's own argument (a file the tool read, for example); instruction files are labelled relative to the project or with `~`.

## The renderer side

- **Tabs.** `#timeline-viewer` (`src/renderer/index.html`, `src/renderer/session/timeline-view.js`) gets two tabs, Events and
  Flow, styled with the existing tab/button classes (reflex 8). Events is unchanged. The view kind `timeline` already exists in
  `VIEW_KINDS` in `src/renderer/views/panes-view.js`; the tab is state inside it, so panes mode and a detached window need no new
  kind. Flow is disabled, with the reason, only when `sessionFlow` is `null` for the session's backend; partial evidence shows
  the limitations instead.
- **Entry points.** The sidebar row button (`showTimelineViewer`, unchanged) and the new toolbar button next to
  `terminal-messages-btn`. Both open the viewer on the last used tab.
- **Layout is a pure module** (src/shared/flow-layout.js (new)): snapshot plus collapse state in, columns and rows out. It has no DOM,
  so the on-screen view, the SVG export, the PDF pages and the Mermaid text all use the same model.
- **Drawing.** Virtualised HTML cards with an SVG connector layer; rows and lanes are windowed (req. 7). Spawn and return
  connectors run in the gap between two rows, so they never cross a card.
- **Default collapse (req. 7).** Steps are grouped by turn (a turn starts at a user prompt). Finished agent lanes are collapsed.
  Consecutive equivalent tool calls inside a turn collapse into one group with a count (equivalence: O7). Never collapsed
  across a prompt, a mode change, a compaction, a spawn, a return, a failure or an interrupt. A collapsed group inherits the
  flags inside it. A lane is drawn as waiting only from an explicit wait event.
- **Refresh.** A button; while the tab is open the viewer polls the cheap `status` call and shows "new steps available". It
  refreshes once on its own when the session ends. A refresh keeps the selected lane, the collapse state and the scroll anchor
  (anchored on a step id, not on a pixel offset). A step that vanished falls back to the nearest surviving ordinal.
- **Evidence in the picture.** Measured values are solid; estimated values are visually distinct (dashed outline plus an
  "est." label, never colour alone); `included` and `unknown` say so in words.
- **Detail panel.** Key/value rows from `Step.detail`, the flags with their `why` and evidence, and "Open in messages" where a
  stable source reference can navigate there (O6).

### Flow tab, as built (T8/T9)

`session/flow-view.js` (global `FlowView`, loaded after `timeline-view.js`; pure helpers exported and tested in
`test/flow-view-logic.test.js`). `#timeline-viewer` has two tabs, Events and Flow, in the `.conversation-question-tabs` classes;
`showTimelineViewer` calls `FlowView.attach`, so the sidebar button and the toolbar button both open on the last used tab (in
memory). Flow is disabled, with the reason as tooltip, when the backend's `capabilities.sessionFlow` is `no` or `unknown`, when
`window.api.getSessionFlow` is missing, or when it returns `null`. Nothing is read until the Flow tab is first shown. Single lane:
a card per row with kind badge, label, checkpoint (fill bar against the window, estimated values dashed and worded "estimated"),
turn marker, flag count; a limitations banner (every limitation, with the capabilities that point at it); groups and lane summaries
expand by click, Enter/Space or the arrow keys.

- **Windowing.** `ROW_H` 40 px, `OVERSCAN` 10, index arithmetic from scrollTop (`computeSlice`); a passive scroll listener records
  scrollTop and schedules one rAF; the slice is built in a `DocumentFragment` and swapped with `replaceChildren`; the rail comes from
  `connectorsForRows` (cap 200); `contain: layout paint` on the scroller; no animation or transition in the Flow styles.
- **Held state.** An LRU of 2 snapshots (with collapse state and selection), all dropped when the viewer is hidden (a
  MutationObserver on the viewer's `style`, together with the ResizeObserver and the `visibilitychange` listener, exists only while open).
- **Refresh and poll (T9).** The Refresh button calls `getSessionFlow` again; the selection (by step) and the scroll anchor (step id
  plus pixel offset, nearest surviving ordinal when the step vanished) are kept. `getSessionFlowStatus` is polled every 5 s through a
  setTimeout chain (no overlapping calls) only while `shouldPoll` holds: viewer open, Flow tab visible, window visible
  (`document.visibilityState`, `body.window-hidden`) and the session running (`activePtyIds`) or just ended; `grew` / `rewritten`
  show "New steps available"; one automatic refresh follows the end of the session.
- **Refresh with lanes (T13).** Refresh and the automatic refresh at the session's end keep the same held entry, so the per-lane collapse state (keys are the stable lane ids, `agent:<id>`), the selection and the scroll anchor carry over. An explicit choice wins in both directions (a finished lane the user expanded stays expanded, an open lane the user collapsed stays collapsed); with no choice an open lane is expanded and a finished one collapsed. A selected step inside a lane that is folded now resolves to the nearest folded ancestor's summary row (`resolveSelection`, over the `buildStepRowMap` lookup of G2); a selected summary whose lane is expanded now falls back to the lane's first step.
- **Status with subagents (T13).** `getStatus` is one stat of the main file, a 4 KB head read only when it moved, and, when the sources hold a `subagents-dir` (read by role, no backend id), one `readdir` plus one stat per file the last read listed (at most 200; a name that is new answers `grew` without a stat). The directory's own mtime is no signal for growth of a file inside it on Windows, so the files are stat-ed, one after the other (never in parallel: 200 at once would flood the thread pool other I/O shares). Worst case (200 files) measured about 26-36 ms wall per poll. A grown or new file, or a larger file COUNT, is `grew`; a listed file that is gone or smaller is `rewritten` (a listed file is never called gone for falling out of the capped window). The sizes are kept in main beside the fingerprint and never reach the renderer (a test deep-scans the snapshot's fingerprint). A directory that could not be listed at the read (not just absent) is listed again on the next status; a file the read could not stat is recorded as unknown, so only a later successful stat counts as a change. No poll runs while hidden or ended.
- **A deliberate read-time race.** The fingerprint (main file and subagent sizes) is taken before the worker reads, so anything written in between shows up as `grew` on the next poll: at most one spurious "new steps" hint after a read of a running session, never a missed one.
- **Instruction cards.** A step with its own token figure and no checkpoint shows `4.8k chars · ~1.2k tokens · estimated` (dashed like other estimates). Children of the start step (`parentStepId`) are drawn indented directly under START.
- **Limitations banner.** Collapsed by default to one line, `N limitations`, plus the context-window limitation when it is short (90 characters or less); a click or Enter on that line opens the full list. The state is per session, in memory, held in the same LRU entry as the collapse state (so it survives Refresh). No animation.
- **Measuring.** `FlowView.debugStats()` returns `{open, tab, steps, rows, cols, nodes, cached, timerArmed, observers, lastLayoutMs}` for the
  B1-B7 checks of the plan.

**Lanes, as built (T12).** The header of `src/shared/flow-layout.js` is the authority; the decisions:

- **A graph gutter on the left, one card per row on the right (the `git log --graph` shape).** A row belongs to exactly one lane. Every rail, dot and
  spawn/return bar lives in one gutter, `FlowLayout.gutterWidth(cols)` = `cols * 18 + 20` px wide, set once per layout as `--flow-gutter`; a row's dot sits at its
  lane's column inside it and the card starts right of the gutter, never shifted per column. The lane stays readable through the dot position and the lane tag
  (text). There is no per-column DOM, so the node count follows the row window, not the lane count, and no column virtualisation is needed (lane cap 200;
  a very wide graph widens the spacer and scrolls sideways). The bars come from the capped `connectorsForRows` list through `connectorRects`.
- **Row order is a merge, not the snapshot order** (`orderSteps`). A lane starts when its spawn step has been emitted; among the started lanes the next step
  with the smaller `ts` goes first, and with no `ts` on either side the lane started last goes first (a child finishes before its parent resumes).
  Order inside a lane is never changed. A lane whose spawn step is missing is appended after the others. The row lookup by step id is
  `buildStepRowMap(snapshot, rows, lay.order)`, built once per layout and lazily; the ordinal fallback of `resolveRowForStep` still searches the snapshot's
  monotonic ordinals and only maps the landing step to its row.
- **Columns.** The lowest column at least one right of the parent's that is free over the lane's span; the span runs to the last row of the lane or of its
  last descendant. Sequential agents share a column, overlapping ones sit side by side.
- **Connectors** are boxes inside the gutter and in the gap between two rows (`gapRow`), so none can enter a card (`connectorRects`, tested for rails and
  edges against a card box that covers everything right of the gutter): a spawn leaves the parent's rail and turns above the child's first row, a return turns
  below the child's last row and runs up or down the parent's rail. Claude's spawn and return anchor are one step, so its return runs upward to the spawn row.
  When the cap (200) bites, spawn and return edges are kept and rails are dropped first; `debugStats().connectorsTruncated` and `data-truncated` on the rails layer say so.
- **Turn bands belong to the main lane.** A child lane's rows take the band they sit in (`row.turn`); `step.turn` keeps the lane's own number.
- **Collapse.** A finished lane is one summary row at its first row; an expanded lane shows its name (`flow-lane-tag`, text, not colour) on its first row,
  and a click on the tag or Left folds it again. State is per session in memory with the groups.
- **Anchors never group.** A step that is any lane's spawn or return anchor never joins an equivalence run, so two adjacent spawn calls stay two rows,
  each with its own connector (requirement 7; the click test found them folded into "2 × Agent").
- **Nesting reads without colour.** A sibling one column to the right looks like a child, so the lane tag leads with `depth N ·` above depth 1 (the depth
  first, so the tag's ellipsis cuts the label, not the depth), and its title and accessible name say which lane started it (`laneTagInfo`).
- **Waiting.** `lane.waiting === true` draws the rail dashed. It is a reserved field: no reader emits it yet and it is not in the `FlowSnapshot` shape; add it there (and to `validateSnapshot`) when a reader emits an explicit wait event. No lane is dashed today.
- **Row lookup.** A step below a collapsed lane maps to its nearest collapsed ancestor's summary row (walking `parentLaneId`) and never uses up a hidden group's count; two root lanes keep snapshot order.
- **Lane tag on a group row.** Left folds the group there; the row's accessible name carries the tag text and the "Started by" relation, and a click on the tag folds the lane.

## Highlights (a later phase, built on flags the shape already carries)

Four axes, never merged: **risk** (destructive-command pattern, a permission mode that skips prompts, an escalated sandbox, a
guardian `risk_level` above `low`), **outcome** (allowed, blocked, denied, failed; structured only), **attention**, **lifecycle**
(from Events, E5, without merging the sources). "Highlights only" keeps prompt, spawn, return and compaction anchors and
compacts unhighlighted detail rather than dimming it. Colour is never the only signal (a glyph and a word accompany it). The
pattern list is built in, per descriptor, conservative, and labelled heuristic. Editing it is later (a bounded safe pattern
language, documented in `docs/settings-reference.md`, after false positives have been seen).

## Exports

Every export materialises the complete snapshot, not the viewport.

1. **JSON**: the `FlowSnapshot` with capabilities, limitations and evidence basis; no raw vendor records. The export dialog warns
   that prompts, commands and local paths may be present.
2. **SVG**: one complete static drawing from `flow-layout.js`.
3. **PDF**: the same layout cut into pages with repeated lane headers, loaded into a hidden window and printed with
   `webContents.printToPDF` (no new dependency; print CSS keeps a card whole). The IPC handler lives in an `src/app/` module.
4. **Mermaid**: `flowchart TD`, one `subgraph` per agent, nested. Collapsed runs are mandatory here because of Mermaid's default
   of about 500 edges (that limit is the issue's figure, **not measured**).

## Open points

**All nine decided by the owner on 2026-11-10 as recommended** (issue #826). With it the owner set one binding constraint
for every step: the flow must not slow the app down or block the main thread. Reading, parsing and fingerprinting stay off
the main thread or asynchronous and bounded; the renderer draws only the rows in view; nothing polls while the tab is not
visible.

| ID | Point | Recommendation (decided) |
|---|---|---|
| O1 | Where the reader runs: a short-lived worker per Refresh (terminate = cancel), or cooperative reading on the main thread with yields, or paging by cursor. | Worker per Refresh returning one snapshot. Cursor stays in the shape, unused. Main-thread yielding cannot bound a pathological line and shares the event loop with terminals. |
| O2 | How Codex child rollouts and the guardian rollout are found for a parent. `parent_thread_id` is in each child's header, but the session cache treats a guardian rollout as no session (`src/backends/codex/parser.js`), and **whether it indexes spawned children is not verified**. | Decide in the Codex lane step by measurement: first try the cache, else read only the first line of rollouts in the parent's date folder onward. Document the cost. |
| O3 | Whether a template/profile session inherits `sessionFlow` or lists it in `NOT_INHERITED`. | Forward it by hand like `listSubagents` (`src/backends/index.js`), since a template runs the base binary and writes the base's transcript. The shape test pins it. |
| O4 | Order of delivery: the issue's review revision puts highlights before visual exports; the task order is exports (JSON, SVG, PDF, Mermaid), then highlights. | Follow the task order (the plan does). The `Flag` field exists from the first schema, so JSON never changes shape when highlights land. |
| O5 | The step cap and what the viewer does at it. | Measure the largest local transcripts per backend in the first Claude reader step; set the cap from that; `complete: false` plus a limitation, never a silent cut. |
| O6 | "Open in messages": whether the conversation viewer can address a step by a stable reference (line, uuid). **Not verified.** | Check `src/renderer/jsonl/` in the highlights UI step; if there is no addressable anchor, ship the button without it and record the gap. |
| O7 | What "equivalent" tool calls are for collapsing. | Same tool name, same lane, same turn, no flags, adjacent. Commands may differ. The group shows the count and the distinct targets on expand. |
| O8 | Whether claude-native or pi-native declares a measured start baseline (req. 3, "may use an existing measured baseline"). | None in the first version; the start total stays `unknown` before the first request. Revisit with #758. |
| O9 | Whether the Flow tab remembers its collapse state across reopen. | Per session, in memory only, for the first version; no setting. |

### Claude reader, as built (T4/T5)

`src/backends/claude/flow-reader.js`, with the capability and limitation data in `src/backends/claude/flow-capabilities.js` (read by
both the descriptor's `sessionFlow` and the reader, so the two halves cannot disagree). **`readSessionFlow` of a streaming reader
returns a Promise** (the stub returns a value): the caller awaits it. It never rejects for a read problem; an unreadable file, an
abort and every cap end in a snapshot with `complete: false` and a limitation (`read-failed`, `aborted`, `step-cap`, `size-cap`,
`line-over-cap`, `nothing-read`), none of which names a path.

- **Reading.** `fs.createReadStream`, 64 KB chunks, split on `
` in the Buffer, a 4 MB per-line cap. A longer line is dropped as it
  streams (never concatenated, decoded or parsed) and becomes one `event` step labelled "A line exceeded the size cap" with `unknown`
  evidence and a `line-over-cap` limitation; `complete` is false. The signal is checked between chunks. No `readline`, no sync fs.
- **Caps.** 20 000 steps and an 8 MB serialised-size estimate (label and detail lengths plus a fixed overhead per step). The estimate is an approximation (string lengths, JSON escapes not counted), checked after a step and after result or summary text is added, so the real serialised size can differ by a small factor. The measured
  largest transcripts yield about a thousand steps, so the size estimate is the bound that matters; either one stops the read.
- **Steps.** `start` (the first line); `instructions` children of it (`parentStepId`, part of the shape and checked by `validateSnapshot`; characters in `detail`, `tokens` estimated as about characters / 4); `event` for a slash command (`<command-name>`, labelled with the command, its `<local-command-stdout>` folded into `detail.output`; it starts no turn); a line with `isSidechain` is skipped on the main lane until Phase 2; `prompt` (a user line
  without `isMeta`, `isCompactSummary` or `isVisibleInTranscriptOnly`; text parts or an image); `thinking`; `tool` (the call and its
  `tool_result`, paired by `tool_use_id`, `detail.tool` is the tool name on every `tool` step, the key the layout's equivalence rule reads; result and `status` in `detail`; a result with `is_error` puts an `outcome` flag, evidence `structured`, on the step so a failed call never collapses into a run); `output`; `interrupt` (`[Request interrupted by user`
  prefix); `compaction`; `mode`.
- **Checkpoints.** `message.usage` input + cache read + cache creation, `measured`, on the first step of a request (a repeated
  `message.id` is the same request); a request with a zero input has none. The window is `windowFor(parseSpec(model))` from
  `model-windows.js` and is `estimated`, decided by `resolveClaudeVariant` (#620/#621): the model's base window, the 1M window when the model string carries `[1m]`, and the 1M window when the request exceeded the base window (the floor); `unknown` for a model without a window; hence
  `contextCheckpoints` is `partial` (`window-inferred`). The reader never subtracts two checkpoints.
- **Compaction.** `detail.before` is the last non-zero request input ahead of it, `detail.after` the next non-zero one (`unknown` when
  none follows); the boundary line's `preTokens`/`postTokens` stay as `reportedPreTokens`/`reportedPostTokens`; the summary line is
  `detail.summary` of the compaction and is never a prompt. Its `checkpoint` is the "before" reading.
- **Mode.** A `mode` step on a change of `permissionMode` only; the first value is the start step's `detail.mode`. **A `type: "mode"`
  line is not a permission mode**: measured over the 150 largest local transcripts it carries only `normal` (the prompt-input mode)
  while `permissionMode` carries `auto`, `default`, `plan`, `acceptEdits`. The reader ignores `mode` lines.
- **Instruction files.** `attachment.type: "instructions"`, `files[]` of `{ path, type, content }`. An attachment can repeat in one
  transcript with `changed` and `reason` (`session_start`, `compaction`, seen on 13 of 174); each repeat lists its files again as
  children of the start step, the reason in `detail` and in the label (`CLAUDE.md (compaction)`); a repeat stays where it happened, as a child of the start step rather than of the compaction step (the compaction step is a boundary, and the repeat is the same kind of fact as the first listing). **The first attachment is moved up:** in a real transcript it comes after the first prompt, but it describes the session's start, so the reader puts it directly behind the start step (stable partition, ordinals renumbered, ids unchanged because they derive from the source line). **Labels never carry an absolute path:** relative to the session's working directory (`cwd` of the transcript lines) when the file lies inside it (`CLAUDE.md`, a file in a `rules` folder), else `~/...` for the home directory, else the last two segments behind an ellipsis; the full path is not in the snapshot at all. Start total: the first request's input, `measured`, with the `hidden-input`
  limitation (system prompt, tool definitions and memory also count; the files do not add up to it); `unknown` before a first request.
- **Subagent lanes (T11).** `sessionFlow(row)` adds one source with `role: 'subagents-dir'`: the string join `<transcript without .jsonl>/subagents`,
  no fs call in main. The reader lists that directory with `fs.promises.readdir` (an absent one is no agents) and reads each
  `agent-<id>.jsonl` after the main file with the same builder, as its own lane `agent:<id>` (kind `agent`, `parentLaneId` the lane of the spawn call, depth
  one more, in practice 1). Lines marked `isSidechain` are skipped on the main lane and read whole on a subagent's lane. A lane has its own start step
  ("Agent start"), instruction attachment (children of that start), turns, checkpoints and compactions; the session settings' window hint applies to the main lane only, a
  subagent's window comes from its own model. Step ids are `s:agent:<id>:agent:<id>:<line>:<offset>:<part>`, so they derive from the file and the line offset and not
  from an array index. **Anchors:** the spawn anchor is the parent step of the `Agent` (or older `Task`) call, found by the `toolUseId` the `.meta.json` names, else by the
  `agentId` its result carried; the return anchor is the parent step whose `tool_result` line has `toolUseResult.agentId` and is no background launch
  (`isAsync` / status `async_launched` answers at once and is not a return). The return is keyed by the spawn call's id, so a later result line carrying the same `agentId` (a continued agent) is not taken for it. The call and its result are ONE step, so both anchors name that step. With no spawn call found, the meta file's `parentAgentId` names the parent lane when that lane was read. A lane without a
  return stays open. The lane label is `agentType: description` from the meta file, truncated. **Caps and abort cover the whole snapshot**: one step count, one size estimate and one
  signal check between chunks and before each file; at most 200 lanes (`agent-lanes-cap`, chosen by id, not by start time: that would need every file opened first); a file that cannot be read is a limitation (`agent-read-failed`) and `complete: false`.
  Step `ordinal` is the index in the snapshot's `steps` (main lane first, then lanes in the order they started), so it stays one monotonic sequence.
  A lane with no step (an empty file, or no room left under a cap) is not listed. The meta file is read up to 16 KB.
- **Capabilities answered:** `agents` partial (`agents-open`: a background subagent's end is not recorded in the parent, so its lane stays open), `instructionFiles` perFile, `contextCheckpoints` partial,
  `permissionMode` yes, `approvals` no (a terminal transcript records no ask/allow), `compaction` yes, `interrupt` yes,
  `destructivePatterns` no (Phase 5), `timestamps` yes. The `sessionFlow` row of Claude and claude-native stays `limited`.

**Reader timing (T4, one machine, 2026-11-10, Node, warm disk cache).** Largest local Claude transcript (59 170 KB): 742 ms wall, peak
heap about 26 MB, 1165 steps, 961 KB serialised. A 48 MB one: 508 ms, 28 MB, 732 steps, 602 KB. A 17 MB one: 227 ms, 22 MB, 1586
steps, 1405 KB. The median-size file (775 KB): 13 ms, 10 MB, 48 steps. About 2 % of the 30 s worker timeout for the worst case; every
line is `JSON.parse`d (lines over the cap excepted), no cheap-prefix shortcut was needed.

**O5 measured (2026-11-10, one machine, `scripts/measure-flow-sizes.js`).** Claude: 2523 files, size p50/p90/p99/max 774/2464/17455/59170 KB, the largest files 674-2385 assistant steps. Codex: max 6.4 MB, at most 79 steps among the largest. Pi: max 82 MB, at most 786 steps. Steps are few, bytes many, so the binding bounds are the per-line byte cap, string truncation and the wall-clock budget (see `docs/plans/826-session-flow/PLAN.md`, "O5 input"). T4 set the caps to 20 000 steps and 8 MB of estimated snapshot size; the measured Claude maxima are about 1.2k steps and 1.4 MB.

## Known gaps (planned)

- Cross-backend session trees (#804, #806, #809) and live append are later extensions.
- A Claude background subagent (`async_launched`) is never shown as ended: the parent records its launch, and the end arrives as a later notification line the reader does not read, so its lane stays open.
- `status` notices a new or grown subagent file only for a backend whose sources name a `subagents-dir` (Claude), and it stats at most 200 `.jsonl` files (the first 200 names, sorted). Past that, only the file COUNT is compared for the rest: more files than at the read is `grew`, but growth inside a file beyond the first 200 names is not noticed (Refresh reads it). A backend with no such source is polled on its main transcript only.
- Pi subagent steps and Pi nesting cannot be drawn (no child transcript).
- Lane layout: the merge scans the active lanes per step, so 20 000 steps with 200 lanes active at once measure about 50-100 ms on a loaded
  machine, over the 16 ms budget (guard ceiling 250 ms). One lane measures 12-15 ms alone and about 16 ms under the suite's concurrency (guard
  ceiling 80 ms, so only a large regression fails it). Real sessions have far fewer overlapping agents; a heap or a worker is the answer if one is
  measured over.
- Lane layout: with `ts` on only some steps the merge compares by `ts` only where both sides have one, so such a mix can order two lanes inconsistently.
- Codex user denial, guardian `deny`, and Codex/Pi hook blocks are **not measured**.
- Pi `sections` was seen on Pi 1.1.0 only; older sessions list no instruction files.
- A Codex sandbox block and every destructive-command match are heuristics and are labelled so.
- Per-step token values exist only where a transcript measures one; the diagram never invents them.
- The pi-native "asked and allowed" state is not in the transcript and is not shown.

Related: #758 (context breakdown), #302 and #396 (timeline viewer and record), #804, #806, #809 (sessions starting sessions),
spec 28 (session health), spec 30 (pi-native), spec 32 (claude-native).
