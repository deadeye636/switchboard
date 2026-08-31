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
- Resource discovery, added for five backends in one evening, read the user's **real** `~/.codex` and
  `~/.agents/skills` from an isolated instance — and the resource list is clickable, so those real
  files opened in the user's editor. Hermes, written the same evening, did it right; the pattern was
  there to copy.

## A guard that lists its targets reports success about code it never opened

Three defects in one session shared one shape, and it is worth naming on its own because each guard
looked reasonable in review:

- **A blanket assertion over all backends.** `for (const b of BACKENDS) assert.equal(b.pageKeyTarget,
  'pty')` passes exactly when every backend was moved together — which was the bug. The fix is one
  pinned entry per backend, so moving one fails by name (`PAGE_KEY_TARGETS`).
- **A hand-written file list.** `store-isolation.test.js` checked six named files; the readers added
  later were invisible to it. The fix is to derive the targets and require a stated reason to opt out.
- **A source regex where behaviour was meant.** The first page-key test matched `scrollPages()` in the
  source, so it proved the key was swallowed — the defect — and the second one only proved the wiring
  existed. Neither pressed the key.

The question to ask of a new guard: *what would still pass if the thing I am guarding against happened
to a part I did not list?* If the answer is "all of it", the guard is a list, not a guard.

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

### The backend that already worked was overwritten (#410)

The requirement itself said Claude already paged its visible history with bare PageUp/PageDown. The
implementation intercepted those keys before xterm could send them to the PTY and called
`terminal.scrollPages()` for every backend. That made the requested shortcut appear consistent while
removing Claude's own history and overlay navigation — the known-good path was treated as an
implementation detail to replace rather than as the regression control.

The test encoded the replacement, not the requirement: it source-matched `scrollPages()` and `return
false`. It therefore proved that the key was swallowed, which was the defect. The verification opened
the app and checked the console, but never pressed the key in the backend explicitly named as already
working.

What would have prevented it:

- Write the current/desired behaviour matrix before touching a shared input handler. "Claude works;
  the others differ" is evidence of backend-owned semantics, not permission to erase Claude's answer.
- Treat bare terminal keys as PTY input by default. A full-screen TUI may use them in its transcript,
  overlays or configurable keymap even when xterm scrollback also exists.
- Put differences on the backend descriptor and make unknown values fall through to the PTY. Shared
  renderer code dispatches the declaration; it never guesses from a backend id.
- Test the negative half: a PTY-owned key causes no `preventDefault`, no `scrollPages()` and still reaches
  the application. A regex proving that an interception branch exists is not a behavioural test.
- Live-check the previously working backend, not only the backend that motivated the change. The old
  success path is the cheapest and strongest regression fixture available.

**And then it happened a second time, in the opposite direction.** The correction gave the keys back to
the PTY for *every* backend — restoring Claude, but leaving Pi and Codex, the two the request was
actually about, with a key that does nothing: measured, both ignore `ESC[5~` at their prompt. The
declarations had been filled in from each CLI's keymap documentation rather than by pressing the key.
So the same defect shipped twice, from opposite ends, and both rounds had a green test that asserted the
*shared branch* instead of each backend's outcome.

Two things came out of it, and they are the actual prevention:

- **A per-backend capability is pinned per backend** (`PAGE_KEY_TARGETS` in
  `test/terminal-page-scroll.test.js`). A blanket assertion over all backends is the bug written as a
  test: it passes exactly when everything was moved together. One entry per backend means moving one
  fails by name, and the person doing it has to say so.
- **Measure, do not read.** Every wrong entry came from documentation; every right one came from a live
  session. A backend nobody measured stays on the value it already had — out of scope is not a default.

The same round shipped a cursor "fix" that bracketed every PTY chunk with a hide/show sequence. A chunk
may end mid-sequence, so it tore escape sequences in half and the whole screen rendered as garbage —
found by the user on an installed build, not by the suite. **Never inject bytes into a stream that
arrives in arbitrary chunks.**

