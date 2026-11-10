# 45 — Idle session maintenance

Issue: #827. Status: **built**, first stage, on the pipe-driven backends. This file is the design record: the owner's decisions,
what was measured, the shape as built, and what is still open.

As built, against the design below: the running-session control is one button in the session line that opens a popover (#832).
A click opens it and nothing else does: no modifier click and no arrow-key step. The popover offers Settings, Off, Keep warm,
Compact only and Warm then compact as this session's override (Settings drops the override), shows the state asked fresh when it
opens (next action and time, refreshes of the limit, the last cache verdict, the reason it ended or is refused), says that each
refresh and compaction is a real model turn and that compaction cannot be undone, and links "All settings…" to the project
settings window at category `idle-maintenance` (the global one for a session that names no project). Escape or a click outside closes it and the caret returns to the button; the
button's title stays short. A maintenance turn read back is matched by key,
else by its exact words, once per record, without the `sent_at` compare. A user's own compaction counts as a turn and starts a
new idle period.

## The problem

A coding CLI keeps a prompt cache for the conversation it holds. When the user steps away, the cache ages out; the
next prompt then pays full price for the whole context and waits for it. Two things help, and both are turns the app
would send without the user asking:

- **Warm** — a minimal turn that re-reads the prefix and so refreshes the cache before it expires.
- **Compact** — shrink the conversation while the user is away, so the next prompt starts from a smaller context.

Both spend real tokens unprompted. That is the cost of the feature and the UI has to say so (see "New flow").

## Owner decisions (binding, 2026-11-09, on the issue)

| ID | Decision |
|---|---|
| E1 | Stages, pipe-driven first. The neutral capability comes first and every backend answers or declines it; only claude-native and pi-native deliver real actions. |
| E2 | Terminal backends decline for now, Hermes included (`/compress` would need the PTY path this issue rules out). Narrows the Hermes note on the issue. |
| E3 | No before-known-expiry mode until a backend supplies an expiry. Measured: a lifetime class, no expiry time. |
| E4 | The running-session override is in the first stage. |
| E6 | The backend answers its lifetime class; an interval that would arrive cold is refused. Measured on Pi: a bound between 300 and 315 seconds, from one sample with six sessions (`docs/backend-formats.md`, "How long Pi's cache holds"). |
| E7 | A maintenance turn is recognised after a restart through a record in the app's database keyed on the entry, never a marker in the prompt text. Measured: a key at send time on Claude, none on Pi, which takes the named fallback (see "E7" below). |
| E8 | A per-turn flag in `src/app/agent-rpc.js` silences attention and keeps pending shell lines. Usage, cost and stats keep counting. Last activity moves (it comes from the CLI's own file). |
| E14 | The first refresh also falls within `maxRefreshMs` of the last turn; the idle time applies to compaction only. On Pi, three refreshes extend the cache by about 13.5 minutes. |
| E15 | Build without first measuring a real Pi conversation or the jump in its prompt. Pi stays `limited` and shows best effort. |

First-stage modes: **Off, Keep warm, Compact only, Warm then compact**, a finite **refresh limit** and a **hard ceiling**.

## What was measured (do not re-derive)

`docs/backend-formats.md`, "What a turn says about the prompt cache" and "How long Pi's cache holds". Claude has one run and no threshold.

- `cache_read > 0` is not proof of a warm cache. Compare read against the previous turn's prompt
  (input + read + write). Claude T2 83 %, T3 99.9 %.
- Lifetime class: Claude wrote the 1-hour class, Pi did not; Pi missed after 6.5 minutes (read 0, about nine times the cost).
- The usage figures and the lines logged name no expiry time; the rest of each stream was not inspected. A Claude miss is unmeasured (needs over an hour).

## What the code does today (verified for this spec)

- A maintenance turn sent through `sendTurn` (`src/app/agent-rpc.js:1545`) while busy is HELD (`:1565`) and later sent
  as an ordinary prompt by `flushHeld` (`:1246`). It needs its own gate.
- `deliverShellCarry` (`:664`) already gates on the right set of conditions (exited, busy, paused queue, in flight, open
  asks, held prompts, owed turn). The maintenance gate is that set plus a draft check.
- `sendTurn` does not look at `heldInFlight` (set only by `flushHeld`, `:1250`). On a runtime that acknowledges its
  turns (pi-native) busy begins only at `agent_start`, so a user send in the gap is written into Pi. Measured: Pi refuses
  such a prompt rather than queueing it. On claude-native (`sendAcknowledged: false`) the write is the busy edge (`:1198`), so a later send is
  held and runs next.
- The attention path is `report('idle')` (`:801`) -> `hooks.deliverBindSignal`; the busy edge also clears the
  suggestion and start notices (`:793`, `:796`) and unread ready state; a turn takes the pending shell lines
  (`carryFor`, `:646`, used at `:1185`). `session._review` (`src/app/hooks.js:273`) silences a whole session and is not a
  per-turn seam.
- `/compact` is not an ordinary prompt on either pipe. Claude: a local command, never played back; the decoder draws a
  `/` line itself from `noteSent`, the transcript keeps `<command-name>` markup (spec 32, "Slash commands"). Pi: an
  extension command registered by the runtime extension, refused while a turn runs (spec 30, "Pi's own commands"). Pi
  also takes an RPC `compact`, measured with no `agent_start` and no `agent_settled`; Claude's ends in `result`
  (`docs/backend-formats.md`, "What idle maintenance can rely on"). A warm turn, by contrast, reads back as a user
  prompt on both (`src/backends/claude-native/rpc-protocol.js`, `src/backends/pi-native/rpc-protocol.js`).
- Settings: `effectiveSettings` (`src/app/settings.js:467`) has two levels (global, project through
  `settingsOwnerPath`, `src/shared/worktree-path.js`) and cascades backend defaults per option. A running-session level
  does not exist.
- Capability rows are declared in `CATALOG` (`src/backends/capabilities.js:41`); each row names `declaredBy`, every
  backend answers `yes` / `limited` (with a note) / `no`; `test/backend-capabilities.test.js` pins each answer. A
  template copies capabilities by hand in `profileToDescriptor`; `test/template-descriptor-shape.test.js` fails on a key
  neither forwarded nor listed in `NOT_INHERITED` with a reason.
- A new optional `rpc` hook is read in `agent-rpc.js` first, then declared (`.claude/rules/backends.md`,
  `test/runtime-backends.test.js`).

## Design

### Neutral capability (E1, E2)

One descriptor hook, `idleMaintenance()`, answered by every backend (`null` = decline, with a comment naming why):
`{ cacheClass, maxRefreshMs, warm, compact }`. `cacheClass` is the backend's lifetime class for what it writes (from
`usage`, measured); `maxRefreshMs` is the longest gap the scheduler may leave before a refresh, and it promises no hit. Pi: 270
seconds, measured hits up to 300 and a miss at 315, less a margin. Claude: 50 minutes, inferred from the 1-hour class and not
measured (O3). The core never
spells a slash command or a prompt: the action is the `rpc` half's `maintenanceCommand({ id, action, instructions })`
(`action` is `warm` or `compact`), each worded in its own folder. pi-native's compact is the RPC `compact`, not its `/compact`
extension command: the extension handler is `detached` and does not await `ctx.compact`
(`src/backends/pi-native/session-commands.js:458`), so its answer would not carry the outcome. claude-native's is a
`/compact` line. The answer also says how the action ends, `endsBy: 'idle'` or `'answer'` (see "One maintenance flag").
An action whose end does not say whether it ran names the op that proves it, `confirmedBy`. claude-native's compaction names
`compacted`, which its decoder sends at `system/compact_boundary`: Claude ends a declined `/compact` with an ordinary
`result`, `success` included (measured, `docs/backend-formats.md`). `agent-rpc.js` notes the op while the action runs and
hands `confirmed: true | false` to the schedule with the idle edge that ends it (`null` where nothing was named); `false`
is recorded as "Compaction skipped" and ends the period as `refused`. Pi's compaction ends with its answer, which says so.
Capability row `idleMaintenance` (group `live`): terminals `no`; claude-native `limited` ("cache hit not verified");
pi-native `limited` ("verdict measured on small prompts only") until a real conversation is measured. A template does not inherit it (`NOT_INHERITED`:
the consumer asks the live pipe-driven session, and a template is never one).

### The turn gate (new, in `agent-rpc.js`)

`maintenanceOpen()` is true only when `deliverShellCarry`'s conditions hold, `turnInFlight` and `state.maintenance`
are empty, no shell run is active, no observer follows the session (a warm turn's edge would end a review), and the view's
draft is empty. A maintenance turn never goes through `sendTurn` and is never
held. `maintain` writes it directly, outside `send`, so it takes no shell lines with it. A line from anyone else that enters a
warm turn (a steer, a trigger) makes the turn theirs: the flag clears and its end is loud.

### Closing the Pi gap in main

A runtime that acknowledges its turns gets `turnInFlight`, beside `heldInFlight`, which only `flushHeld` sets. It is set when
any prompt is written, and cleared by the next busy edge, a refusal answer, the process's exit, a re-key, or an answer that
says no turn will follow. That last case needs the runtime's word: a plain success answer cannot clear it, because Pi
answers before its turn starts (measured, `data.disposition: "started"`). An extension command is meant to answer `handled`
(read in Pi's source, not observed). A turn that was promised and never begins lets go after `TURN_START_WAIT_MS`, 5 seconds,
and a runtime that names nothing goes back to writing the next prompt, so neither holds the user's prompts for good. An
optional `rpc` hook reads the disposition, so the core names no format. `sendTurn` treats `turnInFlight` and `state.maintenance` like `busy`: the prompt is held and flushed when they clear, so a
user send inside the gap or during a compaction is not refused by Pi. This also protects the maintenance turn: it yields
to a user send, never the reverse.

### The draft signal

One-way, view to main, on the empty/non-empty edge of the composer, handled in `agent-rpc.js`
(`registerIpc`, no new handler in `main.js`), bound in `src/preload.js`. The view clears it on teardown; a re-key keeps it,
because the session and its composer are the same. A window that dies holding a draft leaves it set, which only stops
maintenance for that session. No mounted view means no draft (nothing can be typed), so main starts from none. The
signal cannot close the submit race (same path as the send); the main-side `turnInFlight` and the held queue do.

### One maintenance flag (E8)

`state.maintenance` holds the running action, `{ action, endsBy }`, from the write until it ends, and it is the only such
flag. `endsBy: 'idle'` (a warm turn on either backend, Claude's compaction) clears it at the matching idle edge.
`endsBy: 'answer'` (Pi's RPC compact, which has no turn edges) clears it at the command's answer, and an idle edge cannot
clear it there. A refusal, a re-key and the process's exit clear it in every case. Clearing it flushes held prompts,
because Pi's answer brings no idle edge that would. While it is set:
`report()` adds `quiet: true`, and `hooks.deliverBindSignal` raises no response-ready, no attention, and the busy edge
clears no unread ready state; `carryFor` is skipped, so pending shell lines stay for the next user turn. Usage, cost,
stats and the timeline keep counting. Last activity moves (read from the CLI's own file). The scheduler therefore keeps
its OWN idle clock from the user's last turn and the busy edges in main; reading last activity would restart idleness
after every refresh.

### E7: recognising a maintenance turn after a restart

A table `maintenance_turn (session_id, entry_key, entry_text, kind, sent_at)`, one append-only migration, written when the
turn is sent. `entry_key` is the stable key where a backend has one and null otherwise; `entry_text` is the warm prompt for
the fallback. A record whose action was refused is dropped, so a later entry cannot be claimed by it. The attach stamps matching entries `maintenance: true` and the view draws them
as a dim, collapsed "Maintenance" entry. **Measured key at send time: Claude yes, Pi no.** claude-native sets a `uuid` on
the input line, which comes back on the replay and stays on the transcript line. Pi's user message carries no id, so
pi-native takes the fallback: key on `(session_id, sent_at, exact text)` and claim the first user entry at or after
`sent_at` whose text equals the recorded text, once per record; the text is the backend-worded warm prompt, never a
marker added for recognition. As built, a compaction on Claude is matched the same way, by the words of its `/compact` line.
Pi's has no line to mark: its RPC `compact` writes no prompt, and the outcome goes to the timeline.

### Pi's RPC compact has no turn edges

Pi's RPC `compact` raises no `agent_start` and no `agent_settled`, so the busy state stays idle while it runs, and Pi refuses
a prompt in that time (measured). Hence `endsBy: 'answer'` and the hold in `sendTurn` above. That answer comes only when the compaction is over, so the command
is requested with a 10-minute wait, `ANSWER_ENDED_WAIT_MS`, not the 20-second default: on that timeout the flag would clear
and flush prompts into a running compaction. One still unanswered after 10 minutes is told to stop with Pi's `abort`, and the
user's prompts go on, which at worst Pi refuses where they can see it. That `abort` stops a compaction is not measured.
Confirmation is that answer's
`success: true`; `compaction_end` confirms only together with its `result`, because a refused compaction sends both events.
Three things follow for this path. The decoder raises an error notice for a refused compaction
(`src/backends/pi-native/rpc-protocol.js:201`), which from an idle timer would appear with nobody asking, so the flag has to
quiet it and the outcome goes to the timeline. No settled run follows, so the core asks the context and state again on the
answer, or the session line stays stale. And `get_state` answers `autoCompactionEnabled`, which is what O6 can read on Pi.

### The scheduler (a new module under `src/app/`)

Per live pipe-driven session in a mode other than Off, with a timer owned by main:

1. The clock starts at the user's last turn or the last non-maintenance busy edge. `idleMinutes` applies to compaction only
   (E14).
2. Keep warm: warm every `refreshEveryMinutes`, starting one interval after the clock starts, so no refresh falls past the
   backend's `maxRefreshMs`. A configured interval above that bound is refused with a stated reason, not silently shortened.
3. Compact only: one compaction after `idleMinutes`.
4. Warm then compact: warm up to the refresh limit, then one compaction right after the last refresh's verdict.
5. Stop at the **refresh limit** (count of warms) or the **hard ceiling** (time since the last user turn), whichever comes
   first. After that nothing runs until the user sends again, which restarts the clock.
6. Every tick checks `maintenanceOpen`; a blocked tick is skipped and retried at the next one, not queued.
7. The timer is cleared on session end, re-key, app quit (the cancel flag is set synchronously, `main-process.md`, #76)
   and mode change.

### Settings (cascade, then the running session)

Keys in the settings blob, global and per project: `idleMaintenanceMode` (`off`), `idleMaintenanceIdleMinutes`,
`idleMaintenanceRefreshMinutes`, `idleMaintenanceRefreshLimit`, `idleMaintenanceCeilingMinutes`,
`idleMaintenanceBestEffortCompact`. Both settings windows show them in a category of their own, **Session idle
maintenance** (`idle-maintenance`, #832); the global window had them inside Sessions, without a heading, where they read
as stray fields. The project value goes
through `settingsOwnerPath` (reflex 17), never `'project:' + path` by hand. The running-session override is a third,
runtime-only level held by main per live session; it never writes the defaults and is not persisted (O2). Default is Off.
All keys are added to `docs/settings-reference.md` with their real code defaults.

### Hit check (best effort)

After a warm turn the decoder's `usage` yields a verdict `warm` / `cold` / `unknown` by comparing `cacheRead` with the
previous turn's prompt (input + read + write). On Pi the measured ratios on small prompts were at least 0.998 or exactly 0: a
ratio of 0.9 or more is `warm`, a read of 0 is `cold`, anything between is `unknown`. Claude has no measured miss and warm
reads from 83%, so it answers `warm` above 0.9 and otherwise `unknown`, never `cold`, labelled "best effort" in the UI.

Every refresh is judged afterwards, and the UI promises no warm cache. Pi's four misses inside its bound lined up with a one-off
jump in the prompt per process, which is not established as the cause. **A `cold` verdict on any refresh ends keep-alive for that
idle period.** That goes further than the issue, which names only the final refresh, because the issue also forbids rebuilding a
cold cache. Compaction after it is skipped unless the new setting `idleMaintenanceBestEffortCompact` allows it (default off, the
issue's "explicitly allow best-effort compaction"). `unknown` ends nothing, and the compaction it leads to is labelled best effort.

## New flow (flagged under the issue-is-not-law rule)

**What is new:** while a session sits idle the app may send turns to the model on its own, within limits the user set.
**Pros:** a warm cache avoids a slow, expensive first prompt; compaction before return keeps context small.
**Cons:** it spends real tokens unprompted (a warm turn is cheap, a cold-cache compaction reads the whole context at full
price); compaction is lossy and cannot be undone; the conversation gains entries the user did not write; a CLI that
already auto-compacts could do it twice.
**Ways:** (A) a timer in the app with the modes above, default Off, as decided by the owner; (B) no timer, only a manual
"Warm now" / "Compact now" button on the running session. Recommendation: A as decided; B costs little on top of the
override control and is the fallback if A's gate proves unsafe. The UI states, next to the mode, that maintenance turns
cost real tokens and that compaction is lossy.

## Deferred (not in this stage)

Terminal backends (E2: their pipe drivers are claude-native and pi-native; agy has none); Hermes, once it runs over a
pipe (#778); Codex native (#734). Both issues carry the requirement since #828 was split into them: answer
`idleMaintenance()` with a measured `maxRefreshMs` and say whether a cache miss can be called. Also deferred: any
before-known-expiry mode (E3); a Claude cache-miss
measurement (needs over an hour); keying the schedule on a backend-supplied expiry; per-backend interval defaults beyond
the class bound; a "Warm now" button as its own feature (way B).

## Decided points

All eight decided by the owner on 2026-11-09, each as recommended below.

- [x] **O1** Where the running-session override lives. The tab header has no Messages/Timeline selector: those are separate
  viewer kinds (`src/renderer/views/panes-view.js:116`, `:125`) opened from a sidebar row button
  (`src/renderer/shell/sidebar-events.js:309`). Recommendation: the conversation view's session line
  (`src/renderer/session/conversation-view.js`), because the feature exists only for pipe sessions. Confirm the exact
  element in T12 before building.
- [x] **O2** Does the override persist? Recommendation: no, it lives with the running process and is reset when the process ends;
  a resumed session falls back to the cascade.
- [x] **O3** Hit-verdict threshold and the Claude miss. Recommendation: derive the Pi threshold from repeated runs (T2), label
  Claude best effort, and measure a Claude miss only on the owner's explicit go (about 70 minutes on Haiku).
- [x] **O4** Side effects beyond E8: message and user-turn counts and daily metrics move; the busy edge clears the suggestion
  and start notices. Recommendation: accept the counts (the spend is real), but extend the flag so a maintenance turn does
  not clear the suggestion or the notices.
- [x] **O5** Who words the warm prompt and how it is drawn. Recommendation: the backend's `maintenanceCommand`, one short fixed
  sentence, shown as a collapsed "Maintenance" entry.
- [x] **O6** Duplicate compaction when the CLI auto-compacts (issue note). First taken as "disable the compact modes where the
  CLI's own threshold compaction is on". Revised by the owner on 2026-11-09: both CLIs compact by themselves unless told
  otherwise, so that rule would disable the modes for nearly everyone, and a threshold compaction runs at a full context, not
  while idle. Built instead: a note beside the mode setting saying the CLI's own compaction is separate and unchanged.
- [x] **O7** Defaults. Recommendation: Off; idle 10 minutes, for compaction only (E14); refresh limit 3; ceiling 3 hours; refresh interval the class bound
  minus a margin, never above it.
- [x] **O8** Does the timeline record maintenance turns? Recommendation: yes, as one labelled kind, record-only (E8 silences
  attention, not history).

## Measured end to end (2026-11-09)

On the demo instance, one minute apart. Claude on Haiku 5.5: a refresh, then a compaction, ending `compacted`; after a re-attach
2 of 3 prompts were folded. Pi on Haiku 4.5: Compact only on a session with one large turn ended `compacted`, and a prompt sent
during the compaction was held and went out afterwards. An earlier Pi run went through a launch that did not carry the model and
ran two short turns on `claude-opus-4-8`: a refresh, read cold on a process under two minutes old, which is the jump in its prompt
in `docs/backend-formats.md`. No attention was raised, and the console stayed clean.

A second round the same day, on Haiku: a Claude prompt sent during a warm turn was held and ran next as an ordinary turn; after an
app restart the warm turn's prompt was still marked when the conversation was read back (the folded drawing was not counted, the
window stayed hidden to the renderer); and on Pi a prompt right after `/session` went out within a second, so the command answers
`handled`. A turn that failed to authenticate (a `<synthetic>` reply) started no idle period, as intended.

## Known gaps

- Pi's `/compact` through its runtime extension: not measured, and not used here.
- Whether Pi's `abort` stops a running compaction, and whether the view offers Stop during one (its `busy` is false then).
- A Claude `ai-title` written later, in a longer session, or under claude-native's entrypoint (none in about 20 seconds).
- A user's own earlier `/compact` can be drawn as the app's after a re-attach, because the match by words has no time compare. A
  warm prompt's words are the app's own, so that case does not arise for them.
- [x] The reply to a warm turn was drawn as an ordinary entry. Closed 2026-11-10: while a maintenance action runs, its
  prompt and every entry the backend reads as assistant text (`assistantTextOf`) are stamped and folded ("Maintenance: the
  reply"); a compaction's summary and a tool-only line are not. Read back, the assistant text right after a recognised
  maintenance prompt is stamped, and the first entry that is not ends the stretch, so a shell, task or interrupt turn that
  follows stays visible. Left open: an assistant entry that holds both text and a question to the user is folded with the
  warm turn, although the question then takes the turn over.
- `maintenance_turn` has no retention and does not move on a re-key, so a fork's copied lines stay unmarked.
- What Pi's one-off jump in the prompt is, and whether it causes the early misses. How Pi behaves in a real conversation: the
  measurement used small prompts with identical text, at Pi's default thinking setting.
- How long a compaction of a larger session takes on either backend.

- [x] A refused `/compact` on Claude read as compacted. Closed 2026-11-10 by `confirmedBy` (see "Neutral capability"). Its
  error reply ("Error: No messages to compact") is still drawn in the conversation, as any declined command is. The fix
  rests on `compact_boundary` arriving before the `result` that ends the turn: measured again on 2.1.318 the same day, on
  a session of two short turns only. Should a larger session ever send the `result` first, a real compaction would be
  recorded as skipped.
- [x] A compaction its idle edge was to end, whose turn never began, left the schedule's `running` on `compact` until the
  next turn. Closed 2026-11-10: `maintenance-ended` records it as "Compaction skipped" and ends the period as `refused`,
  unless `tick` still waits for the action's answer (`awaitingAnswer`), which then carries the outcome, or the end came
  from a re-key (`cause: 'rekey'`), whose own edge clears the period without a record. An end that arrived while the answer
  was out is caught by `tick` through the handle's `maintaining()`. Neither path is reached by today's two backends
  (claude-native writes without an answer, Pi's compaction ends with its answer); both are pinned by tests.
- In a detached window a maintenance turn draws Working, because `recordActivityEdge` takes it; the main window's row stays quiet.
- The control shows the mode and its source, not the interval, the ceiling or the idle time, and only the mode can be overridden
  from the view. `setOverride` takes every `idleMaintenance*` key.

Everything measured is in `docs/backend-formats.md`.
