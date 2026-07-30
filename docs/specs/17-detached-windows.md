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
                         clears `rendererAttached`, and only for the window that still OWNS the
                         session — #328; the process runs on either way)
                      →  the new window calls openTerminal → the reattach branch → buffer replay
```

## 2 · One channel routes, the rest do not

| Channel | Goes to |
|---|---|
| `terminal-data` | the **owning** window — `app/detach.js` `windowForSession(id)`, asked by `spawn.js` through ctx |
| `process-exited` | the owning window **and** main (main writes the sidebar's state, the owner writes the banner into the terminal the user is looking at) |
| `session-detached` / `session-reattached` | the window that must let go / take over — main by default, a specific detached window since #316 |
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
| a whole PANE → a window of its own | "Move pane to new window" in the pane menu (#340) — detach the first tab, then move the rest to where it went |
| a tab DRAGGED onto another window | the tear-off gesture (#352) resolved against `window-at-screen-point` (#360) |

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

Four consequences worth stating:

- **A detached window that gives away its last session closes.** It has no sidebar to pick a new one
  with, so an empty one is a window the user cannot use and cannot interpret.
- **A drag cannot cross a window boundary, so main answers where it ended** (#360). HTML5 drag and
  drop is per renderer process: the far window never sees a `drop`, and the near one only knows the
  pointer left its own box. `window-at-screen-point` turns that into a window id — the same id
  `move-session-to-window` takes. Two limits are deliberate: with two windows stacked under the
  pointer the topmost cannot be identified (Electron exposes no z-order, first match wins), and a
  point that cannot be resolved moves **nothing**, because a plausible guess is what puts a session
  where the user did not aim. The renderer sends the box it measured for itself alongside the point;
  main converts through that window's real bounds, so a zoomed renderer still hit-tests correctly.
- **`detach-session` answers with the id of the window it made** (#340). Moving several sessions to
  one new window is "detach the first, move the rest to where it went", and the id is the only way to
  name it: a window is titled after a session, and two sessions can carry the same name.
- **Closing a window hands back everything it holds**, not the one session it was opened for. The
  explicit paths delete their entry *before* destroying, so `closed` never repeats a handover.

**A session with no process moves too, and the rule it used to break lives elsewhere now (#332).**
`move-session-to-window` refused one until then, and that refusal predated #319: back when the taking
window mounted whatever it was given, a mount with no live PTY *spawned* one, so a move resumed a CLI
the user had stopped (#315). Since #318/#319 the renderer states that rule where the mount happens —
the boot reconcile, `adoptOwnedSessions` and `adoptSession` each gate on whether the session runs, from
main's answer rather than their own poll — and a second copy of it in the move handler is what stranded
a dormant session: the menu entry was disabled *and* the call refused, so closing the whole window was
its only exit, which handed back every live session that window held as well.

What the taking window then does with it depends on what that window has to show it in, and the two
answers are deliberate:

| Taking window | Dormant session lands as |
|---|---|
| any window in **panes** mode | a **dormant tab** — the pane draws the "not running / Launch" placeholder it already draws for a tab restored from a saved layout (#318). `panesView.openDormantTab` is the one path that puts an unmounted session into the tree: `show` refuses one, because it is the choke point every `showSession` goes through and a phantom tab there would be worse than a declined move |
| the **main** window in tabs mode | nothing is mounted and nothing is drawn — the sidebar lists the session, which is the way back the move existed for |
| a **detached** window in tabs mode | refused before it starts, by name ("that window cannot show a session that is not running"). That strip is built from `openSessions` and the window has no sidebar, so the session would be held by a window that shows it nowhere |

The adopt tells those cases apart rather than falling back on `release-session-claim`. That channel
means "I cannot render this one" (#331); a window that *can* show a dormant session keeps the claim,
because handing it back would undo the move the user just made.

Two places had to learn the same thing, and both were the bug again in miniature:

- **The boot reconcile.** `adoptOwnedSessions` mounted only what runs and *skipped* the rest, so a
  reload of a window holding a dormant session came back without its tab while main still recorded the
  window as its owner — unreachable, which is what this issue is about. It now gives it the same dormant
  tab, with `{ activate: false }` so it lands behind whatever the boot path already chose to show, and
  hands the claim back when there is nowhere to put one.
- **The sidebar's own "Bring back to this window".** It was disabled without a live process, with a
  comment pointing at the refusal in main. That refusal is gone, so the button is offered either way —
  it was the more discoverable of the two exits from a shared window, and it was the one still shut.

The window list is built in main (`list-session-windows`) and names each window by what it shows;
"window 3" means nothing to the user. It marks the window that already holds the session, because the
renderer cannot work that out: a detached window does not track its own set, and "not detached means
in main" is only true when asked from the main window. The list is fetched when a menu opens and its
items are appended to the open menu — the alternative would be to hold the menu until main answers.

**The name has to keep up (#325).** That list reads `win.getTitle()`, which Electron takes from the
window's `document.title` — and the title was set once, at boot, from the session the window was
opened for. Once a window holds a set, a title naming a session that has since moved out points the
user at the wrong window under the right name. So the detached renderer re-derives its own title from
what it holds: **its active session, plus `+N` for the rest.** Everything a detached window holds it
renders, so `openSessions` *is* its set — no second bookkeeping to fall out of sync. It re-derives on
the three events that can change either half: `setActiveSession` (the choke point every focus path in
the renderer funnels through), the release/adopt handover, and a re-key.

`window.__detachedSessionId` follows the same value. It used to name the opening session forever,
which left the no-argument `reattachSession()` and the re-key filter tracking a session the window no
longer had — latent, because every menu path passes an explicit id. **The identity question is
`window.isDetachedWindow()`**, answered from the URL and immutable; asking it through
`__detachedSessionId` is the bug that value now invites.

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
| Detached without a process (#319) | The window opens and **shows** the session — named, with a Launch button — instead of starting it. Mounting is what would start it (`openSession` → `openTerminal` spawns when it finds no live PTY), so the window simply does not mount, and Launch is the press that does. Panes mode draws this from the pane's own placeholder (#318); tabs mode has no `#placeholder` here (it says "select a session in the sidebar", and this window has none), so the same block is built for it. Launching starts the process in **this** window: main already has the session down as its, so the bytes route here |
| Window closed by hand | **Every** session it still holds returns to the main window (#316) — each one unless its process has ended: taking it back always reopened it, which silently resumed a CLI the user had stopped |
| Reattach / move action | Main deletes the map entry **before** destroying the window, so the `closed` handler stays silent and the notification fires once |
| Moved without a process (#332) | The move runs and starts nothing — see §2b for where it lands, which depends on the taking window's display mode. A window left holding only live sessions stays open; the dormant one no longer needs the window closed to get out |
| Last session moved out | The window closes: no sidebar, nothing to show, nothing to pick (#316) |
| Main window closed | `closeAll` clears the map **first**, then destroys: on the plain Alt+F4 path `appQuitting` is still false, and a reattach would land in a renderer being torn down |
| App quit | Same call; nothing is handed back |
| PTY exits while detached | The banner is written in the detached window; the sidebar keeps its own state from main |
| Session re-keyed (fork, accepted plan) | `applyRekey` migrates the window: output is sent under the **new** id, so a window left on the old one falls silent mid-run |

## 6 · Why `index.html?detached=<id>` and not a smaller page

A minimal `detached.html` would have to re-wire the terminal by hand and would drift from the real
one: ConPTY quirks, paste, mouse reporting, the right-click menu, WebGL fallback, the fit self-heal.
Reusing the page costs one full renderer per detached WINDOW — since #316 a window can hold several
sessions — which is accepted for a power feature.

With panes mode (spec 16) already in place, the window needed no special renderer at all: it gets a
tree with one leaf and inherits the strip, the session bar and the tools. The **ghost tab** the
original plan proposed for the main window turned out to be unnecessary — a detached session simply
has no tab there, and clicking its sidebar row raises its window.

## 7 · Tests

`test/detach-routing.test.js` (36) covers the routing and the state machine without Electron —
`BrowserWindow` arrives through ctx for exactly that reason. It pins per-session routing, the window's
shape (no `parent`: a child window is always on top, which defeats a second monitor; no background
throttling), double detach, reattach, close-by-hand, quit, `closeAll` off the quit path, a window
destroyed without its event, the focus path, and the re-key in both directions. The move cases (#316)
are there too: the window list and its `current` marking, main → detached, detached → main, detached →
detached, a window closing with several sessions, a move onto the window a session is already in, and
the refusals that are left. Since #332 that includes the dormant moves in both directions, and that
moving one spawns nothing; the renderer's half of that decision — which window can *show* a dormant
session — is in `test/panes-view.test.js` (`openDormantTab`), because it is a pane-tree question.

What it cannot cover is the invariant in §3: that lives in the renderer, and it is where both real
bugs were. `docs/ai/driving-the-app.md` has the two traps that made checking it harder than it should
have been — a renderer reload does not reload the main process, and `--target` matches both windows.

## 8 · Not built

Persisted bounds per detached window (the original plan's optional line), and a detached session is
not part of the saved open-sessions set, so it is not restored on the next launch.
