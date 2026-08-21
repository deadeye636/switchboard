# Driving the app (no clicking required)

Electron speaks the same DevTools protocol Chrome does, so the running app can be scripted. This is
the missing half of "run it and look": a test cannot see a sidebar, and a green suite has twice
hidden a feature that was plainly broken on screen (Codex stuck at "working"; a Save that discarded
every backend setting).

```
npm run start:debug                                   # app + DevTools port 9222
node scripts/drive-app.js eval "<js>"                 # run JS in the renderer, print the result
node scripts/drive-app.js text "<selector>"           # innerText of the first match
node scripts/drive-app.js count "<selector>"          # how many match
node scripts/drive-app.js click "<selector>"          # click the first match
node scripts/drive-app.js clicktext "<sel>" "<text>"  # click the first match containing <text>
node scripts/drive-app.js drag "<from>" "<to>" [zone] # a REAL drag: center|left|right|top|bottom of <to>
node scripts/drive-app.js console                     # renderer console — finds a ReferenceError in seconds
node scripts/drive-app.js dims ["<sessionId>"]        # active terminal geometry: cols/rows, cell box, WebGL state
node scripts/drive-app.js shot out.png                # screenshot the window
node scripts/drive-app.js --target=settings shot s.png  # …a SECOND window, by title or URL
```

No dependency (Node 22 ships a global `WebSocket`; CDP is JSON over one). `window.api.*` is reachable
from `eval`, so the app's own IPC can be exercised directly — e.g. `await window.api.getProjects(false)`
to read what the sidebar would render, or `await window.api.unhideProject(path)` to do what a click
would do. Give the renderer a second after launch; a query fired too early answers about an empty page.

## `drive-app.js` talks to the FIRST page — unless you name one