## `onData` is not the user (#384)

The away recap was a banner, and the plan said *auto-dismiss on next user input to that terminal*. The
code did exactly that:

```js
entry.terminal.onData(() => dismissAwaySummary(sessionId));
```

`onData` is xterm's **bytes bound for the PTY** — the user's keystrokes, but also everything the
terminal answers on its own. Revealing a session necessarily moves focus, so with focus reporting on
(DECSET 1004) the terminal replied `ESC [ O` and the banner tore itself down in the same beat it was
rendered. Measured in a running instance: one focus switch, nothing typed, one payload.

The repair was a whole-string filter (`isUserInput`) against the shapes a terminal sends unprompted —
focus in/out, cursor-position and device-status replies, device attributes, mouse in X10 and SGR —
while a bare `ESC`, the arrows in either mode and a bracketed paste stayed input, because those are the
user acting. It went away with the banner in #402, and the lesson is not the regex: **a stream named
after the user carries the terminal's own traffic too.**

## Driving the producer answers a different question (#426)

The banner deleted in #402 held one thing that was not about banners: the throttled `keydown` /
`pointerdown` / `wheel` / `focus` listeners that call `reportPresenceActivity()`. Nothing took them
over. So `lastActivityAt` in `app/presence.js` never left null, `absenceEnded` always answered null,
and **no absence was ever detected** — the whole away recap was correct and unreachable from ordinary
use for as long as that stood.

What made it invisible is worth more than the fix: every check of the recap, across two issues, had
called `reportPresenceActivity()` itself. Driving the producer is the natural way to test a consumer,
and it answers a different question than the one being asked — *does the app produce this* was never
put to the app. The measurement that settled it was two real key presses through
`Input.dispatchKeyEvent`, 85 s apart, with the harness touching nothing else.

Two things follow, and both generalise past this feature:

- **Deleting a surface deletes whatever was hosted in it.** Grep the removed file for every name it
  exports *and* for every listener it registered — the #218 rule applied to a deletion.
- **A source-regex guard would have passed** against a file that registers a listener and sends
  nothing. `test/presence-reporting.test.js` runs the real file in a jsdom window and dispatches real
  events at it, so dropping the block fails an assertion and deleting the file fails the load.

## "Not yet" and "never" look identical, and the difference was three minutes (#427)

A Hermes session launched in the demo instance showed nothing. Checked at 25 s, checked again at 150 s:
no bytes at all. From there the reasoning ran downhill fast and every step was defensible — the home
must be broken, so `hermes doctor` was asked (it reported the home healthy); then the CLI must be
starved of something, so it was spawned from a bare node-pty with the same home, the same cwd, the same
env overlay, the same bundled `conpty.dll` and the same early resize (it painted every time, in about
75 s). Conclusion: the CLI is fine, the app loses the bytes, this is a Switchboard bug — written into
the issue as a finding, with a table.

It was none of that. The session comes up in **about three and a half minutes** in a cold home, and
every probe that "exonerated the CLI" had simply run against a warm one. What the app shows meanwhile
is its own startup hint promising ten to fifteen seconds, which is true of a warm home and off by an
order of magnitude for a fresh one.

Three things to take from it:

- **A negative measurement needs a stated deadline.** "Nothing after 150 s" is a fact; "nothing will
  come" is a claim, and only a wait long enough to have been wrong supports it.
- **The throttling trap has a second half.** A five-second poll written into one in-page `eval`
  actually sampled at 5, 11, 17 … 41, 73, 133, 193 seconds — the paint landed in a gap, so the harness
  confirmed the wrong answer. `docs/ai/driving-the-app.md` now says to poll from outside the page.
- **A ruled-out cause is only ruled out for the conditions it was tested under.** Each probe was
  honest and each was answering "does the CLI work in a *warm* home", which nobody had asked.

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

## A requirement declined on a premise nobody checked (#281)

