# Switchboard Feature Specs

Each file in this folder is a **self-contained spec for one feature**, written so a single agent can pick it up and implement it without needing the original planning conversation. They derive from the productivity roadmap (since migrated to GitHub Issues — see `docs/BACKLOG.md`).

**All ten specs are implemented.** They remain as design records; each spec's `Status:` line and an "As built" note (where the implementation diverged) reflect the final state. Line-number references below describe the codebase at spec-writing time and have drifted.

**Every agent must read this README first**, then their assigned spec.

## Specs

| # | Spec | Roadmap opp. | Independent? |
|---|------|--------------|--------------|
| 01 | [Native notifications + badge + tray](01-native-notifications.md) | #1 | Yes |
| 02 | [Next-attention hotkey + alert sound](02-next-attention-hotkey.md) | #2 | Mostly (shares 2 files w/ 01) |
| 03 | [What changed while I was away](03-what-changed.md) | #3 | Yes |
| 04 | [One-click handoff](04-one-click-handoff.md) | #4 | Yes |
| 05 | [Hook-based attention detection](05-hook-attention-detection.md) | #5 | Yes |
| 06 | [Bulk actions from grid](06-grid-bulk-actions.md) | #6 | Yes |
| 07 | [Session groups (visual folders)](07-session-groups.md) — **removed (#185)**, kept as a design record | #7a | Yes |
| 08 | [Flexible grid layout (resize/drag)](08-flexible-grid-layout.md) | #7b | Depends on 07 |
| 09 | [Multi-LLM backends](09-multi-llm.md) | #142 | No — touches spawn/scan/settings |
| 10 | [The project list is a list](10-project-registry.md) | #167 | No — touches the scan + the sidebar |
| 11 | [Performance: keeping the main thread responsive](11-performance.md) | #199, #200 | No — touches the scan hot path + get-projects |

## Shared architecture (read once, applies to all specs)

**Process model** — Electron. `main.js` (main process, Node) ⇄ `preload.js` (context bridge) ⇄ `public/*.js` (renderer). The renderer has no Node access; everything crosses via `window.api` (see `preload.js`).

**Adding an IPC channel:**
- Request/response: `ipcMain.handle('my-channel', handler)` in `main.js`; expose `myThing: (args) => ipcRenderer.invoke('my-channel', args)` in `preload.js`.
- Fire-and-forget renderer→main: `ipcMain.on(...)` + `ipcRenderer.send(...)`.
- main→renderer push: `mainWindow.webContents.send('my-event', ...)` + an `onMyEvent` listener in `preload.js`.
- `mainWindow` is the singleton browser window in `main.js` (declared ~line 125; guard every send with `if (mainWindow && !mainWindow.isDestroyed())`).

**Renderer module convention** — pure-logic modules use the UMD wrapper (see top of `public/session-status.js`): `module.exports` under Node (for tests), `Object.assign(root, factory())` in the browser (globals). Keep all testable logic in this style and **Electron-free**. UI wiring lives in `public/app.js`, `public/sidebar.js`, `public/grid-view.js`.

**Script load order** — new renderer files must be added as `<script>` tags in `public/index.html` (current order ends ~lines 124–151). Add pure-logic modules **before** the files that consume them (e.g. before `sidebar.js`/`grid-view.js`/`app.js`).

**Settings persistence** — `window.api.getSetting(key)` / `setSetting(key, value)` (SQLite-backed via `db.js`). The renderer keeps a `global` settings blob (restored in `app.js` ~line 1261). Small per-feature blobs (e.g. `groups`) are the cheapest persistence path.

**Tests** — Node's built-in test runner (`node --test`), files in `test/*.test.js`. Run with `npm test`. Tests require the module under test via `require('../public/foo.js')` thanks to the UMD wrapper. Native modules (better-sqlite3, node-pty) are avoided in unit tests — keep logic decoupled from them.

**Validation gate for every spec (user rule):**
1. `npm test` passes.
2. `ReadLints` clean on touched files (and Prettier-consistent formatting).
3. Build/run smoke check — launch the app (`npm run electron`) and exercise the feature; confirm no new runtime errors in the console.

## Key runtime state (lives in `public/app.js`, ~lines 122–130)

These Sets/Maps are the source of truth for supervision and are passed into the pure helpers as a `runtime` object:

- `attentionSessions: Set<sessionId>` — needs human action (from OSC-9, `app.js:401`).
- `responseReadySessions: Set<sessionId>` — agent finished while unfocused.
- `sessionBusyState: Map<sessionId,bool>` — currently working.
- `activePtyIds: Set<sessionId>` — has a live PTY.
- `openSessions: Map<sessionId,entry>` — `entry.element` is the terminal container, `entry.closed`, `entry.terminal` (xterm), `entry.session`.
- `lastActivityTime: Map<sessionId,Date>`.
- `activeSessionId` — currently focused session.
- `sessionTimelineStore` — see `public/session-timeline.js`.

Status/health helpers: `getSessionStatus`, `getStatusCounts`, `getAttentionInboxItems`, `getNextAttentionInboxItem` (`public/session-status.js`); `getSessionHealth`, `buildHandoffTemplate`, `buildHandoffRequestPrompt` (`public/session-health.js`).

## File-conflict map (for parallel work)

Coordinate or sequence when two in-flight specs touch the same file.

| File | Specs that touch it | Note |
|------|---------------------|------|
| `public/app.js` | 01, 02, 03, 05, 07 | Highest-contention file. Each spec edits a *different region* (see per-spec "Files to touch"). Land small, rebase often. |
| `preload.js` | 01, 03, 05, 06 | Additive only — append new bridge methods; conflicts are trivial. |
| `main.js` | 01, 05 | 01 adds notification/badge/tray near `mainWindow` (landed at ~468); 05 adds a local HTTP ingest server (landed at ~2287, not the OSC parsing region). Different regions. |
| `public/index.html` | 02, 03, 07, 08 | Additive `<script>` tags only. |
| `public/grid-view.js` | 06, 07, 08 | **Real contention.** Prefer sequencing 07 → 08, and 06 alongside 07. |
| `public/sidebar.js` | 03, 07 | 07 adds group rendering; 03 adds a small "while away" affordance. Different regions. |
| `public/style.css` | 01, 03, 06, 07, 08 | Append new rule blocks at end; low conflict risk. |
| `public/settings-panel.js` | 01, 02 | Both add Global Settings toggles — coordinate the settings section. |

**Recommended ordering:** Ship 01 first (foundational, exercises the IPC/notification path). 02, 03, 04, 05, 06 are independent and can run in parallel. For the grid family, do 07 then 08; 06 can run with 07 if both authors coordinate `grid-view.js` regions.
