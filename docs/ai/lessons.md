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

## Verification that verified nothing (#309, panes mode)

Six defects shipped in one pass, every one of them past a green suite **and** past scripted checks
that looked like a click. What they cost, and what actually caught them:

- **A synthesised `DragEvent` proves nothing.** Dispatching dragstart/dragover/drop from
  `drive-app.js eval` moved tabs between panes perfectly. Under a real mouse nothing happened: the
  terminal container's own drop handler took the event first and pasted the payload into the shell.
  A scripted event carries a `DataTransfer` nobody else can see, skips the drag controller, and lands
  on the listener the script chose. → `drive-app.js drag` drives a **real** drag through CDP's drag
  interception.
- **Boot order beat the feature.** The display mode is applied before the launch restore mounts a
  single session, so pruning the stored layout against `openSessions` — which is empty at that moment —
  threw the whole split away and rewrote it flat. It looked fine in every session where the app was
  already running. Only a restart shows it, and the flattened result reads as "nothing broke".
- **`dispose()` is not "gone".** xterm's WebGL addon leaves its canvases in the DOM; the DOM renderer
  then draws its rows *underneath* an opaque dead layer, and every suspend/restore cycle stacks
  another pair. The grid had suspended terminals for months without noticing — it only ever suspends
  cards that are off-screen anyway.
- **rAF does not run in a window you are not looking at.** A render scheduled with
  `requestAnimationFrame` never fired while the app sat behind the terminal, leaving a mounted
  terminal outside every pane. A microtask always runs; frame callbacks are for painting, not for
  state.
- Two more of the same family: a flex fraction that only a branch's *children* carried (so a
  single-pane tree shrank to the width of its own strip), and a teardown that cleared `.visible` on
  every container while the mode being switched into does not re-establish it.

The suite was green for all six, at 1835 tests. The pane-tree model behind them has 38 tests and is
correct — the model was never the risk.

**#2 (detach) repeated the shape, twice more.** A review found seven defects after the feature was
called done and verified by hand:

- **Two more mount paths.** The "one session, one renderer" guard was put where sessions are opened
  (`openSession`) — but the grid's auto-open calls `attachRunningSession` directly, and the grid
  shortcut still worked *inside* a detached window. Both only fire after a display-mode switch, which
  is not where anyone looks for a detach bug. Either would have put a second xterm on a live PTY.
- **Shared origin, shared damage.** The pane tree was guarded against the detached window writing it;
  the open-sessions restore state was not, so closing that window replaced the main window's whole
  restorable set with one session — in a key deliberately kept across a crash, so the loss surfaces a
  launch later.
- **A renderer reload does not reload the main process.** Two of the fixes read as broken through two
  rounds of live checks that were exercising the previous main process. Any `src/app/**` change needs
  the app restarted before the reading means anything (`docs/ai/driving-the-app.md`).
- **`drive-app.js --target` matched both windows** — every window of this app has `switchboard` in its
  URL — so an `eval` aimed at the main window ran in the detached one and answered truthfully about
  the wrong page.

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

## A fix that reduces the symptom is not the fix

#140 investigated "grid card renders clean, turns corrupt a moment later" and got the mechanism right:
`loadTerminalWebgl` disposed and recreated the addon unconditionally, Chromium frees a GL context
asynchronously, the burst overshot the context budget, the oldest context was killed, and xterm waits
3 s before falling back to DOM. The comment even named the fix — make the load idempotent.

What shipped instead was "WebGL only on the focused card". That takes the context count to one, so the
symptom cannot occur; the churn was left in place, and the closing comment justified the change with
*shared-atlas contention* — a different cause than the one that had just been established. Two things
followed:

