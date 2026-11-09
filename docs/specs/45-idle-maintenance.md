# 45 — Idle session maintenance

Issue: #827. Status: **planned** (nothing built; the plan is `docs/plans/827-idle-maintenance/PLAN.md`, local only).
This file is the design record: the owner's decisions, what was measured, the shape, and the open points.

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
| E6 | The backend answers its lifetime class; an interval that would arrive cold is refused. Pi's bound is not measured yet: a hit about a second later, a miss at 6.5 minutes (plan T2). |
| E7 | A maintenance turn is recognised after a restart through a record in the app's database keyed on the entry, never a marker in the prompt text. Measured: a key at send time on Claude, none on Pi, which takes the named fallback (see "E7" below). |
| E8 | A per-turn flag in `src/app/agent-rpc.js` silences attention and keeps pending shell lines. Usage, cost and stats keep counting. Last activity moves (it comes from the CLI's own file). |

First-stage modes: **Off, Keep warm, Compact only, Warm then compact**, a finite **refresh limit** and a **hard ceiling**.

## What was measured (do not re-derive)

`docs/backend-formats.md`, "What a turn says about the prompt cache". One run per backend, so no threshold yet.

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

One descriptor hook, `idleMaintenance(options)`, answered by every backend (`null` = decline, with a comment naming why):
`{ cacheClass, maxRefreshMs, warm, compact }`. `cacheClass` is the backend's lifetime class for what it writes (from
`usage`, measured); `maxRefreshMs` is the longest interval that still arrives warm for that class. The core never
spells a slash command or a prompt: the action is the `rpc` half's `maintenanceCommand({ id, action, instructions })`
(`action` is `warm` or `compact`), each worded in its own folder. pi-native's compact is the RPC `compact`, not its `/compact`
extension command: the extension handler is `detached` and does not await `ctx.compact`
(`src/backends/pi-native/session-commands.js:458`), so its answer would not carry the outcome. claude-native's is a
`/compact` line. The answer also says how the action ends, `endsBy: 'idle'` or `'answer'` (see "One maintenance flag").
Capability row `idleMaintenance` (group `live`): terminals `no`; claude-native `limited` ("cache hit not verified");
pi-native `yes` once the hit check below is measured, else `limited`. A template does not inherit it (`NOT_INHERITED`:
the consumer asks the live pipe-driven session, and a template is never one).

### The turn gate (new, in `agent-rpc.js`)

`maintenanceGate(state)` is true only when `deliverShellCarry`'s conditions hold, `turnInFlight` and `state.maintenance`
are empty, no shell run is active, and the view's draft is empty. A maintenance turn never goes through `sendTurn` and is never
held. It is written through `send` with a `maintenance` marker.

### Closing the Pi gap in main

