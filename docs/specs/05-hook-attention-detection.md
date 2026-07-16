# Spec 05 — Reliable attention detection via Claude Code hooks

> Read `docs/specs/README.md` first.

**Status:** Implemented · **Roadmap:** Opportunity #5 (Phase 4) · **Independent:** Yes

> **As built:** in addition to the `Notification` and `Stop` hooks below, `UserPromptSubmit`, `SubagentStart` and `SubagentStop` hooks are also registered. The HTTP ingest server lives in **`src/app/hooks.js`** — it was in `src/main.js` (never near the OSC parsing region, despite Step 1 below) until #213 split it out. That module requires no Electron on purpose, which is what lets `test/hook-ingest.test.js` drive the token check and the settings.json rewrite for real; before the split neither was asserted by anything.

## Problem & goal

Attention detection is a **heuristic**: `src/main.js` parses iTerm2 OSC-9 escape sequences from the PTY and the renderer regex-matches the payload (`/attention|approval|permission|needs your|wants to enter/i`, `app.js:409`). This can miss states it wasn't tuned for (e.g. certain MCP/tool permission prompts, plan-mode approvals) and can mis-classify.

**Goal:** Add a more reliable, structured attention signal sourced from **Claude Code hooks** (events Claude Code can fire on tool use / permission / notification), feeding the same `attentionSessions` state — while keeping the OSC-9 heuristic as a fallback.

## Current state (grounded)

- OSC-9 parse + emit: `main.js:1285–1308` → `webContents.send('terminal-notification', sessionId, payload)`.
- Renderer consumes via `onTerminalNotification` (`preload.js:57`) → handler at `app.js:401–415` which regex-matches and does `attentionSessions.add(sessionId)`.
- Busy/idle is independently tracked via OSC-0 title spinner + OSC-9;4 progress (`main.js:1262–1301`) → `cli-busy-state`.
- The app already understands Claude Code's project layout: sessions are JSONL files under `~/.claude/projects/<folder>/`; scheduling reads `.claude/commands/` (`src/servers/schedule-runner.js`). So writing/reading Claude config is an established pattern.

## Scope

**In:** investigate Claude Code hook capabilities; if viable, register hook(s) that notify Switchboard on permission/attention events and map them to `attentionSessions` with a precise reason; keep OSC-9 as fallback; surface the richer reason in the timeline/inbox.
**Out:** removing the OSC-9 path (keep as fallback); changing the status model.

## Design

### Step 0 — Spike (required first)
Confirm the current Claude Code hooks contract (events, payload shape, how a hook delivers data back to a local app). Options to evaluate:
- **Hooks → local IPC:** a hook command that POSTs to a tiny local HTTP/Unix-socket endpoint Switchboard runs in `src/main.js`, including the session id and event type. (Switchboard already runs an MCP server per session — `src/servers/mcp-bridge.js`, `startMcpServer` in `main.js:1211` — so a local listener is architecturally consistent.)
- **Hooks → file:** a hook appends structured events to a known file Switchboard watches (it already watches files via `watch-file`/`chokidar`-style handlers, `main.js:475`).
- Map the hook's working dir / session to a Switchboard `sessionId` (use the JSONL/`cwd` correlation already in `src/servers/schedule-runner.js` `readProjectPathFromJsonl` / `src/db/db.js` `getAllFolderMeta`).

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
  - `Stop` — fires when Claude finishes responding (→ "ready"). No matcher support (matcher silently ignored).
  - (`PermissionRequest` also exists and maps to needs-attention; covered by `Notification`'s `permission_prompt`, so we register the smaller set.)

### Session correlation — direct, no cwd mapping needed
Every hook payload includes `session_id`, and `transcript_path` points at `~/.claude/projects/<folder>/<session_id>.jsonl`. **`session_id` is the Claude session UUID, which is exactly Switchboard's `realSessionId`** (the JSONL filename the app already keys `openSessions`/`activeSessions` on after `src/session/session-transitions.js` rekeys temp→real). So a hook event maps to a Switchboard session with **zero** extra correlation logic. (Edge case: a brand-new session still on its temp id won't match until the real id is detected — the OSC-9 fallback covers that early window.)

### Chosen design
- **Ingest = local HTTP server** in `src/app/hooks.js` (`src/main.js` as originally built), bound to `127.0.0.1` on an OS-assigned port (consistent with the existing per-session WS MCP servers in `src/servers/mcp-bridge.js`). It parses the hook JSON, normalizes via the shared `src/shared/attention-source.js` helper, and pushes a new `attention-signal` IPC event. It replies `200 {}` (empty decision = no-op, never blocks Claude).
- **`~/.claude/settings.json` is touched only when the setting is ON, and reversibly:** our handlers are tagged by a sentinel URL path (`/switchboard-attention-hook`). Enable strips any stale Switchboard handlers then writes fresh `Notification` + `Stop` HTTP hooks for the live port; disable strips them and leaves all other user hooks untouched. The port is re-stamped on each app start while enabled (URLs dedup, stale ones are pruned first).
- **Default OFF (opt-in)** — touching the user's real `~/.claude/settings.json` should be a deliberate choice; the OSC-9 heuristic remains the default and the fallback.

### Validation caveat
A *live* end-to-end hook round-trip can't be exercised from the automated smoke run (it needs a real Claude Code process firing a permission prompt). The classification/precedence logic is fully unit-tested in `test/attention-source.test.js`; the smoke run verifies the app boots, the HTTP ingest server binds, and the IPC wiring loads without runtime errors.
