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
       waiting?: boolean,         // present (true) only while an explicit wait call of this lane has no answer
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
loading the registry loads no reader (`test/flow-snapshot.test.js`). Every reader is built (see "Claude reader, as built", "Codex reader, as built" and "Pi reader, as built" below) and takes its capabilities from a `flow-capabilities.js` beside it, the same data the descriptor's `sessionFlow` answers (pinned in
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
| Instruction files | per file (`attachment` `instructions` `files[]`, characters) | one block (`# AGENTS.md instructions for <dir>`); `estimated` (characters / 4) | per file from `sections.project_context` (`<project_instructions path>`), **Pi 1.1.0 and newer only**; older sessions store no system message, so the start step lists none and a limitation says why |
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
- **Waiting.** `lane.waiting === true` draws the rail dashed. As built (T15): it is in the `FlowSnapshot` shape (optional, a boolean; `validateSnapshot` refuses another type) and only an explicit wait call sets it. Codex's reader sets it on a lane whose last `wait_agent` / `wait` call has no output at the end of the read and no later turn began or was aborted; no other call, no silence and no open lane makes a lane waiting. Claude's reader emits none (it records no wait event). A wait call is an ordinary `tool` step.
- **Row lookup.** A step below a collapsed lane maps to its nearest collapsed ancestor's summary row (walking `parentLaneId`) and never uses up a hidden group's count; two root lanes keep snapshot order.
- **Lane tag on a group row.** Left folds the group there; the row's accessible name carries the tag text and the "Started by" relation, and a click on the tag folds the lane.

## Highlights (a later phase, built on flags the shape already carries)

Four axes, never merged: **risk** (destructive-command pattern, a permission mode that skips prompts, an escalated sandbox, a
guardian `risk_level` above `low`), **outcome** (allowed, blocked, denied, failed; structured only), **attention**, **lifecycle**
(from Events, E5, without merging the sources). "Highlights only" keeps prompt, spawn, return and compaction anchors and
compacts unhighlighted detail rather than dimming it. Colour is never the only signal (a glyph and a word accompany it). The
pattern list is built in, per descriptor, conservative, and labelled heuristic. Editing it is later (a bounded safe pattern
language, documented in `docs/settings-reference.md`, after false positives have been seen).

Each marker says WHY (`why`, one sentence) and whether its evidence is `structured` (the transcript says so) or `heuristic` (a
pattern matched). Markers are separate facts that coexist on a step: a blocked destructive command carries a `risk` marker AND an
`outcome` marker. Only a structured outcome says whether a call ran.

*As built (T21, Claude).* Neutral matcher `src/backends/flow-patterns.js` (`matchPatterns(list, command)`: entries `{ id, test, reason, view? }`,
no backend knowledge); Claude's list, flag builders and result texts in `src/backends/claude/flow-flags.js`; the reader calls them.
T22 (Codex) and T23 (Pi) add only their own list and flag builders. Flags per step:
- `risk`, heuristic, code `destructive:<id>`: a `Bash` or `PowerShell` call whose `command` matches the list; why is the pattern's reason plus the matched
  simple command (cut to 80 characters). `risk`, structured, `mode-bypass-permissions` and `mode-accept-edits` (milder: only edits skip the
  prompt; there is no severity field, the code and the sentence carry it): on the `mode` step only, never repeated on later tool steps; a session
  that STARTS in such a mode carries it on the start step. `dontAsk`, `auto` and `plan` are not flagged.
- `outcome`, structured: `hook-blocked` (a `tool_result` that is `is_error` and whose text STARTS with `PreToolUse:<Tool> hook error`, with or without `BLOCKED` or a `[cmd]:` segment; measured in `docs/backend-formats.md`: such a result is the only result of its call, so it is read as a call that did not run, which is inferred, not observed), `permission-denied`
  (`Permission for this action was denied ...`; did not run), `hook-cancelled` (a `hook_cancelled` attachment, an `event` step), `tool-error` (any other
  `is_error`; the call ran and failed). A block or denial replaces `tool-error` rather than adding to it.
- `lifecycle`, structured, `skill-granted-tools`: a `command_permissions` attachment becomes an `event` step "Skill granted tools: <first six names, +N>". It is
  not a risk.
- Layout: a step with any flag is never part of a run of equivalent calls (O7), so a flagged call keeps its own row; a collapsed lane summary
  inherits its members' flags (`test/flow-layout.test.js`, `test/flow-claude-flags.test.js`).

