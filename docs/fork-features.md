# Fork Features

> **Lineage.** This repo (codename *deadeye*) is a downstream fork of a fork:
> `doctly/switchboard` (original) → `HaydnG/switchboard` (base) →
> `JeanBaptisteRenard/switchboard` (feature source) → **this fork**. The foundation is
> upstream work and the credit for it belongs to its authors; it has since been
> substantially rewritten here. **Waves 1–3 below document what the HaydnG base adds over
> upstream `doctly`** (inherited by this fork). **Wave 4 documents what *this* fork adds on
> top of HaydnG.**

Everything in the HaydnG base fork (`HaydnG/switchboard`) that is **not** in the upstream
project (`doctly/switchboard`). The base fork takes upstream `v0.0.30` to `v0.1.0`,
adding two major feature waves plus a set of reliability/packaging fixes.

At a glance:

- **19 new renderer modules** in `src/renderer/` (pure, `node --test`-covered logic — they lived in
  `public/` until #214 moved every source file under `src/`)
- **47 new test files** at the time this list was started (72 total under `test/`; the base fork had 29) —
  count `test/` for today's number, it has grown several times over
- **Two feature waves**: an *Agent Supervision* layer and a *Productivity* layer
- **A reliability/infra wave**: crash-resistance, packaging, caching, hardening

> How this was derived: `git diff upstream/main...main`. Per-feature design docs
> live in `docs/specs/` (features 01–08); the planning context now lives in the
> GitHub Issues.

---

## Wave 1 — Agent Supervision

Turns Switchboard from a session browser into an "agent control room": explicit
per-session state, a prioritized attention queue, health/cost insight, and safer
human control flows. Upstream tracked some raw runtime state inline; this fork
extracts it into tested pure modules and builds a full supervision UI on top.

### Session status model
`src/renderer/session/session-status.js`

- A formal status model: **Needs You → Ready → Working → Running → Exited →
  Idle**, each with a label, CSS class, priority, and inbox membership.
- Derives status from runtime state (`attentionSessions`, `responseReadySessions`,
  `sessionBusyState`, `activePtyIds`, open/closed terminals).
- Helpers for inbox ordering, status counts, and status filtering — all pure and
  unit-tested (`test/session-status.test.js`).

### Session lineage / provenance (#223, #193)
`src/session/session-lineage.js`, `src/renderer/shell/sidebar-lineage.js`, spec 13

- A session that continued another's work folds its earlier sessions under the live head behind a
  **"▶ N earlier"** caret (the subagent-nesting affordance), each a **full session row** with all its
  actions; a live earlier session stays its own row. Lineage is a tree — each head walks its own path up,
  so a shared ancestor can appear under more than one head (Model A).
- Backend-neutral via `lineageParentId`/`lineageKind`: Hermes `parent_session_id`, a Claude fork's
  `forkedFrom` and a Pi fork's `parentSession` are hard links; a Claude `/clear` (no on-disk back-link) is inferred and labelled a guess —
  never presented as fact.
- #223: a `/clear` folds the old session onto the new one so the tab follows — **including with several
  sessions live in one folder**. No folder-local signal (mtime, cwd, gitBranch) can attribute a clear, so
  Switchboard asks the CLI instead: each launch gets a per-spawn hook settings file whose `SessionEnd`
  hook names the terminal, and the CLI then reports which terminal cleared which session. A fact, not a
  guess. Two terminals clearing in the same folder at the same moment still bail on purpose (#242).
- Tested: `test/session-lineage.test.js`, `test/clear-rekey.test.js`, `test/sidebar-lineage-vm.test.js`.

### Session visit history
`src/renderer/session/session-history.js`

- Browser-style **back / forward** through visited sessions
  (`Ctrl/Cmd+Shift+,` / `.`, rebindable). Temporal order, unlike `navigateSession`,
  which cycles the sidebar's spatial order.
- A visit stack with a cursor; going somewhere new from the middle abandons the
  forward tail, and a back/forward jump never records itself. Entries whose
  session is gone are pruned, not navigated to. Pure and unit-tested
  (`test/session-history.test.js`).

### Attention inbox + status chips
`src/renderer/shell/sidebar.js`

- An **"Attention" section** that appears above projects whenever any session
  needs human action, has finished with unread output, or is actively running.
- The list is **priority-ordered** with a working **"Focus next"** button
  (`getNextAttentionInboxItem`) that cycles through everything needing you.
- Visible **status chips** on session rows so state is conveyed by text, not just
  a colored dot.
- **Sticky inbox** (global setting `stickyAttentionInbox`, default on) — the section
  pins to the top of `#sidebar-content` while the project list scrolls under it.

### Grid command center
`src/renderer/views/grid-view.js`

- Per-card status chips and per-project counts.
- Status **filters** in grid mode: All / Needs You / Ready / Running.
- Attention-session card actions stay visible (not hover-only).
- **Auto-open running sessions** in the grid (`getGridAutoOpenSessionIds`) —
  reattaches to live PTYs only, never spawns a new `claude`.
- **Keyboard move mode** (`Ctrl/Cmd+Shift+M`, rebindable) — the a11y counterpart to
  pointer drag/resize: arrows reorder the focused card, `Shift`+arrows resize it,
  `Esc`/`Enter` leave. While the mode runs it gates its keys away from the focused
  terminal; every exit path (blur, card destroyed, grid closed, focus moved) clears
  it. Announcements go to a grid-owned live region, separate from the attention one.

### Session health + handoff packets
`src/renderer/session/session-health.js`

- A health model: **Healthy → Growing → Marathon Risk → Handoff Recommended**.
  Handoff Recommended comes from the **context fill**: the last turn's input
  against the window of the model it ran on, at a global threshold (default
  80 %). User turns, entries, active time, cache reads and the largest prompt
  raise Marathon Risk at most (#620, `docs/specs/28-session-health.md`).
- The fill is measured for Claude, Codex and Pi and shown as text in the row
  ("62 % context · 4h active", switchable); Hermes and agy cannot measure it
  and show no health badge.
- Shows *why* a session is flagged (the fill first, then the crossed thresholds)
  in the handoff dialog.
- `buildHandoffTemplate()` / `buildHandoffRequestPrompt()` generate a structured
  handoff packet so a long/expensive session can be continued cheaply in a fresh
  one. (Wired into one-click handoff — see Wave 2.)

### Per-session timeline
`src/renderer/session/session-timeline.js`

- A per-session event log (capped at 80 events) for the supervision-relevant
  moments: started, busy, idle, needs-attention, response-ready, exited, stopped,
  forked.
- Searchable/filterable timeline viewer, separate from raw terminal scrollback.

### Session card details / traffic-light metrics
`src/renderer/session/session-card-details.js`

- Compact per-session metric labels (turns, cache, context fill (#620), active time, message count)
  with **green/amber/red** traffic-light levels for each metric and for
  last-activity age — so an at-risk session reads at a glance.
- Worktree label extraction for a session working in one — all three conventional layouts and either
  separator since #582, and since #586 the whole chain (`agent-a / hotfix-1`) rather than the leaf, so two
  checkouts of the same name under different agents do not read alike. `worktreeLabelOf`
  (`src/shared/worktree-path.js`) is the one answer; every surface that names a worktree asks it.

### Usage monitoring (per backend, #191)
`src/renderer/shell/usage-status.js`, `src/backends/usage-format.js`, `backends/<id>/usage.js`

- **One status-bar segment per backend that reports a quota**, each with its own badge and each
  selectable in *Settings → Usage & notifications*. A backend declares the capability on its
  descriptor; nothing in the core names a backend id.
- **Claude** is fetched live from the API (5h, weekly, Sonnet, Opus, and the extra-usage credit pool
  with money formatting). **Codex** is read out of its own transcript — no network call, no credential
  access — so its figure is *as of its last run*: the segment dims past an hour and its tooltip says
  when it was measured. **Antigravity** reads AGY's loopback quota service, preferring any running `agy`
  process — its own sessions or one started in a terminal — and otherwise using one bounded probe that
  backs off while it keeps failing; the old Google OAuth endpoint remains a best-effort fallback.
  Isolated demo/sandbox runs never start or query the real AGY CLI. Hermes and Pi have no quota and never
  appear.
- **A switched-off backend is never fetched.** Colour thresholds are keyed on how fast a bucket
  refills, not on a window name, so a backend that invents its own windows still colours correctly.
- Graceful states for rate-limited / unavailable / never-reported / **stale-cached** usage, including
  retry-timing hints.

### Spring cleaning (bulk session cleanup)
`src/renderer/session/session-cleanup.js`

- Finds stale sessions safe to clear out:
  - **Age-based candidates** (inactive ≥ 3/7/30 days), excluding starred,
    archived, and live sessions.
  - **"Abandoned short"** sessions — started, barely used, then left untouched
    (conservative bounds on messages, user turns, and cache-read tokens; unknown
    metrics are never flagged).
- Selection summary (count + project span).

### Accessibility hardening
`src/renderer/lib/a11y-utils.js`

- Make custom clickable rows keyboard-operable: `role="button"`, tab focus, and
  Enter/Space activation.
- Sync icon-button `title`s to `aria-label`/tooltip.
- Live-region announcements for status changes ("3 sessions need attention") and
  `prefers-reduced-motion` support across ripples, spinners, shimmer, toasts.

### Safer human-control dialogs
`src/renderer/dialogs/control-dialogs.js`

- App-styled confirmation dialogs/toasts replacing native `confirm`/`alert` for
  archive, hide-worktree, remap, and stop actions — with affected counts/names,
  an explicit destructive-action label, and an **Undo** path where supported.

---

## Wave 2 — Productivity (specs 01–08)

Gets the supervision intelligence *out of the app window* and shortens every
context switch. Each feature has a full design doc under `docs/specs/`.

### 01 — Native notifications + badge + tray
`src/renderer/shell/notification-policy.js`, `src/app/notifications.js`

- Native **OS notifications** when a session needs you while Switchboard is
  unfocused; clicking one focuses the window and that session.
- **Dock/taskbar badge** count of inbox sessions; **tray icon** with summary
  tooltip and a menu (Open / Focus next attention / Quit).
- **Coalescing + throttling** so five agents finishing at once become one
  "3 sessions need you", not five toasts.
- Global Settings toggles (notifications on/off, notify-on-Ready vs only-Needs-You).
- The notify/badge decision is a pure, unit-tested helper.
- An **optional second tray icon** showing usage (#113): one backend's worst window as a
  ring or a badge, in that backend's own colour, fixed or rotating through the ones the
  status bar shows. Drawn in the renderer — the main process has no canvas, and the app
  has no close-to-tray, so a renderer is always there. On macOS the figure goes beside
  the icon with `setTitle` rather than into a bitmap the menu bar cannot recolour. It
  reuses the status bar's own reading: no poll and no fetch of its own.

### 02 — Next-attention hotkey + alert sound
`src/renderer/shell/alert-sound.js`, `src/renderer/app.js`

- A configurable in-app **hotkey** (default `Cmd/Ctrl+Shift+A`) to jump to the
  next session needing attention, working even while a terminal is focused.
- An optional **alert sound** on a new "Needs You" (coalesced, off by default),
  with the decision logic unit-tested.

### 03 — "While you were away" recap
`src/renderer/shell/away-summary.js`, `src/renderer/shell/away-overview-view.js`,
`src/renderer/shell/presence-report.js`

- Tracks whether **you** were away — not whether a window lost focus (#386).
  `src/app/presence.js` owns it: every window reports focus and input, and main
  is the only place that can see all of them. Since #673 main also polls the
  OS idle time, so working in another application is not an absence either.
  Switching windows and sessions while you work shows nothing; the attention
  inbox is the surface for that.
- On coming back after a real absence you get **one entry in the attention
  inbox**, and opening it shows **one overview of every session that changed**:
  rows expand to that session's events and the files it touched, and each row
  has a button that reveals its session in the window that holds it (#402).
- It used to be a banner over the terminal, per session, in whichever window
  rendered it — so the answer to "what did I miss" sat wherever the sessions had
  been scattered to, and a stray keystroke destroyed it before it was read.
- Losing it is a decision now: closing the overview leaves the entry to be opened
  again, and only its × discards it. Every inbox row has that × — dismissing a
  session settles it *without* marking it as read.
- The record behind it lives in the main process (#396), so it survives a reload,
  a window close and a restart — the exact span the recap exists to describe.
- Two settings: show it at all, and how long counts as away.

### 04 — One-click handoff
`src/renderer/handoff/handoff-actions.js`, `src/renderer/dialogs/dialogs.js`

- Turns "Handoff Recommended" into a single guided flow: ask the current agent
  for a handoff packet → start a fresh, lean session seeded with it → switch to
  it. Every token-spending step is explicit and cancelable.

### 05 — Hook-based attention detection
`src/shared/attention-source.js`, `src/app/hooks.js`

- A more reliable attention signal sourced from **Claude Code hooks**
  (`Notification` + `Stop` events) via a local `127.0.0.1` HTTP ingest server,
  catching permission/tool prompts the OSC-9 regex misses.
- Direct session correlation via the hook's `session_id`; the OSC-9 heuristic
  remains the fallback. Classification/precedence is a single tested helper.
- Opt-in: only writes to `~/.claude/settings.json` when enabled, and removes its
  own handlers reversibly when disabled.

### 06 — Bulk actions from the grid
`src/renderer/shell/bulk-actions.js`, `src/renderer/views/grid-view.js`

- Safe bulk actions scoped to the current grid filter: **Step through queue**,
  **Mark all ready as seen** (with Undo), and **Stop all running** (destructive →
  confirmation listing names). Target computation is pure and tested.

### 07 — Session groups (visual folders) — **removed (#185)**

Shipped, then taken back out. Session tags carry the same idea on a better model
(many per session, their own table, central management) and the tag filter (#164)
selects the same set a group section drew — so groups, the folder-first sidebar
layout and the grid's group regions were deleted rather than maintained twice.
The design record survives in `docs/specs/07-session-groups.md`.

### 08 — Flexible grid layout (resize / drag)
`src/renderer/views/grid-layout.js`, `src/renderer/views/grid-view.js`

- **Resize** grid cards to span columns/rows (snap presets 1×1 / 2×1 / 1×2 / 2×2 /
  full width; up to 3 rows via the keyboard move mode) and **drag to reorder**
  them, with a live FLIP reflow preview and snap-layout popover.
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
- **Restore open sessions** across a normal quit/relaunch, with a one-shot restore
  on app restart (`src/renderer/shell/update-restart.js`; originally built for auto-update
  relaunches — the auto-updater itself has since been removed from this fork).
  Restored is what was **running**, not only what had a tab (#438) — and the two come back
  differently, because the goal is the state at quit rather than a busier one:
  - a session that had a **tab** is reopened with its tab, as before;
  - a session that was only **running** (its tab closed, its CLI still going — the quit guard already
    counts it) gets its **process back and no tab**. The sidebar marks it running and a click
    reattaches it with its scrollback, exactly as before the quit.

  In panes mode such a session keeps its tab in the saved layout, drawn dormant. Its placeholder follows
  the process it describes: once the poll has seen the restarted process it stops saying "not running"
  and offering Launch, and says so again if the process ends (#668).

  The set is written on the unload that goes with a quit, and a crash or a killed process never unloads.
  A session re-keyed while the app runs (a `/clear`, a fork) is therefore renamed in the saved set on the
  spot, as the pane layout and a window of its own already were (#669); otherwise the next launch resumed
  the session from before the `/clear`. Chromium writes that state to disk on a delay of its own, so the app
  asks it to commit shortly after each re-key, or a kill right after it would lose the rename. The price:
  after a crash, a fork re-keyed before its first turn has no transcript under its new id yet and is skipped
  by the restore instead of resuming its parent — which is what a normal quit already did.

  A window of its own restores its own sessions the same way, telling the two apart by its saved pane
  arrangement. A plain terminal stays excluded: it has no transcript, so a reopened one would be a
  fresh shell wearing the old session's name.

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
- **Durable usage cache** (`src/backends/usage-cache.js`) so usage survives rate-limits with a
  stale-but-useful fallback, including a write fallback.
- **SQLite busy/locked retry** wrapper (`src/db/sqlite-busy-retry.js`) for overlapping
  watcher/index writes.

### Security hardening
- Route terminal **copy through the main-process clipboard** and handle **OSC 52**.
- Harden the interactive `claude` spawn and the MCP lock file.
- Use `execFileSync` for Keychain reads (avoids shell interpolation).
- Add `dompurify` for safe HTML rendering.
- Renderer IPC security hardening and shell hardening (integrated
  upstream-safe PRs).

### Packaging & release
- **Arch/Manjaro `pacman` target** (published as `switchboard-doctly` to avoid a
  name collision), plus multi-size Linux **icons** (`build/icons/`).
- Fork release pipeline via GitHub Actions with **unsigned fork builds** (no
  signing secrets required), publishing to `HaydnG/switchboard`.

---

## Wave 4 — deadeye fork additions (on top of HaydnG)

Everything below is added by **this fork** on top of the HaydnG base. Derived via
`git diff haydng/main...main`. Some items are ports of other community forks (noted).

### Onboarding

- **A welcome tour on the first launch (#146)** — nine panes over one dialog, opened once on a profile
  that has no `welcomeDismissed`, and reachable again from **Settings → Maintenance** (it is a thing you do, not a plate to read). What makes it more than a
  splash screen: **every pane that names a setting also writes it**, through the route that setting is
  actually written by (a flat merge, a read-modify-write for the nested ones, the hook call for the
  attention hooks) and re-applied in the window on the spot. Five panes draw the effect of their own
  controls — the arrangement, the sidebar's fold, what the × on a tab does, where a diff lands, which
  directories a plan and a handoff go into — and redraw as the controls change. The figures are inline
  SVG rather than screenshots, because a picture that answers to a number cannot be a PNG. It names no
  backend: the two panes about a CLI's own options ask the registry which backend declares them.

### Multi-LLM backends

The largest structural change this fork makes: Switchboard stops being a Claude-only cockpit and
becomes a **multi-CLI** one. Full spec: [`multi-llm.md`](multi-llm.md).

- **Five backends, one app** — Claude Code, **Codex**, the **Antigravity CLI** (`agy`), **Hermes** and
  **Pi** run side by side in one sidebar, one FTS index, one launch menu and one stats view. A backend is a folder under `backends/`
  with a single descriptor; the registry, scanner, watcher, launch menu, settings page, Configure
  dialog, badge, search, stats and resume all derive from it.
- **Pi driven through its runtime (#568)** — `Pi (native)` starts `pi --mode rpc` instead of Pi's TUI and
  draws the conversation from its events: the turn being streamed, tool calls and their output, and
  questions an extension is waiting on. It has no terminal. A text field sends, queues and steers turns,
  and before `bash`, `powershell`, `edit`, `write`, a delegation to the `subagent` tool, a taken-over
  command's shell line or a taken-over MCP tool runs, the call is shown with its command or diff and waits for
  allow once, allow for the session, or refuse. Its sessions stay Pi's rows. A marker in the
  transcript says how a session was driven, and the row reopens there. **Pi's own commands (#642, #643)**:
  `/login` (subscription or API key), `/logout`, `/model`, `/thinking` and `/compact` work in the text field.
  The questions they ask appear as cards in the conversation. `/tree` (#646) opens the session's branch tree
  in a dialog and moves the session to an earlier point, with or without a summary of the branch it leaves;
  a picked message of the user's goes back into the text field. Pi's other terminal commands say where the
  function lives instead of going to the model as a prompt. The text field completes as you type: `/` lists
  Pi's commands, prompt templates and skills, `/model`, `/thinking`, `/login` and `/logout` list their
  arguments, and `@` lists the project's files. An image pasted or dropped into the conversation goes out
  with the next turn (#656); any other file is named in the text as `@path`, which Pi passes on for the
  model to read itself (#699). Spec:
  [`specs/30-pi-native.md`](specs/30-pi-native.md).
- **Claude driven through its stream protocol (#653)** — `Claude (native)` starts the installed `claude` in
  print mode with stream-json on both sides, the protocol the Claude Agent SDK wraps, and draws the
  conversation in the same view as `Pi (native)`. Tool approvals are Claude's own permission prompt,
  answered on a card: allow once, refuse, and "for this session" where Claude suggests something for the
  session, worded as what it allows, and "always allow in this project" where Claude suggests a rule for the
  project's local settings, which Claude then writes itself (#674). `AskUserQuestion` and `ExitPlanMode` arrive as a question card and a
  plan card. A pending card takes the input's place until it is answered, from the keyboard like in the CLI:
  a tab per question, numbered options, notes and "chat about this" (#704). A text field sends, queues and
  steers turns, and Stop interrupts the turn without ending the process. A prompt sent during a turn is held
  by the app until the session is idle, so it can still be edited or withdrawn (#702). Under the input a
  session line shows the context fill, the model, the permission mode (Shift+Tab switches it, #696) and the
  working state, and background shells and agents get a list with Output, Open and Stop (#691, #695).
  Claude's prompt suggestions appear greyed in the empty input and Tab takes one (#693), a sent message
  shows at once (#694), and tool calls start collapsed unless *Show tool calls expanded* is on (#687). A
  skill the model loads is part of its `Skill` call's collapsed output, not a message from the user (#710).
  Scrolled back from the end, the view pins the prompt of the turn being read over the top of the log, in
  Pi's conversation too, and a click on it goes back to that prompt (#709). The
  terminal backend's launch options come along: worktree, Chrome, extra directories, restricted mode and the
  auto-compact window (#685). An image pasted or dropped into the conversation goes out with the next turn (#662), and any
  other file is named as `@path`, which Claude reads into the turn (#699); `/`
  completes Claude's commands and skills, and `/clear` moves the tab to the new session. A local command is
  drawn as the user's line above its output (#718), and `/mcp` opens the session's MCP servers in a dialog shaped
  like the CLI's own — grouped, with state, tool count and error, where the CLI alone would point to a terminal
  (#719) — and manages them from there by mouse or keyboard: view tools, reconnect, enable or disable (asked
  first, since the CLI stores it for the whole project), sign in through the browser and sign out (#728). A
  subagent's report is drawn as a closed card of its own, opened in place, so it does not read as the main
  session answering (#729). Print mode skips Claude's trust dialog, so a session starts only in a project Claude trusts, and
  the app asks the trust question at launch when there is no saved answer (#655). The backend has no login
  and handles no token. Its sessions stay Claude's rows; the marker is the `entrypoint` Claude Code writes
  itself, and Claude's own `/resume` picker does not list them. Off by default. Spec:
  [`specs/32-claude-native.md`](specs/32-claude-native.md).
- **Terminal or GUI, per session (#670)** — a session of an owner/driver pair (`Claude` / `Claude (native)`,
  `Pi` / `Pi (native)`) opens where the user last put it, stored per session in `session_meta.opener`.
  Without a stored choice the old routing applies: the transcript marker while the driver can launch,
  otherwise the terminal. The sidebar row keeps the owner's backend badge and shows a terminal or a
  conversation glyph beside it; a hover button, a pane menu entry, a palette action and the View field of
  *Resume with config* open a session in the other view and store the choice, and *Use the default view*
  clears it. A running session is switched in place: only while idle (no turn running, nothing waiting for
  an answer), after a confirmation, by stopping it and opening it again in the same tab. When either half cannot
  launch, none of this is shown and a stored choice waits until it can. Specs:
  [`specs/32-claude-native.md`](specs/32-claude-native.md), [`specs/23-command-palette.md`](specs/23-command-palette.md).
- **Document preview card (#755)** — in the conversation view of Claude (native) and Pi (native), and in the
  Message History viewer, a file the agent reads (a PDF page range, an image, Markdown, HTML) is drawn as one
  card with a first-page thumbnail, the name and a page label, instead of every page inline. A click opens a
  viewer over the conversation with a pager, zoom and Esc, built from the pages the result already holds; a
  card with no pages (a whole-PDF read, Markdown, HTML) follows the file-click setting, with Ctrl/Cmd
  inverting it, and with `external` sends a PDF, an image or an HTML file to the default program and Markdown
  to the editor. Two buttons open the file in the default app or in a tab. The backend stamps a neutral
  `document` element into the read result; main keeps the paths a session's backend reported and the open
  button is answered only for those (absolute and local, a document extension, a real path that is not
  sensitive, a regular file), so the renderer names no path of its own. The history viewer shows a card and
  the pager but no open buttons. `Documents in the conversation` (`card` or `inline`) and `Largest document with
  a thumbnail (KB)` are in the Sessions category. Pi returns no PDF pages, so its PDF reads stay text; Codex,
  Hermes and agy do not stamp and keep their images inline; the open buttons are refused once the session has
  exited. Spec: [`specs/33-document-preview.md`](specs/33-document-preview.md).
- **Subagents for Pi (#634)** — Pi has no nested agents of its own. With the `subagentTool` setting on, a
  Pi session gets a `subagent` tool that hands one task to an agent defined in a markdown file. The agent
  runs as a separate Pi process with a fresh context and without a session file, and the tool result says
  what the run cost. The tool is passed as a per-spawn extension, so nothing is installed into Pi's own
  configuration. It is off by default. Both Pi backends offer it, and `Pi (native)` asks before a
  delegation unless `approvalGate` is off or that agent was allowed for the session, naming the agent's
  tools and model, because the child runs
  without the app's approval question. Settings: [`settings-reference.md`](settings-reference.md).
- **Resources from (#632)** — switching a session from Claude or Codex to Pi used to leave the user's setup
  behind. The `resourcesFrom` setting on both Pi backends names one source (Claude Code, Codex or the
  Antigravity CLI), and a Pi session then gets that CLI's skills as `--skill` directories and its commands
  through the session's resources extension, which expands arguments, `@file` and inline shell lines. A shell
  line runs only where the command file's `allowed-tools` permits it, and `Pi (native)` asks first unless `approvalGate` is off. Pi's
  own skills and commands win by name (only the app's own `/handoff` and `/plan` give way to a source's), and a project's own directories are passed only when Pi trusts the
  project. The settings screen fills the choices from the backends that offer something and previews what a
  launch would get. **Agents (#639)** come along while the subagent tool is on: their tools are mapped through
  a neutral vocabulary, anything Pi has no counterpart for or cannot enforce is left out and named, an agent
  left with nothing is refused, and a model name is resolved within the session's own provider, never
  another. **MCP servers (#633)** come along while their own switch is on: the source's stdio servers are
  started by a small MCP client in the same extension, their tools are offered as `mcp__<server>__<tool>`,
  the server list reaches Pi through its environment rather than a file, a project's servers need Pi's
  trust and the user's approval in the source CLI, and `Pi (native)` asks before each tool. **Hooks (#635)**
  come along while their own switch is on: a command the source attached to the session opening, a tool call
  finishing or the agent going idle runs at the matching moment in Pi; a hook that answers back does not come
  along. Spec:
  [`specs/31-resources-from.md`](specs/31-resources-from.md).
- **Two kinds of history, one seam** — discovery is dual-mode from the start: a backend yields
  `{kind:'file'}` handles (Claude, Codex, Pi, and agy — whose per-conversation file happens to be a
  SQLite DB, read via an exporter like Hermes) **or** `{kind:'db'}` handles (Hermes keeps its sessions
  in SQLite). Every file parser also exposes an incremental contract (byte offset + tail fingerprint +
  schema version).
- **Launch options per CLI** — each backend declares its own `configFields`; the Settings page and the
  Configure dialog are **generated** from them and stored under `backendDefaults.<id>`, cascading
  global → project. Claude's permission mode is never shown to Codex.
- **Provider badges + mixed mode** — a badge per session row, shown only once more than one backend is
  actually in use. A Claude-only user sees the app unchanged.
- **Busy/idle from four different sources, and an honest answer when there is none** — Claude states it
  in the terminal; Codex, Hermes, Pi and agy have it read out of their own store. When a live session
  never pairs with a store record — Hermes writes plain JSON when it cannot open its own database, and
  the database is what we read — no state can be reported for as long as it runs. The session then
  carries a **hollow dot and the reason on hover** (#151, #460) instead of a blank indicator. It is
  never inferred from PTY output: output is liveness, never work.
  **A second reason sits in the same place** (#305): a backend that CAN announce its turns still needs
  the per-spawn argument that makes it, and everything that stops that is swallowed on purpose — so a
  session that will never say a word used to look exactly like one with nothing to say. Now it says so,
  in one sentence in the session bar's tooltip, joined with the notice above rather than replacing it.
  Deliberately not a badge on the row: the CLI in such a session works, and this explains a quiet
  session rather than reporting a broken one. **A template inherits its base's ability to report**
  (#603) — it runs the base's binary, so it gets the base's binding, and the turn-hold that goes with it. Each backend also says WHEN its record
  appears (#512) — Codex writes its rollout and agy its conversation database with the first turn rather
  than at the spawn, so a session of theirs sitting at its prompt with nothing asked of it yet is never
  reported as one the backend cannot see. That same answer narrows who a record can belong to when two
  sessions of one backend run in one project (#527): a session that has been asked nothing has written
  nothing, so it no longer walks off with the record the session next door produced — as long as that
  neighbour is still live and unpaired, which is the honest limit of what a directory and two timestamps
  can settle.
- **Cost analytics** — where a backend prices its own turns (Hermes, Pi), Stats shows it per backend.
  An estimate is labelled as an estimate, a zero estimate reads as "no cost reported" rather than
  `$0.00`, and a token-only backend shows an em dash.
- **Profiles + presets** — the Claude binary against another endpoint (DeepSeek, GLM, OpenRouter, or
  blank). Secrets are `$VAR` references resolved at spawn and never written to disk; a literal key is
  refused, and a profile that would send your Anthropic key to a third-party endpoint is blocked.
- **Custom launchers (Tier-3)** — any command or script as a saved launcher (in-app monitored tab or
  detached window), global template ⊕ per-project override. The launch menu offers them behind one
  **Custom commands** entry, so a project's tools cannot push the rest of the menu off a short window;
  the entry is absent while nothing is saved.
- **Identity, resume and fork done honestly** — a backend that names its own sessions (Codex, Hermes,
  Pi) has its id adopted, so one session is one row; resume reapplies the recorded backend and never
  falls back to Claude; Fork is only offered where the backend can actually fork. A resume keeps the model the
  session last ran on (Claude, Codex, Pi) unless you chose one for that launch.
- **What each backend supports, as one table** — a matrix with one row per capability, one column per
  installed backend, each cell supported / limited / not supported with a short note saying what is
  limited. It opens from the global Backends settings page and from the page of a single backend, which
  is where someone is already asking what that one can do. Every answer is declared on the backend's own
  descriptor, so a new backend fills its column without a renderer change. Where a capability is missing
  the app says so rather than going quiet — a session whose backend cannot fork keeps the Fork button,
  greyed, and it names the backend that cannot do it.
- **Its skills, rules and commands, in the app** — the Agent Files tab lists what each CLI reads its own
  behaviour from, beside the instruction files it already showed. A customization directory is one row
  that opens into its entries, and an entry opens in the built-in viewer instead of being handed to the
  system.
- **And they can be changed there** — a skill, a rule, a command or a CLI's settings file is saved back
  from the same panel. The format is checked before anything is written (JSON, TOML, YAML, a skill's
  frontmatter), the file's own line endings and BOM survive the round trip, the write is atomic so a CLI
  reading its config mid-save never sees half of one, and a save built on a version something else has
  changed since is refused with the same conflict bar an external change raises. Which files a CLI lets
  the app touch is that CLI's own declaration, so nothing executable is on the list. Skills, commands,
  rules and agents can also be created from a per-backend template and deleted, the deletion asking a
  narrower question than the reading did.
- **A command palette** — F1 over sessions, projects and the app's own commands, matching from
  the first keystroke rather than the third. It opens on the **commands**, under a heading of their own,
  with the jump targets below: an empty palette is being asked what the app can do, and where you were is
  one keystroke away either way. Each group gets its own slice, so the longest cannot eat the list, and
  typing ranks across everything at once with the best match still leading.
  - The commands are declared by whatever owns them, so a feature that gains one does not have to be
    remembered in a list somewhere else — opening a picker, splitting or closing a pane, bookmarking,
    creating a task, writing a handoff or a plan. Navigation is deliberately not there: a direction lives
    in the key press, and a row for it would say nothing without one.
  - **A row says which key does the same thing**, read from the same binding table the key handler
    matches against, so a rebound key cannot leave a stale hint behind. A command that acts on the
    session you are in is offered only when there is one, and names it in the row.
- **Every CLI that reads a file is credited on it** — a project's `AGENTS.md` is Codex', Pi's and
  Hermes'; `CLAUDE.md` is Claude's, Pi's and Hermes'. Hermes had declared no per-project instruction
  files at all while its own launch option offered to skip them, so a Hermes-only project showed nothing;
  its own source settles the set, and files without an extension (`.cursorrules`) open like the rest.
- **Filtered by type and by backend** — the Agent Files tab filters by what a file IS (skills, rules,
  commands, instructions) and by which CLI reads it, both at once, alongside the search. A file two
  backends declare — `AGENTS.md` belongs to Codex and Pi, `CLAUDE.md` to Claude and Pi — wears both
  badges and answers to both filters, rather than being attributed to whichever was asked first.
- **A document stays live while an agent rewrites it** — the viewer already reloaded a file that changed
  on disk, which was enough while the only writer was the user. Now the change arrives as a change: the
  reading position and the cursor survive it, a document being appended to follows the writer if you were
  already at the end, and it reaches whichever window the document was pushed to rather than the main one
  only. If you have edits of your own when the file moves, nothing is overwritten in either direction —
  a bar says so and offers to show you what changed, and a save over a file that moved underneath is
  refused rather than silently winning.
- **Hand a plan to the running CLI from the keyboard** — a shortcut opens a plan picker anchored in the
  focused terminal, holding that terminal's project and nothing else — a foreign plan in a list opened by
  hotkey is another codebase's instructions one Enter away, and the Plans tab is where you go to borrow
  one deliberately. It
  inserts a reference rather than the plan: a plan runs to hundreds of lines and belongs in the agent's
  context through the agent's own file tools, not pasted into a prompt. What exactly gets typed is a
  template you can change, per project if you want to.
- **Hand a skill to the running CLI from the keyboard** — a shortcut opens a skill picker in the focused
  terminal, listing the CLI's own skills alongside skills you keep in Switchboard for every CLI. A CLI that
  can run a skill from its prompt gets its own command, measured for each one rather than guessed; the rest
  get a reference to the document, and a note saying so. Taking a row runs it, which a setting turns off.
- **Hand a handoff to the running CLI from the keyboard** — the same picker shape again, over the
  packets this project keeps. It inserts a reference and does not press Enter: a handoff is context for
  what comes next, not an instruction to act on it.
- **PDFs open in the app** — a PDF from a terminal file link or the file list is rendered page by page
  in the panel instead of being decoded into the source editor, where it used to arrive as unreadable
  bytes over a Save button that would have written them back destroyed.
- **One place for plans, across CLIs** — plan documents can live in the project they are about instead of
  in one CLI's home directory, so a plan written in Claude can be read by whatever runs next. The path is
  a setting with a per-project override, and a button in the project's settings writes what each installed
  CLI needs after showing every file it would change. Because Claude declines a plans directory it does
  not like — outside the project, reached through a link — and does so silently, the list reports what
  actually arrived rather than what was configured. The convention itself is written down in
  `docs/plans-convention.md`, for a person and for an agent, and it degrades: a plan with no issue, no
  tracker and no version control is still a plan.
- **A project's own plans are found, not imposed** — plenty of projects already keep plan documents in
  `docs/plans/` or somewhere of their own choosing. Switchboard looks for them and lists them under that
  project, in a group named after the directory they came from, without anything being configured and
  without writing anything. The names it looks for are a setting, so a layout nobody anticipated can be
  added rather than argued with.
- **A plan knows its project** — plan documents are written into one flat directory under a generated
  name, with nothing in the file to say which project they belong to. The session that wrote the plan
  recorded a reference to it and knows its project, so the Plans list groups by that instead of showing one
  undifferentiated pile. A plan whose session is no longer on disk keeps its place in a group of its own
  that says so, rather than being dropped or labelled as an error.
- **Work files in the same list** — a project's `.work-files/` directory is one more group under that
  project, beside its instruction files and its skills, instead of a sidebar tab of its own. Filtering
  to Work files is what the tab used to be. Deleting stayed with them and with nothing else: a work file
  opens in the one viewer that has a delete button, which is why no other type could grow one by
  accident.

### UI / window
- **Session tabs** — the fork started with a tabbed single view as its primary layout. That mode was
  retired in #357, and its tabs live on in every pane of **Panes**, the default since #374 (below); the
  grid is the other mode left. Right-click **tab context menu** (Close / Stop / Relaunch / Redraw —
  the last repairs a screen a foreign writer has destroyed, #479),
  auto-close, and removal of the top menubar for a cleaner window.
- **Detached session windows** (#2, #314, #315, #316) — move a running session into an OS window of its
  own (pane menu or the tab's context menu) and drag it to a second monitor. It comes back the same
  way: **Return to main window** in that window's menu, or the sidebar row's own button — a detached
  session is marked `⧉` there and its row raises the window instead of opening it twice. A session can
  also move **into any window that is already open**, so a second monitor can carry several of them;
  a window that gives away its last session closes — unless it still holds a view or a review nobody
  has answered (#393) — and closing one by hand hands everything it holds back, answering any open
  review first. The PTY never moves: only the window that receives its output changes, so the session
  runs through the whole detour. Its **attention inbox, badge and sidebar row** stay in the main window,
  and so does "Ready for review", which says something is waiting for *you*. Its own **status** does
  not: since #395 a window of its own learns what its sessions are doing, so its tabs show "Working"
  and its away recap has something to report (#390 keeps it from announcing any of it).
- **Panes** (#309, #312, #313, #318, #321) — the default display mode since #374 (the grid is the other one), which splits the terminal area into a
  VS-Code-style tree of panes, each with its own tab strip. Drag a tab onto a pane's edge to split,
  onto its middle to move it there — a caret marks the gap it will land in — and sashes resize; the
  layout survives a restart. The session tools (messages, tasks, variables, stop) sit with the pane,
  so they act on the terminal below them rather than on "the active session", with the running state
  as a dot in front of the session name. Right-click a tab for its own actions plus the pane's, or the
  strip and the session bar for the pane's alone. A tab whose session has ended offers a **Launch**
  button rather than restarting the CLI on a stray click. `Ctrl/Cmd+Shift+\` splits,
  `Ctrl/Cmd+Shift+1…9` focuses a pane.
- **The settings screen is a category list, in both scopes** — a nav on the left, one page per subject on
  the right, with the field count beside each name **counted** rather than written down (the Terminal page
  said ten and held twenty-six). Project settings got the same shell in #490, and there every installed
  backend is an entry of its own whose page holds its launch defaults **and** its own resources — before
  that the screen listed every backend's defaults first and every backend's resources after them, so a
  backend and the files belonging to it were never on screen together. An entry says how many launch
  options this project overrides, which is the question a project screen exists to answer. A backend's
  resources are read the first time you open its page, so opening settings walks no filesystem at all.
  Design record: [`docs/specs/26-settings-screen.md`](specs/26-settings-screen.md).
- **Settings overhaul** — two-column layout, permission modes aligned to the Claude CLI, and
  a settings window of its own that paints instantly and is kept warm between opens (the in-window
  overlay it used to be an alternative to was removed in #365).
  The actions are pinned to the bottom edge, reachable at any scroll position in any category:
  Hide/Remove Project on the left, then Cancel, **Apply** (save without closing, so several
  categories can be adjusted and checked one after another) and Save. Custom launchers have a
  page of their own.
- **A backend declares what it can do, and it is all configurable** — `configFields` on the descriptor;
  the settings page, the Configure dialog and the template editor are **generated** from it. Pi and
  Hermes declared a single option each while their CLIs took a dozen (`--provider`, `--thinking`,
  `--tools`, `--toolsets`, `--skills`, `--safe-mode`, `-c key=value`, …) — so neither was configurable at
  all. Two honest exceptions are **declared** rather than discovered: `appliesAt: 'spawn'` (applied by
  `src/app/terminal/spawn.js`, not in the argv) and `requires: '<other>'` (meaningless on its own). `preLaunchCmd` belongs to
  Switchboard rather than to a CLI, so the registry adds it to **every** backend; setting one drops that
  session to the shell path, because a shell prefix needs a shell. A declared option that changes nothing
  is a control that lies, and `test/backend-config-fields.test.js` refuses to let one exist.
- **Per-option "is this set?" marker, at every level** — the cascade is
  `backend default → global → project → template`, resolved **per option**, and each level stores only
  what it explicitly set. Without the marker, "not set" cannot be told from "deliberately empty / off",
  and an option whose default is ON could not be switched off at all. The **global** scope lacked it and
  therefore froze the shipped defaults into every user's settings the first time they saved — after which
  no improved default could reach them, and nothing said so.
- **A backend default is never put on the command line** — it describes what the CLI does anyway. Every
  non-empty default used to be seeded into the launch, so a plain Codex session carried
  `-a on-request -s workspace-write` although the user had chosen neither, overruling their own
  `config.toml` without telling them. Nothing anybody chose, nothing on the argv.
- **The Configure dialog is a per-session override that layers on the cascade** — same marker, ticked by
  default, so opening it and pressing Start changes nothing. Each control says where its value comes from
  (*"From your settings."* / *"Codex decides."*), and an override is sent even when it equals our own
  default — which is the only way to say *"workspace-write, just this once"* when your `config.toml` says
  otherwise.
- **Per-backend environment variables** (`$VAR` references, resolved at spawn, never on disk). Only a
  template could carry a bundle before, so the only way to hand Codex a variable was to wrap it in a whole
  extra backend.
- **Templates** — a named set of defaults **for a backend**: *Codex with this model and sandbox*, or
  *Claude Code against DeepSeek*. The same mechanism, not two concepts. A template names its base backend
  (it was hardcoded to Claude in three places, and the editor never said so), carries its own options and
  env bundle in **one** record, and is **staged** like every other setting — created, edited and deleted
  by *Save Settings*, discarded by *Cancel*.
- **Claude is disableable** like any other backend. The "always enabled" rule lived in one line of
  renderer code while the model would have half-broken on it — so a settings import could already produce
  a state the app could not handle. The gate is in the model now, every Claude fallback that assumed it
  could not fail is gone, and *disable is not delete*: the sessions stay visible and searchable.
- **Settings export / import** (*Settings → Maintenance*) — the global settings blob to a JSON
  file and back, for a backup or a move to another machine. Import **merges**: keys the file does
  not name keep their value, and keys this build does not know survive untouched, so a file from a
  newer Switchboard cannot silently drop a setting. A file from a *newer format* is refused rather
  than guessed at. Import and a normal save share one write path (`persistSettingsBlob`), which is
  what keeps the launcher secret-scrub and the backend re-arm from being bypassed — the imported
  backends take effect with no restart. Values that could not mean anything elsewhere
  (`windowBounds`) are dropped in both directions. Pure logic in `src/app/settings-transfer.js`, unit-tested.
- **About tab.**

### Projects & sidebar
- **Projects tab** — dedicated project management: add manually vs. automatically, hide /
  restore, and rename. The Add Project dialog also takes an optional name and tags, and **Add & Edit**
  opens the new project's settings once they are written (#675). While sessions work, the table refreshes
  in place — scroll position, search text and an open rename survive (#672).
- **The project list is a stored list, not a derivation** (#167) — it used to be read out of the
  transcripts on disk, so a project without one could not exist however often you added it (the
  old "add" wrote a **fake transcript** to fake one up), and "remove" could not be implemented at
  all — the next scan derived the project straight back, so it was faked as a permanent hide.
  Now: `project_meta` carries the register, **hide** and **remove** are different acts (hide keeps
  it listed and unseen; remove takes it off and leaves a tombstone, so the sessions on disk do not
  resurrect it — a *new* session does), a project with **no sessions** can be on the list, and
  discovery registers from **any** backend's store. Design record: `docs/specs/10-project-registry.md`.
- **A worktree is a SUB-UNIT of its project, not a project beside it** (#582/#586/#593/#594/#595/#598).
  All three conventional layouts, either separator, one pattern — the copies that existed before had
  drifted so far apart that the nesting never ran on Windows at all. Discovery no longer registers one;
  its visibility, its auto-hide and its settings all resolve to the project, walked up through however
  many levels sit between. In the sidebar its worktrees are gathered under one caret carrying the count,
  with anything RUNNING drawn beside the fold so a collapse can never hide work in progress; a worktree
  created inside another hangs from the top-most project and its name carries the chain
  (`agent-a / hotfix-1`). A checkout with no sessions still gets a row — the third row source is what the
  project holds on disk, real `git worktree add` checkouts only, collected on the index sweep behind a
  floor of its own. The project manager groups and indents the same rows, naming the parent in the cell
  wherever a filter breaks the grouping — and its Settings button names the project it opens, because a
  worktree carries none of its own. Hiding a worktree works and is undone from the manager's eye;
  **Remove is not offered on a worktree row at all**, because three of its four effects were wrong there
  and one of them silently destroyed the checkout's own display name.
  Design record: `docs/specs/10-project-registry.md`.
- **Clean up what is gone in one step** (#679, #602). "Clean up missing (n)" in the project manager lists
  every project and worktree whose directory no longer exists. Worktrees start ticked, with their history
  and config entry. Projects start unticked, because an unplugged drive looks the same as a deleted
  directory. A missing worktree also gets a Delete button of its own, in the manager and in the sidebar,
  and the repository is told to forget the checkout. Design record: `docs/specs/10-project-registry.md`.
- **Sidebar** — favorite projects, an own favorites list, and a startup-collapse setting.
- **View menu** — the project order (Activity / A–Z / Manual) sits in the
  sidebar, where the list is, instead of only behind the settings dialog. What it sets is an override
  for **this run of the app**: it is never written anywhere, Settings stays the source of truth and the
  fallback, and a restart is back to it. The button carries a dot while the order differs from the saved
  one, and the menu offers *Reset to saved* — an order you cannot tell from the saved one is how you end
  up "fixing" a setting that was never wrong.
- **The sidebar says what it is NOT showing** — a session in a project that is not on the list is indexed
  and searchable and painted nowhere (correct: in manual mode discovery may not write to the register).
  A line under the project list now says how much is being withheld and opens the project manager
  filtered to exactly those projects. It offers precisely what auto-add would have taken — it asks the
  same registry function — so the offer can never contradict what the register would do, tombstone
  included.
- **Tag filter, both kinds in one bar** — tag projects in the project settings via a chip editor
  (type + Enter adds, `×` removes) with a datalist of existing tags for reuse and a per-chip
  palette picker, including a custom color. The chips below the search bar filter the sidebar:
  **project chips** (folder glyph) drop whole projects, **session chips** (`#`) drop session rows and a
  project disappears only as a consequence of having none left. **AND** within a kind, and the two AND
  together (*sessions tagged `bug` in projects tagged `kunde`*) — which is why they share one bar rather
  than sitting behind a Projects/Sessions switch. The glyph is not decoration: the namespaces are
  separate, so the same word can be both. Tags live in their own tables; both filters are pure,
  unit-tested modules (`src/renderer/bookmarks/project-tags-filter.js`, `src/renderer/session/session-tags-filter.js`).
- **Closing does not silently kill your work** — the window owns every running CLI: when it goes, they
  go, and it used to go without a word (an accidental Alt+F4 was enough). Closing with sessions running
  asks first, in the app's own dialog, naming how many sessions and terminals and in which projects.
  The dialog opens on Cancel, so Enter keeps the sessions, and it is not dismissible: Escape and a click
  beside it do nothing. The decision
  and the wording are a testable module (`src/app/quit-guard.js`); the native message box survives only as the
  fallback for a renderer that cannot answer, or a crashed one would leave a window that can never be
  closed. Switch it off in *Settings → Sessions*.

- **Version-control state on the cards (#277, #284, #285, #287)** — a session's working directory is
  usually a repo, and the app showed nothing about it. A git glyph on every project/worktree header and
  grid card opens a **changes window** per repo: files grouped by state (conflicts first), renames as
  `old → new`, Open and Reveal, live-refreshed on the same poll. A file row expands a colored inline
  diff; above ~200 lines it offers *Open in window*, a standalone CodeMirror side-by-side view with
  syntax highlighting. The branch/counts badge is opt-in (`vcsShowBadge`, default off) — the glyph alone
  is the default affordance. The poll is scoped to the cwds actually on screen, backs off per repo, and
  passes `--no-optional-locks` so it can never take `index.lock` away from the agent working in that
  repo. The core names no VCS: `src/vcs/` is a provider registry (detect / statusArgs / parse /
  detectState / diffArgs / showArgs), git is the only provider shipped, and a parity test makes a future
  hg/svn answer the whole contract. Full spec: [`specs/15-vcs-status.md`](specs/15-vcs-status.md).

### Agent status signals
- **Working detection for full-screen TUI sessions** — the CLI renders its busy spinner
  inside the alternate screen buffer instead of emitting the OSC-0 title spinner the busy
  detection relied on, so such sessions showed *Running* and never *Working*. A
  `UserPromptSubmit` hook now marks the turn start; the existing `Stop` hook clears it.
- **Live subagent status** — a running indicator on a subagent's nested sidebar item plus an
  "N running" badge on the parent caret, driven by the `subagent-spawned`/`-completed` signals.
- **Subagent activity overlay** — while a subagent works, the parent keeps its own status
  (*Working* / *Running*) and its dot goes two-color: a green core (subagent working) inside
  the parent's own ring. Subagent work is deliberately **not** a status of its own — with
  async subagents the parent keeps generating rather than waiting, because the Agent tool call
  returns seconds after launch while the subagent runs on.
- **Exact subagent edges from hooks** — `SubagentStart` / `SubagentStop` drive the live set.
- **Subagent display settings** — a *Show subagents* toggle (off hides the caret and both the nested and
  the orphan subagent rows) and a *Subagent row layout* choice — **A** title-first with the type demoted
  into the meta line, **B** three-line (title / badge / stats), **C** a badge only when the type differs
  from `general-purpose` — with the per-type colour kept in every layout. Both are shown only for a backend
  that declares the `supportsSubagents` capability (so a Codex-only setup sees none).
  Both carry the *parent* `session_id` plus the subagent's `agent_id`, and `SubagentStop`
  fires at the subagent's real end, so both edges land with ~no lag. `SubagentStop` is
  explicitly *not* treated as `ready`: its session is the parent's, and doing so would end the
  parent's turn while it is still generating.
- **Filesystem fallback, kept in its place** — the JSONL spawn→complete scan writes into the
  same live set, so the indicators still work with hooks disabled. Completion there is a guess
  (stable mtime), and a subagent that goes quiet inside a long tool call would otherwise be
  declared finished mid-run. Entries are therefore tagged with their source: the scan may only
  retract what the scan set, never a hook-tracked agent. If a "completed" agent writes again,
  the scan reopens it. A self-stopping sweep re-checks open subagents every few seconds, since
  a finished subagent produces no further watcher events to trigger the check. A file the scan
  has never seen only counts as a spawn when it was written recently — otherwise the five-minute
  GC, which forgets finished agents while their transcripts stay on disk, would rediscover them
  and resurrect long-dead subagents on the next walk.
- **Adjustable log level** — packaged builds log at `info` (transitions and lifecycle). A
  global setting raises it to `debug` or `silly` live, without a dev build; the raw per-event
  terminal lines sit at `silly` because the CLI retitles on every spinner frame.
- **No stuck "Working"** — an OSC 9;4 progress sequence used to latch the busy flag with no
  way to release it (`4;0` was ignored, TUI sessions emit no OSC-0 idle glyph, and a dialog
  runs no turn so no `Stop` hook fires). Opening `/mcp` and pressing ESC left the session on
  *Working* forever. The latch now releases on `4;0`, and with hooks enabled the progress
  sequence no longer sets busy at all — the turn boundaries are authoritative
  (`src/app/terminal/osc-busy.js`, unit-tested).
- Gated by a **Subagent live status** setting (default on).

### Terminal
- Configurable **font / size / zoom** (Ctrl+mouse-wheel + status-bar buttons), **clipboard
  image & file paste** via Ctrl+V, a right-click **behavior dropdown** (Menu / Copy or paste /
  Copy only / Selection bar + paste / Native — the selection bar pops a floating Copy/Task toolbar above a
  text selection, Office-style, with right-click paste), a **mouse-mode dropdown**
  (Native / Select PowerShell-style / Off — `select`
  keeps native wheel scroll in a TUI while a left-drag selects text locally), an
  **external-terminal + file-explorer** launcher, a **configurable external editor** (open
  files via Ctrl/Cmd+click a file link, the right-click menu, or the file-panel button;
  OS-default fallback), and a batch of **Windows ConPTY** rendering fixes.
- **A plain terminal says what it is, and says when nothing is happening** (#585, #588). It opens with
  one dim line — this terminal is not monitored, the `+` button starts a tracked session — written into
  its own buffer once the shell has stopped drawing, so a login shell's own clear cannot wipe it. A
  launcher terminal does not get it: that one was opened to run a command the user saved. And a terminal
  whose shell prints nothing at all says so after six seconds, in the terminal and in the log, instead of
  sitting black behind a Running tab. What replaced the old `claude` wrapper: it names no backend, wraps
  nothing, and reaches the user before they type rather than after they guessed wrong.
- **Drop = paste** (#307): a drop on a terminal takes the same route as Ctrl+V — files insert their
  absolute paths, quoted the way the reader takes them (#700: in a plain terminal cmd gets double quotes,
  PowerShell single quotes with inner quotes doubled, every other shell and every CLI session POSIX single
  quotes), an image with no file behind it (a screenshot, an image dragged out of a
  web page) is saved to a temp file so the CLI can read it as a path, and text inserts as text. A
  drop never submits, and it focuses the session it landed on, so the next keystroke goes where the
  path went. Those temp images are age- and size-pruned (#308).
- **Terminal renderer robustness** — a VSCode-style **`gpuAcceleration` mode (Auto / On / Off)**:
  Auto tries WebGL and auto-falls back to the DOM renderer for all terminals once the GPU/driver
  drops or corrupts a WebGL context (ports VSCode's suggested-renderer fallback). Every open terminal
  holds its GL context for its whole lifetime, so Chromium's per-renderer budget is **raised from 16
  to 32** (`--max-active-webgl-contexts`) — well above the terminal LRU cap, so a normal session never
  overflows it. A context that is lost anyway now **re-fits and repaints** instead of silently keeping
  a stale WebGL fit on the DOM renderer. Plus a
  **devicePixelRatio re-fit** — on a DPR change (monitor switch, display scaling, zoom) every open
  terminal is re-fit so xterm's DOM cell grid can't drift into garbled/misaligned text (xterm.js#6015).
  On Windows, PTYs run on **node-pty's bundled conpty.dll** (Windows Terminal codebase) instead of
  the in-box conhost ConPTY, which leaves stale/duplicated rows (e.g. a doubled status line) during
  rapid in-place redraws — the same escape hatch as VSCode's `windowsUseConptyDll`. An advanced
  **Windows ConPTY setting (Bundled / System)** falls back to the OS pseudo-console without a rebuild.
- **Bookmarks & session tags** (SQLite) — per-message transcript bookmarks with a hover gutter
  (bookmark / copy / create task); session-level bookmarking removed in favor of the pin.
- **Task / note system** (SQLite) — scoped tasks (project / session / message) with status
  (open / in progress / done / dropped), notes and a captured quote. Created from a transcript
  selection or whole message (block gutter, right-click, or a configurable shortcut) or from the
  terminal (right-click / shortcut). Jump to the transcript source, or open/start the live
  session from a task. Opened from the project header or per-session from the terminal toolbar;
  session cards show an open-task count badge and the project task icon highlights on open tasks.
- **Saved Variables** — reusable snippet/template panel with quick-pick, insert-template and
  a management tab (port of **brianstanley**). Insert into the terminal via the right-click
  menu or a **configurable hotkey** (default Ctrl/Cmd+Shift+V) — works in every right-click mode.
  - **Cross-references** (#205): a template can compose other variables —
    `mysql -u {var:user} -p{var:db-pass}`. A secret reached through `{var:}` is **never** inlined as
    plaintext, even when its own template says `{value}`: that consent was given for inserting *that*
    variable, at its own row, with its Secret pill — not for someone else's insert months later, where
    it would land in shell history, scrollback and the transcript the CLI uploads. It resolves through a
    0600 temp file instead. Cycles, a 20-node cap, a control character and a **quoted** file reference
    are all refused before anything reaches the terminal.
  - **A multi-line template inserts as text**: every surface pastes rather than types, so a template holding
    a whole prompt arrives as one block and nothing is submitted. Only an insert that materializes a temp
    file collapses its breaks to spaces — a file reference is one shell word on one command line.
  - **A template editor that shows what the insert will do** (#204): chips to place `{value}` / `{path}` /
    `{ref}` / another variable, and a live preview built with the **same functions the insert runs** — so
    it cannot drift from what will actually be produced. It needs no plaintext to do it. A file reference
    is a complete shell word, and quoting it silently produces a wrong credential plus a leaked temp-file
    path — so the preview does not explain that rule, it runs the real check and says which reference is
    about to break, before you reach for the credential.
  - **A template can name what is around it** (#485, #491): `{handoffDir}` / `{handoffPath}` /
    `{planDir}` / `{planPath}` resolve for the project the terminal belongs to, so one global variable
    works everywhere instead of one per project — and **`{clipboard}`** is whatever was copied last,
    composed with the stored ones instead of pasted separately. A copied file or a screenshot inserts its
    path as one quoted shell word, the same ladder paste and drop already walk; text is inserted with the
    control characters a terminal would obey removed, and its line breaks kept. It is the one token whose
    content the app has never seen, so it is treated exactly like another variable's value: resolved once,
    never rescanned, and seen by the check that catches a file reference someone has quoted. A secret's
    template does not resolve it at all — a clipboard usually holds someone's last password.
  - **Your own order** (#676): drag a variable in the manager, or move it with Alt+Up/Alt+Down, and every
    picker lists them that way — one list with global and project variables mixed, each row badged with its
    scope. New variables go to the end; **Sort by name** restores alphabetical order, with an Undo.
  - Design record: [`docs/specs/12-saved-variables.md`](specs/12-saved-variables.md).
- **File preview** — the integrated file panel renders **Markdown**, a **sandboxed HTML preview**
  (`allow-same-origin`, no scripts), and **images** (PNG/JPG/GIF/WebP/SVG/… via a size-capped
  base64 data-URL IPC) inline (port of **brianstanley**). Pure kind/MIME helpers in
  `src/shared/preview-kind.js` (unit-tested).
- **Live Preview and a formatting bar in the editor** — a Markdown or HTML file opens in one of three
  modes: **live** edits the source *drawn as the rendered document* (the syntax markers hidden, the
  content styled, and the cursor's line showing its markers again), **preview** is read-only, **text**
  is the raw source. All three hold the same text — the file's own — because `live` renders with
  CodeMirror decorations rather than converting anything, so nothing is ever serialised back. A
  formatting bar writes into the source (bold through tables, per-kind command tables) and can sit
  under the toolbar, float over the editor, or appear beside the selection. A file the app cannot
  write is pinned to the read-only preview, and that forced mode is never remembered.
  Design record: [`docs/specs/19-editor-live-preview.md`](specs/19-editor-live-preview.md).

### Supervision extensions
- **Staged prompts** (#614) — hand a busy session its next instruction and walk away. The command palette
  asks for the text, the session's row carries a chip with the count, and Switchboard types it in when the
  session is ready for it: never while the agent is working, never while it is waiting for an answer, and
  never while you have something half-typed in its own prompt line. It is staging, not keystroke
  buffering — the prompt has an input of its own, so nothing is intercepted on its way to the CLI and the
  keys that answer a permission dialog still answer it. Held delivery says so on the chip rather than
  going quiet, and only submitting the line releases it: whether Esc empties a composer is that CLI's
  business, and one of them was measured not to. Staged items live in the window's memory and go with the session when it exits; the chip
  is where you read them back and throw them away.
- **Handoffs as files** — a packet is markdown in the project (`.handoffs/` by default, plus the directories a project or a CLI already uses), so it is editable, greppable and travels with the repo. A picker on Ctrl/Cmd+Shift+H hands one to the session you are already in as a reference, and its rows say when each packet last changed. Writing one is a keyboard route out of the session too — the command palette offers it for the session you are in, and the picker's empty state offers it when there is nothing to pick.
- **Handoff library** — save packets, editable prompt, resume, direct "New session" seed,
  and target selection in the review dialog (extends inherited feature #03/#04). Since #468 a saved
  packet is a file in the project rather than a row in the database.
- **Per-session AFK timeout.**
- **Attention inbox** made configurable — "Running" mode ("timed"), "Working" removed.
- **Token/usage stats** — per-(session, date, hour, model) token/tool/message/cost metrics into the DB,
  bucketed on the **local** clock so every backend's day means the same thing.
- **Stats: one backend filter, and the charts to go with it** — a single *All / Claude / Codex / …*
  control at the top of the page scopes every figure below it (heatmap, 30-day bars, summary tiles,
  per-backend cards). It is resolved in SQL, not in the renderer: only aggregates cross IPC, so there is
  nothing there to filter. New charts: **tokens per backend over time** (stacked — where the work goes),
  **token share per model**, **cost over time**, and a **weekday × hour grid** of when you actually work.
  Cost is never dressed up as a bill: an estimate is coloured and labelled as one, and a backend that
  reports no money gets no chart instead of a row of free days. The rate-limit panel is deliberately
  unfiltered — those are Claude's subscription limits, which no other CLI has.
- **The cache invalidates itself when a parser changes** — a cached row records the parser version that
  wrote it, and the scan re-reads a session whose parser has moved on, even though the file has not. Its
  absence is why the charts sat stale for every existing user until they found the manual *Rebuild
  session cache* button.
- **Usage** as status-bar color-threshold progress bars.
- **Search** — 3-char minimum + explicit reindex (Enter / refresh button); the sidebar search
  also matches **project names** (display name + path short-name), not just session content.

### Infra / hardening / tooling
- **Build provenance in About** — every build is stamped (`scripts/gen-build-info.js` → bundled `build-info.json`) with its git branch @ short-commit and a `dirty` flag, shown in the About pane so an installation is traceable to its source commit.
- Ported **security hardening** (kreaddis #46) + dependency audit fixes.
- **Isolated demo/sandbox env** — `npm run demo:start`: a fully isolated instance (own DB, userData, and every backend's session store root via a unified `SWITCHBOARD_STORE_<ID>` env var) against a seeded layout under `C:\temp\switchboard`, so it never touches real data (`docs/demo-env.md`). Since #241 the isolation also covers where each **CLI**
  writes (`cliHomeEnv()` per backend), so a session actually launched in the demo lands in the demo store —
  and `npm run demo:auth` copies your existing CLI logins into it so such a session can run at all.
- **`upstream:check`** tooling to detect portable upstream changes across all fork branches.
- **Issue-based workflow** — Conventional-Commits (English), backlog migrated to GitHub Issues.
- Windows build path for **VS 2026** (node-gyp 13 override, node-pty Spectre-off patch).

---

## Testing

Everything pure above is covered by `test/*.test.js`, run with `node --test` and no Electron —
attention/status, health, timeline, usage, cleanup, notifications, hotkey/sound, away-summary, handoff,
bulk actions, groups, grid layout, accessibility, update-restart, cache reconcile, shell quoting,
DB busy-retry, containment, and more. Count the directory rather than trusting a number here: the one
that used to stand in this paragraph was off by a factor of five before anyone noticed. Run with:

```bash
npm test
```
