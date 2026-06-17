# Spec 05 — Reliable attention detection via Claude Code hooks

> Read `docs/specs/README.md` first.

**Status:** Spike then build · **Roadmap:** Opportunity #5 (Phase 4) · **Independent:** Yes

## Problem & goal

Attention detection is a **heuristic**: `main.js` parses iTerm2 OSC-9 escape sequences from the PTY and the renderer regex-matches the payload (`/attention|approval|permission|needs your|wants to enter/i`, `app.js:409`). This can miss states it wasn't tuned for (e.g. certain MCP/tool permission prompts, plan-mode approvals) and can mis-classify.

**Goal:** Add a more reliable, structured attention signal sourced from **Claude Code hooks** (events Claude Code can fire on tool use / permission / notification), feeding the same `attentionSessions` state — while keeping the OSC-9 heuristic as a fallback.

## Current state (grounded)

- OSC-9 parse + emit: `main.js:1285–1308` → `webContents.send('terminal-notification', sessionId, payload)`.
- Renderer consumes via `onTerminalNotification` (`preload.js:57`) → handler at `app.js:401–415` which regex-matches and does `attentionSessions.add(sessionId)`.
- Busy/idle is independently tracked via OSC-0 title spinner + OSC-9;4 progress (`main.js:1262–1301`) → `cli-busy-state`.
- The app already understands Claude Code's project layout: sessions are JSONL files under `~/.claude/projects/<folder>/`; scheduling reads `.claude/commands/` (`schedule-runner.js`). So writing/reading Claude config is an established pattern.

## Scope

**In:** investigate Claude Code hook capabilities; if viable, register hook(s) that notify Switchboard on permission/attention events and map them to `attentionSessions` with a precise reason; keep OSC-9 as fallback; surface the richer reason in the timeline/inbox.
**Out:** removing the OSC-9 path (keep as fallback); changing the status model.

## Design

### Step 0 — Spike (required first)
Confirm the current Claude Code hooks contract (events, payload shape, how a hook delivers data back to a local app). Options to evaluate:
- **Hooks → local IPC:** a hook command that POSTs to a tiny local HTTP/Unix-socket endpoint Switchboard runs in `main.js`, including the session id and event type. (Switchboard already runs an MCP server per session — `mcp-bridge.js`, `startMcpServer` in `main.js:1211` — so a local listener is architecturally consistent.)
- **Hooks → file:** a hook appends structured events to a known file Switchboard watches (it already watches files via `watch-file`/`chokidar`-style handlers, `main.js:475`).
- Map the hook's working dir / session to a Switchboard `sessionId` (use the JSONL/`cwd` correlation already in `schedule-runner.js` `readProjectPathFromJsonl` / `db.js` `getAllFolderMeta`).

Document findings in this spec's "Spike notes" before building.

### Step 1 — Ingest channel (`main.js`)
- Stand up the chosen channel (local endpoint or watched file). Normalize each event to `{ sessionId, kind, reason }` where `kind ∈ {needs-attention, busy, idle, ready}`.
- Emit to renderer via a **new** structured event `attention-signal` (don't overload `terminal-notification`): `mainWindow.webContents.send('attention-signal', { sessionId, kind, reason, source: 'hook' })`.

### Step 2 — Pure mapping helper `public/attention-source.js` (UMD, tested)
```js
// classifyAttentionSignal({ source, payload }) -> { kind, reason } | null
//   source: 'osc9' | 'hook'
//   for osc9: run the existing regex (move it here from app.js) -> needs-attention|null
//   for hook: trust the structured kind/reason
// Single place that decides attention, used by both paths so behavior is consistent + testable.
```
Move the inline regex from `app.js:409` into this helper (keeps one source of truth; reduces drift).

### Step 3 — Renderer wiring (`app.js`, `preload.js`)
- `preload.js`: add `onAttentionSignal(cb)`.
- `app.js`: both `onTerminalNotification` (→ `classifyAttentionSignal({source:'osc9', payload})`) and `onAttentionSignal` (→ `classifyAttentionSignal({source:'hook', payload})`) funnel into one `applyAttention(sessionId, {kind, reason})` that updates `attentionSessions`/`responseReadySessions` and records a timeline event with the richer `reason`. Hook signals win over OSC-9 when both present.

### Step 4 — Settings
- Add a Global Setting "Use Claude Code hooks for attention (recommended)" (default on if the spike shows it's reliable; otherwise opt-in). When off, OSC-9-only.
- If the integration requires writing a hook into the user's Claude config, do it explicitly and reversibly, with a settings toggle and clear messaging (follow the established pattern of touching `~/.claude` carefully).

## Files to touch
- **New:** `public/attention-source.js`, `test/attention-source.test.js`.
- **Modified:** `main.js` (ingest channel near OSC parsing region; new `attention-signal` send), `preload.js` (append `onAttentionSignal`), `public/app.js` (funnel both sources via `applyAttention`; remove inline regex now living in the helper, ~401–415), `public/settings-panel.js` (toggle), `public/index.html` (script tag).

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