Quoting rule. The command is cut to 8 KB, then into simple commands at `;`, `&&`, `||`, a lone `&` and a newline, outside quotes only. Each pattern
is anchored on the command word (leading `sudo`, `doas`, `env`, `nice`, `time`, `nohup`, `X=1` assignments and their options, including the argument of `sudo -u`, `nice -n` and `env -u`, a leading `(`, `{`, `!` or ``, and a path on the command word such as `/bin/rm` are stripped), so quoted text is data:
`echo "rm -rf /"` does not match and `rm -rf "/"` does (quote characters are dropped from arguments). A pipeline is tested whole and part by part. A
`sh -c "..."`, `bash -c`, `eval`, `cmd /c` or PowerShell `-Command` wrapper has its payload scanned (two levels). A pattern with `view: 'blanked'`
(the redirect onto a device) sees code outside quotes only. The PowerShell tool is read in the `powershell` dialect: the backtick escapes and a backslash is an ordinary
character; every other tool is POSIX. NOT looked into: `$(...)` and backticks, here-documents, aliases and shell functions, variables (`rm -rf $DIR`), `xargs`,
`find -delete`, `shred`, `truncate`, a wrapper's unquoted payload other than after `-c`, `/c` or `-Command`, `git push --mirror`/`--delete`, `git stash drop`, container and
cloud CLIs (`docker system prune`, `kubectl delete`, `terraform destroy`), and a `-- ` end-of-options marker before a prefix word. A missing mark never means safe.

Claude's list (all heuristic; a recursive delete is flagged only at a BROAD target, so `rm -rf node_modules`, `rm -rf dist/` and `rm -rf ~/projects/x` are not flagged):
`rm-recursive` (`rm -r` on `/`, `~`, `$HOME`, `.`, `..`, `*`, a drive root such as `C:/`, or one top-level directory such as `/etc`; a command that fits both it and `remove-item-recurse` is marked once, as `remove-item-recurse` under the PowerShell tool and as `rm-recursive` otherwise), `git-force-push` (`--force`, `-f`; not
`--force-with-lease`), `git-reset-hard`, `git-clean-force` (`-f`/`--force` without `-n`/`--dry-run`), `git-discard-changes` (`git checkout .`, `git checkout -- .`,
`git restore .` without `--staged`, but with `--staged --worktree`; not `git checkout -b <name> .`), `git-branch-force-delete` (`-D`), `chmod-world-writable` (recursive 777 or a+rwx), `dd-to-device` (`of=` a block device),
`mkfs`, `redirect-to-device` (`> /dev/sdX`), `pipe-to-shell` (`curl|wget ... | sh|bash`), `pipe-to-iex` (`iwr|irm ... | iex`), `remove-item-recurse` (`Remove-Item` and its aliases `rm`, `del`, `erase`, `rd`, `rmdir` with `-r` or `-Recurse`, any order with `-Force`, at a drive, home, `.`, `..`, `*` or a top-level directory of a drive), `cmd-recursive-delete` (`del|erase|rd|rmdir /s` at the same targets), `format-drive`
(`format X:`, `Format-Volume`), `sql-drop` (`DROP TABLE|DATABASE|SCHEMA`, `TRUNCATE TABLE` in a `psql`, `mysql`, `mariadb`, `sqlite3`, `sqlcmd`, `duckdb` or
`clickhouse-client` command). Bound measured by `test/flow-patterns.test.js`: pathological 8 KB inputs against the whole list finish in well under 250 ms.

## Exports

Every export materialises the complete snapshot, not the viewport.

1. **JSON**: the `FlowSnapshot` with capabilities, limitations and evidence basis; no raw vendor records. The export dialog warns
   that prompts, commands and local paths may be present.
   *As built (T17).* `src/app/flow-export.js`, IPC `flow-export { sessionId, format }`, preload `exportSessionFlow(sessionId, format)`.
   Main re-reads the snapshot through `session-flow.js` (a fresh, complete read under a key of its own, so it neither supersedes
   nor is superseded by the view's read; the worker caps still apply and a capped snapshot exports with `complete: false` and its
   limitations), runs `validateSnapshot` and refuses on failure or when there are no steps, opens the native save dialog (default
   name `<first 8 characters of the session id>-flow.json`, folder remembered under `flowExport` in `dialog-dirs.js`) and writes
   through `safe-write.js`. The file is `{ exportVersion: 1, exportedAt, app: { name, version }, snapshot }`; `sources` and the
   `fingerprint` (size, mtime, head hash of a local file) are removed, so no transcript path and no vendor record is in it. Step
   labels and details are the session's own text and stay. The answer is `{ ok, canceled, error, name }` (`name` = the file's base
   name for the toast, never a path). The `FORMATS` table in the module is where SVG, PDF and Mermaid (T18-T20) join; an unknown
   format is refused before any read or dialog. Renderer: an Export select in the Flow toolbar beside Refresh (JSON now) opens a
   question dialog, dismissible since it holds no work, warning that the file can contain prompts, commands and local paths;
   confirming opens the save dialog; a toast reports success or failure and a cancel is silent.
