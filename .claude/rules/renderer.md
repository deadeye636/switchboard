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
list there rather than a number here**: this line said "eleven files" while the map held dozens. Clean a
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

**A descriptor declares what its CLI does with the key; it cannot declare which RENDERER that CLI is
running** (#558). Claude has two — classic draws inline on the normal buffer, so the conversation is
xterm's scrollback; fullscreen draws on the alternate screen, where the conversation is the CLI's and
PageUp/PageDown are its own documented half-screen scroll. And it moves between them **by itself**:
after two fullscreen sessions fail to start it switches that machine to classic until the CLI is updated
or told otherwise. Measured on one machine on one afternoon: four long-running sessions on `normal` with
226-2470 lines of scrollback, a fresh one on `alternate` with `baseY: 0`.

So a `viewport` declaration alone is wrong for whichever half is on the alternate screen, and wrong in
the expensive direction: `scrollPages()` moves nothing there, and the key that IS that user's only way
to page their conversation never reaches the CLI. That is #410's mistake in a new disguise. The routing
therefore asks `buffer.active.type` at the press, and a key whose conversation is not ours falls back to
the application — the same default an unknown declaration gets, for the same reason. **Read it live**:
the buffer can switch partway through a CLI's start, so a value captured at mount describes the startup
screen.

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
- **Both scopes have the nav since #490**, and one function wires it (`wireTwoPane` in
  `settings-panel.js`). It queries `.settings-nav-item` / `.settings-cat` on every use and delegates the
  clicks, because the project scope grows an entry and a pane **per backend** after main has answered —
  a list captured at wiring time leaves every one of those dead. The project nav's BACKENDS group is
  built by `addBackendNav` from what `backendsPanel.mount` reports (`onBackendPanes`), never written down.
- **The counts beside the names are counted** — `settings-panel.js` fills them from each section's
  `.settings-field` elements after the markup is in. Do not write a number into the markup; the ones that
  were there had been wrong for a while. A category another module fills in later counts nothing and
  shows nothing. `data-count-own="1"` opts an entry out: a project's backend shows how many launch options
  it **overrides**, because every backend has the same fields and that is the question the screen answers.