Every command attaches to the first target CDP lists, which is normally `index.html`. Open a standalone
window — settings (always its own window since #365), a changes window, a diff window (#287) — and it may go
to the front of that list, so the next `eval` runs in **that** window and a selector from the main UI
comes back empty. Nothing errors; you just get an answer about the wrong page.

`--target=<substring>` settles it either way: it matches a page by title or URL, so
`--target=settings shot s.png` photographs the settings window whatever the list order is, and the
ordering stops mattering. Without the flag the behaviour is unchanged — first page wins.

**A DETACHED session window is the same file, so the obvious targets stop being unique.** It loads
`index.html?win=detached&detached=<id>`, which means `--target=index.html` matches it as readily as the
main window — and so does `--target=Switchboard`, because the repo path itself contains the word. Detach
one session and every reading taken that way is about whichever page CDP happens to list first, silently.
The one substring that is always unique to a detached window is its session id; the main window has no
unique substring at all, so address it by **closing the children** and dropping the flag, or by picking
the page whose URL carries no query:

```
curl -s http://127.0.0.1:9222/json/list        # the detached ones carry ?win=detached
curl -s http://127.0.0.1:9222/json/close/<id>  # close a child, main is addressable again
```

Cheap guard on any reading that matters: have the page say which one it is — `!location.search` is true
only in the main window.

```
node scripts/drive-app.js --target=settings shot settings.png   # the pop-out settings window
node scripts/drive-app.js --target=changes eval "…"             # the changes window
```

That cuts both ways, and the second way is useful: to drive a standalone window, open it and then talk to
it directly. To get back to `index.html`, close the child.

```
curl -s http://127.0.0.1:9222/json/list            # ids + titles, first entry = what drive-app hits
curl -s http://127.0.0.1:9222/json/close/<id>      # close a child window, main page is first again
```

A worked example — the whole #287 verification was driven this way: open the changes window from the main
page (`window.api.openChangesWindow(cwd, label)`), then `eval` in the changes window itself to click a file
row and read back the diff pane, then click *Open in window* and `eval` in the diff window to assert the
CodeMirror merge view rendered. Three pages, one port, no clicking.

## `window.close()` is NOT closing the window

`drive-app.js eval "window.close()"` makes the main window disappear — and `BrowserWindow`'s `close`
event never fires. Everything hanging off it is skipped: the running-sessions guard, the settings
window teardown, `detach.closeAll()`, the final bounds write. What is left behind looks exactly like a
broken teardown — the main window gone, its detached windows still standing, the app alive with no way
back to them — and reading it that way cost most of an afternoon in #371.

To close it the way a user does, send `WM_CLOSE` to the window itself
(`.claude/scratchpad/close-main-window.ps1` in this checkout, if it is still there — the tree is
gitignored). Two things it has to get right, and both matter:

- **Enumerate top-level windows**, not `Process.MainWindowTitle`. Every Electron window belongs to one
  process, and that property names exactly one of them, arbitrarily.
- **Filter by process.** Two windows can be titled `Switchboard` — the demo instance and the user's
  *installed* app. The installed build runs as `Switchboard.exe`, a dev run as `electron.exe` from the
  checkout, so the command line tells them apart. Closing the wrong one throws away someone's work.

Expect the close to be **held**, not performed, while a session is running: that is the quit guard, the
answer comes from the renderer, and `window.api.confirmCloseResult(true)` is what a click on "Close and
stop them" sends.

## A renderer reload does NOT reload `src/app/**`

`location.reload()` (and `drive-app.js eval "location.reload()"`) re-parses the renderer only. Every
main-process module — `src/main.js`, `src/app/**`, `src/watch/**`, `src/session/**` — is still the code
that was on disk when Electron started. So a main-process fix "does not work" until the app is
restarted, and the reading you take in between is about the old build.

This cost real time in #2: the exit banner and the no-respawn fix both read as broken through two
rounds of live checks that were, in fact, exercising the previous main process. Restart with
`npm run stop:dev && node scripts/demo-start.js --debug` and take the reading again.

## `--target` matches the title AND the URL — which is ambiguous here

The needle is tested against `"<title> <url>"`, and every window of this app has `switchboard` in its
path. With a detached session window open (#2), `--target=Switchboard` matches **both** windows and
the first one in the CDP list wins — so an `eval` meant for the main window silently ran in the
detached one, and every answer it gave was true, about the wrong window.

Pick a needle that only one of them can match:

```
node scripts/drive-app.js "--target=Switchboard file" eval "…"   # the MAIN window (title + a URL word)
node scripts/drive-app.js --target=win=detached eval "…"         # a detached window (its query string)
```

`win=detached` is the marker every window of its own carries, and the only one that matches all of them:
`detached=<sessionId>` is in the URL only when the window was opened ON a session, so a view window
(#370) and a restored one that has not been filled yet have no such pair to match — measured with all
three open at once, `?win=detached&view=stats` against `?win=detached&detached=<id>` against a bare
`index.html`. It is written `--target=win=detached` — the flag splits on its FIRST `=`, so the needle
keeps the second. With more than one detached window open it matches all of them and the first in the
CDP list wins, which is the same ambiguity one paragraph up: add `view=<kind>` or the session id when
you mean a particular one.

The main-window needle survives that, and for a reason worth knowing: a detached window renames itself
(its session's name, its view's name), so `Switchboard` alone stops matching it once it has loaded.
**Once it has loaded** is the caveat — a window that has just been opened still carries the frame's
`Switchboard`, so give a fresh one its moment before addressing the main window by title.

When in doubt, ask the page who it is: `window.isDetachedWindow()` answers from the URL and never
changes, and `window.__detachedSessionId` is the session that window currently treats as its own —
since #325 the **active** one, not the one it was opened with. Neither tells you the whole set, and
`--target=win=detached` matches every detached window. For what is where, ask main:
`await window.api.listSessionWindows(sessionId)` returns one entry per window
(`{id, title, isMain, sessionIds, current}`), with `current` on the one holding that session.
`sessionIds` is `null` for the main window — it renders everything the detach map does not claim, so
the answer is not knowable from main (#327). An empty array would read as "holds nothing".

## A drag has to be a real drag

`drag` exists because dispatching `DragEvent`s from `eval` proves nothing. A synthesised event carries
a `DataTransfer` only the script can see, never enters the drag controller, and reaches whichever
listener the script picked — so it happily "passes" against handlers a real mouse never gets to. That
is how #309 shipped a tab drag that answered every scripted check and did nothing under a mouse: the
terminal container's own drop handler took the event first, which only a genuine drag reveals.

`drag` presses, moves until Chromium starts a native drag, and replays the intercepted payload as
dragEnter/dragOver/drop over the target — every listener sees exactly what the mouse would produce.
The zone picks the point inside the target, which is what a split-on-drop UI keys off:

```
node scripts/drive-app.js drag ".pane .session-tab" ".pane[data-pane-id='pane-2'] .pane-body" right
```

It reports the payload's MIME types, so "the drop did nothing" and "the drop carried the wrong data"
stay distinguishable.

## A key press has to be a real key press — and it answers TWO questions at once

Same reason as the drag. `el.dispatchEvent(new KeyboardEvent(...))` reaches whatever listener the
script picked; it does not go through the browser's key pipeline, so xterm's
`attachCustomKeyEventHandler` and the PTY behind it are never exercised. CDP's
**`Input.dispatchKeyEvent`** is the real thing: focus the terminal's `.xterm-helper-textarea`, dispatch
`rawKeyDown` + `keyUp`, and both halves become observable.

Both halves is the point. For any terminal key, ask who got it:

```js
// before: watch what leaves for the PTY, and where the viewport stands
const spy = entry.terminal.onData(d => sent.push(d));
const before = entry.terminal.buffer.active.viewportY;
```

- bytes in `onData` and an unmoved `viewportY` → the **application** got the key
- nothing in `onData` and a moved `viewportY` → **xterm** consumed it

That distinction is what #410 got wrong twice in opposite directions. Two more things it taught:

- **`window.api` is frozen** (contextBridge), so `window.api.sendInput = spy` fails silently and your
  recorder records nothing. Hook `terminal.onData` instead.
- **A full-screen TUI runs on the ALTERNATE screen**, where `baseY` is 0 and there is no scrollback at
  all — `scrollPages()` there cannot move anything, however correct the call looks. Read
  `buffer.active.type` before concluding anything about scrolling, and read it *after* the CLI has
  finished starting: the buffer switches from `normal` to `alternate` partway through, and a
  measurement taken too early describes the startup screen.

**Timers are throttled in a background window.** A `setInterval` sampler at 20 ms fires about once a
second while the window is not in front, so a sampling loop reports two data points and looks like
"nothing changed". Drive the code path directly, or bring the page to front, rather than believing the
gaps.

**And a window that is not VISIBLE starves `requestAnimationFrame` outright — it is not throttled, it
never fires.** Neither do `ResizeObserver` callbacks (not even the initial one on `observe()`), `scroll`
events, or `matchMedia` `change` events. `Page.bringToFront` does not fix it; the window has to genuinely
be on screen, which on Windows means asking the user to bring it up. What this looks like from the
outside is a code path that does nothing: a function whose whole body sits inside a frame callback
returns, and nothing happens, forever. `refitActiveTerminal` in `views/file-panel.js` is one, and
believing its silence cost two rounds in #459.

Check before trusting any deferred measurement, and read `visibilityState` rather than `hasFocus()` — an
`eval` never takes focus, so `hasFocus()` is false even on a window in front:

```
node scripts/drive-app.js eval "window.__raf=0; requestAnimationFrame(()=>{window.__raf=1}); document.visibilityState"
node scripts/drive-app.js eval "window.__raf"    # 0 after a second → nothing deferred will run
```

Layout still measures correctly there: `clientWidth`, `getBoundingClientRect` and a synchronous
`safeFit` all answer honestly on a hidden window. It is only the deferred and the observed that stop.

## Opening several terminal tabs to verify (WebGL, shared atlas)

To reproduce more than one live terminal at once — needed to see the tabs-mode shared-atlas behaviour
(#262) — open sessions with the **renderer** function `openSession(session, undefined, {show:true})`
(a top-level fn in `app.js`, reachable from `eval`), NOT `window.api.openTerminal(...)`. The latter is
the low-level PTY spawn in main and creates neither a tab nor an `openSessions` entry, so a second
call just replaces the first and `dims` still reports one open terminal. Session objects come from
`await window.api.getProjects(false)`. Tabs exist when `getSetting('global').sessionDisplayMode`
is `'panes'` (a stored `'tabs'` resolves to it — #357). With two tabs open, `dims <id>` on each confirms both hold a live WebGL
context (`webglAddon: true`) — the shared-atlas state to test against.

**Tabs mode is the only place several terminals hold a context at once.** Panes drops every terminal to
DOM from two panes up, grid keeps WebGL on the focused card alone — both because two *visible* WebGL
terminals corrupt each other's glyphs with no reveal repaint to heal it (#320, #140).

**And a burst of output through two terminals does not reproduce that corruption** — #320 measured
exactly that, saw nothing, and drew the wrong conclusion. What reproduces it is two terminals rendering
**alternately over minutes**, each with its own glyph set. If you are testing an atlas question, drive
it that way and give it time; a flood proves the opposite of what it looks like it proves.

## A dev run you stopped may not be stopped (#220)

Killing the `npm run start:debug` wrapper leaves its Electron processes alive, and they keep port
9222 — so the next `drive-app.js` attaches to the **old** process and reports on code that is no
longer on disk. That is a verification that reads as a pass and is worth nothing.

Two things now stop it: every build takes the single-instance lock (dev included — #216 gave dev its
own `userData`, and Electron scopes the lock to `userData`), and `start:debug` refuses to launch when
9222 is already bound (`scripts/check-debug-port.js`).

**A refusal only helps if you read it.** The guard exits non-zero and explains itself — and then the
old process is still answering on 9222, so `drive-app.js` connects, the console is clean and every
query returns something sensible. The reading looks exactly like a successful one. There is no symptom
to notice, because the symptom is that nothing changed.

So the check after launching is the **exit code**, not whether CDP answers:

```
node scripts/demo-start.js --debug   # non-zero here means you are about to test the old build
npm run stop:dev                     # …then this, and launch again
```

Backgrounding the launcher makes this easy to miss — the exit arrives as a notification long after the
queries have already run. If a fix "does not work", check this before checking the fix. It cost a full
round of live verification in the #455/#457 session, and the same trap in reverse is the one #220 was
filed for.

To run two dev builds deliberately: `SWITCHBOARD_ALLOW_MULTIPLE_INSTANCES=1`, or better, the two-var
isolation in `docs/ai/running-and-data.md`. When stopping a leftover run, filter on
`node_modules\electron\dist` and stop **only** those PIDs — a blanket kill of `electron.exe` takes
the user's installed app with it (`npm run stop:dev` does exactly that filtering).

## Prefer the demo instance

`npm run demo:start` is the default for dev/verify work: fully isolated stores, consistent test
projects and sessions every run. Plain `npm start` scans the **real** `~/.claude` store and is the
exception, for when you deliberately want live data.

## Launching a REAL CLI session from a driven app (#243)

`window.api.openTerminal(id, projectPath, true, {backendId})` spawns a genuine CLI. Three things make
a driven session look like "the CLI wrote no transcript", and all three are the harness, not the app:

1. **The session id must be a UUID.** Claude's launch carries `--session-id <id>`, and a non-UUID id
   kills the CLI on the spot with `Error: Invalid session ID. Must be a valid UUID.` — the PTY stays
   open, our MCP server is up, the row looks alive, and nothing is ever written. The renderer always
   mints `crypto.randomUUID()`; a hand-made id like `test-123` does not. This one has burned two
   verification passes.
2. **The CLI needs far longer than the app does.** `[mcp] … CLI connected` / `CLI initialized` in the
   log is the first moment input can land — measured at ~45 s on this machine, sometimes longer.
   Input sent before that goes nowhere. Wait for that line, do not sleep a fixed amount.
3. **`sendInput` does not submit.** Text arrives in the composer, but Enter written this way is
   absorbed as a literal newline (Claude uses the kitty keyboard protocol). The app's own submit path
   (`src/watch/trigger-watcher.js` `submitToPty`) writes the text, waits ~50 ms and then writes `\r`
   as a **separate** PTY write for exactly this reason. Driving a turn from `drive-app.js` needs the
   same shape — and a driven session that never submitted has no user message, so the CLI correctly
   writes no transcript at all.

4. **A COLD home starts far slower than a warm one, and the two are indistinguishable while you wait.**
   A demo instance hands the CLI an empty home, so the first session there also downloads its model
   caches and runs its plugin discovery before anything is drawn. Measured for Hermes: about **three
   and a half minutes**, against the ten to fifteen seconds its own startup hint promises — and the
   hint is what the terminal shows meanwhile. Two checks taken at 25 s and 150 s read as "the CLI
   writes nothing", which then reads as an app that loses bytes; both were wrong, and proving it cost
   an evening (#427).

To see what a driven session is actually showing, attach to the data stream instead of guessing:
`window.api.onTerminalData((id, data) => …)`, strip the escapes, print the tail. That is how the three
above were told apart — the composer still held the un-submitted prompt.

**Poll from OUTSIDE the page, or not at all.** The throttling above turns an in-page sampling loop into
a liar in exactly this situation: a five-second poll written into one `eval` actually sampled at 5, 11,
17 … then 41, 73, 133, 193 seconds, and the paint happened inside a gap. The reading it produced was
"still nothing" for a session that had already come up. One `drive-app.js` call per sample costs a
round trip and cannot lie about when it looked.

For a live session in the **demo** instance, run `npm run demo:auth` first: an isolated home has no
credentials and has never onboarded (see `docs/demo-env.md`).

## Driving a full-UI Axis-B session to test live-id adoption (agy/Codex/Pi)

To reproduce identity adoption and busy/idle for a backend that names its own session (the
`matchLiveSession`/`liveState` path), you need a session with a **real xterm attached**, not a bare
PTY. `window.api.openTerminal(id, path, true, {backendId})` spawns the PTY but creates no tab and no
xterm — a TUI (agy is a bubbletea TUI) never initialises and silently swallows every keystroke, so no
prompt lands and the store `.db` is never written. Drive the **renderer** launcher instead:

```
node scripts/drive-app.js eval "(async()=>{const ps=await window.api.getProjects(false); \
  const proj=ps.find(p=>String(p.projectPath).includes('<name>'))||ps[0]; \
  return await launchNewSession({projectPath:proj.projectPath},{backendId:'agy'});})()"
```

`launchNewSession(project, {backendId}, seedText)` (a top-level fn in `app.js`) is what the `+`
new-session button calls: it mints the uuid, builds the pending row, creates the terminal entry and
`syncPtySize`s it — so the TUI renders and accepts input. It returns the **launch** id (the id the app
spawned under, before the backend names its own).

Then submit a prompt the same way `trigger-watcher.js` `submitToPty` does — text, a pause, then `\r`
as a **separate** PTY write (one write with a trailing `\r` is absorbed as a literal newline):

```
node scripts/drive-app.js eval "(async()=>{const id='<launchId>'; \
  window.api.sendInput(id,'<prompt>'); await new Promise(r=>setTimeout(r,120)); \
  window.api.sendInput(id,'\r'); return 'sent';})()"
```

What to watch, and the gotchas that cost time here:

- **The `.db` appears only on the first prompt**, not at launch (agy behaves like `agy --print`). Until
  it exists, `matchLiveSession` has nothing to correlate, so adoption cannot fire — wait for the turn.
- **Adoption is visible in the main log:** `[<backend>] session <launchId> → <realId> (adopting the
  backend's own session id)` then `[<backend>] session=<realId> → BUSY|IDLE`. If the busy edge names
  the **launch** id after that adopting line, the edge is being addressed to a re-keyed-away card
  (the bug class in `adopt.js`).
- **agy cannot run in the demo instance.** It has no store env var (`cliHomeEnv()` → null), so a
  demo-launched agy writes to the real `~/.gemini/antigravity-cli` while the app scans the empty demo
  agy store — adoption never reproduces. Use `npm start` / `npm run start:debug` (real stores) for
  agy. Codex and Pi **can** be isolated, so `demo:start` reproduces them. The same applies to
  **anything else read out of agy's home**: its resource list comes back empty in the demo and full
  against the real stores, so a reading taken there describes the sandbox — `docs/demo-env.md`
  ("Known gaps") has the derivation.
- **Paths through `drive-app.js eval` lose their backslashes** (`D:\Projekte\x` → `D:Projektex`). Never
  hand-build a Windows `projectPath` in the eval string — read the real object from
  `await window.api.getProjects(false)` and pass `proj.projectPath`.
- **A live-but-idle Axis-B session still reads "Running", not "Idle"**, in the sidebar: `cli-busy-state
  false` only drops the `status-busy` ("Working") state, and `session-status.js` then falls through to
  `status-running` while the PTY is alive (same model as Claude). "Idle" needs the PTY gone. Don't read
  a green "Running" on a live session as a stuck indicator by itself — check the log edge.