- The policy was copied into panes mode, where it produced a **new** visible bug (#320): the two
  renderers do not agree on the cell box at dpr ≠ 1, so the unfocused pane drew heavier and a line off.
- The real defect stayed in the tree for eleven issues, load-bearing enough that every caller grew its
  own "only act on a difference" guard around it.

When the diagnosis and the fix do not name the same thing, say so in the issue. And when a later mode
inherits a workaround, re-measure before assuming the reason still applies — the measurement that
settled #320 took twenty minutes and needed no code change at all.

**And then #320 made the mirror-image mistake, which is the more useful half of this entry.** That
measurement — two WebGL terminals, ~18 000 distinct codepoints flooded through each, no corruption —
was used to conclude the atlas contention was gone, and every pane got a context. Daily use disproved
it within hours: glyphs went missing in the pane the user was not typing in. The bench test and the
real workload differ in the one dimension that matters here: a **flood through both at once** grows
the atlas once and then hits cache, while **two terminals rendering alternately over minutes**, each
with its own glyph set, is what makes one recycle the atlas under the other's feet.

Two things to take from it:

- **A measurement disproves the thing you measured, not the thing you believe.** "No corruption in
  20 minutes of synthetic load" is not "no corruption"; the honest write-up of that result names the
  workload it used, so the next reader can see what it did *not* cover. The #320 comment did say
  "~18 000 codepoints flooded through each" — that phrasing is what made the gap findable afterwards.
- **When you overturn a workaround, look for the workload it was written from.** #140 and #118 both
  came from real use over time, and neither was reproducible by a burst. A cheap test that contradicts
  an expensive bug report is evidence about the test.

The final rule is one live GL renderer whenever more than one terminal is on screen — in every mode.
The churn fix from #320 was right and stays; only the conclusion drawn from the bench was wrong.

## An invariant asserted from one measurement (#361)

A window snapped to maximized drew its terminal four rows off: the CLI's prompt box appeared above
its own transcript, and doing it a second time corrected it. Three explanations were proposed and
each was killed by the next measurement.

1. **"Panes mode never scrolls back to the bottom after a fit."** True as an observation —
   `refitVisible` calls `safeFit` while every other resize path calls `fitAndScroll` — and irrelevant
   as a cause. `scrollToBottom()` in the broken state moved nothing: it is a no-op on the alternate
   buffer, which is where a full-screen CLI lives.
2. **"The TUI needs a repaint nudge."** `terminal-redraw` in the broken state left the buffer byte
   for byte unchanged. The frame was already correct; only where it was addressed from was wrong.
3. **"On the alternate buffer `ybase` must be 0, so `ybase > 0` is the defect."** This one was worse
   than wrong, because it *fixed the reported bug*. It shipped, the snap symptom went away, and it
   quietly wrecked every freshly detached window — bottom rows blank until the next resize. A healthy
   terminal measured `rows 59, baseY 4, length 63`: a non-zero `baseY` on the alternate buffer is
   perfectly ordinary. The broken one measured `rows 75, baseY 4, length 75`. The difference is not
   `baseY`; it is `baseY + rows > length` — the screen addressing lines the buffer does not have.

The third is the entry. The first two were disproved cheaply because they predicted something that
could be checked in the broken state. The third predicted nothing: it explained the observation, the
repair built on it made the observation go away, and the suite went green — so nothing pointed at the
terminals it was corrupting. What found it was an **A/B run in the app**: the same gesture with the
repair compiled out. Repair off, the snap bug returned and the detach was clean; repair on, the
reverse. Two symptoms that exclude each other are one predicate that is too wide.

- **A rule derived from a single broken sample is a description of that sample.** Before treating a
  value as impossible, measure a HEALTHY one and check the rule still says so. Here that was one
  `eval` away and would have saved a shipped regression.
- **A fix that makes the symptom go away is not evidence the model is right.** It is evidence the
  repair overlaps the fault somewhere. The overlap can be much larger than the fault.
- **The self-check that worked was removing the fix, not adding to it.** When a repair runs on every
  fit, "does the bug come back without it, and is everything else still fine with it" is one run and
  answers both halves.
