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
| Window closed by hand | The session returns to the main window — **unless its process has ended**: taking it back always reopened it, which silently resumed a CLI the user had stopped |
| Reattach action | Main deletes the map entry **before** destroying the window, so the `closed` handler stays silent and the notification fires once |
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

`test/detach-routing.test.js` (17) covers the routing and the state machine without Electron —
`BrowserWindow` arrives through ctx for exactly that reason. It pins per-session routing, the window's
shape (no `parent`: a child window is always on top, which defeats a second monitor; no background
throttling), double detach, reattach, close-by-hand, quit, `closeAll` off the quit path, a window
destroyed without its event, the focus path, and the re-key in both directions.

What it cannot cover is the invariant in §3: that lives in the renderer, and it is where both real
bugs were. `docs/ai/driving-the-app.md` has the two traps that made checking it harder than it should
have been — a renderer reload does not reload the main process, and `--target` matches both windows.

## 8 · Not built

Persisted bounds per detached window (the original plan's optional line), and a detached session is
not part of the saved open-sessions set, so it is not restored on the next launch.
