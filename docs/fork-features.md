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

- **19 new renderer modules** in `public/` (pure, `node --test`-covered logic)
- **47 new test files** (72 total under `test/`; the base fork had 29)
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

- A health model: **Healthy → Growing → Marathon Risk → Handoff Recommended**,
  computed from user-turn count, total entries, active time, cache-read tokens,
  and largest single prompt.
- Shows *why* a session is flagged (the crossed thresholds) on the health chip.
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

- Compact per-session metric labels (turns, cache, active time, message count)
  with **green/amber/red** traffic-light levels for each metric and for
  last-activity age — so an at-risk session reads at a glance.
- Worktree label extraction for sessions living under `.claude/worktrees/`.

### Usage monitoring (per backend, #191)
`src/renderer/shell/usage-status.js`, `src/backends/usage-format.js`, `backends/<id>/usage.js`

- **One status-bar segment per backend that reports a quota**, each with its own badge and each
  selectable in *Settings → Usage & Notifications*. A backend declares the capability on its
  descriptor; nothing in the core names a backend id.
- **Claude** is fetched live from the API (5h, weekly, Sonnet, Opus, and the extra-usage credit pool
  with money formatting). **Codex** is read out of its own transcript — no network call, no credential
  access — so its figure is *as of its last run*: the segment dims past an hour and its tooltip says
  when it was measured. Hermes and Pi have no quota and never appear.
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

### 02 — Next-attention hotkey + alert sound
`src/renderer/shell/alert-sound.js`, `src/renderer/app.js`

- A configurable in-app **hotkey** (default `Cmd/Ctrl+Shift+A`) to jump to the
  next session needing attention, working even while a terminal is focused.
- An optional **alert sound** on a new "Needs You" (coalesced, off by default),
  with the decision logic unit-tested.

### 03 — "While you were away" recap
`src/renderer/shell/away-summary.js`, `src/renderer/shell/away-overview-view.js`