A runtime that acknowledges its turns gets `turnInFlight`, beside `heldInFlight`, which only `flushHeld` sets. It is set when
any prompt is written, and cleared by the next busy edge, a refusal answer, the process's exit, a re-key, or an answer that
says no turn will follow. That last case needs the runtime's word: a plain success answer cannot clear it, because Pi
answers before its turn starts (measured, `data.disposition: "started"`). An extension command is meant to answer `handled`
(read in Pi's source, not observed), and without that clear the next prompt would be held with nothing to flush it. An
optional `rpc` hook reads the disposition, so the core names no format. `sendTurn` treats `turnInFlight` and `state.maintenance` like `busy`: the prompt is held and flushed when they clear, so a
user send inside the gap or during a compaction is not refused by Pi. This also protects the maintenance turn: it yields
to a user send, never the reverse.

### The draft signal

One-way, view to main, on the empty/non-empty edge of the composer, handled in `agent-rpc.js`
(`registerIpc`, no new handler in `main.js`), bound in `src/preload.js`. State is cleared on teardown and re-key and
fails towards not sending: an unknown draft state blocks. No mounted view means no draft (nothing can be typed). The
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
marker added for recognition. A compaction is matched to the first entry of the CLI's own at or after `sent_at`, once per
record: `compact_boundary` on Claude, a `compaction` entry in Pi's file. T8 has to check this against what the attach
actually reads: a pi-native attach reads `get_messages`, not the file, so neither Pi shape above is established there, and
older warm entries may be gone from that answer after a compaction.

### Pi's RPC compact has no turn edges

Pi's RPC `compact` raises no `agent_start` and no `agent_settled`, so the busy state stays idle while it runs, and Pi refuses
a prompt in that time (measured). Hence `endsBy: 'answer'` and the hold in `sendTurn` above. That answer comes only when the compaction is over, so the command
is requested with `timeoutMs: 0`, as a shell line is (`src/app/agent-rpc.js:940`), not under the 20-second default: on a
timeout the flag would clear and flush prompts into a running compaction, and the real answer would be lost. `no answer` is
never a refusal. The process's exit bounds the wait. Confirmation is that answer's
`success: true`; `compaction_end` confirms only together with its `result`, because a refused compaction sends both events.
Three things follow for this path. The decoder raises an error notice for a refused compaction
(`src/backends/pi-native/rpc-protocol.js:201`), which from an idle timer would appear with nobody asking, so the flag has to
quiet it and the outcome goes to the timeline. No settled run follows, so the core asks the context and state again on the
answer, or the session line stays stale. And `get_state` answers `autoCompactionEnabled`, which is what O6 can read on Pi.

### The scheduler (a new module under `src/app/`)

Per live pipe-driven session in a mode other than Off, with a timer owned by main:

1. Idle for `idleMinutes` since the user's last turn or the last non-maintenance busy edge.
2. Keep warm: warm every `refreshEveryMinutes`, clamped to the backend's `maxRefreshMs`. A configured interval that would
   arrive cold is refused with a stated reason, not silently shortened.
3. Compact only: one compaction after the idle time.
4. Warm then compact: warm up to the refresh limit, then one compaction.
5. Stop at the **refresh limit** (count of warms) or the **hard ceiling** (time since the last user turn), whichever comes
   first. After that nothing runs until the user sends again, which restarts the clock.
6. Every tick checks `maintenanceGate`; a blocked tick is skipped and retried at the next one, not queued.
7. The timer is cleared on session end, re-key, app quit (the cancel flag is set synchronously, `main-process.md`, #76)
   and mode change.

### Settings (cascade, then the running session)

Keys in the settings blob, global and per project: `idleMaintenanceMode` (`off`), `idleMaintenanceIdleMinutes`,
`idleMaintenanceRefreshMinutes`, `idleMaintenanceRefreshLimit`, `idleMaintenanceCeilingMinutes`. The project value goes
through `settingsOwnerPath` (reflex 17), never `'project:' + path` by hand. The running-session override is a third,
runtime-only level held by main per live session; it never writes the defaults and is not persisted (O2). Default is Off.
All keys are added to `docs/settings-reference.md` with their real code defaults.

### Hit check (best effort)

After a warm turn the decoder's `usage` yields a verdict `warm` / `cold` / `unknown` by comparing `cacheRead` with the
previous turn's prompt (input + read + write). The threshold is a measured plan step (T2); one run gives none. Pi has a
measured miss; a Claude miss is not, so the Claude verdict stays labelled "best effort" in the UI and the capability note.

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

Terminal backends and Hermes (E2); Codex native (#734); any before-known-expiry mode (E3); a Claude cache-miss
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
- [x] **O6** Duplicate compaction when the CLI auto-compacts (issue note). Recommendation: where a launch option shows
  the CLI's own threshold compaction on, the compact modes are shown disabled with the reason; where the backend cannot
  say, a note.
- [x] **O7** Defaults. Recommendation: Off; idle 10 minutes; refresh limit 3; ceiling 3 hours; refresh interval the class bound
  minus a margin, never above it.
- [x] **O8** Does the timeline record maintenance turns? Recommendation: yes, as one labelled kind, record-only (E8 silences
  attention, not history).

## Known gaps (before any build)

Still open after T1:

- Pi's `/compact` through its runtime extension: not measured, and not used here. T5 checks that an extension command answers
  `handled`, because `turnInFlight` depends on it.
- A Pi compaction that hangs holds the user's prompts until the process exits, with no bound of its own. T5 names the way out
  (Stop or a bounded abort).
- A Claude `ai-title` written later, in a longer session, or under claude-native's entrypoint (none in about 20 seconds).
- Tying a Claude `compact_boundary` to its record: the `/compact` line was sent without a `uuid`.
- What a pi-native attach's `get_messages` holds for a warm turn and a compaction (T8).
- What each decoder passes on of `usage`, and the stream lines not inspected (T11). No decoder op carries a figure of its own today.
- Pi's cache bound and hit threshold (T2), and how long a compaction of a larger session takes on either backend.

Everything measured is in `docs/backend-formats.md`.
