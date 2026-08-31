# Spec 05 — Reliable attention detection via Claude Code hooks

> Read `docs/specs/README.md` first.

**Status:** Implemented · **Roadmap:** Opportunity #5 (Phase 4) · **Independent:** Yes

> **As built:** in addition to the `Notification` and `Stop` hooks below, `UserPromptSubmit`, `SubagentStart` and `SubagentStop` hooks are also registered. The HTTP ingest server lives in **`src/app/hooks.js`** — it was in `src/main.js` (never near the OSC parsing region, despite Step 1 below) until #213 split it out. That module requires no Electron on purpose, which is what lets `test/hook-ingest.test.js` drive the token check and the settings.json rewrite for real; before the split neither was asserted by anything.
>
> **Where the code is now** — everything under "Current state" below names `main.js` with line numbers from the day it was written; both moved. The OSC-9 / OSC-0 parsing is in **`src/app/terminal/spawn.js`**'s PTY `onData` handler, and the busy/idle it derives is **Claude's alone** (#120): the idle half is the literal `✳`, so running it against another CLI that spins in its title latches "working" forever. Every other backend reports state through `liveState` — see **`src/watch/adopt.js`**. The dev/installed hook-sentinel clash is **#219**.
>
> **A `Stop` is not proof the session is idle (#495).** The hooks fire in an order the contract below does not describe, and the section "A turn that announces nothing" at the end of this file is the part to read before reasoning about busy/ready. Short version: `UserPromptSubmit` fires when a prompt is **enqueued**, so a `Stop` can arrive while the CLI still owes a turn, and the turn it then runs announces nothing at all.
>
> **Moved (#228):** the renderer funnel described below split out of `src/renderer/app.js`. The `onTerminalNotification` / `onAttentionSignal` IPC listeners are in **`src/renderer/shell/session-ipc.js`**; `applyAttention` (the single funnel both feed) is in **`src/renderer/shell/attention-engine.js`**; `classifyAttentionSignal` is the pure **`src/shared/attention-source.js`**. app.js line numbers below are pre-#228.

## Problem & goal

Attention detection is a **heuristic**: `src/main.js` parses iTerm2 OSC-9 escape sequences from the PTY and the renderer regex-matches the payload (`/attention|approval|permission|needs your|wants to enter/i`, `app.js:409`). This can miss states it wasn't tuned for (e.g. certain MCP/tool permission prompts, plan-mode approvals) and can mis-classify.

**Goal:** Add a more reliable, structured attention signal sourced from **Claude Code hooks** (events Claude Code can fire on tool use / permission / notification), feeding the same `attentionSessions` state — while keeping the OSC-9 heuristic as a fallback.

## Current state (grounded)

- OSC-9 parse + emit: `main.js:1285–1308` → `webContents.send('terminal-notification', sessionId, payload)`.
- Renderer consumes via `onTerminalNotification` (`preload.js:57`) → handler at `app.js:401–415` which regex-matches and does `attentionSessions.add(sessionId)`.
- Busy/idle is independently tracked via OSC-0 title spinner + OSC-9;4 progress (`main.js:1262–1301`) → `cli-busy-state`.
- The app already understands Claude Code's project layout: sessions are JSONL files under `~/.claude/projects/<folder>/`; scheduling read `.claude/commands/` (`src/servers/schedule-runner.js`, removed in #246 — spec 14). So writing/reading Claude config is an established pattern.

## Scope

**In:** investigate Claude Code hook capabilities; if viable, register hook(s) that notify Switchboard on permission/attention events and map them to `attentionSessions` with a precise reason; keep OSC-9 as fallback; surface the richer reason in the timeline/inbox.
**Out:** removing the OSC-9 path (keep as fallback); changing the status model.

## Design

### Step 0 — Spike (required first)
Confirm the current Claude Code hooks contract (events, payload shape, how a hook delivers data back to a local app). Options to evaluate:
- **Hooks → local IPC:** a hook command that POSTs to a tiny local HTTP/Unix-socket endpoint Switchboard runs in `src/main.js`, including the session id and event type. (Switchboard already runs an MCP server per session — `src/servers/mcp-bridge.js`, `startMcpServer` in `main.js:1211` — so a local listener is architecturally consistent.)
- **Hooks → file:** a hook appends structured events to a known file Switchboard watches (it already watches files via `watch-file`/`chokidar`-style handlers, `main.js:475`).
- Map the hook's working dir / session to a Switchboard `sessionId` (use the JSONL/`cwd` correlation in `src/db/db.js` `getAllFolderMeta` (it was also in the scheduler's `readProjectPathFromJsonl`, removed in #246)).

Document findings in this spec's "Spike notes" before building.

### Step 1 — Ingest channel (`src/main.js`)
- Stand up the chosen channel (local endpoint or watched file). Normalize each event to `{ sessionId, kind, reason }` where `kind ∈ {needs-attention, busy, idle, ready}`.
- Emit to renderer via a **new** structured event `attention-signal` (don't overload `terminal-notification`): `mainWindow.webContents.send('attention-signal', { sessionId, kind, reason, source: 'hook' })`.

### Step 2 — Pure mapping helper `src/shared/attention-source.js` (UMD, tested)
```js
// classifyAttentionSignal({ source, payload }) -> { kind, reason } | null
//   source: 'osc9' | 'hook'
//   for osc9: run the existing regex (move it here from app.js) -> needs-attention|null
//   for hook: trust the structured kind/reason
// Single place that decides attention, used by both paths so behavior is consistent + testable.
```
Move the inline regex from `app.js:409` into this helper (keeps one source of truth; reduces drift).

### Step 3 — Renderer wiring (`app.js`, `src/preload.js`)
- `src/preload.js`: add `onAttentionSignal(cb)`.
- `app.js`: both `onTerminalNotification` (→ `classifyAttentionSignal({source:'osc9', payload})`) and `onAttentionSignal` (→ `classifyAttentionSignal({source:'hook', payload})`) funnel into one `applyAttention(sessionId, {kind, reason})` that updates `attentionSessions`/`responseReadySessions` and records a timeline event with the richer `reason`. Hook signals win over OSC-9 when both present.

### Step 4 — Settings
- Add a Global Setting "Use Claude Code hooks for attention (recommended)" (default on if the spike shows it's reliable; otherwise opt-in). When off, OSC-9-only.
- If the integration requires writing a hook into the user's Claude config, do it explicitly and reversibly, with a settings toggle and clear messaging (follow the established pattern of touching `~/.claude` carefully).

## Files to touch
- **New:** `src/shared/attention-source.js`, `test/attention-source.test.js`. *(As built the ingest channel is its own module too — `src/app/hooks.js` + `test/hook-ingest.test.js`, since #213.)*
- **Modified:** `src/main.js` (ingest channel near OSC parsing region; new `attention-signal` send), `src/preload.js` (append `onAttentionSignal`), `src/renderer/app.js` (funnel both sources via `applyAttention`; remove inline regex now living in the helper, ~401–415), `src/renderer/panels/settings-panel.js` (toggle), `src/renderer/index.html` (script tag).

## Tests (`test/attention-source.test.js`)
- OSC-9 payloads that previously matched still classify as needs-attention; non-matching payloads return null.
- Hook structured events map straight through to their kind/reason.
- Hook signal takes precedence over a conflicting OSC-9 signal for the same session (test the precedence rule if you put it in the helper, else in a small pure reducer).

## Acceptance criteria
- A permission/tool-approval prompt that the OSC-9 regex misses is reliably caught via the hook path and shows in the attention inbox with a descriptive reason.
- OSC-9 still works with hooks disabled (no regression).
- Toggle persists; any change to `~/.claude` is explicit and reversible.
- `npm test`, `ReadLints`, Electron smoke run pass.

## Risks / notes
- **Spike-gated:** if the current hooks contract can't deliver session-correlated events cleanly, descope to "improve the OSC-9 regex + move it into the tested `attention-source.js` helper" — still a net win (one tested source of truth) and unblocks the others.
- Correlating hook events to Switchboard sessions is the main complexity; lean on existing `cwd`→session mapping.

## Spike notes (Step 0 — findings)

**Date:** 2026-06-17 · **Conclusion: FULL build is feasible — implemented.**

### Hooks contract (verified against `code.claude.com/docs/en/hooks.md`)
- Hooks are configured in `~/.claude/settings.json` (user scope) under a top-level `hooks` key. Project (`.claude/settings.json`) and local (`.claude/settings.local.json`) scopes also exist; we use **user scope** so it applies to every Switchboard-launched session.
- Each hook event maps to an array of *matcher groups*; each group has `{ matcher, hooks: [handler, ...] }`.
- Handlers can be `type: "command"` (event JSON on **stdin**) **or `type: "http"` (event JSON as the POST request body)**. HTTP handlers take `{ type: "http", url, timeout? }` and are **deduplicated by URL**. This is the cleanest fit — no `curl`/`jq`/shell dependency, no temp scripts.
- Relevant events:
  - `Notification` — fires when Claude needs the user (matcher = notification type: `permission_prompt`, `idle_prompt`, `elicitation_dialog`, …). This is the signal the OSC-9 regex misses for some tool/MCP permission prompts.
  - `Stop` — fires when Claude finishes the turn it was running (→ "ready"). No matcher support (matcher silently ignored). **It does not say the session is idle**, only that one turn ended; see #495 below.
  - `UserPromptSubmit` — fires when a prompt is **enqueued**, not when it is sent (→ "busy"). Measured, and the whole of #495: type while the agent is working and this arrives at once, while the prompt itself waits.
  - (`PermissionRequest` also exists and maps to needs-attention; covered by `Notification`'s `permission_prompt`, so we register the smaller set.)

### Session correlation — direct, no cwd mapping needed
Every hook payload includes `session_id`, and `transcript_path` points at `~/.claude/projects/<folder>/<session_id>.jsonl`. **`session_id` is the Claude session UUID, which is exactly Switchboard's `realSessionId`** (the JSONL filename the app already keys `openSessions`/`activeSessions` on after `src/session/session-transitions.js` rekeys temp→real). So a hook event maps to a Switchboard session with **zero** extra correlation logic. (Edge case: a brand-new session still on its temp id won't match until the real id is detected — the OSC-9 fallback covers that early window.)

### Chosen design
- **Ingest = local HTTP server** in `src/app/hooks.js` (`src/main.js` as originally built), bound to `127.0.0.1` on an OS-assigned port (consistent with the existing per-session WS MCP servers in `src/servers/mcp-bridge.js`). It parses the hook JSON, normalizes via the shared `src/shared/attention-source.js` helper, and pushes a new `attention-signal` IPC event. It replies `200 {}` (empty decision = no-op, never blocks Claude).
- **`~/.claude/settings.json` is touched only when the setting is ON, and reversibly:** our handlers are tagged by a sentinel URL path (`/switchboard-attention-hook`). Enable strips any stale Switchboard handlers then writes fresh `Notification` + `Stop` HTTP hooks for the live port; disable strips them and leaves all other user hooks untouched. The port is re-stamped on each app start while enabled (URLs dedup, stale ones are pruned first).
- **Default OFF (opt-in)** — touching the user's real `~/.claude/settings.json` should be a deliberate choice; the OSC-9 heuristic remains the default and the fallback.

### Validation caveat
A *live* end-to-end hook round-trip can't be exercised from the automated smoke run (it needs a real Claude Code process firing a permission prompt). The classification/precedence logic is fully unit-tested in `test/attention-source.test.js`; the smoke run verifies the app boots, the HTTP ingest server binds, and the IPC wiring loads without runtime errors.

---

## A turn that announces nothing (#495)

The two hooks above describe the start and the end of a turn, and nothing guarantees they arrive in
that order. `UserPromptSubmit` fires when a prompt is **enqueued**. Type while the agent is working
and the busy edge arrives at once, which is fine as long as the queue drains before the turn ends.
When the agent finishes first, the order measured on a real session is this:

```
19:19:54.369  enqueue                → UserPromptSubmit → busy
19:20:35.093  Stop (the OLD turn)    → ready            ← wins, 72 ms too early
19:20:35.131  dequeue                → no hook fires
19:20:35.165  the queued prompt runs, and announces nothing
```

That session then worked for another fifteen minutes with its row on "Ready". Nothing later could
heal it: the event that would have announced the new turn had already fired 41 seconds earlier and
been overwritten by the previous turn's `Stop`. Getting whose turn it is wrong is the one thing the
attention inbox may not do, so a `Stop` is now checked before it is believed.

### The transcript is the second source

Claude records the queue in the transcript, one line per movement, and it is regular enough to
count — `docs/backend-formats.md` has the shape and the numbers behind that claim. A `Stop` arriving
with a depth above zero is a `Stop` with another turn behind it, and it is held rather than
delivered.

**A hold that nothing can release would be worse than the bug**, so there are three ways out of one:

| What happens | What the hold does |
|---|---|
| The queued prompt starts its turn — an entry newer than the `Stop` that is a turn, not a tool result | dropped, never delivered. The busy state was right, and that turn ends with its own `Stop` |
| The queue empties without running — the user changed their mind, and no hook will ever say so | delivered late, because the session really is idle |
| Neither, for a minute | delivered anyway, with a line in the log. An unresolvable hold has to end in the honest answer rather than in a session stuck on "Working" |

Any other signal for that session releases a held one too: whatever it described has moved on.

### What belongs to whom

`src/app/turn-hold.js` holds the signal and knows no CLI's format. Whether a turn is still owed is a
question about one CLI's own transcript, so it is the `readTurnQueue` descriptor hook, answered by
`src/backends/claude/turn-queue.js` and declined by every other backend through the `queuedTurn`
capability row. **A declined answer means exactly the behaviour that shipped before this**, which is
what lets the four backends that fire no turn hooks stay out of it entirely.

`src/app/hooks.js` delivers a signal through one closure, so a held one does what an immediate one
would have done. Every path other than `ready` is untouched.

### Two things the first implementation got wrong

Both were found by review and both were settled by measurement rather than argument, which is why
the numbers are written down in `docs/backend-formats.md` rather than recalled:

- **A tail cannot answer this.** The reader started by counting the queue in the last 128 KB of the
  transcript. The depth is enqueues minus closures over the whole history, and a window cuts that
  history in two places that each mislead: an enqueue that is still open gets pushed out of view by
  the very turn that is still running, and, the queue being FIFO, a closure inside the window takes
  the oldest queued prompt rather than the one beside it. Either way a queued prompt reads as none,
  no hold is taken, and this bug is back with no timeout behind it. A partial read is not trusted.
- **Injected entries are not turns.** A skill's body and a system reminder are written as `user`
  entries with an ordinary text block, and counting one as a turn start releases the held signal
  *without* delivering it — taking the timeout that would otherwise have rescued the session along
  with it. `isMeta` is the flag that tells them apart.

`test/turn-hold.test.js` carries the measured order above as a fixture, including the 72 ms.
