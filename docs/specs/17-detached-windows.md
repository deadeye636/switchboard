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
| a tab DROPPED on empty space | a window of its own, on the display it was dropped on (#362, #363) |
| one of the app's own VIEWS onto another window | it opens there and closes here (#364) — nothing is handed over, both windows have their own copy of the element |

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
- **A new window opens on the display it was asked for** (#362). The renderer sends the drop point
  with the detach — the same point-plus-box pair `window-at-screen-point` takes, converted the same
  way — and main places the window on `getDisplayNearestPoint`'s answer. A detach with no drag (a
  menu, a keyboard) carries no point and uses the pointer's display, which is where the menu was
  clicked. The bounds are then clamped into that display's work area, and the minimum window size
  gives way to a work area smaller than itself: a window hanging off two edges of the screen it was
  just placed on is worse than a small one.
- **A drop on empty space means the same thing in every window** (#363). It used to mean "back to the
  main window" when the drag started in a detached one — because `window.detachSession` was defined
  below detach-window.js's early return and did not exist there at all — so one gesture had two
  meanings depending on where it began, and the drop point was discarded. Returning a session to main
  is what the tab menu offers by name; the gesture is for giving it a window of its own.

  **"Detached" is not "alone", and `detach-session` has to tell them apart.** Its idempotency guard
  used to answer "already detached" by focusing that window, which was written when a detached window
  held exactly one session — since #316 it can hold several, and a session sharing one has no window
  of its own yet. Reached from the tear-off gesture, that guard swallowed the drag whole: no window
  made, no placement run, nothing moved. So only a window holding the session ALONE short-circuits.
  The release then has to be addressed to the window that actually holds it, not to main — main
  letting go of a session it never had releases nothing, and the sharing window would keep drawing
  one that had moved away.

  **Open, deliberately unresolved:** tearing out the ONLY tab of a detached window still just focuses
  it. The session does already have a window of its own, so "give it one" is satisfied — but the drop
  point is discarded, and moving that window to where the user dropped it would be a different
  operation (moving a window, not detaching a session). Left as it is until someone asks for it.
- **A window with no sidebar cannot steer a sidebar-driven view, so main relays the pick** (#364).
  Memory, Plans and Work files pick their file in the sidebar, which lives here by design — so once one
  of them sits in another window, `route-view-file` delivers the click to whichever window holds it, and
  the clicking window says where it went. The register (`window-views-changed`) is reported by the window
  that shows the view, never inferred: main guessing from what it last sent is how a routing table goes
  stale in a way nobody notices until a click lands nowhere.
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
| the **main** window in grid mode | nothing is mounted and nothing is drawn — the sidebar lists the session, which is the way back the move existed for |
| a **detached** window in grid mode | refused before it starts, by name ("that window cannot show a session that is not running"). Nothing there is built to draw an unmounted session and the window has no sidebar, so it would be held by a window that shows it nowhere |

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

## 2c · A window can hold no session at all (#370)

A window was built around a session, in four places at once: the URL named one
(`?detached=<sessionId>`), the map was keyed by one, the title came from one, and closing handed one
back. So "give Memory a window of its own" had nowhere to go, and the view menu said as much by
having no "new window" entry.

A fifth place is the one that is easy to miss, and it is the one that actually bit: **the session map
was also the only list of windows there was.** Every "which windows exist" question read it — the move
menu, the drop hit-test, the quit teardown. A window absent from it cannot be moved to, cannot be
dropped on, and *survives the app that made it*. So the two questions are now two collections:
`detachedWindows` (session → window) still answers where a session's bytes go, and a plain set of every
window answers which windows there are.

What follows from that:

| | |
|---|---|
| The URL | `win=detached` is the identity; `detached=<id>` and `view=<kind>` are what the window opens **on**, and it can have neither (a restore fills it afterwards, §5b). `isDetachedWindow()` reads the marker — asking it through the session id is what left a view window falling through to the MAIN window's wiring, launch restore included |
| The title | A window with no session is named after its views, in the same `<name> +N` shape a session set is named with |
| The close rule | "A window that gives away its last session closes" was the same statement as "it has nothing left to show" only while a window could hold nothing else. It now closes when it holds **neither** sessions nor views |
| Which views may go | Unchanged from #364: a singleton that names a loader. A diff still never leaves, and an instanced preview cannot be rebuilt from a kind and a ref |
| The opening tab | **None** (#379). The pane tree is built around the session the window was opened for, and building that tab from a session id of `null` made a real one: nameless, about 49 px wide, nothing behind it, sitting beside the view — and written into the saved layout, so every restore made it again. An empty leaf is a shape the tree already has; the main window reaches it whenever pruning takes the last tab |

## 2d · A drop on another window lands where it was dropped (#375)

A tab dragged onto another window used to land in that window's **active** pane. Inside one window
the drop decides everything — an edge splits, the middle inserts, the strip places by caret — so the
same gesture meant two different things depending on which window the pointer was over.

**The obstacle was never the placement. It was the feedback.** HTML5 drag and drop is per renderer
process: the far window sees no `dragover` at all, and the near one only knows the pointer left its
box. Three pieces, and the order they are listed in is the order of difficulty:

| Piece | Where |
|---|---|
| **Ask the far window.** It converts the screen point into its own coordinates and hit-tests its pane tree, answering `{kind: 'tab'\|'split'\|'root', …}` | `dropTargetAt` in `views/panes-view.js` |
| **Have it draw that answer** while the pointer is still held — the same hint a local drag draws | `showPlacementHint`, same file |
| **Carry the answer in the move**, so the taking window puts the session where it highlighted | `move-session-to-window`'s third argument → `session-reattached`'s fourth |

Five things this rests on, each of which would be a defect on its own:

- **The question is asked from the `drag` event, not `dragover`.** `dragover` only fires over our own
  window; `drag` fires on the SOURCE for the whole gesture, including while the pointer is over
  another window. It is the only hook that can reach across at all.
- **The conversion happens in the FAR renderer**, because only it knows its own zoom. It is
  `toScreenPoint`'s inverse: `outerWidth / bounds.width` is CSS pixels per DIP, and `screenX` is where
  that viewport starts in the same screen coordinates the point is given in. Its bounds travel with
  the question so it has both halves of the ratio.
- **Main→renderer has no reply channel**, so one is built: main sends with a ticket, the renderer
  answers on `drop-probe-answer` quoting it, and the ticket resolves the promise. Bounded by 250 ms —
  a renderer that is busy or gone must not leave a drag waiting on it, and the timeout's answer is
  "nowhere", which the caller already knows how to handle.
- **One probe in flight at a time.** `drag` fires many times a second and each probe is a round trip
  through a second renderer; a queue of them would arrive after the drop that was waiting for them.
- **A window that cannot say WHERE still gets the session.** The issue asked for the opposite — "a
  drop that cannot be resolved moves nothing" — and that was written by analogy with §2b, where an
  unresolvable point moves nothing because no WINDOW could be identified. Here a window has been
  identified: the user dropped on it, visibly. What is missing is only the pane, and the answer to
  that is the one a drop on another window has always had — its active pane. Refusing the move
  instead would make a busy renderer (the probe has a 250 ms deadline) or a pointer over that
  window's own chrome swallow a gesture that worked before this feature existed, which is a
  regression dressed as strictness.

  §2b's rule is untouched and still means what it says: a point over **no window of ours** moves
  nothing. The two are different questions — which window, and where inside it — and only the first
  one has an answer that can be absent altogether. What that landing is missing is not the placement
  but the announcement, which is §2e.

The hint is taken down on `dragend` while the ANSWER is kept: `tearOffTab` reads it one line later to
place the tab, and clearing both together threw it away in front of its only reader.

## 2e · A landing that cannot be named is still announced (#377)

§2d's last bullet left one thing unsaid, and it was the thing the user could see: a window that could
name no pane answered **nothing**, and the session then landed in its active pane anyway. The window
had highlighted nothing while the pointer was over it, so the drop succeeded at a place that was
never shown.

Every application that moves a tab between windows makes the outcome visible before the pointer is
released — Chrome and Firefox with a caret in the far tab strip, VS Code and IntelliJ with a drop
frame or a "no drop" cursor. They differ on what an unresolvable point *does* (Chrome tears off a new
window, the others cancel); none of them lands silently somewhere unannounced.

So the probe answer gained a third shape. A window under the pointer now always answers something:

| Answer | Meaning | Drawn as |
|---|---|---|
| `{kind: 'tab'\|'split'\|'root', …}` | a pane and a zone | the caret / pane hint / outer hint of §2d |
| `{kind: 'window'}` | this window, but no pane of it | a frame around the whole window |
| `null` beside a window id | the renderer did not reply inside `PROBE_TIMEOUT_MS` | nothing — see below |

Three consequences worth keeping:

- **`{kind: 'window'}` places nothing.** `applyPlacement` answers `false` for it, which is what hands
  the session to the active-pane fallback the adopt already had. The placement rule of §2d is
  unchanged; only the feedback is new.
- **The frame is drawn by `shell/detach-window.js`, not by the panes view.** The same answer has to be
  drawable by a window in **grid** mode, where that view is not running at all — and a grid window is
  one of the two everyday ways to reach this case, the other being a pointer over the window's own
  chrome.
- **A renderer that never replies is unchanged.** It cannot draw, so it cannot announce; the session
  lands in its active pane the way it did before any of this existed. Refusing the drop there would
  put back exactly the swallowed gesture §2d argued against, and this time with a 250 ms deadline as
  the trigger.

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
  user's arrangement with a single pane. It does have one of its own since #372; it is kept in the
  **main process**, beside the rest of what that window holds, precisely because this key is not its
  to write;
- **the open-sessions restore state** — the detached window's `beforeunload` would otherwise replace
  the whole restorable set with its one session, in a key kept deliberately durable across a crash;
- **`gridViewActive`** — see §3.

## 5 · Lifecycle

| Case | Behaviour |
|---|---|
| Detached without a process (#319) | The window opens and **shows** the session — named, with a Launch button — instead of starting it. Mounting is what would start it (`openSession` → `openTerminal` spawns when it finds no live PTY), so the window simply does not mount, and Launch is the press that does. Panes mode draws this from the pane's own placeholder (#318); grid mode has no `#placeholder` here (it says "select a session in the sidebar", and this window has none), so the same block is built for it. Launching starts the process in **this** window: main already has the session down as its, so the bytes route here |
| Window closed by hand | **Every** session it still holds returns to the main window (#316) — each one unless its process has ended: taking it back always reopened it, which silently resumed a CLI the user had stopped |
| Reattach / move action | Main deletes the map entry **before** destroying the window, so the `closed` handler stays silent and the notification fires once |
| Moved without a process (#332) | The move runs and starts nothing — see §2b for where it lands, which depends on the taking window's display mode. A window left holding only live sessions stays open; the dormant one no longer needs the window closed to get out |
| Last session moved out | The window closes: no sidebar, nothing to show, nothing to pick (#316) |
| Main window closed | `closeAll` clears the map **first**, then destroys: on the plain Alt+F4 path `appQuitting` is still false, and a reattach would land in a renderer being torn down |
| App quit | Same call; nothing is handed back |
| PTY exits while detached | The banner is written in the detached window; the sidebar keeps its own state from main |
| Session re-keyed (fork, accepted plan) | `applyRekey` migrates the window: output is sent under the **new** id, so a window left on the old one falls silent mid-run |

## 5b · The windows come back on the next launch (#371)

They used to come back nowhere. The main window persists the set **it** renders, and a detached
session was released from that set the moment it left — so it was in no saved blob at all, and the
windows themselves existed only in this process's memory. Quit with three windows across two
monitors, reopen to one window and fewer sessions than you left.

**The state lives in the main process** (`detachedWindows` in the global settings), and that is forced
rather than chosen: §4 is the reason. Every window shares one origin, so a detached window writing the
renderer's restore key would replace the main window's whole restorable set with its own. Bounds and
the window set are this process's facts anyway.

- **Written on every change, not at quit.** A detach, a move, a view opening or closing, a window
  moved or resized — each schedules a debounced write. A crash or a force-kill therefore still leaves
  a usable state, and the quit path only has to flush what is already true.
- **`closeAll` writes FIRST, then tears down.** Its own `closed` handlers run during the teardown, and
  one of those persisting the half-emptied list would overwrite the answer. A window closed **by
  hand** does drop out, which is the difference the flag exists to keep.
- **The payload is PULLED by the restored window,** not pushed at it. A push has to pick a moment and
  every moment is wrong: `did-finish-load` can beat the renderer's own boot, and anything later races
  the reconcile. It asks once, when it is ready to act on the answer; a reload gets nothing, because by
  then the sessions are running and the ordinary adopt is what puts them back.
- **Restoring MOUNTS a session, which resumes its CLI.** That is deliberately the opposite of what an
  adopt does (§2b): a session moving between windows must never start a process the user stopped,
  because there they asked to move a window. Here they asked for their windows back, and it is exactly
  what the main window has always done with its own set. With **Restore sessions on launch** off,
  nothing comes back — windows included.
- **A display that is gone must not take a window with it.** The saved position is kept only while a
  display still covers it (the same ±100 tolerance the main window's restore uses); otherwise the
  window opens at the primary display's origin, never larger than the work area it lands in. The
  decision is a pure function (`restoreWindowBounds`) so `node --test` can exercise the multi-monitor
  cases a single-screen machine can never show.
- **Once per process.** `createWindow` runs again on the macOS `activate` path, and a second pass
  would duplicate every window rather than reveal the ones already standing.

- **The arrangement comes back too** (#372). Four sessions in a two-by-two split returned as four
  tabs in one pane, which is most of the reason to have a window on a second monitor undone at every
  launch. The tree rides along in the same per-window record — §4 is why it cannot ride in
  localStorage — and it is applied **before** the sessions and views are put back, because a mount
  and an `openViewTab` both look for an existing tab first, and the layout is what puts those tabs
  there. Applying it afterwards works too, but it draws the window twice: once piled into one pane,
  once rearranged, which reads as the restore correcting itself. It is pruned on the way in by the
  same two rules the rest of the restore obeys, and **declined** when nothing survives that — a
  window of empty panes is worse than the single pane it would otherwise have had.

- **A window this mode cannot show is held, not opened** (#378). The app's own views live in panes
  mode, so a saved window holding nothing else has no target in **grid**: it came back as an empty
  frame with no title and no explanation. Worse, the next state write drops a window that holds
  neither sessions nor views — the rule that stops a window mid-handover being saved — so the entry
  was gone for good and returning to panes did not bring it back.

  It is now skipped at restore and carried through the write **unchanged**, so it reopens with its
  views the next time the mode can fill it. A window holding sessions is unaffected: grid shows those,
  and it is only the view half that has nowhere to go. Main reads the mode with its own copy of the
  grid spellings — an explicit grid choice is grid, anything else is panes (#374) — and a test pins
  that list to the renderer's `resolveSessionDisplayMode`, because two copies of one rule drifting
  apart is how the empty frame would come back.

What does **not** come back: an instanced preview or diff, which cannot be rebuilt from a kind and a
ref alone.

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

`test/detach-routing.test.js` (105) covers the routing and the state machine without Electron —
`BrowserWindow` arrives through ctx for exactly that reason. It pins per-session routing, the window's
shape (no `parent`: a child window is always on top, which defeats a second monitor; no background
throttling), double detach, reattach, close-by-hand, quit, `closeAll` off the quit path, a window
destroyed without its event, the focus path, and the re-key in both directions. The move cases (#316)
are there too: the window list and its `current` marking, main → detached, detached → main, detached →
detached, a window closing with several sessions, a move onto the window a session is already in, and
the refusals that are left. Since #332 that includes the dormant moves in both directions, and that
moving one spawns nothing; the renderer's half of that decision — which window can *show* a dormant
session — is in `test/panes-view.test.js` (`openDormantTab`), because it is a pane-tree question.

Since #370 it also pins the window that holds no session: the URL it is given, that it is listed and
hit-tested and torn down like any other, that it survives its last session leaving while a view is
still in it — and still closes when nothing is. Since #371, the save/restore round trip against a
stand-in settings store, and `restoreWindowBounds` on its own: the display that is still there, the
one that is gone, a window larger than the screen it lands on, and one hanging off an edge. Those four
are the reason that decision is a pure function — they are exactly what a single-screen machine cannot
show. Since #378, the held-back window: not opened in grid, still saved afterwards, reopened in panes,
a window with sessions unaffected either way, both grid spellings, the double-append on the macOS
`activate` path — and the guard that pins main's copy of those spellings to the renderer's.

The two renderer halves of §2e are in `test/panes-view.test.js`: that `{kind: 'window'}` places
nothing rather than addressing a leaf id of `undefined`, and that it clears a pane hint left over from
the pointer's last position. The frame itself is `shell/detach-window.js` and was checked in a running
instance — a real probe round trip into a second window in grid mode — because a hint nobody has seen
drawn is a hint that has not been tested.

What it cannot cover is the invariant in §3: that lives in the renderer, and it is where both real
bugs were. `docs/ai/driving-the-app.md` has the two traps that made checking it harder than it should
have been — a renderer reload does not reload the main process, and `--target` matches both windows.

## 8 · Not built

- **Two files side by side** in the sidebar-driven views. That is what making them self-contained
  would buy, and the relay deliberately does not (§2b, spec 16 §4.2).
- A restored **preview or diff**: an instanced view is built by the window that opened it, and a kind
  plus a ref is not enough to rebuild one (§5b).
(The main window's close path was in this list while it could not be exercised — `window.close()` from
the renderer does not fire `BrowserWindow`'s `close` at all, so it looked like a teardown that never
ran. Driven with a real `WM_CLOSE` it does everything it says: the guard holds the close, the answer
lets it through, `closeAll` takes both windows down, and the next launch brings them back.
`docs/ai/driving-the-app.md` has the trap.)
