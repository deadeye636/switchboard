# Spec 01 — Native notifications + dock/taskbar badge + tray

> Read `docs/specs/README.md` (shared architecture, IPC, conventions, validation gate) before starting.

**Status:** Implemented · **Roadmap:** Opportunity #1 (Phase 1) · **Independent:** Yes

## Problem & goal

Switchboard's whole value is watching multiple agents for you, but **every attention signal currently dies inside the renderer**. There is no native OS notification, no dock/taskbar badge, and no tray icon anywhere in `src/main.js`. The moment the window is unfocused (you're in your editor/browser), an agent hitting a permission prompt produces **zero** signal.

**Goal:** When a session needs the human while Switchboard is not focused, raise a native OS notification, reflect the count in a dock/taskbar badge, and provide a tray icon with quick status. Clicking a notification focuses the window and that session.

## Current state (grounded)

- Attention transitions happen in `src/renderer/app.js`:
  - `attentionSessions.add(sessionId)` at ~line 411 (OSC-9 "needs attention", `onTerminalNotification` handler).
  - `responseReadySessions.add(sessionId)` in `setActivity()` ~line 187 (agent finished while unfocused).
  - Both call `refreshSessionStatusViews()`.
- `clearNotifications(sessionId)` / `clearUnread(sessionId)` (~lines 215–230) clear state when the user attends a session.
- Counts available via `getStatusCounts(sessions, runtime)` (`src/renderer/session/session-status.js`) → `{ all, attention, ready, active }`.
- `mainWindow` singleton in `src/main.js` (~line 125); `getMainWindow()` exported ~line 304.
- The renderer does **not** currently track window focus.

## Scope

**In:** focus tracking, a pure "should notify" decision helper + tests, native `Notification`, dock/taskbar badge, tray icon + menu, coalescing/throttle, Global Settings toggles, click-to-focus.
**Out:** sound (Spec 02), the next-attention hotkey (Spec 02), changing *how* attention is detected (Spec 05).

## Design

### New pure module: `src/renderer/shell/notification-policy.js` (UMD, Electron-free, tested)
Decides whether/what to notify based on transitions + focus + settings + coalescing. No DOM, no Electron.

```js
// decideNotifications({ prev, next, windowFocused, settings, now, lastNotifiedAt })
//   prev/next: { attention: Set|string[], ready: Set|string[] } snapshots
//   settings:  { enabled, notifyOnReady } (sound handled by spec 02)
// returns: { notifications: [{ kind:'attention'|'ready', sessionIds:[...], title, body }], badgeCount }
// Rules:
//   - only emit for sessions that transitioned INTO attention/ready since prev
//   - never emit when windowFocused is true (badge still updates)
//   - coalesce multiple sessionIds of the same kind into one "N sessions need you"
//   - throttle: skip if now - lastNotifiedAt < COALESCE_WINDOW_MS (e.g. 4000); caller batches
//   - badgeCount = attention.size + (notifyOnReady ? ready.size : 0)
```

### Main process (`src/main.js`)
Add an IPC-driven notification surface near `mainWindow` setup:
- `ipcMain.on('notify', (_e, { title, body, sessionId }) => …)` → create `new Notification({ title, body })`; on `click`, focus window (`mainWindow.show(); mainWindow.focus()`) and `webContents.send('focus-session', sessionId)`.
- `ipcMain.on('set-badge', (_e, count) => …)`:
  - macOS: `app.dock?.setBadge(count ? String(count) : '')`.
  - Windows/Linux: `mainWindow.setOverlayIcon(...)` is optional; at minimum `app.setBadgeCount(count)` (Linux Unity/macOS). Use `app.badgeCount = count` where supported.
- Tray: create a `Tray` with the app icon (`build/` icon or `public/icon.png`), tooltip = summary string, context menu: **Open Switchboard**, **Focus next attention** (sends `focus-next-attention` — Spec 02 owns the handler; until then it just focuses the window), **Quit**. Update tooltip via an IPC `set-tray-summary`.
- Guard all sends with `mainWindow && !mainWindow.isDestroyed()`.

### Preload (`src/preload.js`) — append
```js
notify: (payload) => ipcRenderer.send('notify', payload),
setBadge: (count) => ipcRenderer.send('set-badge', count),
setTraySummary: (text) => ipcRenderer.send('set-tray-summary', text),
onFocusSession: (cb) => ipcRenderer.on('focus-session', (_e, id) => cb(id)),
onFocusNextAttention: (cb) => ipcRenderer.on('focus-next-attention', () => cb()),
```

### Renderer (`src/renderer/app.js`)
- Track focus: `let windowFocused = document.hasFocus();` update on `window` `focus`/`blur` and `document` `visibilitychange`.
- Snapshot `{ attention, ready }` before each transition; after a transition, call `decideNotifications(...)`, then for each result `window.api.notify(...)`, plus `window.api.setBadge(badgeCount)` and `window.api.setTraySummary(...)`. Hook this into the existing `refreshSessionStatusViews()` path so all transitions funnel through one place.
- `window.api.onFocusSession(id => { /* open + focus the session, clearNotifications(id) */ })`.
- When window regains focus, recompute badge (attended sessions may have cleared).
- Read settings from the `global` blob (`global.notifications`, default `{ enabled: true, notifyOnReady: false }`).

### Settings (`src/renderer/panels/settings-panel.js`)
Add a "Notifications" section: **Enable notifications** (default on), **Notify when a session is ready** (default off). Persist into the `global` blob (coordinate with Spec 02, which adds a sound toggle to the same section).

## Files to touch
- **New:** `src/renderer/shell/notification-policy.js`, `test/notification-policy.test.js`.
- **Modified:** `src/main.js` (notification/badge/tray near `mainWindow`), `src/preload.js` (append), `src/renderer/app.js` (focus tracking + funnel in `refreshSessionStatusViews`/transition region ~120–230), `src/renderer/index.html` (script tag before `app.js`), `src/renderer/panels/settings-panel.js` (Notifications section), `src/renderer/style.css` (only if settings UI needs styling).

## Tests (`test/notification-policy.test.js`)
- Transition into attention while unfocused → one attention notification, badge=1.
- Window focused → no notification, badge still reflects count.
- Two sessions ready at once → coalesced single "2 sessions ready" when `notifyOnReady` on; none when off.
- Throttle window suppresses a second emit inside `COALESCE_WINDOW_MS`.
- No transition (already in set) → nothing emitted.

## Acceptance criteria
- Unfocus app → trigger a permission prompt in a session → native notification appears; dock/taskbar shows a badge.
- Clicking the notification focuses the window and that session and clears its badge contribution.
- Tray icon present with working Open / Quit; tooltip shows live counts.
- Toggles in Global Settings enable/disable behavior and persist across restart.
- `npm test`, `ReadLints`, and an Electron smoke run all pass.

## Risks / notes
- Badge APIs are platform-specific; degrade gracefully (macOS dock is the primary target, then Linux `setBadgeCount`, then Windows overlay/no-op).
- Don't spam: all emission must go through `decideNotifications` coalescing.
- Tray needs a correctly-sized icon; reuse an existing build icon.