2. **SVG**: one complete static drawing from `flow-layout.js`.
   *As built (T18).* `src/app/flow-svg.js` (a pure string renderer; main is its only caller, so it is not in `src/shared/`), registered as `svg` in the `FORMATS` table of `flow-export.js`: same warning dialog, same fresh read, same save dialog and `safe-write.js` write, file `<8 chars>-flow.svg`. It lays the snapshot out with every lane and every run of tool calls OPEN (`FlowLayout.layout` with a state expanding everything), so the file holds every step. Geometry is the screen's: the graph (rails, dots, spawn and return bars from `connectorRects`) sits in the left gutter, cards start right of it, 40 px rows. A card has two lines: kind word, turn, lane tag, flag count and checkpoint text on the first, the label on the second; a label over 84 characters is cut for the drawing and carried in a `<title>`, up to 2000 characters. An estimated checkpoint is drawn with a dashed outline and the word "estimated" (text from `FlowText.checkpointInfo`, the one derivation). The header has the short session id, the model of the start step when there is one, the export date and app version, step and lane counts, a PARTIAL notice for an incomplete read and the limitations as text. It is a light print theme with explicit colours and a generic font stack; no script, no event attribute, no `foreignObject`, no `href`, and every text is escaped with control characters dropped. The header names the backend by the label the sidebar badge shows: the Flow view computes it with `sessionBadgeBackendId` (`dialogs/dialogs.js`, the one function the row's badge uses too: the pair's owner when a session has a Terminal/GUI pair, else the stamped backend) plus the descriptor's `label`, and hands it to `exportSessionFlow(sessionId, format, { backendLabel })`. Main takes it as a string only (trimmed, control characters dropped, at most 80 characters) and prints nothing when it is absent; it derives no backend itself, and the snapshot has no such field. The words (checkpoint figure, banner items, lane tag, row text) live in `src/shared/flow-text.js`, shared with the Flow tab. Measured: 20 000 steps render in about 0.3 s into 7.5 MB (`test/flow-svg.test.js` bounds it); the largest local Claude transcript (60 MB, 1 121 steps) read in 0.7 s and rendered in 27 ms into 0.6 MB.
3. **PDF**: the same layout cut into pages with repeated lane headers, loaded into a hidden window and printed with
   `webContents.printToPDF` (no new dependency; print CSS keeps a card whole). The IPC handler lives in an `src/app/` module.

   *As built (T19).* Registered as `pdf` in the `FORMATS` table of `flow-export.js`, the one `binary` entry: same warning dialog, same fresh read and label, file `<8 chars>-flow.pdf`; the save dialog comes BEFORE the build, so a cancel costs nothing. `src/app/flow-pages.js` (pure) lays the snapshot out fully expanded like the SVG and cuts the rows into A4 portrait pages (12 mm margins; the SVG of a page is scaled to the 186 x 272 mm box, about 29 rows a page). A row is one fixed-height card, so the cut always falls between two cards. Every page repeats a header with the short session id and "Page n of N" and the lane legend (swatch, kind and label as text, two to a line, at most 24 lanes then a count); page 1 adds the full header, counts, a PARTIAL notice and the limitations (each limitation at most 6 lines, cut with an ellipsis; the list stops at half the page with "… and N more limitations"). Page 1's row capacity is computed from the actual header height; if the header alone fills the page, page 1 holds no rows and they start on page 2. Rails: `connectorsForRows` clips each rail to the page, so a lane active over a boundary runs top to bottom on both pages. A spawn or return bar is drawn only on a page that holds both of its rows and its gap row; otherwise the rail just continues. The pages go into one static HTML document (a block per page, `page-break-after: always`, `@page { size: A4; margin: 0 }` with the margin as block padding so it holds with or without `preferCSSPageSize`), with a CSP of `default-src 'none'`, no script, no `href`. `src/app/flow-pdf.js` writes it as `page.html` into a fresh `mkdtemp` directory under the system temp directory with plain `fs` and the flag `wx` (no CLI reads it, nothing else writes it, the directory is new; a data URL is capped near 2 MB), loads it in a hidden `BrowserWindow` (`show: false`, `sandbox`, `contextIsolation`, no Node, no preload, `javascript: false`, navigation and new windows refused) and calls `printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true })`. The window is destroyed on success, on failure, at a 60 s timeout and at quit; the temp directory is removed in every case, and synchronously by `destroyPending()` at quit. One PDF export at a time: a second one is refused with a sentence. The bytes are written atomically by `safeWrite.writeBinaryFile` (temp file and rename, no encoding rules). Bound: `MAX_PAGES = 300` (about 8 700 rows); a longer flow is cut off, page 1 says "PAGE LIMIT: only the first N of M rows" in bold and points to JSON or SVG for the complete flow. Measured with a 20 000-step snapshot (20 001 rows): building the 300 pages and the HTML took about 0.12 s and +35 MB of memory for a 2.8 MB document; the print itself was measured by the click test on one machine, a synthetic session, 2026-11-11: 4 004 steps gave 173 pages in about 8 s including the dialog automation, a 3.9 MB PDF, no split card, rails continuing across the breaks, no temp file left. A 20 000-step print is not measured, which is why 300 pages is a conservative figure and not a limit found in Chromium.