The ask was "edit the rendered Markdown, like Obsidian". It was read as WYSIWYG and declined on cost:
a second document model, a serialiser back to source, round-trip loss, a fork to maintain. Every one
of those costs is real — **for WYSIWYG**. Obsidian's Live Preview is not WYSIWYG. It is CodeMirror
editing the Markdown source with decorations that hide the markers and style the content, so none of
those costs apply.

The reasoning was sound and aimed at the wrong object. What would have caught it in a minute: the
requirement named a product, and the product's mechanism was one search away.

The same issue carried a second unchecked premise, this one written into the issue body as a
decision: colour and alignment buttons were kept out because they "would widen the sanitiser's
surface (#49)". Measured afterwards, DOMPurify's default allowlist already passes `<u>`, `<mark>`,
`<span style>` and `<div align>` — a hand-typed tag renders in the preview today. The decision had
been standing for weeks on something a five-line script disproved.

- **When a request names a product, look at how that product does it before pricing the work.** The
  price of the wrong architecture is not the price of the request.
- **A design decision that rests on a factual claim needs the claim measured, once, in writing.** Both
  claims here were plausible, both were repeated in an issue body, and both were wrong.
- A concern raised and then reaffirmed by the owner is a decision, not a debate. The correction cost
  here was one message; carrying the wrong premise further would have cost the feature.

## A test that greps for a sentence proves the sentence exists (#447)

The Agent Files tab gained a type filter. Filtering to nothing was supposed to say "Nothing matches
the current filter." — and the test asserted exactly that, by checking the string was present in the
source. Green. The branch was unreachable: the empty check asked whether the RAW data was empty, so
narrowing a non-empty list to zero fell straight past it, rendered no group, and left the panel
**blank**. Every path that could reach the message was a path where the message was not needed.

A reviewer found it by reading; the repro is four seconds in the app (search Agent Files for a string
that matches nothing). Six source-string assertions in that file, and not one of them could have.

The fix was not a better assertion. The decisions moved out of the view into
`src/renderer/views/agent-file-filter.js` — pure functions, `require`-able — so a test can hand them
data and check the answer. `agentFileSections(data, filters)` returns `shown`, counted from what
survived, and the test asserts `shown === 0` *and* the message for that case. Same shape as
`src/backends/capabilities.js` and `backend-capabilities.js` (#439): the renderer keeps the DOM, the
decisions go somewhere they can be called.

- **A source-regex test is a wiring guard, not a behaviour test.** It can say a name is referenced or
  a tag is registered. It cannot say a line runs. `.claude/rules/renderer.md` already says this about
  `renderer-no-undef`; it is just as true of anything hand-written that matches on source.
- **When the renderer needs a rule, put the rule where it can be called.** The UMD-module pattern
  costs one file and the three-file wiring; it buys tests that fail when the behaviour is wrong
  instead of when the wording changes. Both times it was done here it immediately paid: the same file
  later caught a crash on a malformed payload, and pinned when a badge is drawn.
- The rewrite is the tell. Two of the old assertions broke on the *next* edit — not because the
  behaviour changed, but because a comment moved. A test that breaks on rewording and holds through a
  defect is measuring the wrong thing.

## A single-element PowerShell array is not an array (#281)

An edit script did `$pairs = @( @('old','new') )`, then `foreach ($pair in $pairs) { $s.Replace($pair[0], $pair[1]) }`.
PowerShell **flattens** `@(@(a,b))` to `@(a,b)`, so the loop iterated the two strings, `$pair[0]` was
the first *character* of one — and the script ran `.Replace('f','u')` over an entire source file.
Every `function` became `uunction`. The same pattern with two or more pairs is fine, which is why it
had worked four times before.

`git checkout HEAD -- <file>` recovered it, at the cost of re-applying the uncommitted edits by hand.

- **Prefer the `Edit` tool over a scripted string replace.** It fails loudly on a miss and cannot
  touch anything it was not aimed at.
- If a script must do the replacing, force the shape: `@(,@('old','new'))`, or iterate an array of
  hashtables. Never index into a loop variable whose type you have not pinned.
- Commit before running a rewrite over a file you have uncommitted work in.

## An enumerated ctx is a place a reader can go missing (#449)

The plans list gained a project per row, read through `ctx.db.getPlanRefAttributions()`. The suite was
green, the probe against a real database answered with twelve attributions, and the app showed every
plan as unattributed.

`ctx.db` is not the database module. It is an object literal built in `main.js` naming exactly the
readers a module may use — so a reader added to `db.js` and used in `src/app/**` throws until it is
added there too. The `catch` around the call turned that throw into "no plan has a project", which is
indistinguishable from a machine whose sessions have all been cleaned up.

- **A catch around a dependency lookup must say something.** The one that swallowed this now logs, and
  the difference between "there is nothing to attribute" and "the reader is missing" is one line in the
  log instead of a silent shrug.
- The probe was not wrong and neither was the suite: both asked the database. Neither could ask the
  question the app asks, which is whether the module can *reach* the database. The click could.

## The neutrality guard catches what an id-hunt cannot (#450)

Pointing a project's CLIs at a plans directory needs to know which file to write. The first version put
`path.join(projectPath, '.claude', 'settings.local.json')` in `src/app/plans-memory.js` — no backend id
anywhere in it, and `test/backend-path-neutrality.test.js` failed anyway: a hardcoded store path is a
backend id the id-hunt cannot see.

The fix was the seam, not an allow-list entry: a backend declares `planDirSetup` and answers with the
file, its current contents and what they would become. Which config file a CLI reads is the CLI's
business, and the core is better off not knowing.

Worth remembering when the same shape appears again: the guard is not being pedantic about a string. A
`.claude` literal in the core is the point where a second backend's version of the feature becomes a
branch instead of an answer.

## A red test can be the specification working (#472)

Making the per-backend resource lists load lazily turned nine tests in `backend-resources-panel.test.js`
red at once. They mounted the panel and read the rows a microtask later — which only worked because
rendering fetched everything, the exact behaviour the issue existed to remove.

The reflex to reach for is not "what did I break". Ask what the test PINS: if it pins the old behaviour
and the change was the point, the test is the thing to update, and updating it is where the new contract
gets written down. Those nine now open the disclosure first — what a user does — and two more say what
is new: a closed section makes no call, opening it makes exactly one.

The failure mode this avoids is the opposite one, and it is worse: keeping the eager fetch so the suite
stays green, and shipping the issue's title without its content.

## The guard caught the literal the author had a reason for (#468)

`.claude/handoffs` went into the core's default list of handoff directories on purpose — it is where
Claude's own handoff skills write, the coverage was explicitly agreed with the owner, and leaving it out
would have lost real files. `test/backend-path-neutrality.test.js` failed on it anyway, together with the
two settings files that carried the same string.

Both facts were true: the directory had to be covered, and the core must not spell it. The seam that
resolves them is the one the rules already name — a `handoffDirs({ projectPath })` hook on the descriptor,
answered by Claude and by nobody else. Ten minutes, and the core knows nothing about `.claude`.

**A neutrality failure is not a request to weaken the list.** It is the question "whose knowledge is
this?", and the answer is nearly always a descriptor hook that did not exist yet.

## A rule established on one surface, and nowhere else (#444, #457)

#444 asked that no message shown to the user carry a raw filesystem error string. The fix held for the
listing it was filed against, the issue was closed with the acceptance box ticked, and the app went on
answering `EACCES: permission denied, open '<home>/…'` in a dialog on the very next screen — the Agent
Files tab, on the same class of file, one button along. The reading path had been sanitised and the
writing path had not.

An adversarial review found it. Nothing else could have: the four `catch (err) { return { ok: false,
error: err.message } }` blocks had no test over them at all, and a green suite says nothing about code
it never calls. The sweep afterwards ran through `main.js`, `projects/projects.js`, three usage probes,
two trust writers, the PTY spawn and the settings, variable and hook stores — every one written by
someone who had never heard of the rule, because the rule lived in one file's comments.

Then a second review found the sweep's own blind spots, which is the part worth remembering:

- **The guard only saw the shape the sweep already knew.** `error: err.message` has a field name in
  front of it and greps beautifully. `'Scan failed: ' + msg.error` does not, and that one was **live** —
  a scandir error under the user's home, painted into the status bar — while the guard reported success
  about the file it was in. The exemption written for that file even explained, wrongly, why its text
  could never reach a window.
- **A handler that does not catch is not safe from the rule; it is the worst case of it.** Roughly forty
  handlers had no `try` at all, and Electron serialises a thrown Error across `invoke` straight into the
  renderer's own `catch`. The sweep looked inside `catch` blocks, so those were invisible by construction.
  The fix is one wrapper around the registration rather than forty bodies — the version a later handler
  inherits without being told.
- **Counts written into prose go stale immediately, and this lesson said two different wrong ones.** The
  answer is the guard, which is why the rule now refuses to name a number at all.

Four things worth carrying:

- **A rule enforced by one fix is a coincidence.** The question after fixing a class of defect is not
  "is this file right now" but "what else is written this way" — and the answer is a grep, not a memory.
- **Then ask what the grep cannot see.** The first sweep was a grep, and it was still half the problem:
  it matched one syntax for one mechanism. Write down the mechanisms — returned, concatenated, thrown —
  before writing the pattern.
- **Scope the acceptance to the app, not to the diff.** "No message shown to the user contains a raw
  filesystem error string" was false the day it was ticked, and false again after the first sweep.
  Closing on the narrow reading leaves a checked box that is not true, which is worse than an open issue.
- **The guard has to be able to fail, and be shown failing.** `test/no-raw-fs-errors.test.js` derives its
  targets by walking `src/`, its exemptions carry reasons, an exemption that stops matching is reported
  as stale, and it runs its own patterns against every shape actually found in the wild plus the log
  calls that must NOT be flagged. A guard whose pattern has never been shown to catch anything is
  decoration — see the guard-shape lesson above.

And the thing that made it cheap to fix everywhere: the translation drops the message rather than
trimming it, so there is no per-site judgement about which part of a string is safe. Where the detail
matters it goes to the log. Dropping it in both places would have been the tempting version, and it
turns a support question into an unanswerable one.

## A measurement that cannot tell your code from the library's (#459)

The fix was one line of condition: clear a terminal selection when a re-wrap has moved the text under
it. Three live measurements were taken and reported as proof — a font-size change, a UI zoom, a sidebar
collapse, each one dropping the selection exactly as intended. All three were worthless.

xterm clears the selection itself on `rowsChanged`, and on nothing else. A font-size change moves the
column count and the row count together, so the library was clearing it before our line ever ran. The
control that was missing is the boring one: hold the rows constant and move only the width. That
measurement, taken afterwards, is the whole proof — 78 columns to 45, 53 rows to 53, a selection of 270
characters gone — next to its opposite, a raw `fitAddon.fit()` at the same shape leaving all 190
characters of it in place.

- **Before claiming a behaviour, ask what else could produce it.** Both the code under test and the
  library it sits on were plausible causes, and the measurement did not separate them. A proof that a
  fix works has to be a measurement the un-fixed version fails.
- **Read the library rather than inferring its behaviour from yours.** One grep of the bundled
  `xterm.js` for `onResize` answered it: `onResize(e => e.rowsChanged && this.clearSelection())`. That
  is now in the code comment beside the condition, because the next person to widen it to rows would be
  reintroducing something upstream already does.
- **Correct the record where the claim was made.** The issue comment had already been posted with the
  three worthless rows in it. Editing it to say so is cheaper than leaving a false proof behind for
  whoever reads the issue next.

The second half of the same issue cost two more rounds for an unrelated reason: **a window that is not
visible starves `requestAnimationFrame` entirely**, and the code path under test deferred to one. It
read exactly like a function that does nothing. `docs/ai/driving-the-app.md` carries the check.
## The same guard, four surfaces, and only the one asked about (#474, #476, #477)

#474 said containment was decided on the spelled path rather than the real one, and named three places:
the plan directories, the handoff directories, and the folder picked after a refused write. Those three
got the shared check, the acceptance box could be ticked, and an adversarial review found a **fourth**
implementation in `backend-resources.js` guarding read, write and delete of a backend's own files — with
a docstring making almost the identical argument, written by someone who had never heard of the new
module because it did not exist yet.

Two more surfaces followed, one issue each. That is the shape worth remembering: **an issue names the
surfaces its author happened to know.** The acceptance bullet even said "one implementation, used by
every caller that asks this question today" — and the honest way to satisfy that bullet is to go looking
for callers rather than to convert the ones the issue lists. `git grep` for the *shape* (`startsWith`
against a resolved root) found in minutes what three rounds of reading had not.

**And the reason given for leaving one out was wrong.** `vcs.js` was skipped on the argument that it
rejects symlinks outright and is therefore stricter. It is not: `lstat` inspects only the final component
of a path, and every directory above it was already followed by the OS. A junctioned subdirectory with an
ordinary file at the target passed the prefix check, passed the symlink check, and was read. A scope
decision defended by a technical claim is only as good as the claim — and this one was written into a
rules file, where it would have been trusted.

## A guard placed after the early return never sees the case it exists for (#476)

The first fix for the diff readers asked about containment *after* `lstat`. That looked right and closed
the case it was tested against. But `readWorkingFile` answers a missing file with an empty side — that is
how a deletion renders — and that branch returns before the check. So an existing file behind a junction
was refused while a missing one came back as `{ ok: true, text: '' }`: indistinguishable from a file
legitimately deleted inside the project, and never consulting the guard at all.

The fix is not a second check. It is asking a question whose answer does not depend on the thing that
triggers the early return: **containment of the DIRECTORY, before the stat.** A missing file behind a
junction is still a path out of the repository, and the directory is there either way.

The general form: when a function has an early return for "nothing here", check what the guards below it
never see. A guard that only runs on the success path protects the case that was already fine.

Neither of these was found by the suite. Both were found by a verifier told to be adversarial about a
specific function and a specific ordering — and in both cases the first report came back PARTIAL on work
that had already been live-checked, tested and called done.

## A blanket "open everything" defeats a rule it was never told about (#490)

Project settings gained a search box. The search force-opens every `details.settings-adv` so a hit inside
one is visible — code that predates the change and reads perfectly well on its own.

A backend's resources block is a `details.settings-adv`. It is also the thing #472 made lazy, because
listing five backends' resource directories on render was a filesystem walk per backend for lists nobody
had asked to see. And #490 had just put every backend's pane into the DOM at once.

So the first keystroke in the project search box walked the filesystem once per installed backend. Nothing
errored, nothing was slow enough to notice on a warm cache, and the whole suite was green — twice, because
the search path has no test at all and the laziness test only covers the click that opens one pane.

Two things to take from it:

- **A blanket operation over a shared DOM inherits every rule that DOM carries**, including the ones added
  after it was written. `querySelectorAll('details.settings-adv')` is a promise to know what every
  `settings-adv` in the app is for. It did not, and could not.
- **The cost of a rule is where it gets re-broken.** #472 removed exactly this cost; #490 restored it
  through a control that had never heard of it. The guard is now a condition in the code
  (`dataset.loaded === '1'`) and a sentence in `.claude/rules/renderer.md` that describes the BEHAVIOUR
  rather than the intention — the previous wording said the search opens "one" disclosure, which is what
  the author meant and not what the loop does.

## `normalizeShortcuts` is not a migration, and a stored default is not a choice (#491)

Moving the command palette off Ctrl/Cmd+K needed one line: a new default. The first version shipped that
line, and on a real store the chord did not move at all.

The settings panel writes **every** binding whenever the global settings are saved. So anyone who has ever
pressed Save has all twenty-two frozen at whatever they were that day — and "there is a stored value" says
nothing about whether anyone chose it. Giving Ctrl+K back to the shell would have reached new installs only.

The obvious repair — treat a stored value that equals the superseded default as never-chosen — is worse
than the bug it fixes, and that is the actual lesson. `normalizeShortcuts` is not a migration that runs once
at upgrade time: it runs on every settings open, on every boot, and its output is written back on every
save. A comparison alone would therefore fire **forever**, so a user who deliberately rebinds the palette
back to Ctrl+K has that choice quietly undone the next time anything loads. A chosen Ctrl+K and an
inherited one are the same four fields; nothing in the value can tell them apart.

What tells them apart is a stamp: `_defaultsVersion` rides in the shortcuts blob, so the rewrite applies to
a table that predates the move and never again. **Before writing a migration into a normalizer, ask how
often the normalizer runs.** If the answer is "on every read", it is not a migration, it is a rule — and a
rule that erases user intent is a bug wearing an upgrade's clothes.

Both of these were found by a verifier reading the diff, not by the suite, and both were on work that had
already been live-checked and called done.

## The last record is not the last reading (#494)

Codex writes its rate limits into the transcript, and the reader took the last block it found. That is
the obvious reading of "only the newest figure is current", and it was wrong in a way nothing pointed
at: a session ENDS by writing a block with no windows in it at all, only the reason it stopped. So the literal last block was regularly a reason rather than a measurement, and taking it
threw away the forty-odd good readings sitting earlier in the same file.

The symptom was the worst kind. Not an error, not an empty bar — "no data yet", which the user reads
as *the app cannot tell*, while the backend had in fact said exactly what was wrong and Switchboard
had dropped it on the floor. The fix reads two things out of the file instead of one: the last record
that measures something, and the last record of any kind, the second only for its reason.

**Ask what a record MEANS before deciding which one is current.** "Newest wins" is a rule about
position; it answers nothing about whether the thing in that position is the kind of thing you are
looking for.

The same pass found a field that had moved under us — the credits pool changed from a percentage to a
balance with no total — and the honest answer there was to report no quota rather than invent the
denominator. A bar drawn from a number nobody has captured is worse than an absent bar.

## The fix that reproduced the bug it was closing (#495)

A `Stop` hook arriving while a prompt was still queued made a working session read as "Ready". The fix
reads the queue out of the transcript and holds the signal, and the reader did that by counting the
last 128 KB — a tail, because the file runs to megabytes and this is asked while the user waits.

The argument for the tail was written into the file as a comment, and it was persuasive: an enqueue
whose closure is out of frame is impossible, because the closure always comes later. It was also
incomplete in two directions at once. An enqueue that is still OPEN gets pushed out of view by the
very turn that is still running — 7 of 1570 real pairs are further apart than the window and the widest
is 985 KB — and, the queue being FIFO, a closure seen inside the window takes the oldest queued prompt
rather than the one whose enqueue sits beside it. Either way a queued prompt read as none, no hold was
taken, and the bug was back with the timeout that would have caught it never engaging.

Nothing in the suite could see it: every fixture was a handful of lines, so the window was never
reached. It took an adversarial review asking "construct an input where this under-reports", and then
a measurement over the real store to settle whether that input occurs.

Three things worth carrying:

- **A comment that argues an optimisation is safe is a claim, not a proof.** This one covered one of
  the two ways a window can cut a history and read as though it covered both.
- **A fixture that never reaches the boundary does not test the boundary.** The tests were meaningful
  about the logic and blind to the mechanism the feature exists for.
- **The cheap fix was possible only after removing a parameter.** The scan took the caller's cutoff and
  answered a yes/no, which made the result unique to each asker and therefore uncacheable. Reporting
  the newest instant instead, and comparing the cutoff afterwards, made one scan answer everyone — and
  a memo on mtime and size then removed the repeated read entirely. **An answer shaped around the
  question cannot be shared; an answer shaped around the data can.**
