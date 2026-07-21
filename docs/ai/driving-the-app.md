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
```

No dependency (Node 22 ships a global `WebSocket`; CDP is JSON over one). `window.api.*` is reachable
from `eval`, so the app's own IPC can be exercised directly — e.g. `await window.api.getProjects(false)`
to read what the sidebar would render, or `await window.api.unhideProject(path)` to do what a click
would do. Give the renderer a second after launch; a query fired too early answers about an empty page.

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
