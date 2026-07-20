# Lessons — what actually went wrong, and what it cost

Not rules. The rules live in `CLAUDE.md` and `.claude/rules/`. This is the evidence behind them, kept
because "we tried it, here is what broke" is the part that stops an argument.

## A green suite is not a working app

| What shipped | What the suite said | What it took to see it |
|---|---|---|
| Codex sessions stuck permanently at "working" — a Claude-only OSC title heuristic ran on every backend | green | opening the app |
| Save with a backend's gear page open silently discarded **every** backend setting | green | one click on Save |
| #218: pulling tag lists out of `openSettingsViewer` left `settingsViewerBody` behind (IIFE-level const, not a global) — the whole Tags section died with a `ReferenceError` the instant the panel opened | **1488 passed** | `node scripts/drive-app.js console`, four seconds |
| #218: cutting the shortcut rebinding out left `stopShortcutCapture` behind — `persistSettings` *and* the Cancel button both call it, so **Save threw for every setting and Cancel threw too** | **1488 passed** | pressing Save. Opening the panel found nothing. |

Both #218 cases have the same shape: the moved block *defined* a name something *outside* it still
called. Hence the rule — after a cut, grep the moved file for every name it declares, and expect more
than one caller.

## Documentation that lied

- The CLAUDE.md claimed the renderer contained no backend-id branches **for eleven issues** while
  #212 counted 23 `|| 'claude'` fallbacks plus id branches. A prose claim in a doc is not a guard;
  `test/backend-integrations.test.js` is.
- #218 shipped a header defect in six of sixteen passes, four of them false claims: an undercounted
  caller, a stale tag count, "eleven" panes that were twelve, "byte-identical" off by one byte, a
  free-globals register naming three of six, functions attributed to the wrong file. Every one was
  caught by a reading verifier; none by the suite.
- #162 "removed the fallbacks" and left 23 standing. #225 then found sixteen sites across eight files
  each patching the same unreliable `window._defaultBackendId` instead of fixing it once.

## Things that were fixed more than once

- The same backend defect got fixed in **one** backend four separate times while its siblings quietly
  kept it. → `test/backend-parity.test.js`.
- Four separate modules composed a path under Claude's home from `os.homedir()` (the MCP bridge's lock
  files, the attention hook's `settings.json`, the Projects admin's `.claude.json` reader **and
  writer**, and the scheduler — which ticked every 60 s on every boot and pre-seeded session files,
  removed since in #246), all inside an instance that promises it touches nothing real. →
  `test/store-isolation.test.js` (#241).
- #193 shipped lineage for Claude+Hermes only and had to be redone as a descriptor hook (#223). That
  is why the neutral seam gets built first, always.

## Things that were invisible because nothing pointed at them

- `scripts/db-migrate-probe.js` sat **broken from #193 to #224**. Every migration swallows its own
  throw, so "it ran" is not "it did something", and that probe was the only thing that could tell the
  two apart.
- #120 was invisible because its diagnostic landed at `debug`, which the packaged default hides.
- 0.7.5's first installer shipped without `backends/` and died on its first `require`. The repo ran,
  `npm start` ran, the suite was green — only the *installer* was missing anything. `build.files` is
  an allow-list and `*.js` in it matches the top level only.
- 0.7.6 got a **second** release on the same tag from a stray `gh release create`, carrying no
  `latest*.yml` — so auto-update from it silently could not work, and the releases page showed the
  wrong one.

## Isolation that wasn't

- `SWITCHBOARD_DATA_DIR` alone moves the DB but not `userData`, so a "sandbox" landed on the dev
  instance's `userData` and the two fought over one Chromium cache (#216), then got refused outright
  by the single-instance lock (#220).
- Killing the `npm run start:debug` wrapper leaves Electron alive holding port 9222, so the next
  `drive-app.js` verifies **the old build** and reports a pass (#220).
- A dev enable/quit of the attention hook stripped the **installed** app's live hook, because the
  sentinel carries no instance marker (#219).

## Keyboard handling that guessed at the platform

Both from #207's variable palette, both introduced by a *fix* for an earlier review finding, both
invisible to the suite — the palette's key handling has no automated coverage at all.

- **AltGr IS Ctrl+Alt.** To stop a session switch leaving the palette aimed at the old terminal, one
  pass closed it on any `ctrlKey || metaKey || altKey` chord. On a German (or any European) layout
  that is how `@ \ [ ] { } ~ €` are typed — every one of them would have closed the palette and eaten
  the character. Nobody on a US layout would ever see it. A modifier combination is not a reliable
  "this is a command, not text" signal.
- **A modifier's own keydown already reports its flag.** Pressing Ctrl fires a keydown with
  `key === 'Control'` **and** `ctrlKey === true`. So a check of the shape "has a modifier and is not
  in my whitelist" fires on the bare modifier press, before any letter arrives — a Ctrl tap alone
  killed the palette, and the whitelist behind it was dead code that never ran.

The fix for both was to stop inferring intent from keys: claim only the four keys the widget owns, let
everything else through, and handle the session case where it actually happens (`setActiveSession`).
When a widget must react to something the app does, hook the app's own choke point rather than trying
to recognise the keystroke that led there.