- **A backend's resources are read when its pane is SHOWN, never before.** A filesystem walk per backend
  before anyone has looked is what the closed disclosures avoided until #490, and the pane keeps that
  promise a different way: `showCat` fires `settings-cat-shown`, the pane opens its own disclosure, and
  `bindLazyResources` fetches on `toggle`. One backend's walk, never every backend's. No remembered state,
  so two people looking at one project see one screen.
  **The search is the hole in that** and it is guarded, not assumed: `applyGlobalSearch` force-opens every
  `details.settings-adv` so a hit inside one is visible, and `.backend-resources` is a `settings-adv`, so the
  first keystroke would have opened all of them and walked the filesystem once per backend. It now force-opens
  a resources disclosure only when `dataset.loaded === '1'` — one already read has nothing left to pay, one
  nobody has opened stays closed and is not searched. Any future "open everything" over the settings DOM has
  to answer this same question.

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
| tabs / single | every open terminal keeps its context | only one is *visible*; a reveal heals whatever a sibling did to the atlas meanwhile (`forceRepaint`, #118 — and read what it heals with, below). **Nothing bounds the count** — see below |
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
- **A reveal heals by rebuilding ITS OWN model, and wipes the shared atlas only when that atlas
  restructured (#525).** `terminal.refresh()` alone heals nothing across terminals: `_updateModel` skips
  every cell whose code, fg, bg and ext are unchanged, so a repaint of an unchanged screen looks nothing
  up again. What heals is `_clearModel(true)` — reached through the renderer's public `clear()`, or as a
  side effect of `clearTextureAtlas()`. Only the second one is shared, and it is what a merge or a new
  page needs, because then the coordinates everyone holds have actually moved (`_mergePages` rewrites
  them, `_deletePage` shifts `texturePage`). Wiping on every reveal is what made #525: `AtlasPage.clear()`
  resets the canvas and row layout but never the page's `glyphs` array, so each re-rasterised glyph is
  appended and the old one is kept — 1403 entries for one clear of a 58-row terminal, 219 063 entries and
  ~65 MB in a day. `atlasStructure` (page count plus each page's canvas size) is the local stand-in for
  upstream's `_pageLayoutVersion` — which is on master and the 0.20.0-beta line, so a consumer on stable
  0.19.0 cannot reach it. **The stand-in is weaker than the original in one specific way**, and that is
  what makes the model rebuild load-bearing rather than optional: upstream bumps its version inside
  `clearTexture()` too, so a sibling's wipe reaches every renderer, while a structural signature cannot
  see a wipe at all — nothing moved. Delete the non-wiping branch's `renderer.clear()` as "redundant" and
  #118 comes back. **And do not put `page.version` in that signature** — this xterm bumps it per glyph
  added, so it would gate nothing.
- **Every renderer switch re-fits, `suspendTerminalWebgl` included (#322).** The two renderers do not
  agree on a cell (8.2065 px against 8.000 px at dpr 2, xterm.js#6015), so a terminal demoted to DOM
  keeps a stale fit and clips its bottom row — the #81 family. Load re-fits, the context-loss handler
  re-fits, and suspend now re-fits on a deferred frame like it does. Do not hand that back to a
  caller: panes mode looked covered only because `render()` calls `refitVisible()` right after the
  policy, which `focusPane` does not.

## PTY bytes are written on a settle, not on the next frame (#81, #513)

`terminal-manager.js`'s `scheduleFlush` decides when the buffered PTY chunks reach `terminal.write()`,
and its shape is load-bearing in a way that looks like pointless latency:

- **A pending flush is REPLACED by the next chunk, not left to fire.** ConPTY hands a TUI's redraw over
  in small reads — measured at 5-56 bytes, a *median* of 14 ms apart — and cuts the redraw across them.
  Flushing on the very next animation frame wrote the first read alone, so a CLI that parks its cursor
  at the viewport origin before the correcting read arrives had that origin painted for one frame: a
  cursor visibly flickering between the prompt and the redraw position (#513).
- **Three ordinary bounds, and all three matter.** The floor is the ~30 fps cap (#81); `FLUSH_SETTLE_MS` is how
  long a still-receiving buffer waits; the ceiling is one interval past the buffer's FIRST chunk, and it
  is what keeps a continuously streaming session on its old cadence instead of waiting forever on its own
  steady arrival of data. Remove the ceiling and streaming stalls; remove the settle and #513 returns.
- **One structural state gets a bounded exception.** Some TUIs complete a synchronized-output block by
  showing the cursor at column 1, then send the real composer placement in a separate frame. The ordinary
  ceiling presented that transient state and the floor delayed its already-arrived correction. A visible
  session whose last completed DEC-2026 block has exactly that shape is held until a later placement joins
  the buffer or `TRANSIENT_CURSOR_FRAME_HOLD_MS` expires. This is terminal semantics, never a backend-id
  branch; hidden sessions keep their background cadence, and the timeout preserves a legitimate column-1
  placement.
- **Do not "fix" the echo latency by dropping the settle.** A lone chunk with nothing behind it waits
  `FLUSH_SETTLE_MS` instead of one frame. That is the price, and it is the whole mechanism.

`test/terminal-background-write.test.js` holds the three ordinary bounds plus the structural hold and its
timeout. The old test asserting an immediate rAF for a visible session was replaced, not weakened — that
guarantee is what #513 removed on purpose.

## Motion is paid for BY THE FRAME, wherever it is, and by PLACE is the only lever (#519)

An animation that Blink cannot accelerate recalculates style on the main thread every frame for as long
as it runs — and it runs whether or not anybody can see it. Measured on a live instance, across the
pipeline rather than style alone: about 1.9 s of rendering work per 20 s with the sidebar's spinner,
shimmer and icon blink going, against ~0.3 s with them off. Paint was the biggest line of it and never
showed up in a style-only reading.

Four things were measured before the rule below was settled on, and each killed an obvious fix:

- **The spinner IS composited.** `LayerTree.compositingReasons` answers `ActiveTransformAnimation`, the
  pi icon answers `ActiveOpacityAnimation`. Choosing a different property fixes nothing, and the first
  attempt paused the one animation that was already free while leaving the two that were not.
- **A composited animation still recalculates style per frame** — by design: Blink ticks a main-thread
  copy so the element's computed style stays in step with the compositor.
- **One running animation costs what five cost** (69.9 recalculations a second against 72-77 for five,
  0.8 with none). So reducing the NUMBER of animated indicators saves nothing; the static-dot and
  animate-only-the-focused-row options were both weighed against a benefit that does not exist.
- **Selector complexity is not it either.** The row's dot, reached through five compound selectors and
  three negations, cost 135 µs per element; a probe `div` with one class nothing else targets cost 142.

So the rule is **pause by PLACE, never by property**: everything inside a row nobody can see stops.
`.session-item.offscreen > .session-row *` and `body.window-hidden #sidebar-content *` /
`.sidebar-tab *` in style.css, `animation-play-state: paused` so a row scrolled back resumes mid-spin.
A new decorative animation inside a session row is covered on the day it is written; do not "tidy" that
into a list of the animations that exist today.

Three parts that look redundant and are not:

- **`visibilitychange`, not focus.** A window can sit unfocused in plain view, and a spinner frozen
  there reads as a session that stopped working.
- **`preserveSidebarState` carries `.offscreen` across a render.** The observer re-delivers after
  morphdom, but a frame or two later — long enough for every paused animation in the sidebar to start up
  again, twice per render.
- **`> .session-row`**, like every state rule in that file: a row CONTAINS other rows, each observed on
  its own, and a nested row still on screen must not be paused by the head it sits under.
  `test/sidebar-nested-row-scoping.test.js` catches the descendant form.

**And measuring this is its own trap.** Three runs of ONE identical configuration on a live instance gave
592, 748 and 879 ms — a spread of nearly 50 %. `scripts/perf-trace.js` prints what was animating in every
run for that reason; two runs that do not name the same state are not comparable, and a whole issue's
worth of conclusions was drawn from a table that sat entirely inside that spread.

## An icon is markup, and markup is parsed (#520)

`el.innerHTML = '<svg…>'` invokes the HTML parser. The row builder did it twelve times per row, for a
constant string, on every render: 12 778 `ParseHTML` events in 20 seconds, all attributed to
`buildSessionItem`. `setIcon(el, markup)` in `lib/icons.js` parses each distinct string once and hands
out `cloneNode(true)` copies — measured at 5040 parses before against 1820 after, same window, same
forced render loop.

Keyed by the markup itself, not by a name: the callers hold their SVG inline, and a key they have to
invent is a key that goes stale against the string beside it. **A new icon-bearing control uses
`setIcon`**; the other builders (project headers, chips) still assign `innerHTML` and are the remaining
1820.

## A change that only moves numbers inside a rendered row does not rebuild the sidebar

`refreshSidebar()` used to cost 121-157 ms of main thread at seven projects and 78 sessions, nearly all of
it in `renderProjects` (split evenly between building the tree and morphdom diffing it), and more than ten
call sites reach for it. Two patch paths exist for the high-frequency ones — `patchSidebarStatuses` (#80)
for a busy/idle edge, `patchSidebarChips`/`patchCardChips` (#515) for a VCS status — and a third belongs
wherever a caller fires repeatedly during ordinary work.

**Two things make the full render cheap, and both have a rule attached** (#516, measured 63-100 ms → 9-16 ms
on the same instance):

- **A row behind a fold nobody opened is not built.** `buildSessionsList` builds the "N older" rows only
  when the live fold is showing or one of them is an OPEN session — 65 of 74 rows in the measured instance
  were built and then hidden. So an item is *described* (`id`, `topLevelId`, `sessionIds`, `build()`) and
  built later, and **anything that reads sessions out of the sidebar's DOM has to say so here**: session
  navigation and the grid derive their order from the rows, folded ones included, which is why an open
  session keeps its row; the older-group archive reads `data-deferred-session-ids` instead. Add a reader
  and you add a case to that list, or it silently sees a shorter sidebar than the user does. "Keeps its
  row" is decided at RENDER time, so `openSession` renders when the session it just opened has no row —
  the palette and a bookmark open one without passing a render, and until one came the grid gave that
  session no card and `Ctrl+Shift+[`/`]` skipped it.
- **A node that already is what the builder wants is skipped.** `preserveSidebarState` ends in
  `fromEl.isEqualNode(toEl)`, so morphdom does not walk a subtree it would not have changed. Native deep
  compare on purpose: a hand-written signature that forgets a field is a row that goes stale.

A patch is only safe when **the render can re-derive it**: update the cache first, then patch, and derive
what you paint from the same function the builder calls. Two copies of a derivation, one in the builder and
one in the patch, is the #229 trap wearing a different hat — it agrees today and drifts on the next edit.
Report structural change (a thing that has to appear or disappear) back to the caller and let it rebuild.
The remaining cost of a full render is #516.

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
