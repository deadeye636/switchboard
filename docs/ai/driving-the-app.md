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
window — settings (`settingsOpenMode: 'window'`), a changes window, a diff window (#287) — and it may go
to the front of that list, so the next `eval` runs in **that** window and a selector from the main UI
comes back empty. Nothing errors; you just get an answer about the wrong page.

`--target=<substring>` settles it either way: it matches a page by title or URL, so
`--target=settings shot s.png` photographs the settings window whatever the list order is, and the
ordering stops mattering. Without the flag the behaviour is unchanged — first page wins.

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

## Opening several terminal tabs to verify (WebGL, shared atlas)

To reproduce more than one live terminal at once — needed to see the tabs-mode shared-atlas behaviour
(#262) — open sessions with the **renderer** function `openSession(session, undefined, {show:true})`
(a top-level fn in `app.js`, reachable from `eval`), NOT `window.api.openTerminal(...)`. The latter is
the low-level PTY spawn in main and creates neither a tab nor an `openSessions` entry, so a second
call just replaces the first and `dims` still reports one open terminal. Session objects come from
`await window.api.getProjects(false)`. Tabs only exist when `getSetting('global').sessionDisplayMode`
is `'tabs'` (otherwise grid, where only the focused card runs WebGL, #140). With two tabs open,
`dims <id>` on each confirms both hold a live WebGL context (`webglAddon: true`) — the shared-atlas
state to test against.

## A dev run you stopped may not be stopped (#220)

Killing the `npm run start:debug` wrapper leaves its Electron processes alive, and they keep port
9222 — so the next `drive-app.js` attaches to the **old** process and reports on code that is no
longer on disk. That is a verification that reads as a pass and is worth nothing.

Two things now stop it: every build takes the single-instance lock (dev included — #216 gave dev its
own `userData`, and Electron scopes the lock to `userData`), and `start:debug` refuses to launch when
9222 is already bound (`scripts/check-debug-port.js`).

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

To see what a driven session is actually showing, attach to the data stream instead of guessing:
`window.api.onTerminalData((id, data) => …)`, strip the escapes, print the tail. That is how the three
above were told apart — the composer still held the un-submitted prompt.

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
  agy. Codex and Pi **can** be isolated, so `demo:start` reproduces them.
- **Paths through `drive-app.js eval` lose their backslashes** (`D:\Projekte\x` → `D:Projektex`). Never
  hand-build a Windows `projectPath` in the eval string — read the real object from
  `await window.api.getProjects(false)` and pass `proj.projectPath`.
- **A live-but-idle Axis-B session still reads "Running", not "Idle"**, in the sidebar: `cli-busy-state
  false` only drops the `status-busy` ("Working") state, and `session-status.js` then falls through to
  `status-running` while the PTY is alive (same model as Claude). "Idle" needs the PTY gone. Don't read
  a green "Running" on a live session as a stuck indicator by itself — check the log edge.