4. **Mermaid**: `flowchart TD`, one `subgraph` per agent, nested. Collapsed runs are mandatory here because of Mermaid's default
   of about 500 edges (that limit is the issue's figure, **not measured**).

   *As built (T20).* `src/app/flow-mermaid.js` (pure, main-only), registered as `mermaid` in the `FORMATS` table of `flow-export.js`: same warning dialog, same fresh read, label and save dialog, file `<8 chars>-flow.mmd`, filter "Mermaid". Lanes are all open and each run of equivalent tool calls is ONE node ("tool: 3 × Read"); a node is `n<row index>` with a quoted label (kind word, label cut at 60 characters, the checkpoint figure as plain text, an estimated one with the word "estimated"). The main lane is at the top level, every other lane a `subgraph l<n>["kind: label"]` nested inside its parent lane's. Edges: in order inside a lane (`-->`), spawn from the parent's anchor to the child's first node (`-->|spawn|`) and return from the child's last node (`-.->|return|`). Escaping: inside a label `"` becomes `#quot;` and every other character Mermaid, HTML or a markdown string could read (number sign, percent, ampersand, semicolon, angle brackets, square and curly brackets, parentheses, the vertical bar, the backslash and the backtick) a numeric entity like `#40;`; control characters and line breaks are dropped or folded to a space. A comment line carries no curly brace (braces become parentheses), because Mermaid reads a `%%{…}%%` directive anywhere in the text, comment lines included, and the model name and limitation texts come from the transcript. The output holds only comments, `flowchart TD`, `subgraph` / `end`, nodes and edges: no `click`, `href`, `call`, `style` or `%%{init}`. The header is comment lines (short session id, backend label, model, export date, app version, limitation count, steps and lanes, PARTIAL notice) and one `%% limitation:` line per limitation. Bound: `MAX_EDGES = 450` (below Mermaid's default of 500, which is not measured here); over it the diagram folds to one node per lane and turn ("turn 3: 12 steps") with a `%%` comment, and if it still passes the limit it is cut at the node where the budget ends with a `%% truncated: the first N of M nodes` comment. Tests: golden bodies for the Claude parent and child, the Codex parent and spawned child and the Pi session, read through the real readers (`test/flow-mermaid.test.js`).

## Open points

**All nine decided by the owner on 2026-11-10 as recommended** (issue #826). With it the owner set one binding constraint
for every step: the flow must not slow the app down or block the main thread. Reading, parsing and fingerprinting stay off
the main thread or asynchronous and bounded; the renderer draws only the rows in view; nothing polls while the tab is not
visible.

| ID | Point | Recommendation (decided) |
|---|---|---|
| O1 | Where the reader runs: a short-lived worker per Refresh (terminate = cancel), or cooperative reading on the main thread with yields, or paging by cursor. | Worker per Refresh returning one snapshot. Cursor stays in the shape, unused. Main-thread yielding cannot bound a pathological line and shares the event loop with terminals. |
| O2 | How Codex child rollouts and the guardian rollout are found for a parent. | **Answered (T15).** The session cache does NOT hold spawned children: `src/backends/codex/parser.js` marks any rollout with a `source.subagent` header internal and `buildRow` returns null for it, so the guardian and every spawned child are absent from the cache by design (#492), and indexing them would put them in the sidebar. So the worker reads headers, bounded by the parent's time window taken from file names: see "Codex reader, as built (T14, T15)", "Finding the children". Cost measured there. |
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
  `destructivePatterns` yes (T21; limitation `patterns-heuristic`: the list is a heuristic), `timestamps` yes. The `sessionFlow` row of Claude and claude-native stays `limited`.

**Reader timing (T4, one machine, 2026-11-10, Node, warm disk cache).** Largest local Claude transcript (59 170 KB): 742 ms wall, peak
heap about 26 MB, 1165 steps, 961 KB serialised. A 48 MB one: 508 ms, 28 MB, 732 steps, 602 KB. A 17 MB one: 227 ms, 22 MB, 1586
steps, 1405 KB. The median-size file (775 KB): 13 ms, 10 MB, 48 steps. About 2 % of the 30 s worker timeout for the worst case; every
line is `JSON.parse`d (lines over the cap excepted), no cheap-prefix shortcut was needed.

### Codex reader, as built (T14, T15)

`src/backends/codex/flow-reader.js` with its data in `src/backends/codex/flow-capabilities.js` (read by the descriptor's `sessionFlow` and by the
reader, so the two cannot disagree). The reading primitives are shared: `src/backends/flow-lines.js` holds the bounded line reader (64 KB chunks,
4 MB per-line cap, abort between chunks), the step and size caps (20 000 steps, 8 MB estimate), `trunc` / `firstLine` / `detailSize` / `evidence`,
extracted from Claude's reader so the two cannot drift on a cap. Only the format stays in the backend folder. Lanes: `main` and, since T15, one lane per
spawned subagent (below). A guardian rollout is not a session and is never a lane.

- **Steps.** `start` (the first line); one `instructions` child for the AGENTS.md message (a user `message` whose part starts `# AGENTS.md instructions`):
  characters in `detail`, `tokens` basis `estimated` (about characters / 4, as for Claude; the block is part of the first request's input), no per-file split because
  Codex names no files; a later copy is labelled "(again)". `prompt` is a user `message` that is not an injection (the AGENTS.md part, `<environment_context>`,
  `<turn_aborted>`, `<user_instructions>`, `<no retained transcript`, `<subagent_notification>` parts are dropped; a `<user_shell_command>` part (the user's own `!` line) is an `event` step "Shell command: ..." and starts no turn; a `developer` message is
  ignored); `thinking` for `reasoning` (its summary text when there is one: the local ones are empty); `output` for an assistant message (`phase` in `detail`);
  `tool` for `custom_tool_call` (`exec`) and `function_call`, paired by `call_id` with `custom_tool_call_output` / `function_call_output`
  (an output is a parts list or a string); `detail.tool` is the tool name on every tool step. The brief of a function call is the first of
  `cmd`, `command`, `message`, `task_name`, `prompt`, `path`, `target`, `query` (the arguments are parsed only up to 64 K characters).
- **Failure.** Codex records no status for a call. A call is marked failed (`detail.status` `error`, `detail.exitCode`, an `outcome` flag `tool-error`) when its
  output HEAD reads `Exit code: N` or its last line reads `exit_code=N` with N non-zero. The flag's evidence is `heuristic`, not `structured` as for Claude's `is_error`,
  because the code is read out of text. A code quoted in the middle of a script's output is no verdict, and the code-mode `exec` prints none, so most
  local failures are not marked (limitation `failure-from-text`).
- **Checkpoints.** `event_msg` `token_count`: `info.last_token_usage.input_tokens` (it already includes the cached part), `measured`, with the window
  `info.model_context_window` as `measured` too (the CLI reports it; unlike Claude's it is not inferred, so `contextCheckpoints` is `yes`). It sits on the first
  `thinking` / `tool` / `output` step since the last checkpoint, else on a `checkpoint` step. A record with input 0 (the one after a compaction) is skipped, a record
  without `info` (rate limits only) is skipped, and a record with the same total and input as the last is the same request reported again.
- **Compaction.** The top-level `compacted` line: `detail.before` the last non-zero input ahead of it, `detail.after` the next non-zero one (`unknown` when none
  follows), `detail.windowNumber` from `window_number`, and a checkpoint with the "before" reading. The line's `latest_token_usage_record` is the summarising call
  and is never read (spec 28); the replacement history is not read either.
- **Interrupt.** `turn_aborted` becomes an `interrupt` step (`reason`, `durationMs`).
- **Mode.** `turn_context` `approval_policy` and `sandbox_policy.type`, joined as `on-request, workspace-write`; the first is the start step's `detail.mode`, a `mode`
  step appears only when the pair changes. `detail.model` of the start step and the checkpoints' `model` come from `turn_context.model`.
- **Capabilities answered:** `agents` `partial` (`agents-partial`), `instructionFiles` `block` (`instructions-block`), `contextCheckpoints` `yes`, `permissionMode` `yes`, `approvals` `no`
  (a rollout records no ask/allow; the guardian's verdict is in another rollout), `compaction` `yes`, `interrupt` `yes`, `destructivePatterns` `no` (later), `timestamps` `yes`.
  The `sessionFlow` row of Codex stays `limited`. The session settings' window hint is not used: the rollout reports the window.

- **Finding the children (T15, O2).** `sessionFlow(row)` adds a source with the role `rollout-scan` naming the parent rollout's folder (a string join; no fs call in
  main). A child is spawned by a call of the parent, so its rollout STARTS while the parent runs. The reader takes the window from the parent's own first and last
  line timestamps, plus 2 minutes of slack on each side, and works from file NAMES: a rollout's name begins with its start time in LOCAL time
  (`rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl`, measured against the header's UTC timestamp), and Codex files it under `<root>/<year>/<month>/<day>/`. So it builds the day
  folders of the window from the calendar (no listing of the store; a missing folder reads as empty), lists each, and opens only a rollout whose name time lies in the
  window. Opening one reads the first 4 KB: in a header `source` comes BEFORE the very large `base_instructions` (measured: `source` at about byte 470-590, `base_instructions`
  at 540-910, the line about 19 KB), so a head that shows `source` without `thread_spawn` (an ordinary session, a guardian's `source.subagent.other`) is dropped
  there; only a candidate is read on, in steps up to 64 KB and to the end of its line. A first line longer than that (or one that does not parse) is not dropped: `id` and the flat `thread_spawn` object are taken from the bytes already read by a bounded pattern match, since `source` precedes `base_instructions`; if even that fails for a header that names a `thread_spawn`, the snapshot is `complete: false` with `agent-header-unreadable`. The name filter looks one hour further back than the window (names are local time, so the autumn clock change can put a name an hour off); that costs a few extra 4 KB heads. **A child that ran longer than the parent widens the window:** after the children found are read, the upper bound moves to the latest last line among them (plus the slack) and only the new range is searched, up to 4 rounds, so a grandchild spawned by a long-running child is found. A header with `thread_spawn.parent_thread_id` naming the session or a child already found is a
  child, so one pass in name order finds a whole tree. Without a timestamp to build a window from, only the parent's folder is read, after the parent. Bounds:
  2 000 rollouts opened, 31 calendar days over all widening rounds, 200 lanes, 4 widening rounds (running out of rounds with time still unsearched counts); reaching one is `complete: false` with `agent-scan-cap`, otherwise the search is complete (the earlier
  "older than a week" blind spot is gone). The worker may report the counts to a caller (`opts.onScan`: folders, rollouts listed and opened, bytes read).
  **Measured (one machine; the only local store is one day folder of 16 rollouts, 2 sessions with 3 children each, 8 guardian rollouts):** per session 1 folder
  listed (16 names), 6-7 rollouts opened, 86-90 KB read (a guardian costs 4 KB, a child about 25 KB), 160-240 ms for the whole read including the scan and the children's
  lanes. The earlier whole-folder version opened 16 rollouts at 64 KB each (up to 1 MB). A session with no children in a quiet period opens only the few rollouts
  that started during it; no old session without children exists in the local store, so that case is a bound by construction (opened = rollouts that started within
  the session's own span) and not a measurement.
- **Lanes (T15).** Lane id `agent:<thread id>` (the header's `id`), `parentLaneId` the lane of the thread named by `parent_thread_id` (main, else the child that
  spawned it; one that was not read hangs on main), depth counted up the chain (header `depth` is not used); a lane re-parented onto main because its chain is deeper than 8 or loops loses both anchors, which named steps of the lane it came from. Label: `agent_nickname` (else the last segment of
  `agent_path`) plus `: <agent_role>`; no path. Step ids derive from the lane id and the source line like Claude's.
- **Anchors.** The `spawn_agent` call's output names NO child id (measured: `{"task_name"}` only), so the spawn anchor is the parent lane's first unused
  `spawn_agent` call whose `task_name`, appended to the spawning lane's own path (`/root` for main, else its `agent_path`), equals the child's `agent_path`; a
  call that matches nothing leaves `spawnAnchor` null. The return anchor is the first `agent_message` in the parent lane whose `author` is the child's
  `agent_path` (Codex delivers a child's result to its parent as that message; `recipient` is the parent's path), shown as an `agent` step "Message from <name>". A
  `wait_agent` output (`{message, timed_out}`) names no child, so it is no anchor. A child with no such message keeps `returnAnchor: null` and stays open.
- **Agent messages.** The top-level `inter_agent_communication_metadata` line (`trigger_turn`) precedes an `agent_message`. With `trigger_turn: true` the message starts a turn
  of the receiving agent, so it is that lane's `prompt` step (`detail.startedBy: "agent"`, `from`), not the user's; with false it is an `agent` step. A message whose author
  is the lane's own path (the echo of what it sent) is skipped. `send_message` is an `event` step "Message to <name>: ..." on the sender's lane.
- **Waiting.** `waiting: true` goes on a lane only when its LAST `wait_agent` / `wait` call has no output at the end of the read and no turn began (a user prompt or a turn another agent started) and none was aborted (`turn_aborted`) since; an earlier unanswered wait, an answered one and every other call do not set it.
- **Status poll.** The worker reports each child rollout it read (`onFiles`: file and size, taken before the read) next to the snapshot; main keeps them with the
  fingerprint and `status` stats them in sequence (a larger one is `grew`, a smaller or removed one `rewritten`). A new child needs no check of its own: the
  parent's rollout grows when it spawns. Paths stay in main; the snapshot has none.

**Reader timing (T14, one machine, 2026-11-11, Node, warm cache).** Largest local Codex rollout (4 703 KB): 116 ms, 43 steps, 73 KB serialised; a median one
(409 KB): 10 ms, 37 steps.

### Pi reader, as built (T16)

`src/backends/pi/flow-reader.js` with its data in `src/backends/pi/flow-capabilities.js`; the bounded line reader, the caps and `instructionLabel` (moved out of Claude's reader so the two label a file the same way) are in `src/backends/flow-lines.js`. One lane. pi-native resolves through the same reader (it forwards Pi's two hooks).

- **Steps.** `start`; one `instructions` child per `<project_instructions path="...">` block of the `system` message's `sections.project_context` (characters in `detail`, tokens `estimated` at characters / 4; the label is relative to the session `cwd`, else `~/...`, else an ellipsis and the last two segments, never an absolute path); `prompt` for a `user` message; for an `assistant` message one step per block in order: `thinking` (`thinking`), `output` (`text`), `tool` (`toolCall`, `detail.tool` is the name), paired by id with the `toolResult` message. Only the ACTIVE branch is shown: Pi stores a tree, and the reader keeps each entry's `id` / `parentId` and the entry of each step, then at the end keeps the steps on the chain from the last entry back to the root (`src/backends/pi/active-branch.js`, the walk the parser and the transcript view use too), renumbering `ordinal` and `turn`. A compaction's `after` and the start total come from the active branch only. Steps of an abandoned branch still count against the step and size caps while the file is read. A compaction does not re-root the chain (measured: every local Pi session's chain is its whole file; none has a branch point), so history before a compaction stays. A line skipped over the line cap (or unparsable) would break the chain, since the entry after it names a parent never seen; without a remedy the walk stopped at the gap and cut all earlier history (measured: two skipped image lines took the largest session from 1 599 to 281 steps). `readLines` hands the first 512 bytes of a skipped line to `onOversize`, Pi writes `type`, `id`, `parentId` first (verified on the two skipped lines of the largest session), and the reader records the real link from that head. Only when the head shows none, the unknown parent is bridged to the entry before the gap, which assumes the skipped line sat on the active branch. A line that does not parse is such a gap too (limitation `line-unparsed`, `complete` false); the last line alone is not counted, since a transcript being written may end in half a line. On a cap or an abort the leaf is the last entry read, so the kept branch may differ from the finished session's (the snapshot is `complete: false` then). A user's own `!` shell line (`bashExecution`) is an `event` "Shell command: ...", starting no turn. `model_change`, `thinking_level_change`, `custom_message` and the branch summaries are not steps.
- **Instruction files.** `perFile`, with limitation `instructions-version`: Pi writes the `system` message from 1.1.0; a session without one gets the reader limitation `instructions-not-recorded` and no instruction steps. That is a limitation, not an error (`complete` stays true).
- **Checkpoints.** `usage.input + cacheRead + cacheWrite` of an assistant message, `measured` (key names verified against local Pi sessions: `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost`, sometimes `reasoning`). It sits on the first step of that message, or on a `checkpoint` step when the message has none. The window is Pi's own catalog (`./model-windows`, the lookup the health badge uses, keyed by the message's `provider` and `model`), `measured`; a model the catalog does not list reads `unknown` (capability `contextCheckpoints` `partial`, limitation `window-from-catalog`). The reader reads that catalog (two small JSON files, held a few seconds) inside the worker.
- **Interrupt.** An assistant message with `stopReason: "aborted"` is an `interrupt` step; its usage is zero, so it gets no checkpoint (spec 28). `stopReason: "error"` is an `event` step ("The model call failed") with the error text; local sessions hold both (3 aborted, 23 error in the 1 443 assistant messages measured).
- **Compaction.** The `compaction` entry: `detail.before` and the step's checkpoint are `tokensBefore` (`measured`), `detail.after` is the next non-zero request input (`unknown` when none follows). The entry's `usage` is the summarising call and is never read.
- **Failure and refusal.** A `toolResult` with `isError: true` gets the `outcome` flag `tool-error` with evidence `structured`, and `detail.status` `error`. When its text is exactly `The user did not allow this <tool> call.` (the pi-native gate's refusal, `src/backends/pi-native/runtime-extension.js`) the step also has `detail.refused: true`; the later highlight phase reads it. An ordinary error is not a refusal, and neither is a delegation the gate refuses up front (`runtime-extension.js`, the `refused` branch of the `tool_call` handler: a different reason text), which is a plain tool error.
- **Subagent.** The app's `subagent` tool is ONE `tool` step with `detail.kind: "agent"`, `detail.agent` and, parsed from the `[subagent <name>: N turns, I in / O out tokens, $C, <model>]` line the tool writes at the end of its result, `detail.turns`, `inputTokens`, `outputTokens`, `costUsd`, `model`. No lane (the child runs with `--no-session`): `agents` is `partial`, limitation `agents-summary-only`. No local session holds a delegation, so the line's format is taken from the tool's source, not from a transcript. An agent name containing `:` or `]` does not match the line, so that node shows no numbers (it fails safe).
- **Mode and approvals.** `permissionMode` `no` (Pi records none). The start step's `detail.approvals` says once that terminal Pi has no approval step; when the `switchboard-transport` `custom` entry names a transport (the marker `src/backends/pi/transport-marker.js` reads), it says the app's gate asks instead, with an answer not recorded and a refusal shown as a refused call. `approvals` is `partial` (limitation `approvals-by-transport`). The core names neither backend.

**Reader timing (T16, one machine, 2026-11-11, Node, warm cache).** Largest local Pi session (83.8 MB): about 450 ms, 1 599 steps, 1.6 MB serialised; the read is incomplete there (`line-over-cap`: lines over 4 MB, images, are skipped unread). The plan's note that readline took over 120 s on it was the reason for the bounded reader.

**O5 measured (2026-11-10, one machine, `scripts/measure-flow-sizes.js`).** Claude: 2523 files, size p50/p90/p99/max 774/2464/17455/59170 KB, the largest files 674-2385 assistant steps. Codex: max 6.4 MB, at most 79 steps among the largest. Pi: max 82 MB, at most 786 steps. Steps are few, bytes many, so the binding bounds are the per-line byte cap, string truncation and the wall-clock budget (see `docs/plans/826-session-flow/PLAN.md`, "O5 input"). T4 set the caps to 20 000 steps and 8 MB of estimated snapshot size; the measured Claude maxima are about 1.2k steps and 1.4 MB.

## Known gaps (planned)

- Cross-backend session trees (#804, #806, #809) and live append are later extensions.
- A Claude background subagent (`async_launched`) is never shown as ended: the parent records its launch, and the end arrives as a later notification line the reader does not read, so its lane stays open.
- `status` notices a new or grown subagent file only for a backend whose sources name a `subagents-dir` (Claude), and it stats at most 200 `.jsonl` files (the first 200 names, sorted). Past that, only the file COUNT is compared for the rest: more files than at the read is `grew`, but growth inside a file beyond the first 200 names is not noticed (Refresh reads it). A backend with no such source is polled on its main transcript only.
- Pi subagent steps and Pi nesting cannot be drawn (no child transcript): a delegation is one summary step (T16). The summary line's format is read from the tool's source; no local session holds a delegation.
- Lane layout: the merge scans the active lanes per step, so 20 000 steps with 200 lanes active at once measure about 50-100 ms on a loaded
  machine, over the 16 ms budget (guard ceiling 250 ms). One lane measures 12-15 ms alone and about 16 ms under the suite's concurrency (guard
  ceiling 80 ms, so only a large regression fails it). Real sessions have far fewer overlapping agents; a heap or a worker is the answer if one is
  measured over.
- Lane layout: with `ts` on only some steps the merge compares by `ts` only where both sides have one, so such a mix can order two lanes inconsistently.
- Codex user denial, guardian `deny`, and Codex/Pi hook blocks are **not measured**.
- Pi `sections` was seen on Pi 1.1.0 only; older sessions list no instruction files (shown as the limitation `instructions-not-recorded`). The Pi reader shows the active branch only (abandoned steps still count against the caps), and a model missing from Pi's catalog has an unknown window.
- A Codex sandbox block and every destructive-command match are heuristics and are labelled so.
- Codex (T15): a header whose fields cannot be read at all (a `thread_spawn` seen, no `id` in the first 64 KB) is reported as `agent-header-unreadable`, not dropped; a first line over 64 KB whose `source` object and `id` lie inside those bytes is read by pattern, not by a full parse.
- Codex (T15): a child lane exists only if its rollout starts within the parent's first-to-last-line window (plus 2 minutes) and the search bound (2 000 rollouts opened, 31 days, 200 lanes, 4 widening rounds) was not hit; a parent that is still running has a window that ends at its last written line; the spawn-to-lane link rests on the task name matching the child's path (a repeated task name pairs calls and children in order); the child's result is the first message from its path, so a continued or second result is not a second return.
- Codex (T14): a failed call is recognised only from an `Exit code: N` head or an `exit_code=N` last line, neither of which was seen in a local rollout (the code-mode `exec` prints no exit code), so failures are probably under-marked. `turn_aborted` was not in the local rollouts either. Codex shows one AGENTS.md block, never per file, and no subagent lane until T15.
- Per-step token values exist only where a transcript measures one; the diagram never invents them.
- The pi-native "asked and allowed" state is not in the transcript and is not shown.

Related: #758 (context breakdown), #302 and #396 (timeline viewer and record), #804, #806, #809 (sessions starting sessions),
spec 28 (session health), spec 30 (pi-native), spec 32 (claude-native).
