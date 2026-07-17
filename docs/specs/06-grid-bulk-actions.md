# Spec 06 — Bulk actions from the grid command center

> Read `docs/specs/README.md` first.

**Status:** Implemented · **Roadmap:** Opportunity #6 (Phase 4) · **Independent:** Yes (coordinate `grid-view.js` regions with Spec 07 if concurrent)

> **Moved (#218):** the chips and the three buttons live in **`src/renderer/views/grid-bulk-actions.js`**
> now, not in grid-view.js — `renderGridStatusFilters`, `renderGridBulkActions`, `stepThroughQueue`,
> `markAllReadySeen`, `stopAllRunning`. Behaviour is unchanged; the file references below are the ground
> this spec was written against. The STATE they read (`gridStatusFilter`, `getGridRuntimeState`,
> `getGridOpenSessions`, `getGridAllowedSessionIds`) deliberately stayed in `grid-view.js`: the
> composition point owns the state, the modules render it. Note `gridStatusFilter` has three writers
> across three files (here, `showGridView`, and `terminal-manager.js`), each writing localStorage in its
> own line — a fourth that forgets loses the setting on reload, and nothing would say so.

## Problem & goal

The grid is positioned as a "command center" for many agents, but every action is **per-session** (focus, stop, handoff via the card). Supervising 6+ agents means repetitive one-by-one clicking.

**Goal:** Add safe **bulk actions** operating on the current grid view: step through the attention queue, and dismiss-all-ready. Anything token-spending or destructive stays behind an explicit styled confirmation.

## Current state (grounded)

- Grid: `src/renderer/views/grid-view.js`. Cards built in `wrapInGridCard` (per-session header with stop/handoff). Filter bar `renderGridStatusFilters` (now in `src/renderer/views/grid-bulk-actions.js` — see the callout above) with All / Needs You / Ready / Running, counts from `getStatusCounts`. `getGridOpenSessions()` / `getGridAllowedSessionIds()` give the working set.
- Focus traversal exists: `getNextAttentionInboxItem` (`src/renderer/session/session-status.js`), `focusGridCard(sessionId)` (`src/renderer/views/grid-view.js`), `navigateGrid`/`navigateSession` (`src/renderer/shell/session-nav.js`).
- Clearing state: `clearNotifications(sessionId)` / `clearUnread(sessionId)` (`app.js`).
- Stop with confirmation: `confirmAndStopSession(sessionId)` (used by card stop button). Styled dialogs/toasts: `src/renderer/dialogs/control-dialogs.js` (`showControlDialog`, `showControlToast`).

## Scope

**In:** a bulk-action bar in the grid header with: **Step through queue** (focus next attention/ready, looping), **Mark all ready as seen** (clear `responseReadySessions` for the visible set), and **Stop all running** (destructive → confirm with counts + names). All scoped to the **currently filtered** grid set.
**Out:** bulk *prompting* agents (sending input to many sessions) — explicitly excluded for safety in v1; can be a later, heavily-confirmed addition.

## Design

### Pure helper: `src/renderer/shell/bulk-actions.js` (UMD, Electron-free, tested)
Compute the targets for each action from the runtime + filter, so the dangerous part (what gets acted on) is unit-tested:
```js
// bulkTargets(sessions, runtime, filter) -> {
//   readyToClear: [sessionId...],     // status === response-ready in the visible set
//   runningToStop: [sessionId...],    // status busy|running in the visible set
//   queue: [sessionId...],            // attention+ready ordered (reuse getAttentionInboxItems order)
// }
```
Reuse `getFilteredSessionsByStatus` + `getSessionStatus` + `getAttentionInboxItems` from `session-status.js`.

### UI (`grid-view.js`)
- Add a bulk-action row to `#grid-viewer-header` (next to filters/count). Buttons reflect counts and disable at zero:
  - **Step ▶** — focus the next item in `queue` relative to `gridFocusedSessionId` (wrap). Pure traversal, no confirm.
  - **Mark N ready seen** — `clearUnread` for each `readyToClear`; toast with **Undo** (re-add to `responseReadySessions`) via `showControlToast`.
  - **Stop N running** — `showControlDialog` tone `danger`, listing affected session names/projects (detail rows), then stop each (`window.api.stopSession` / existing stop path). No silent stop.
- Keep the bar visible (not hover-only), consistent with the existing "attention actions visible" decision in the supervision plan.

## Files to touch
- **New:** `src/renderer/shell/bulk-actions.js`, `test/bulk-actions.test.js`.
- **Modified:** `src/renderer/views/grid-view.js` (header bulk bar + handlers; reuse `focusGridCard`, `clearUnread`, `confirmAndStopSession`/`stopSession`), `src/renderer/index.html` (script tag before `grid-view.js`), `src/renderer/style.css` (bulk bar styles). `src/preload.js` only if a not-yet-exposed action is needed (stop already exposed).

## Tests (`test/bulk-actions.test.js`)
- `readyToClear` only includes response-ready sessions within the active filter.
- `runningToStop` only includes busy/running within the active filter.
- `queue` ordering matches `getAttentionInboxItems` priority.
- Empty sets when filter excludes everything.

## Acceptance criteria
- With several sessions ready/running, the grid header shows accurate bulk counts.
- "Mark all ready seen" clears the visible ready set and offers Undo.
- "Stop all running" confirms with names before stopping; cancel does nothing.
- "Step" cycles focus through the attention/ready queue.
- Actions respect the active grid filter.
- `npm test`, `ReadLints`, Electron smoke run pass.

## Risks / notes
- Destructive scope must be obvious — always show counts + names before stopping.
- If Spec 07 (groups) is in flight, coordinate edits to `grid-view.js` header rendering; the bulk bar and the group filter both live there.
