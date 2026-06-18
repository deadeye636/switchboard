# Fork Features

Everything in this fork (`HaydnG/switchboard`) that is **not** in the upstream
project (`doctly/switchboard`). The fork takes upstream `v0.0.30` to `v0.1.0`,
adding two major feature waves plus a set of reliability/packaging fixes.

At a glance:

- **19 new renderer modules** in `public/` (pure, `node --test`-covered logic)
- **27 test files** (upstream had none of these)
- **Two feature waves**: an *Agent Supervision* layer and a *Productivity* layer
- **A reliability/infra wave**: crash-resistance, packaging, caching, hardening

> How this was derived: `git diff upstream/main...main`. Per-feature design docs
> live in `docs/specs/` (features 01–08), with the planning context in
> `docs/productivity-roadmap.md` and `docs/agent-supervision-ux-plan.md`.

---

## Wave 1 — Agent Supervision

Turns Switchboard from a session browser into an "agent control room": explicit
per-session state, a prioritized attention queue, health/cost insight, and safer
human control flows. Upstream tracked some raw runtime state inline; this fork
extracts it into tested pure modules and builds a full supervision UI on top.

### Session status model
`public/session-status.js`

- A formal status model: **Needs You → Ready → Working → Running → Exited →
  Idle**, each with a label, CSS class, priority, and inbox membership.
- Derives status from runtime state (`attentionSessions`, `responseReadySessions`,
  `sessionBusyState`, `activePtyIds`, open/closed terminals).
- Helpers for inbox ordering, status counts, and status filtering — all pure and
  unit-tested (`test/session-status.test.js`).

### Attention inbox + status chips
`public/sidebar.js`

- An **"Attention" section** that appears above projects whenever any session
  needs human action, has finished with unread output, or is actively running.
- The list is **priority-ordered** with a working **"Focus next"** button
  (`getNextAttentionInboxItem`) that cycles through everything needing you.
- Visible **status chips** on session rows so state is conveyed by text, not just
  a colored dot.

### Grid command center
`public/grid-view.js`

- Per-card status chips and per-project counts.
- Status **filters** in grid mode: All / Needs You / Ready / Running.
- Attention-session card actions stay visible (not hover-only).
- **Auto-open running sessions** in the grid (`getGridAutoOpenSessionIds`) —
  reattaches to live PTYs only, never spawns a new `claude`.

### Session health + handoff packets
`public/session-health.js`

- A health model: **Healthy → Growing → Marathon Risk → Handoff Recommended**,
  computed from user-turn count, total entries, active time, cache-read tokens,
  and largest single prompt.
- Shows *why* a session is flagged (the crossed thresholds) on the health chip.
- `buildHandoffTemplate()` / `buildHandoffRequestPrompt()` generate a structured
  handoff packet so a long/expensive session can be continued cheaply in a fresh
  one. (Wired into one-click handoff — see Wave 2.)

### Per-session timeline
`public/session-timeline.js`

- A per-session event log (capped at 80 events) for the supervision-relevant
  moments: started, busy, idle, needs-attention, response-ready, exited, stopped,
  forked.
- Searchable/filterable timeline viewer, separate from raw terminal scrollback.

### Session card details / traffic-light metrics
`public/session-card-details.js`

- Compact per-session metric labels (turns, cache, active time, message count)
  with **green/amber/red** traffic-light levels for each metric and for
  last-activity age — so an at-risk session reads at a glance.
- Worktree label extraction for sessions living under `.claude/worktrees/`.

### Usage monitoring
`public/usage-status.js`

- Surfaces Claude usage limits: current 5-hour window, weekly (all models),
  weekly Sonnet, weekly Opus, and the monthly extra-usage **quota** (with
  money formatting).
- Graceful states for rate-limited / unavailable / **stale-cached** usage,
  including retry-timing hints and high-usage (≥80%) emphasis.

### Spring cleaning (bulk session cleanup)
`public/session-cleanup.js`, `public/spring-cleaning-effects.js`

- Finds stale sessions safe to clear out:
  - **Age-based candidates** (inactive ≥ 3/7/30 days), excluding starred,
    archived, and live sessions.
  - **"Abandoned short"** sessions — started, barely used, then left untouched
    (conservative bounds on messages, user turns, and cache-read tokens; unknown
    metrics are never flagged).
- Selection summary (count + project span) and a celebratory cleanup effect.

### Accessibility hardening
`public/a11y-utils.js`

- Make custom clickable rows keyboard-operable: `role="button"`, tab focus, and
  Enter/Space activation.
- Sync icon-button `title`s to `aria-label`/tooltip.
- Live-region announcements for status changes ("3 sessions need attention") and
  `prefers-reduced-motion` support across ripples, spinners, shimmer, toasts.

### Safer human-control dialogs
`public/control-dialogs.js`

- App-styled confirmation dialogs/toasts replacing native `confirm`/`alert` for
  archive, hide-worktree, remap, and stop actions — with affected counts/names,
  an explicit destructive-action label, and an **Undo** path where supported.

---

## Wave 2 — Productivity (specs 01–08)

Gets the supervision intelligence *out of the app window* and shortens every
context switch. Each feature has a full design doc under `docs/specs/`.

### 01 — Native notifications + badge + tray
`public/notification-policy.js`, `main.js`

- Native **OS notifications** when a session needs you while Switchboard is
  unfocused; clicking one focuses the window and that session.
- **Dock/taskbar badge** count of inbox sessions; **tray icon** with summary
  tooltip and a menu (Open / Focus next attention / Quit).