- Tracks whether **you** were away — not whether a window lost focus (#386).
  `src/app/presence.js` owns it: every window reports focus and input, and main
  is the only place that can see all of them. Switching windows and sessions
  while you work shows nothing; the attention inbox is the surface for that.
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
`public/handoff-flow.js`, `src/renderer/dialogs/dialogs.js`

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

### Multi-LLM backends

The largest structural change this fork makes: Switchboard stops being a Claude-only cockpit and
becomes a **multi-CLI** one. Full spec: [`multi-llm.md`](multi-llm.md).

- **Five backends, one app** — Claude Code, **Codex**, the **Antigravity CLI** (`agy`), **Hermes** and
  **Pi** run side by side in one sidebar, one FTS index, one launch menu and one stats view. A backend is a folder under `backends/`
  with a single descriptor; the registry, scanner, watcher, launch menu, settings page, Configure
  dialog, badge, search, stats and resume all derive from it.
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
- **Cost analytics** — where a backend prices its own turns (Hermes, Pi), Stats shows it per backend.
  An estimate is labelled as an estimate, a zero estimate reads as "no cost reported" rather than
  `$0.00`, and a token-only backend shows an em dash.
- **Profiles + presets** — the Claude binary against another endpoint (DeepSeek, GLM, OpenRouter, or
  blank). Secrets are `$VAR` references resolved at spawn and never written to disk; a literal key is
  refused, and a profile that would send your Anthropic key to a third-party endpoint is blocked.
- **Custom launchers (Tier-3)** — any command or script as a saved launcher (in-app monitored tab or
  detached window), global template ⊕ per-project override.
- **Identity, resume and fork done honestly** — a backend that names its own sessions (Codex, Hermes,
  Pi) has its id adopted, so one session is one row; resume reapplies the recorded backend and never
  falls back to Claude; Fork is only offered where the backend can actually fork.
- **What each backend supports, as one table** — the Backends settings page opens a matrix: one row per
  capability, one column per installed backend, each cell supported / limited / not supported with a
  short note saying what is limited. Every answer is declared on the backend's own descriptor, so a new
  backend fills its column without a renderer change.
- **Its skills, rules and commands, in the app** — the Agent Files tab lists what each CLI reads its own
  behaviour from, beside the instruction files it already showed. A customization directory is one row
  that opens into its entries, and an entry opens in the built-in viewer instead of being handed to the
  system.
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
  focused terminal, with that terminal's project listed first and everything else still reachable. It
  inserts a reference rather than the plan: a plan runs to hundreds of lines and belongs in the agent's
  context through the agent's own file tools, not pasted into a prompt. What exactly gets typed is a
  template you can change, per project if you want to.
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
- **Tabbed single-view** as the primary layout — session tabs, viewer close buttons; the
  grid is kept as a legacy mode. Right-click **tab context menu** (Close / Stop / Relaunch),
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
- **Panes** (#309, #312, #313, #318, #321) — a third display mode that splits the terminal area into a
  VS-Code-style tree of panes, each with its own tab strip. Drag a tab onto a pane's edge to split,
  onto its middle to move it there — a caret marks the gap it will land in — and sashes resize; the
  layout survives a restart. The session tools (messages, tasks, variables, stop) sit with the pane,
  so they act on the terminal below them rather than on "the active session", with the running state
  as a dot in front of the session name. Right-click a tab for its own actions plus the pane's, or the
  strip and the session bar for the pane's alone. A tab whose session has ended offers a **Launch**
  button rather than restarting the CLI on a stray click. `Ctrl/Cmd+Shift+\` splits,
  `Ctrl/Cmd+Shift+1…9` focuses a pane.
- **Settings overhaul** — two-column layout, permission modes aligned to the Claude CLI, and
  an optional pop-out settings window that paints instantly and is kept warm between opens.
  The actions are pinned to the bottom edge, reachable at any scroll position in any category:
  Hide/Remove Project on the left, then Cancel, **Apply** (save without closing, so several
  categories can be adjusted and checked one after another) and Save. Terminal tools have a
  page of their own under Terminal.
- **A backend declares what it can do, and it is all configurable** — `configFields` on the descriptor;
  the settings page, the Configure dialog and the template editor are **generated** from it. Pi and
  Hermes declared a single option each while their CLIs took a dozen (`--provider`, `--thinking`,
  `--tools`, `--toolsets`, `--skills`, `--safe-mode`, `-c key=value`, …) — so neither was configurable at
  all. Two honest exceptions are **declared** rather than discovered: `appliesAt: 'spawn'` (applied by
  `app/terminal/spawn.js`, not in the argv) and `requires: '<other>'` (meaningless on its own). `preLaunchCmd` belongs to
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
  restore, and rename.
- **The project list is a stored list, not a derivation** (#167) — it used to be read out of the
  transcripts on disk, so a project without one could not exist however often you added it (the
  old "add" wrote a **fake transcript** to fake one up), and "remove" could not be implemented at
  all — the next scan derived the project straight back, so it was faked as a permanent hide.
  Now: `project_meta` carries the register, **hide** and **remove** are different acts (hide keeps
  it listed and unseen; remove takes it off and leaves a tombstone, so the sessions on disk do not
  resurrect it — a *new* session does), a project with **no sessions** can be on the list, and
  discovery registers from **any** backend's store. Design record: `docs/specs/10-project-registry.md`.
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
  Cancel is the default (Escape and Enter both cancel) and the dialog is not dismissible. The decision
  and the wording are a testable module (`src/app/quit-guard.js`); the native message box survives only as the
  fallback for a renderer that cannot answer, or a crashed one would leave a window that can never be
  closed. Switch it off in *Settings → Sessions & CLI*.

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
- **Drop = paste** (#307): a drop on a terminal takes the same route as Ctrl+V — files insert their
  escaped absolute paths, an image with no file behind it (a screenshot, an image dragged out of a
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
- **Handoff library** — save packets, editable prompt, resume, direct "New session" seed,
  and target selection in the review dialog (extends inherited feature #03/#04).
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

The fork adds **47 test files** under `test/` (72 total, `node --test`), covering all the
pure modules above — attention/status, health, timeline, usage, cleanup,
notifications, hotkey/sound, away-summary, handoff, bulk actions, groups, grid
layout, accessibility, update-restart, cache reconcile, shell quoting,
DB busy-retry, and more. Run with:

```bash
npm test
```
