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

The module is `src/shared/flow-snapshot.js` (pure, no fs, path, DOM or crypto). Until T7/T8 first load it in the renderer it is a
main and worker module only: it has no `<script>` tag and no `script-order.json` entry, which makes it a temporary third
exception to `.claude/rules/renderer.md` "`src/shared/`" (modules both processes load). T7/T8 add the tag and the entry, and
that rule's list is updated then. The body is wrapped, so a classic-script load adds one global (`FlowSnapshot`) and none of its
helper names; in main and a worker it is `require()`d.

Its sibling `src/shared/flow-layout.js` (T7: pure layout and collapse, one global `FlowLayout`) is the renderer's from T8 on
and main's once the exports (T18-T20) lay out a full snapshot there; until then tests alone load it. The two are the Flow pair
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
   // null = this backend has no usable flow reader; Flow is disabled and Events stays.
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
| Lanes | main plus `subagents/agent-<id>.jsonl`, joined by `agentId` in the parent's `tool_result`; depth 1 in practice | child rollouts; `source.subagent.thread_spawn` states `depth` and `agent_path`; parent side `spawn_agent`, `wait_agent`, `wait`, `send_message`; `inter_agent_communication_metadata` marks a turn another agent started | single lane; the app's `subagent` call is one collapsed node (call plus the one summary line), never a lane, and Pi nesting cannot be shown. No built-in subagents. |
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
- **Off the main thread, cancellable.** A short-lived `worker_threads` Worker (src/workers/flow-worker.js (new)) per Refresh, started
  and terminated by src/app/session-flow.js (new). Termination is the cancel; a second Refresh while one runs cancels the first.
  The worker resolves the backend by id through the registry (the way `index-worker.js` does), streams each file line by line,
  and returns one `FlowSnapshot`. Recommendation and alternatives: O1.
- **File fingerprints.** The read records, per source file, size, mtime and a hash of a leading and a trailing chunk. A cheap
  `status` call (main thread, `fs.stat` only) compares them and lets the viewer say "newer steps available". If a file shrank or
  its leading chunk changed, the next Refresh is a full rebuild; there is no incremental append in the first version.
- **Caps.** The reader stops at a step cap and sets `complete: false` with a limitation. The number is measured on the largest
  local transcripts in the first reader step, not guessed (O5).
- **Paths.** The renderer sends a session id, never a path. Main resolves the sources from the cached row (reflex 13: any guard
  on a path decides on real paths through `src/app/path-containment.js`). Exports never contain raw vendor records; instruction
  file paths and commands may appear, hence the export warning.
- **Probes.** The structure-only probes are kept under `scripts/` (see the plan, T1) and listed in `docs/settings-reference.md`.

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
  children of the start step, the reason in `detail`. Start total: the first request's input, `measured`, with the `hidden-input`
  limitation (system prompt, tool definitions and memory also count; the files do not add up to it); `unknown` before a first request.
- **Capabilities answered:** `agents` partial (subagent lanes are Phase 2), `instructionFiles` perFile, `contextCheckpoints` partial,
  `permissionMode` yes, `approvals` no (a terminal transcript records no ask/allow), `compaction` yes, `interrupt` yes,
  `destructivePatterns` no (Phase 5), `timestamps` yes. The `sessionFlow` row of Claude and claude-native stays `limited`.

**Reader timing (T4, one machine, 2026-11-10, Node, warm disk cache).** Largest local Claude transcript (59 170 KB): 742 ms wall, peak
heap about 26 MB, 1165 steps, 961 KB serialised. A 48 MB one: 508 ms, 28 MB, 732 steps, 602 KB. A 17 MB one: 227 ms, 22 MB, 1586
steps, 1405 KB. The median-size file (775 KB): 13 ms, 10 MB, 48 steps. About 2 % of the 30 s worker timeout for the worst case; every
line is `JSON.parse`d (lines over the cap excepted), no cheap-prefix shortcut was needed.

**O5 measured (2026-11-10, one machine, `scripts/measure-flow-sizes.js`).** Claude: 2523 files, size p50/p90/p99/max 774/2464/17455/59170 KB, the largest files 674-2385 assistant steps. Codex: max 6.4 MB, at most 79 steps among the largest. Pi: max 82 MB, at most 786 steps. Steps are few, bytes many, so the binding bounds are the per-line byte cap, string truncation and the wall-clock budget (see `docs/plans/826-session-flow/PLAN.md`, "O5 input"). T4 set the caps to 20 000 steps and 8 MB of estimated snapshot size; the measured Claude maxima are about 1.2k steps and 1.4 MB.

## Known gaps (planned)

- Cross-backend session trees (#804, #806, #809) and live append are later extensions.
- Pi subagent steps and Pi nesting cannot be drawn (no child transcript).
- Codex user denial, guardian `deny`, and Codex/Pi hook blocks are **not measured**.
- Pi `sections` was seen on Pi 1.1.0 only; older sessions list no instruction files.
- A Codex sandbox block and every destructive-command match are heuristics and are labelled so.
- Per-step token values exist only where a transcript measures one; the diagram never invents them.
- The pi-native "asked and allowed" state is not in the transcript and is not shown.

Related: #758 (context breakdown), #302 and #396 (timeline viewer and record), #804, #806, #809 (sessions starting sessions),
spec 28 (session health), spec 30 (pi-native), spec 32 (claude-native).
