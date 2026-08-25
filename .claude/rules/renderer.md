---
paths:
  - "src/renderer/**"
  - "src/shared/**"
---

# Renderer

Vanilla JS, **no framework**. Modules are plain `<script>` tags in `src/renderer/index.html` (load
order matters — `test/script-tags.test.js` guards it). Sorted into folders (`shell/`, `session/`,
`terminal/`, `views/`, `jsonl/`, `panels/`, …). DOM reconciliation via morphdom. Terminal =
`@xterm/xterm`. Diffs = CodeMirror (`codemirror-setup.js`, bundled by esbuild into
`codemirror-bundle.js`). Don't add a framework, build step or bundler beyond that esbuild bundle.

## THE RULE: on any renderer change, the click IS the test

The suite has no opinion about most of the renderer. A green run means "I have not broken the main
process", nothing more. `node scripts/drive-app.js console` is the four-second version of the click.

Two shipped-green disasters, both from #218, both the same shape — the moved block *defined* a name
something *outside* it still called:

- Pulling the tag lists out of `openSettingsViewer` left `settingsViewerBody` behind (an IIFE-level
  const, not a global). The entire Tags section died with a `ReferenceError` the instant the panel
  opened. **All 1488 tests passed.**
- Cutting the shortcut rebinding out left `stopShortcutCapture` behind — and both `persistSettings`
  *and* the Cancel button call it. The panel looked perfect, the rebind showed in the button, and
  **Save threw for every setting** while **Cancel threw too**. Again 1488 green. Opening the panel
  found nothing; only pressing Save did.

So after any cut: **grep the moved file for every name it declares**, and expect more than one caller.

## Scope: a top-level `const`/`let`/`function` is NOT on `window`

It lives in the global lexical scope every classic script shares. One file's function can read (and
rebind) another's `let` — that is how the renderer has always been wired.

- **A reference inside a function resolves at CALL time** — tag order cannot break it. Only what runs
  at PARSE time (`let x = f()`, `document.getElementById(...)`, a top-level listener) needs its
  dependency already loaded. That distinction is the whole of "the load order carries meaning".
