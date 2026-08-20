---
paths:
  - "src/main.js"
  - "src/preload.js"
  - "src/app/**"
  - "src/watch/**"
---

# Main process, ctx, IPC

## `src/main.js` is a composition root

~2000 lines, down from 5011 — the split is done (#213), #227 moved nine more handlers out. What is
left: the requires, `DATA_DIR` (before anything requires db.js), the module wiring (count the `.init(`
calls rather than trusting a number written here — this one said "thirteen" through at least one
module being added), and the **small IPC handlers** that stayed on purpose (thin, no shared state;
moving them buys churn).
`GRANDFATHERED` in `test/main-no-new-ipc.test.js` is the list — count it there rather than here.

`src/app/` holds `lifecycle.js` (boot, ordered teardown), `windows.js`,
`notifications.js`, `hooks.js`, `variables.js`, `settings.js`, `quit-guard.js`,
`settings-transfer.js`, `backend-models.js` + `backend-resources.js` (backend-owned model and
resource discovery — the core asks the descriptor, each backend owns how it shells out and fails),
`plans-memory.js` (the Plans and Agent Files tabs — #227; work files lost their own tab in #448 and
are one group in Agent Files, and #450 put the plan convention here too),
`file-watch.js` (keeping an open document live while something else rewrites it — #452; the watch
moved out of main.js because it only ever told the main window and kept no refcount),
`vcs.js` (the VCS poller + its standalone windows — #277), `detach.js` (detached session
windows — #2, and since #316 which window renders which session), `presence.js` (is the USER at the
machine — #386; one global fact, because every renderer has its own `windowFocused` and none can see
the others), `timeline.js` (what happened to a session — #396; the one writer of the record, so a
session has one history however its windows come and go), `session-shutdown.js` (stopping every CLI
process and CHECKING that it stopped — #424), `db-upkeep.js` (when the database is compacted and how
much of it — #430; the SQL is `src/db/compact.js`, what needs to know about the app is here) and
`terminal/` (`spawn.js` = open-terminal,
`io.js` = input/resize/redraw/flow control, plus the PTY pure-logic).
**The directory is the truth** — this enumeration silently missed two modules for as long as they
existed, so list `src/app/` before assuming an area has no home yet.

## Quitting WAITS, and both kill sites go through one module (#424)

`pty.kill()` is asynchronous. Firing it at every session and letting the process exit is not a teardown,
it is a hope — a CLI that had not wound down by then was orphaned in the background, with no window left
to reach it from. A single kill works; what was missing was the second half.

`app/session-shutdown.js` REMEMBERS every pid it asked to stop, waits for them, and tree-kills whatever
is still alive at the deadline. The remembering is load-bearing: the main window's `closed` handler
empties `activeSessions` immediately, so by the time `before-quit` runs there is no session list left to
check — but there is still a list of pids.

Three things in `lifecycle.js` that look like paranoia and are not, each a failure someone can trigger
from the keyboard:

- **`before-quit` cancels its own first pass** (`event.preventDefault()`), waits, then quits again.
  Without the `sessionsConfirmedStopped` flag the second ask cancels itself and the app never closes.
- **A repeat while that wait is in flight is HELD, not re-run** (`teardownStarted`). Running the body
  twice re-kills from an emptied list, starts a second wait on the same pids, and can let a late
  `flushSessionBackends` write after `will-quit` closed the DB — the #90 class of bug.
- **A system logoff is not held** (`session-end` → `systemShuttingDown`). Windows is not waiting for us;
  holding the quit there only risks being force-killed mid-wait, which re-creates the orphan.

And a hard deadline inside `awaitAllStopped`, because everything it waits on belongs to someone else: a
`taskkill` that never calls back would otherwise leave the promise pending forever. **An app that will
not close is worse than the leak this fixes** — so the answer is guaranteed to arrive, and whatever
survived is reported rather than swallowed.

**Every step of the teardown logs that it ran, including the ones that worked (#397).** The one observed
hang ended on `[detach] the app is going` — the same line a *successful* quit ended on, so the log could
not tell a finished teardown from a stuck one. `lifecycle.js`'s `step()` writes the breadcrumbs and the
last of them comes **after** `closeDb()`: a log that stops before it names the step that hung, and one
that reaches it says the handle belongs to something this file never opened. Keep that ordering, and do
not make the good path silent again to save lines — quitting happens once.

## What routes per session, and what stays in main (#2, #393, #395)

A session can live in a window of its own. `app/detach.js` owns the map and answers
`windowForSession(id)`. What follows the session:

| Routed to the window that renders the session | Why |
|---|---|
| `terminal-data` | the bytes belong to the terminal showing them |
| `mcp-open-diff` / `mcp-open-file` / `mcp-close-tab` / `mcp-close-all-diffs` (#393) | a review opens where the user is looking and is answered in the terminal underneath it |
| `timeline-signal` (#395) | that window's own timeline and status — **record-only by contract** |

Everything else — `cli-busy-state`, `terminal-notification`, `attention-signal`, `session-forked`,
`process-exited` for the sidebar's copy — goes to the **main window**, because that is where the
sidebar, the attention inbox and the badges live. Route those too and the badges stop appearing for
exactly the session the user pushed onto the other monitor.

**The one-inbox rule has three layers, and only two are structural.** `timeline-signal`'s handler
(`recordAttentionSignal`) has no path to the attention sets, the chime or the notification, so what
arrives there *cannot* raise — that holds whoever calls it. `raisesAttention` (#390) gates the four
OS-facing surfaces on top. What is **convention** is the third: that the raising channels above are
addressed to `getMainWindow()` at their producers. Nothing enforces it. Parameterising one of those
sends is a change to this rule, not a refactor.

**Routing a review costs an obligation (#393).** A diff can now live in a window whose ordinary
lifecycle ends while the CLI's `tools/call` is still open, so each pending diff records the window its
view was **sent** to — deliberately not "the window that renders the session", because the view does not
follow a session that moves. `detach.js`'s `closed` handler calls `rejectPendingDiffsForWindow` **first**,
before the session handover the CLI would otherwise wait through; `did-start-navigation` does the same
for a reload; and `hasPendingDiffsForWindow` stops the auto-close from taking a window down under an
open review (grid mode reports no views, so nothing else would notice one).

The corollary bites in the renderer: **nothing may mount a session that is detached**, and there are
more mount paths than `openSession` (`attachRunningSession`, the grid's auto-open). Two xterms on one
PTY echo every keystroke twice and fight over the size — the failure is loud but its cause is not.

**A window owns a SET of sessions (#316).** The map is keyed by session, so several keys may point at
one window, and `move-session-to-window` moves one in any direction — main → detached, detached → main,
detached → detached. Four things follow, and `docs/specs/17-detached-windows.md` §2b is the long form:

- The order inside that handler is load-bearing: **release, re-register, adopt.** The giving window is
  told to let go first, or two renderers hold one PTY for an IPC round trip; the re-registration sits
  in the middle because `windowForSession` decides where the replay the target is about to ask for goes.
- `session-detached` / `session-reattached` are addressed to a **specific window**, not always main.
- `session-reattached` carries a `running` flag from `activeSessions`. The renderer must not answer
  that question itself — its `activePtyIds` is a poll that backs off to 30 s in an idle window, and
  adopting a dead session resumes its CLI.
- …and a `busy` flag beside it (#395). A session that is busy and *stays* busy sends no new edge, so a
  window taking one mid-turn would draw a visibly working session as idle until the turn happened to
  end. The renderer applies it through `setActivity`, never the record half: that file runs in the main
  window too, and the carried flag comes from the title-spinner latch the ready-guard exists to
  disbelieve (#252).
- **`reattach-session` no longer exists.** It was `move-session-to-window(id, 'main')` with a window
  destroy hard-coded, which is wrong for a window holding more than one session.
- **A move does NOT require a live process, and do not put that guard back (#332).** It was there, it
  predated #319, and by the time it was removed it stranded a dormant session in a window it shared —
  the only exit was closing the window, which handed back the live sessions too. The rule it protected
  ("a window change never resumes a CLI") belongs where the mount happens: the renderer gates on it in
  three places from the `running` flag above. Which window can *show* a dormant session is a renderer
  question too — `docs/specs/17-detached-windows.md` §2b has the three answers.

## Where an IPC handler goes

**No NEW handler in `main.js`** — the invariant is "no new ones", not "none".
`test/main-no-new-ipc.test.js` (#222) fails on one and names the module to use instead.

| The handler is about | Home |
|---|---|
| Windows, the settings window, zoom, the close guard | `src/app/windows.js` |
| The settings blob, the cascade, export/import | `src/app/settings.js` |
| Notifications, the badge, the tray | `src/app/notifications.js` |
| Saved variables, secret materialization | `src/app/variables.js` |
| The Claude Code hook server | `src/app/hooks.js` |
| Opening a terminal | `src/app/terminal/spawn.js` |
| Terminal input/resize/redraw/flow control | `src/app/terminal/io.js` |
| The Plans, Memory and Work-Files tabs | `src/app/plans-memory.js` |
| Version-control status, the changes/diff windows | `src/app/vcs.js` (the seam it drives is `src/vcs/`) |
| Detached session windows, which window a session renders in, moving one between windows | `src/app/detach.js` |
| Whether the user is at the machine (focus + input, across every window) | `src/app/presence.js` |
| What happened to a session, and reading its history back | `src/app/timeline.js` |
| **None of the above** | a **new** `src/app/<area>.js` — not `main.js` |

A module exports `init(ctx)` + `registerIpc(ipc)`; `main.js` requires it and calls both;
`src/preload.js` gets the `window.api.*` binding.

`src/watch/*` is deliberately absent from that table: those modules own watching, not IPC. A
watch-related handler goes in an `src/app/` module that calls into them.

If a handler really belongs in `main.js`, add its name to the allow-list in that test **with the
reason**. Being a deliberate act is the entire point.

## The ctx object — three rules, each paid for

How every `src/app/*` and `src/watch/*` module gets what main.js owns.

- **A `const` goes straight through; a `let` ONLY as a getter.** `activeSessions`, `liveStoreRef`
  and the other Maps are passed by reference — same object, every writer sees every write.
  `mainWindow`, `appQuitting`, `closeConfirmed` are reassigned, so they arrive as `getMainWindow()`
  / `getAppQuitting()`. A captured `mainWindow` addresses a window that no longer exists after a
  reopen: the UI stops updating, with no error anywhere. A captured `appQuitting` lets a late flush
  hit a closed DB (#90).
- **Never top-level-`require('../db/db')`** — db.js resolves `DATA_DIR` at module load, before
  main.js sets it, and a dev build then silently writes to the installed app's database.
  `test/main-modules-no-db.test.js` enforces both halves.
- **Electron arrives through ctx too** (`dialog`, `safeStorage`, `app`, even `ipcMain` via
  `registerIpc(ipc)`) — not for purity, but because it is what makes the module loadable in
  `node --test`. That is the whole reason #213 was worth doing: the hook server's token check (#77),
  the secret resolver, the settings write path and the cascade (#149) had NO tests while they sat in
  Electron-bound main.js. Their guards could only grep
  main.js's source — and a grep cannot tell you the line does anything.
- **Where a `let` lives is decided by counting readers, not taste.** Still read in main.js → it
  stays there and the module takes a getter. Read nowhere else → it moves into the module.

## Preload is the only IPC surface

`src/preload.js`: the renderer talks to main exclusively through `window.api.*` defined here
(`ipcRenderer.invoke` for request/response, `.send`/`.on` for streams). Add a binding here when you
add an IPC handler.

## Watching

- `src/watch/projects.js` — fs.watch on Claude's store (folders + per-file refreshes).
- `src/watch/stores.js` — every OTHER backend's store. Scan-generalization is not
  watch-generalization, so this works on `watchTargets()`, not on discovery's per-session handles.
- `src/watch/adopt.js` — identity adoption + busy/idle for the backends that name their own
  sessions. It owns `liveStoreRef`/`liveBusy` and **exports the Maps themselves**: main's PTY-exit
  handler drops a dead session's claim from them, so a copy would leave the claim standing forever
  and a relaunch would inherit a dead ref.
- `src/watch/trigger-watcher.js`.

## Never compose a CLI-home path from `os.homedir()`

Where Switchboard **looks** is `SWITCHBOARD_STORE_<BACKEND>`. Where the CLI **writes** is a second
thing (#241): each backend declares its home variable through the `cliHomeEnv()` descriptor hook
(Claude `CLAUDE_CONFIG_DIR`, Codex `CODEX_HOME`, Hermes `HERMES_HOME`, Pi
`PI_CODING_AGENT_SESSION_DIR`; agy has none and declines). `app/terminal/spawn.js` merges the answer
into the session's env — below the user's and a template's, so an explicit variable of theirs still
wins, and a non-isolated launch carries nothing.

A path under Claude's home composed from `os.homedir()` is the bug this keeps re-creating: four of
them (the MCP IDE bridge's lock files, the attention hook's `settings.json`, the Projects admin's
`.claude.json` reader/**writer**, and the scheduler that #246 has since removed entirely) kept using
the real home from an instance that promises it touches nothing real.
**Resolve it from `SWITCHBOARD_STORE_CLAUDE`, per call** (these modules are required long before a
path is read). `test/store-isolation.test.js` is the guard; `backend-path-neutrality` does NOT cover
this — it sees that a file knows Claude's layout, not whether it resolves that layout against the
isolated home.

**It happened a fifth and sixth time, and the guard's SHAPE is why** (#424-era audit). The resource
readers added for Codex and Pi read the user's real `~/.codex` and `~/.agents/skills` from an isolated
instance — and `openResource` hands what it lists to `shell.openPath()`. The guard was a hand-written
list of six files, so a file added later was simply never opened by it, and it reported success about
code it had not seen. It **derives** its targets now: every file under `src/` that composes a CLI home
must consult that backend's override, and one that legitimately may not needs an entry with the reason.

Two things that audit is worth carrying:

- **Ask the enclosing BLOCK, not the file.** The old codex descriptor mentioned
  `SWITCHBOARD_STORE_CODEX` in its sessions-root helper while the home helper right above it ignored
  it. A file-level check called that compliant.
- **A module's DEFAULT counts too.** Claude's root is injected by main.js and was correct in the app —
  but the module's own default was the real home, so anything reading before that injection got the
  real one and looked isolated. That is what made the first pass of the audit itself misreport.

## The attention hook is OFF in a dev build (#219)

`~/.claude/settings.json` is a shared, CLI-owned file, and `src/app/hooks.js` writes an HTTP entry
into it. A dev run is force-killed by `npm run stop:dev` (no `before-quit`), so a written hook would
be left behind on a dead port — and because the sentinel carries no instance marker, a dev
enable/quit also strips the **installed** app's live hook. So an **unpackaged** build makes the whole
write/strip path a no-op: enabling returns `{ devBlocked: true }` and writes nothing, disabling
strips nothing, attention falls back to the OSC-9 heuristic.

To work on the hook itself: `SWITCHBOARD_DEV_ATTENTION_HOOK=1 npm run start:debug`.
`test/hook-ingest.test.js` pins both states.
