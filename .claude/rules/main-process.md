---
paths:
  - "src/main.js"
  - "src/preload.js"
  - "src/app/**"
  - "src/watch/**"
---

# Main process, ctx, IPC

## `src/main.js` is a composition root

a couple of thousand lines, down from 5011 — the split is done (#213), #227 moved nine more handlers out. What is
left: the requires, `DATA_DIR` (before anything requires db.js), the module wiring (count the `.init(`
calls rather than trusting a number written here — this one said "thirteen" through at least one
module being added), and the **small IPC handlers** that stayed on purpose (thin, no shared state;
moving them buys churn).
`GRANDFATHERED` in `test/main-no-new-ipc.test.js` is the list — count it there rather than here.

`src/app/` holds `lifecycle.js` (boot, ordered teardown), `windows.js`,
`notifications.js`, `hooks.js`, `variables.js`, `settings.js`, `quit-guard.js`,
`skills.js` (what a running session can be asked to run — #462; a BACKEND skill is asked for through
the descriptor's `listResources`/`expandResource`, a SWITCHBOARD skill belongs to nobody's CLI and is
always handed over as text),
`convention-dirs.js` (**the** answer to "where does this project keep its handoffs and its plans" —
CLAUDE.md reflex 12; the handoff prompts, the plan prompt and a saved variable's insert template all
ask it, and a second reading of `eff.handoffDir` is how two of them start naming different directories.
It also settles escaping, so a `../packets` setting falls back to the default instead of sending an
agent outside the tree. Electron-free and DB-free: `conventionDirs(projectPath, effectiveSettings)` is
callable from `node --test` with a plain object),
`file-access.js` (can this file be WRITTEN — #281; one handler rather than a flag on each of the four
readers that feed the viewer, three of which return a bare string. A missing file counts as writable
and so does anything the check cannot answer: a false read-only locks an editable file out of its
editor, which is the worse failure),
`live-owners.js` (is something OUTSIDE Switchboard running this session — #172; the two-hook split and
the three things it cost are in `.claude/rules/backends.md`),
`live-sessions.js` (what main knows about a running session that the INDEX has never seen — #461;
Hermes in its degraded mode writes no record, and reloading the window used to leave a live PTY with
nothing on screen. Deliberately NOT folded into the projects payload — synthesised rows would reach
search, stats and every counter that expects an indexed one),
`store-record-notice.js` (which live sessions their backend has no record of, so no busy/idle can be
shown — decided in `src/watch/adopt.js`),
`settings-transfer.js`, `backend-models.js` + `backend-resources.js` (backend-owned model and
resource discovery — the core asks the descriptor, each backend owns how it shells out and fails),
`plans-memory.js` (the Plans and Agent Files tabs — #227; work files lost their own tab in #448 and
are one group in Agent Files, and #450 put the plan convention here too),
`handoffs.js` (where a handoff packet lives — #468; the directories it is read from and written to, the file format, and the one-time export of the rows it used to be),
`file-watch.js` (keeping an open document live while something else rewrites it — #452; the watch
moved out of main.js because it only ever told the main window and kept no refcount),
`vcs.js` (the VCS poller + its standalone windows — #277), `detach.js` (detached session
windows — #2, and since #316 which window renders which session), `presence.js` (is the USER at the
machine — #386; one global fact, because every renderer has its own `windowFocused` and none can see
the others), `timeline.js` (what happened to a session — #396; the one writer of the record, so a
session has one history however its windows come and go), `turn-hold.js` (a "the agent finished" that
is about to be wrong — #495; a CLI announces the end and the start of a turn through two events and
nothing orders them, so a `Stop` arriving while a prompt is still queued is held rather than delivered.
Reads no transcript: the `readTurnQueue` descriptor hook answers whether a turn is still owed, and a
backend that declines gets the behaviour that shipped before it), `session-shutdown.js` (stopping every CLI
process and CHECKING that it stopped — #424), `db-upkeep.js` (when the database is compacted and how
much of it — #430; the SQL is `src/db/compact.js`, what needs to know about the app is here),
`vcs-ignore.js` (will this directory be committed — the two questions asked before the app suggests writing into one; shared by the plans convention and the handoff writer since #468),
`path-containment.js` (is this path inside that one — #474; the REAL path of both sides, so a junction
cannot be spelled inside a project it is not in. One implementation for the plan directories, the handoff
directories, the folder picked after a refused write, the backend resources and the working-copy readers
in `vcs.js` (#476). What each caller keeps of its own is the CHEAP half: a lexical pre-check, and in
`backend-resources.js` the rule that a resource must already EXIST. **In `vcs.js` the question is asked about the
DIRECTORY, before the stat**: `lstat` sees only the final component — every directory above it was
already followed — and that reader answers a missing file with an empty side, so a check placed after the
stat never sees a path that escaped and had nothing at the end of it. The LEAF keeps its own sentence: a
link the user can see and fix must not be reported as "outside". **It answers EQUALITY too — `samePath`,
#545** — the same two rules for a caller whose question is "this one" rather than "inside it": Claude's
plugin records name the project an install belongs to, and that answer sets a listing entry's scope, so a
resolved-string compare dropped a linked project's plugins and called two Linux directories that differ
only in case one project. A path compare that reaches a scope is still a path compare. **And it answers as
a KEY — `pathKey`, #563** — because project grouping files thousands of rows into buckets and a predicate
cannot be a bucket: the three compares that decided a project's identity by string
(`session/derive-project-path.js`, `projects/projects.js`, `backends/rewrite-cwd.js`) needed the canonical
form itself. `pathKey` is the only memoised thing in the file, and the split is deliberate: the guards
above cost ~92 µs a call against ~0.7 µs for the string compare they replaced, which is affordable for a
decision about writing somewhere and is not affordable per session row — a sidebar rebuild measured 16 ms
with the memo and 311 ms without it. A stale key costs a regrouping; a stale guard costs an escape, so the
guards keep asking the disk), 
`clipboard-insert.js` (what the system clipboard hands a `{clipboard}` insert — #491; the paste/drop
ladder of #307 on the side of the IPC where there is no DataTransfer, so a copied file, a snapshotted
bitmap and plain text are told apart once rather than per caller. It quotes and cleans nothing: the
shell family and the secret flag live in `variables.js`, which is where those decisions belong),
`readable-error.js` (what a THROWN filesystem error may say to a user — #444; it names the path it
failed on, so the errno is translated and the rest of the message is dropped, with the raw text sent to
the log instead. A reason a module wrote itself is not an error and never goes through it),
`safe-write.js` + `format-validate.js` (how this app overwrites a file a CLI also owns — #441, below) and
`terminal/` (`spawn.js` = open-terminal, `io.js` = input/resize/redraw/flow control, plus the PTY
pure-logic and half a dozen more — list it).
**The directory is the truth** — this enumeration has now silently missed modules twice, most recently
five at once including `convention-dirs.js`, which CLAUDE.md reflex 12 sends you here to find. It is
kept complete rather than cut down to the pointer, because the alternative was tried and the pointer is
what people skip: a reader who does not already know a module exists has no reason to list a directory.
So the price of the list is that **whoever adds a module to `src/app/` adds its line here** — and until
that has a guard, list `src/app/` yourself before assuming an area has no home yet.

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

## Never `fs.writeFileSync` a file a CLI reads (#441)

`src/app/safe-write.js` is the one way. Three properties, and the reason each exists is a failure that
had already happened somewhere:

- **A baseline compare**, so a stale editor cannot overwrite what an agent wrote while it was open. It is
  CONTENT, not an mtime — `viewer-panel.js` argued that first and the argument holds: an mtime has a
  resolution and a clock behind it. Check-then-write, not a lock, and the module says so.
- **A temp file and a rename**, so a CLI reading its config mid-save never gets half of one. With a short
  retry, because Windows fails a rename-over-target while anything holds a handle — and never a fallback
  to a truncating write, which is the thing atomicity is for.
- **The file's own line endings and BOM**, because CodeMirror hands back LF with neither, and the first
  save would otherwise rewrite every line of a CRLF file.

`format-validate.js` decides whether the text still parses, by EXTENSION rather than by backend. Syntax
only, never schema: the CLIs change their own schemas whenever they like.

Every writer goes through it — `saveMemory`, `savePlan`, `saveHandoff` (#468), `save-file-for-panel`, the
resource writer in `backend-resources.js`, the attention hook's settings writes, `planConventionApply`, and
the three backend config writers (`claude/config.js`, `codex/trust.js`, `pi/trust.js`).
Grep for `writeTextFile` rather than trusting this list. A new writer that does not use it is a second set
of guarantees for the same files — and the two that landed last were both a settings blob written by a
feature whose subject was something else, which is where this rule gets forgotten.

## A probe here closes its OWN stdin (#541)

Running a CLI just to read what it prints — shell discovery's `wsl.exe --list --quiet` — must end the
child's stdin. A probe never writes to the child, so the pipe Node hands it by default is only a way to
hang: a CLI that reads standard input before answering waits for an EOF that never comes, and the probe
burns its whole timeout instead of failing. **`execFile` silently IGNORES a `stdio` option** (Node hands
`spawn` an allow-list of options and `stdio` is not on it), so the pipe is ended by hand and the call is
**wrapped** — `closeProbeStdin(execFile(...))`, never a separate call on the next line, because only the
wrapper form is greppable. `spawnSync`/`execFileSync` honour a `stdio` option and take one instead.

**`src/backends/cli-probe.js` holds the same fix and does NOT move.** Its header says its scope is
`src/backends/**`, and importing it from here would be an `src/app/` module reaching into a backend
folder — the direction `.claude/rules/backends.md` forbids. So the app side keeps its own few lines
(`closeProbeStdin` in `src/app/terminal/shell-profiles.js`, which names the sibling in its comment), and
the duplication is the deliberate price of the import direction; spec 9's decision 11 is the record.
`test/shell-profiles-probe.test.js` sweeps `src/app/terminal/**` for both call shapes the way
`test/cli-probe.test.js` sweeps the backends. `pty.spawn` is exempt: a terminal with no standard input is
not a terminal.

Not swept, and deliberately: `src/app/vcs.js` and `src/main.js` run `git` with the same open pipe. `git
status`, `diff` and `worktree remove` do not read standard input, and nobody has watched one hang — a
sweep on suspicion would have touched half the file for nothing.

## A FRESH spawn does not arm the redraw nudge (#560)

`src/app/terminal/io.js` follows a resize with a `cols+1` / `cols` wiggle when the session carries
`firstResize: true`. `src/app/terminal/spawn.js` sets that flag on the **reattach** path and NOT on a
fresh spawn, and the asymmetry is the point rather than an oversight somebody forgot to tidy.

The nudge exists to make a TUI that has been drawing all along repaint into a terminal that was just
re-mounted. A CLI that started three milliseconds ago has drawn nothing to repaint. What the nudge does
there is hand it two more geometry changes inside its first 150 ms — the PTY spawns at 120x30,
`syncPtySize` pushes the real size, then the wiggle adds two more. Three geometry changes while the CLI
is drawing its first frame.

That is not free, because **Claude Code counts a fullscreen session as started only once it has drawn a
frame and survived** — and after two failed starts it moves that machine to its classic renderer,
silently, until the CLI is updated or the user runs `/tui fullscreen`. `.claude/rules/renderer.md` has
the consequence from the other end: the conversation leaves the alternate screen, and PageUp/PageDown
change meaning under the user (#558). This app was one of the things causing those failed starts.

`test/spawn-first-resize.test.js` pins it, as a SOURCE check — `node-pty` is required at module load, so
there is no seam a test can reach a fresh spawn through. It exists for the regression that will actually
happen: someone restores the symmetry between the two branches because it looks like a bug.

The other half of #560 — four CLIs plus a cold scan starving the first frame, measured at 10-13 s to the
alternate screen — is open as **#567**. Do not re-derive it here.

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

**This table and that test's `WHERE_IT_GOES` string are the same list, and the test's copy is the one an
agent reads** — it is the failure message. They had drifted by six rows, so a handler in one of those
areas met a red test that offered it no home and became a `GRANDFATHERED` entry instead. Nothing checks
that they agree. Add a row here, add the line there, in the same commit.

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
| Handoff packets — listing, saving, deleting | `src/app/handoffs.js` |
| Version-control status, the changes/diff windows | `src/app/vcs.js` (the seam it drives is `src/vcs/`) |
| Detached session windows, which window a session renders in, moving one between windows | `src/app/detach.js` |
| Whether the user is at the machine (focus + input, across every window) | `src/app/presence.js` |
| What happened to a session, and reading its history back | `src/app/timeline.js` |
| Which live sessions their backend has no record of, so no busy/idle can be shown | `src/app/store-record-notice.js` (decided in `src/watch/adopt.js`) |
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

## A caught error's own text never crosses IPC (#444, #457)

`catch (err) { return { ok: false, error: err.message } }` is one shape of it; `'failed: ' + err.message`
is the other, and the second hid longer because it has no field name in front of it to grep for. That
message names the file it failed on — always somewhere under the user's home — and the renderer puts it in
a dialog, or straight into the status bar. It also says nothing anyone can act on. **How many sites there
were is deliberately not written here**: `test/no-raw-fs-errors.test.js` walks `src/`, and it is the only
answer that stays true.

- **Translate through `src/app/readable-error.js`.** It maps the errno to a sentence and **drops** the
  rest of the message. Not trims, not scrubs: an unrecognised code means there is no way to tell what
  the message carries, so none of it is passed on.
- **The detail is moved, not lost** — pass the module's `log` and the raw text lands there. A failure
  the user cannot explain from the screen and nobody can look up afterwards is the worse trade.
- **A reason you WROTE is not an error.** `'path outside a plans directory'` is already for a reader
  and stays as it is. Only thrown things go through the translator.
- **`src/backends/**` words its own refusals** rather than importing the helper — a backend reaching
  into `src/app/` is the wrong direction. `err.code` in a sentence of the backend's own is enough.
  The one exception is `src/app/safe-write.js`, which CLAUDE.md rule 11 makes mandatory for any file a
  CLI also reads, so `src/backends/claude/config.js` imports it on purpose (#533). That rule is the
  stronger claim: a second copy of the baseline compare is worse than the import.
- **A handler that does NOT catch is the worst case, not the safe one.** Electron serialises a thrown
  Error across `invoke`, so the renderer's own `catch (err)` receives `err.message` verbatim. `main.js`
  installs `guardIpcHandlers` before it requires a single module, which covers every handler and every
  one added later — do not undo that by catching inside a handler and returning the raw text instead.
- **What the renderer receives is not what you threw.** Electron's main half sends `err.toString()` and
  its renderer half re-wraps that, so a toast reads
  `Error invoking remote method '<channel>': Error: <your sentence>`. The prefix carries the channel and
  nothing else — no path, no argument — so it does not undo any of this. It is why nothing may compare an
  error message for equality: assert on a substring, or you are asserting Electron's formatting.
- `test/no-raw-fs-errors.test.js` walks `src/` and fails on all three shapes: the field, the
  concatenation, and a field split across lines. An exemption needs a reason, and one that stops matching
  is reported as stale. Its first version had one pattern, and an adversarial review walked past it
  twice — one of those misses was live, painting a scandir error into the status bar.

## Preload is the only IPC surface

`src/preload.js`: the renderer talks to main exclusively through `window.api.*` defined here
(`ipcRenderer.invoke` for request/response, `.send`/`.on` for streams). Add a binding here when you
add an IPC handler.

## Watching

- `src/watch/projects.js` — fs.watch on Claude's store (folders + per-file refreshes).
- `src/watch/stores.js` — every OTHER backend's store. Scan-generalization is not
  watch-generalization, so this works on `watchTargets()`, not on discovery's per-session handles.
  **The sibling match accepts `-wal` and NOT `-shm`, and that is load-bearing (#521).** A `-shm` is a WAL
  database's shared-memory index, and its mtime moves when the database is merely OPENED — including by
  the reconcile this watcher's own flush posted. agy keeps one database per conversation, so matching
  `-shm` made the app answer its own reads: reconcile opens them, the open touches every `-shm`, the
  watcher calls that a change, and 612 ms later it reconciles again. It cost 5-8 % of a core permanently,
  with no agy process running at all — the main process was the only thing on the machine that never
  reached idle. A commit lands in `-wal`, which is the signal the sibling match exists for; `-shm` says
  "somebody looked".
  **A flush says which store it reconciles, at `debug`** — that one line named agy in a minute, after the
  three obvious suspects (the renderer, transcript writes, the VCS poller) had each been excluded by
  measurement. And a flush with nothing pending posts NOTHING: an empty scope is the unscoped request, a
  full sweep of every backend, so the flush with the least to do would otherwise cost the most.
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