- **`window.foo` is not the same binding as a top-level `let foo`** — it shadows. Never "fix" a
  cross-file read by reaching through `window`, and never wrap a file that WRITES another's `let` in
  the UMD factory the pure modules use: the write lands on a window property the `let` shadows, the
  reader never sees it, and the suite stays green. (#218 measured this on `gridInteracting`.)

## Adding a file is a THREE-file change

The `<script>` tag, `test/fixtures/script-order.json`, and `ALLOWED_BINDINGS` in
`test/backend-integrations.test.js` — those guards iterate that map, not the directory, so a file
left out is silently unchecked. For app.js's siblings the tag and the script-order entry go in the
`index.html` set, not `settings.html` (app.js is not loaded there).

**Unless it is inside the bundle**, and then it is a one-file change with a different rule. A module
`import`ed by `src/renderer/jsonl/codemirror-setup.js` is esbuild's problem, not the script list's:
no tag, no `script-order.json` entry, and `renderer-no-undef` never sees it (the bundle is excluded
from every lint environment on purpose — see the CSP note below). It reaches the renderer only
through what `codemirror-setup.js` puts on `window`, so **the export is the seam** — add it there,
and reach for it as `window.foo` from a classic script, never as a bare global.

`src/renderer/jsonl/live-markdown.js` (#281) is the pattern: a CodeMirror extension that needs
`@codemirror/view` at parse time and therefore cannot be a `<script>`. Its wiring is guarded by
`test/live-preview-wiring.test.js` reading the source, because nothing else can.

## A new HTML PAGE is a different three-file change

The app has standalone windows beside `index.html`/`settings.html` — the changes window
(`changed-files.html`, #277) and the diff window (`diff-window.html`, #287). Each is its own environment
with its own script list, so adding one means: `PAGES` in `test/script-tags.test.js`, its own key in
`test/fixtures/script-order.json`, and its own `lintEnvironment(...)` test in
`test/renderer-no-undef.test.js`. Miss one and the page is simply unguarded — nothing fails.

Two things these pages do differently, both forced by the CSP (`script-src 'self'`, set in
`src/app/lifecycle.js`): the script is **external**, never inline, and `codemirror-bundle.js` is pulled in
**at runtime** (`document.createElement('script')`, the `loadCodeMirrorBundle` pattern) rather than with a
static tag. A static tag would put the minified bundle into that page's lint environment, where the browser
globals it uses (`Window`, `DOMRect`, `requestIdleCallback`) are not in the test's curated list and it fails
`no-undef` — `index.html` avoids this the same way. Reach for the bundle's exports as `window.createMergeViewer`
(member access), not a bare global, so the reference does not depend on the bundle being parsed at all.

`test/renderer-no-undef.test.js` (#228 follow-up) now catches the ReferenceError half mechanically:
it builds each HTML environment's shared scope from `script-order.json` — every top-level
declaration plus every UMD/window export — and runs eslint `no-undef` over each file. It does NOT
replace the click: it sees undefined names, not wrong behaviour (a rebind landing on a `window`
shadow, a stale header). eslint is a devDependency, not part of the shipped renderer.

## The header IS the import graph

A module cut out of a monolith has no `import` line to say what it reaches into — the header comment
is the only record, and nothing checks it. #218 shipped a header defect in six of sixteen passes,
four of them false claims (an undercounted caller, a stale tag count, "eleven" panes that were
twelve, "byte-identical" off by one byte, a free-globals register naming three of six, functions
attributed to the wrong file). Every one was caught by a reading verifier, none by the suite. Treat
any caller-count, dependency or "identical" claim in a header as unverified until checked.

## No backend id in the renderer

`src/renderer/**` contains no `if (backendId === 'codex')` and must not gain one. **Trust the guard,
not this line:** it claimed the renderer was clean for eleven issues while #212 counted 23
`|| 'claude'` fallbacks plus id branches. `test/backend-integrations.test.js` runs over every file in
`ALLOWED_BINDINGS` (id comparison check, literal counter, no-table-keyed-by-backend-id) — **read the
list there rather than a number here**: this line said "eleven files" while the map held 45. Clean a
file → add it to `ALLOWED_BINDINGS`.

**`window._defaultBackendId` is already resolved — never rescue it.** It is the stored target while
still launchable, else the first launchable, else `''` (`resolveDefaultTarget`). So
`_defaultBackendId || <anything>` means the `<anything>` is a bug. That is the whole of #225: sixteen
sites across eight files each patched the same value instead of fixing it once.

**A per-backend TABLE in the renderer is the descriptor's data in the wrong process.** The blurbs
lived in `backends-panel.js` as `{ claude: '…', codex: '…' }` — a new backend had to edit the
renderer to look finished, and one whose author forgot rendered a blank line. Declare it on the
descriptor and project it through `backends-list`. Same for artwork (`icon`), the Endpoint fields
(`endpointEnv`) and backend-owned extras (`integrations`).

## Only the main window announces (#390)

Every window loads the same shell, so every window runs the attention engine and the notification
funnel — and `set-badge` / `set-tray-summary` do not look at which window sent them. A window of its own
therefore sent "0 waiting" and cleared what main had just set.

`raisesAttention` in `shell/attention-engine.js` is the one answer to "may THIS window announce". It
gates exactly four surfaces: the badge, the tray summary, the native notification and the attention
chime. **A new OS-facing surface has to consult it**, or it fires from every window. It deliberately
fails open — a missing identity answer announces — because a silenced main window is the worse failure.

Recording is not gated: a window of its own still learns and records everything about its own sessions.
What it must not do is announce.

## `openSessions` is NOT "the sessions this window holds" (#394)

It holds **mounted terminals**. In panes mode a dormant session is in the window — drawn with a Launch
placeholder, selectable, and still flaggable, because the flags outlive a pty exit (#259) — and it is
not in that map. `window.sessionIdsInThisWindow()` (`shell/detach-window.js`) is the answer: the panes
layout when panes mode is on, `openSessions` otherwise. It was derived twice before it was named, and
the second derivation got it wrong.

## A working backend is the control, not the thing to normalize away

When a request says a terminal interaction already works in one backend, write the behaviour matrix
**before** changing shared xterm handling: one row per backend, current owner (TUI/PTY vs xterm), desired
owner, and evidence. The working row is the regression control and must still work after the change.

Bare terminal keys are application input unless a backend descriptor explicitly gives them to
Switchboard. Never intercept an unmodified key globally because another TUI does not use it; full-screen
TUIs own history, overlays, lists and user-customizable bindings that xterm cannot see. Build the neutral
descriptor seam first, then declare every backend's answer. Unknown answers fall through to the PTY.

Verification must prove both directions: for a PTY-owned key, no `preventDefault`, no xterm scroll and the
key reaches the TUI; for an xterm-owned key, the PTY receives nothing. A source-regex test is only a wiring
guard, not that behaviour test. Live-check the previously working backend as well as the backend that
motivated the change — testing only the new success path is how a regression gets called consistency.

**PIN THE ANSWER PER BACKEND, or the next change will move the ones it was not aimed at.** This went
wrong twice in opposite directions on the same keys: once by giving every backend to xterm (which took
the key from the only backend that already worked), once by giving every backend to the PTY (which left
the two backends the request was actually about with a key that does nothing). Both passed their tests,
because both tests asserted the shared branch rather than each backend's outcome.

`PAGE_KEY_TARGETS` in `test/terminal-page-scroll.test.js` is the shape that stops it: one entry per
backend, so changing any backend's behaviour fails by name and has to be spelled out. A per-backend
capability gets that table; a blanket assertion over all backends (`for (…) assert.equal(x, 'pty')`) is
the same defect written as a test — it passes precisely when everything was moved together.

**And do not fill such a table from a CLI's documentation.** Every wrong entry in both rounds came from
reading a keymap; every correct one came from pressing the key in a live session and watching both
directions. Where a backend was not measured, leave it on the value it already had and say so — an
unmeasured backend is out of scope, not a default to guess at.

## A new control inherits NO styling

A button with only a behaviour class renders as the browser's native control — a white box with
black text next to your styled ones. Reuse an existing class (`.settings-action-btn`,
`.new-session-secondary-btn`, `.backend-btn`, …) or add one; never ship a bare `<button>`. Same for
popovers and overlays. This has bitten repeatedly.

**A dialog that holds work must not be dismissible by accident.** A stray backdrop click or a
reflexive Escape closes a `showControlDialog` — fine for a question, wrong for anything holding
something the user cannot get back (a handoff packet an agent spent tokens writing). Pass
`dismissible: false`, or ask before discarding.

## An action that depends on FOCUS means `activeSessionId`, and it says which one (#473)

The command palette lists what the app can do, and since #473 some of that depends on what has focus —
"write a handoff" is the first. Two decisions there, and both are the kind a later action answers
differently unless it is written down.

**Which session it means is `activeSessionId`, never the DOM focus.** `setActiveSession` in app.js is the
choke point every focus path funnels through — tabs, grid cards, pane focus, the attention inbox — so it
stays right while the caret sits in the sidebar, a settings field or a plan view. A rule that read the
focused element would go blank exactly when someone is reading a plan and decides to hand over.
`focusedActionSession()` is that rule, in one place; a second focus-dependent action calls it rather than
deriving its own answer.

**What keeps it unambiguous is the ROW, not the rule.** The action names the session it is about (`Write
a handoff for “…”`). That is why `title` and `group` in `registerCommandAction` may be functions: they are
resolved per open, like `available()` already was, because the subject is not knowable at registration.
A resolver that throws or returns nothing falls back rather than dropping the row — failing to name itself
is not a reason for an action to disappear.

**Offered when it applies, absent when it does not.** `available: () => !!focusedActionSession()`. An
action offered everywhere and failing on use is the shape this replaces. Ask again inside `run` as well:
the palette may have been open while the session ended.

`paletteMetaWithDate` (palette-core.js) belongs to the same family — one answer to "when was this last
changed", worded through `formatDate` so a picker row reads like the Plans list rather than inventing its
own wording (#475).

## The settings screen: grouped by subject, counted, and closed by default (#471, #472)

Three things there are decisions rather than styling, and each is the kind a later change undoes without
noticing.

- **A category is a subject, and its name says which.** `settings-global-html.js` holds one
  `<section class="settings-cat" data-cat="…">` per category and a nav button per section; the nav
  switching is generic, so adding a category is those two. A field goes where its subject is — the reason
  this rule exists is that Terminal accumulated documents, editor settings and secrets under a heading
  that sounded plausible, and held 26 fields when the screen said 10.
- **The counts beside the names are counted** — `settings-panel.js` fills them from each section's
  `.settings-field` elements after the markup is in. Do not write a number into the markup; the ones that
  were there had been wrong for a while. A category another module fills in later counts nothing and
  shows nothing.
- **Per-backend sections are closed, and cost nothing while closed.** Project settings draw two blocks per
  installed backend, so an expanded default is ten open blocks and a filesystem walk per backend before
  anyone has looked. `bindLazyResources` in `backends-panel.js` fetches on `toggle` — which also covers
  the settings search force-opening a disclosure to reveal a hit. Closed is closed for everyone: no
  remembered state, so two people looking at one project see one screen. What a collapsed header must
  keep saying is whether this project overrides anything, or the screen stops answering the question it
  exists for.

## Panes mode hosts the app's own view elements (#310, #342, #311)

In `sessionDisplayMode: panes`, a tab whose kind is not `terminal` does not build a view. `VIEW_KINDS` in
`views/panes-view.js` is the list; read it there rather than from here. **Two flavours, and mixing them up
is how the app loses its only preview panel:**

- **Singleton kinds** (`jsonl`, `plan`, `stats`, `memory`, `projects`, `variables`, …) — the tab **moves
  the app's single existing element** into the pane and hands it back to the exact slot it came from on
  close. Those MUST be parked at home before a rebuild, or `replaceChildren` destroys them.
- **Instanced kinds** (`preview`, `diff`, since #311) — one instance per thing shown, built by
  `file-panel.js` (`createPanelInstance`) and keyed `<kind>:<ref>` (file path / diff id). They have **no
  home**: created with their tab, destroyed with it, so they must never go through `viewHomes` /
  `releaseViewElement` / `hideViewElement`.
- **A `diff` has no tab at all since #398.** It rides with its session's tab (`buildPane` asks
  `filePanelReviewHostFor`), because a review is read on top and answered in the terminal underneath it —
  the accept/reject buttons are the CLI's. Several reviews of one session share that surface and are
  paged, with a counter, because the bridge dispatches tool calls without awaiting the previous one. The
  obligation that comes with having no tab: **whatever takes the surface away must answer the review** —
  the session's tab close, the pane close, an answered review freeing its own surface. Every path that destroys a diff instance has to ANSWER it
  (`mcpDiffResponse(..., 'reject')`) unless the CLI already decided — otherwise its `tools/call` hangs for
  ten minutes. `docs/specs/16-panes-mode.md` §4.3 has the full rule set.

`test/helpers/file-panel-dom.js` is the harness for that file (it had none until #311); the diff/accept
logic is testable without Electron.

**It is EVERY main-area surface, not the session-shaped ones** (#342). `#terminal-area` is the last
child of `#main` and these viewers are earlier siblings at `z-index: auto`. In tabs and grid mode they
take over by hiding `#terminal-area`; panes mode keeps that area alive on purpose
(`display: flex !important`), so DOM order decides and the pane tree paints over anything not adopted.
Projects and Variables sat behind the tree for exactly that reason while Activity worked — the only
difference was being in the table. A new main-area viewer must be added to it.

Four consequences that are easy to break:

- **`views/panes-view.js` parks every hosted element at home before it rebuilds** `#terminals`.
  Anything still inside the old pane DOM is destroyed by `replaceChildren` — and these are singletons,
  so that would take the app's only preview panel with it.
- **Closing the tab has to close the VIEW**, and there are **two routes**, the same two the viewers'
  own header buttons use: `close: 'admin'` → `closeAdminView()` for the surfaces a SIDEBAR TAB drives
  (Projects, Variables, Activity), the viewer teardown for the rest. Hiding an admin surface without
  moving the sidebar tab back leaves the sidebar asserting a view that is gone, and `hideAllViewers()`
  does not know `#variables-admin-content` at all.
- **Only a USER close may run a route.** The `MutationObserver` also fires when the app hides a
  surface to show another one; answering that with the app's close route undoes the switch — clicking
  Projects then Variables left the sidebar on `sessions` with no tab. Hence `closeTheView`.
- **A second window shares this origin.** A detached window (#2) must not write the layout, the
  open-sessions restore state, or `gridViewActive` — see `docs/specs/17-detached-windows.md` §4.

## WebGL is decided per MODE, and the three answers differ

Each terminal that runs the WebGL renderer holds its own GL context; they all share one glyph atlas.
Three modes, three policies, and the reason they differ is measured, not assumed:

**One live GL renderer whenever more than one terminal is on screen.** That is the rule in every mode,
arrived at twice from opposite directions:

| Mode | Policy | Why |
|---|---|---|
| tabs / single | every open terminal keeps its context | only one is *visible*; a reveal repaints (`forceRepaint`, #118), which heals whatever a sibling did to the atlas meanwhile. **Nothing bounds the count** — see below |
| **panes** | **WebGL only while ONE terminal is visible; two or more panes → every terminal on DOM**, never a mix | two visible terminals have no reveal moment, so the one nobody touched keeps the holes. All-or-nothing because a split renderer is a split *cell metric* — at dpr 2, 8.000 px under WebGL against 8.2065 px under DOM (#320) |
| grid | only the focused card | same reason, reached first (#140) |

**The LRU cap does NOT bound the live count, and this file used to say it did** (#352). `lruEvictOne`
skips everything active, everything with a live PTY and everything not already `closed` — which is
every session a user actually has open. Measured: `open 22 · webgl 22 · lruCap 12 · lruLen 22 ·
closed 0 · canvases 45`. So in tabs/single mode the context count is whatever the user opens, and
past roughly 32 Chromium starts killing contexts. Panes mode is saved by its own two-visible rule;
tabs mode has nothing. Do not reason from the cap until something makes it true.

**#320 is the cautionary tale.** It doubted the atlas, measured two WebGL terminals under a flood of
18 000 codepoints, saw no corruption, and gave every pane a context. Daily use disproved it within
hours: two panes rendering *alternately over minutes* drop glyphs, which a burst through both at once
never reproduces. The context-churn fix from that issue was right and stays; the conclusion drawn from
the bench was not.

Three things that are easy to undo by accident:

- **Never load WebGL from a view path.** `showSession` used to, and in an all-DOM layout that created
  a context per click for the policy to dispose a microtask later — the churn #140 actually died of.
  The layout decides the renderer; a reveal only repaints.
- **A refused load must roll back.** If one pane's load refuses (setting off, WebGL given up after
  repeated losses), the panes that got a context give it back. Half-applied is the split the policy
  exists to prevent.
- **`loadTerminalWebgl` is idempotent, and `disposeWebglAddon` runs even with no addon** — the
  context-loss handler drops the reference without touching the DOM, and the orphaned canvases sit on
  top of the DOM renderer's rows as an opaque layer (#309's shape).
- **Every renderer switch re-fits, `suspendTerminalWebgl` included (#322).** The two renderers do not
  agree on a cell (8.2065 px against 8.000 px at dpr 2, xterm.js#6015), so a terminal demoted to DOM
  keeps a stale fit and clips its bottom row — the #81 family. Load re-fits, the context-loss handler
  re-fits, and suspend now re-fits on a deferred frame like it does. Do not hand that back to a
  caller: panes mode looked covered only because `render()` calls `refitVisible()` right after the
  policy, which `focusPane` does not.

## The session timeline is READ here, never written (#396)

`session/session-timeline.js` is a read-through **cache** of what the main process holds, not a record.
A window fetches a session's history once (`window.api.getSessionTimeline`) and is kept current by
`onTimelineAppended`, which main broadcasts to EVERY window — which window draws which session changes
while the app runs, so routing it would make the copy correct only until something moved.

- **`recordTimelineEvent` is gone.** Every former caller described something main already knows, and a
  second writer is how the two copies drifted. Do not reintroduce one.
- **A fact only the UI can see** goes through `window.api.noteTimelineEvent`, which main validates
  against a short list of kinds and then writes itself. A window cannot forge a busy edge or an exit.
- **`loaded` is load-bearing.** A session with no events and a session not yet fetched look identical
  from the events map alone, and answering the second as "nothing happened" is the failure the whole
  feature exists to prevent. `addTimelineEvent` drops events for a session this window has not fetched.
- Readers are synchronous, so `ensureTimelineLoaded(sessionId)` runs BEFORE them —
  `showTimelineViewer` and `handleSessionViewed` are async for that reason alone.

## `src/shared/`

The four modules **both processes load** — `attention-source`, `custom-launchers`,
`variable-insert`, `preview-kind`. `require()`d in main, a global in the renderer (which has no
require — plain `<script>` tags). The preview in main must compute with the same code the insert runs
in the renderer; two copies would be a bug factory. **Nothing else belongs here.**
