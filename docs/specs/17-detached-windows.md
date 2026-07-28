# 17 — Detached session windows

**Status: built** (#2). Written after the build, as a design record: what the mechanism is, which
invariants hold it up, and which of them were violated by paths nobody thinks about.

Issue: #2 (its comment carries the original phase plan) · builds on panes mode (spec 16).

## 1 · The mechanism, in one sentence

**The PTY never moves.** It stays in `activeSessions` exactly where it was; what changes is which
window receives its byte stream.

That is the whole feature. Everything below is a consequence of it.

```
detach-session (IPC)  →  new BrowserWindow: index.html?detached=<sessionId>
                      →  main renderer releases its terminal for that session (close-terminal only
                         clears `rendererAttached`; the process runs on)
                      →  the new window calls openTerminal → the reattach branch → buffer replay
```

## 2 · One channel routes, the rest do not

| Channel | Goes to |
|---|---|
| `terminal-data` | the **owning** window — `app/detach.js` `windowForSession(id)`, asked by `spawn.js` through ctx |
| `process-exited` | the owning window **and** main (main writes the sidebar's state, the owner writes the banner into the terminal the user is looking at) |
| `cli-busy-state`, `terminal-notification`, `session-forked`, everything else | main only |

The separation is the point. The sidebar, the attention inbox and the badges live in the main window,
and they must keep updating for a detached session — otherwise the one session the user pushed onto
the second monitor is the one that stops telling them it needs attention.

## 2b · A window owns sessions, not a session (#314, #315, #316)

Detach started as a one-way trip: a window per session, and the only way back was to close it. Three
follow-ups turned that into a move in any direction, and the map is what made it cheap — it is keyed
by **session**, so several keys pointing at one window was already legal.

| Direction | Entry point |
|---|---|
| detached → main | "Return to main window" in that window's tab/pane menu (#314) |
| main ← detached | the sidebar row's own action; a detached row is marked `⧉` and cannot be opened in place (#315) |
| any → any existing window | "Move to <window>" per window, appended to the same menus (#316) |

One handler serves all three (`move-session-to-window`), and the order inside it is the invariant of
§3 in miniature: **release, re-register, adopt.** The giving window is told to let go first, *or* two
renderers hold one PTY for the length of an IPC round trip. Re-registering sits in the middle because
`windowForSession` decides where the bytes go, and the replay the target is about to ask for must
already route to it.

All three steps run synchronously in main, before either renderer has acted, so byte routing switches
atomically however the two windows are scheduled. There is no adopt acknowledgement: a target that is
slow to attach simply has no `openSessions` entry yet, its bytes are dropped, and the output buffer
replays them when it does — the same semantics as any reattach.

Whether the session still HAS a process is answered by main, in the `session-reattached` payload. The
renderer's `activePtyIds` is a polled snapshot that backs off to 30 s in an idle window, so a window
adopting on its own answer could refuse a session that started seconds ago — or worse, accept one that
has died and resume its CLI.

Two consequences worth stating:

- **A detached window that gives away its last session closes.** It has no sidebar to pick a new one
  with, so an empty one is a window the user cannot use and cannot interpret.
- **Closing a window hands back everything it holds**, not the one session it was opened for. The
  explicit paths delete their entry *before* destroying, so `closed` never repeats a handover.

The window list is built in main (`list-session-windows`) and names each window by what it shows;
"window 3" means nothing to the user. It marks the window that already holds the session, because the
renderer cannot work that out: a detached window does not track its own set, and "not detached means
in main" is only true when asked from the main window. The list is fetched when a menu opens and its
items are appended to the open menu — the alternative would be to hold the menu until main answers.

## 3 · The invariant: one session, one renderer

Two xterms on one PTY echo every keystroke twice and fight over the size through `syncPtySize`. The
guards, in the order a session can slip past them:

| Path | Guard |
|---|---|
| `openSession` (sidebar, inbox, tasks, panes, dialogs) | raises the detached window instead of mounting |
| `attachRunningSession` (the grid's auto-open — does **not** go through `openSession`) | the same check, repeated |
| The launch restore, in a detached window | `window.__suppressLaunchRestore` |
| The grid inside a detached window | `toggleGridView` bails |

Both grid paths were found by review, not by testing: they only fire after a display-mode switch,
which is not where anyone looks for a detach bug.

## 4 · Two windows, one origin, one process

The detached window is the same `index.html`, so it shares `localStorage` and every module-level
default with the main window. Three things had to be told not to write:

- **the pane tree** — it neither loads nor persists it, or popping a session out would replace the
  user's arrangement with a single pane;
- **the open-sessions restore state** — the detached window's `beforeunload` would otherwise replace
  the whole restorable set with its one session, in a key kept deliberately durable across a crash;
- **`gridViewActive`** — see §3.

## 5 · Lifecycle

| Case | Behaviour |
|---|---|
| Window closed by hand | **Every** session it still holds returns to the main window (#316) — each one unless its process has ended: taking it back always reopened it, which silently resumed a CLI the user had stopped |
| Reattach / move action | Main deletes the map entry **before** destroying the window, so the `closed` handler stays silent and the notification fires once |
| Last session moved out | The window closes: no sidebar, nothing to show, nothing to pick (#316) |
| Main window closed | `closeAll` clears the map **first**, then destroys: on the plain Alt+F4 path `appQuitting` is still false, and a reattach would land in a renderer being torn down |
| App quit | Same call; nothing is handed back |
| PTY exits while detached | The banner is written in the detached window; the sidebar keeps its own state from main |
| Session re-keyed (fork, accepted plan) | `applyRekey` migrates the window: output is sent under the **new** id, so a window left on the old one falls silent mid-run |

## 6 · Why `index.html?detached=<id>` and not a smaller page

A minimal `detached.html` would have to re-wire the terminal by hand and would drift from the real
one: ConPTY quirks, paste, mouse reporting, the right-click menu, WebGL fallback, the fit self-heal.
Reusing the page costs one full renderer per detached session, which is accepted for a power feature.

With panes mode (spec 16) already in place, the window needed no special renderer at all: it gets a
tree with one leaf and inherits the strip, the session bar and the tools. The **ghost tab** the
original plan proposed for the main window turned out to be unnecessary — a detached session simply
has no tab there, and clicking its sidebar row raises its window.

## 7 · Tests

`test/detach-routing.test.js` (25) covers the routing and the state machine without Electron —
`BrowserWindow` arrives through ctx for exactly that reason. It pins per-session routing, the window's
shape (no `parent`: a child window is always on top, which defeats a second monitor; no background
throttling), double detach, reattach, close-by-hand, quit, `closeAll` off the quit path, a window
destroyed without its event, the focus path, and the re-key in both directions. The move cases (#316)
are there too: the window list and its `current` marking, main → detached, detached → main, detached →
detached, a window closing with several sessions, a move onto the window a session is already in, and
the two refusals.

What it cannot cover is the invariant in §3: that lives in the renderer, and it is where both real
bugs were. `docs/ai/driving-the-app.md` has the two traps that made checking it harder than it should
have been — a renderer reload does not reload the main process, and `--target` matches both windows.

## 8 · Not built

Persisted bounds per detached window (the original plan's optional line), and a detached session is
not part of the saved open-sessions set, so it is not restored on the next launch.