- **Coalescing + throttling** so five agents finishing at once become one
  "3 sessions need you", not five toasts.
- Global Settings toggles (notifications on/off, notify-on-Ready vs only-Needs-You).
- The notify/badge decision is a pure, unit-tested helper.

### 02 — Next-attention hotkey + alert sound
`public/alert-sound.js`, `public/app.js`

- A configurable in-app **hotkey** (default `Cmd/Ctrl+Shift+A`) to jump to the
  next session needing attention, working even while a terminal is focused.
- An optional **alert sound** on a new "Needs You" (coalesced, off by default),
  with the decision logic unit-tested.

### 03 — "While you were away" summary
`public/away-summary.js`

- Tracks a per-session **last-viewed** marker and **files touched** while away.
- On returning to a session that changed while unfocused, shows a compact,
  dismissible summary: key timeline events since last view, files touched, and
  whether it's waiting on you. Never hides the live terminal.

### 04 — One-click handoff
`public/handoff-flow.js`, `public/dialogs.js`

- Turns "Handoff Recommended" into a single guided flow: ask the current agent
  for a handoff packet → start a fresh, lean session seeded with it → switch to
  it. Every token-spending step is explicit and cancelable.

### 05 — Hook-based attention detection
`public/attention-source.js`, `main.js`

- A more reliable attention signal sourced from **Claude Code hooks**
  (`Notification` + `Stop` events) via a local `127.0.0.1` HTTP ingest server,
  catching permission/tool prompts the OSC-9 regex misses.
- Direct session correlation via the hook's `session_id`; the OSC-9 heuristic
  remains the fallback. Classification/precedence is a single tested helper.
- Opt-in: only writes to `~/.claude/settings.json` when enabled, and removes its
  own handlers reversibly when disabled.

### 06 — Bulk actions from the grid
`public/bulk-actions.js`, `public/grid-view.js`

- Safe bulk actions scoped to the current grid filter: **Step through queue**,
  **Mark all ready as seen** (with Undo), and **Stop all running** (destructive →
  confirmation listing names). Target computation is pure and tested.

### 07 — Session groups (visual folders)
`public/groups-model.js`, `public/sidebar.js`, `public/grid-view.js`

- User-defined, named, **colored groups** ("folders") for sessions — beyond the
  automatic project/slug grouping.
- Collapsible group sections in the sidebar and bounded, labeled group regions in
  the grid, with **rolled-up attention counts** on group headers and a grid group
  filter. Membership/collapse persist across restarts.
- Includes a one-click **"Launch all"** for a group (`getSessionsToLaunch` skips
  already-open members so nothing double-opens).

### 08 — Flexible grid layout (resize / drag)
`public/grid-layout.js`, `public/grid-view.js`

- **Resize** grid cards to span columns/rows (snap-to-grid 1×1 / 2×1 / 2×2) and
  **drag to reorder** them (and into/out of groups), with a live FLIP reflow
  preview and snap-layout popover.
- Per-session span + order persist across restarts; a "reset layout" affordance
  restores the uniform grid. Geometry math is pure and tested.

---

## Wave 3 — Reliability, packaging & hardening

Smaller but important changes (mostly in main/Node-side files).

### Crash & lifecycle resilience
- **Single-instance lock** (`requestSingleInstanceLock`) so replacing a running
  AppImage doesn't orphan PTYs.
- **Exit banner**: when a session's process dies, the terminal stays mounted with
  a banner instead of silently closing.
- **Restore open sessions** across a normal quit/relaunch, and a one-shot restore
  across auto-update relaunches (`public/update-restart.js`).
- Auto-update **restart toast** flow.

### Session/cache correctness
- **Reconcile the cache with the filesystem** on `get-projects` so sessions stop
  going missing (`test/reconcile-cache.test.js`).
- **Detect missing project paths** and let the user remap them; show error
  feedback and disable clicks on missing projects.
- **Canonicalize/dedupe** project folders that resolve to the same path.
- Don't apply the worktree default when resuming a session.
- **Adaptive polling** of active sessions (faster when active, slower when idle)
  and resolving `projectPath` from cache metadata instead of re-reading JSONLs.

### Durable caches & DB robustness
- **Durable usage cache** (`usage-cache.js`) so usage survives rate-limits with a
  stale-but-useful fallback, including a write fallback.
- **SQLite busy/locked retry** wrapper (`sqlite-busy-retry.js`) for overlapping
  watcher/index writes.

### Security hardening
- Route terminal **copy through the main-process clipboard** and handle **OSC 52**.
- Harden the interactive `claude` spawn and the MCP lock file.
- Use `execFileSync` for Keychain reads (avoids shell interpolation).
- Add `dompurify` for safe HTML rendering.
- Renderer IPC security hardening and scheduler/shell hardening (integrated
  upstream-safe PRs).

### Packaging & release
- **Arch/Manjaro `pacman` target** (published as `switchboard-doctly` to avoid a
  name collision), plus multi-size Linux **icons** (`build/icons/`).
- Fork release pipeline via GitHub Actions with **unsigned fork builds** (no
  signing secrets required), publishing to `HaydnG/switchboard`.

---

## Testing

The fork adds **27 test files** under `test/` (`node --test`), covering all the
pure modules above — attention/status, health, timeline, usage, cleanup,
notifications, hotkey/sound, away-summary, handoff, bulk actions, groups, grid
layout, accessibility, update-restart, cache reconcile, schedule injection,
DB busy-retry, and more. Run with:

```bash
npm test
```
