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
`|| 'claude'` fallbacks plus id branches. `test/backend-integrations.test.js` runs over all eleven
renderer files (id comparison check, literal counter, no-table-keyed-by-backend-id). Clean a file →
add it to `ALLOWED_BINDINGS`.

**`window._defaultBackendId` is already resolved — never rescue it.** It is the stored target while
still launchable, else the first launchable, else `''` (`resolveDefaultTarget`). So
`_defaultBackendId || <anything>` means the `<anything>` is a bug. That is the whole of #225: sixteen
sites across eight files each patched the same value instead of fixing it once.

**A per-backend TABLE in the renderer is the descriptor's data in the wrong process.** The blurbs
lived in `backends-panel.js` as `{ claude: '…', codex: '…' }` — a new backend had to edit the
renderer to look finished, and one whose author forgot rendered a blank line. Declare it on the
descriptor and project it through `backends-list`. Same for artwork (`icon`), the Endpoint fields
(`endpointEnv`) and backend-owned extras (`integrations`).

## A new control inherits NO styling

A button with only a behaviour class renders as the browser's native control — a white box with
black text next to your styled ones. Reuse an existing class (`.settings-action-btn`,
`.new-session-secondary-btn`, `.backend-btn`, …) or add one; never ship a bare `<button>`. Same for
popovers and overlays. This has bitten repeatedly.

**A dialog that holds work must not be dismissible by accident.** A stray backdrop click or a
reflexive Escape closes a `showControlDialog` — fine for a question, wrong for anything holding
something the user cannot get back (a handoff packet an agent spent tokens writing). Pass
`dismissible: false`, or ask before discarding.

## `src/shared/`

The four modules **both processes load** — `attention-source`, `custom-launchers`,
`variable-insert`, `preview-kind`. `require()`d in main, a global in the renderer (which has no
require — plain `<script>` tags). The preview in main must compute with the same code the insert runs
in the renderer; two copies would be a bug factory. **Nothing else belongs here.**
