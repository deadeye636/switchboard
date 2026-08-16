// Guards for the Live Preview wiring (#281).
//
// The decoration plugin itself is bundled ESM over CodeMirror — `node --test`
// cannot load it, and asserting on decoration ranges without a layout engine
// would test the mock rather than the feature. What IS worth guarding is the
// wiring around it, because every one of these is a silent failure: a compartment
// that is created but never applied, a mode that no longer switches the
// extension, an export the renderer reaches for by name.
//
// The behaviour itself is verified by driving the running app — see the issue.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const setup = read('renderer/jsonl/codemirror-setup.js');
const live = read('renderer/jsonl/live-markdown.js');
const panel = read('renderer/views/viewer-panel.js');
const toolbar = read('renderer/views/viewer-toolbar.js');

test('the bundle imports the live-preview module', () => {
  assert.match(setup, /import \{ livePreviewFor \} from '\.\/live-markdown'/);
});

test('both editor factories carry a live compartment and apply it', () => {
  for (const factory of ['createPlanEditor', 'createEditableViewer']) {
    const body = setup.slice(setup.indexOf(`function ${factory}(`));
    const end = body.indexOf('\n}\n');
    const src = body.slice(0, end);
    assert.match(src, /const liveCompartment = new Compartment\(\)/, `${factory}: no compartment`);
    assert.match(src, /liveCompartment\.of\(livePreviewFor\(/, `${factory}: compartment never applied`);
    assert.match(src, /view\._liveCompartment = liveCompartment/, `${factory}: compartment not exposed`);
  }
});

test('setLivePreview is exported on window and reconfigures the compartment', () => {
  assert.match(setup, /window\.setLivePreview = setLivePreview/);
  assert.match(setup, /_liveCompartment\.reconfigure\(livePreviewFor\(kind, imageBase\)\)/);
});

test('the mode control offers live / preview / text, in that order', () => {
  const ids = [...toolbar.matchAll(/\{ id: '(live|preview|text)', label:/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['live', 'preview', 'text']);
});

test('only the live mode turns the decorations on', () => {
  assert.match(panel, /setLivePreview\(this\.editorView, this\.viewMode === 'live' \? this\._formatKind : null/);
});

test('the stored mode migrates both legacies', () => {
  // 'true' / 'false' from the preview toggle, and 'edit' from before the source
  // mode grew a rendering of its own.
  assert.match(panel, /if \(stored === 'edit'\) return 'live'/);
  assert.match(panel, /if \(stored === 'true'\) return 'preview'/);
  assert.match(panel, /if \(stored === 'false'\) return this\._toolbarMode\(\)/);
});

test('the live module names its MIT sources', () => {
  // The repo is public; a derived implementation says where it came from.
  assert.match(live, /atomic-editor/);
  assert.match(live, /codemirror-live-markdown/);
});

test('every replace goes through the per-line splitter', () => {
  // A plugin-sourced Decoration.replace may not span a line break — CM6 throws.
  // pushReplace is the only thing allowed to build one.
  const splitterFrom = live.indexOf('function pushReplace');
  const splitterTo = live.indexOf('\n}\n', splitterFrom);
  assert.ok(splitterFrom > 0 && splitterTo > splitterFrom, 'pushReplace must exist');

  const outside = live.slice(0, splitterFrom) + live.slice(splitterTo);
  assert.equal((outside.match(/Decoration\.replace\(/g) || []).length, 0,
    'Decoration.replace belongs in pushReplace alone — every other site must call it');
  assert.ok(live.slice(splitterFrom, splitterTo).includes('Decoration.replace('));
});

test('the decorations rebuild on selection and focus, not only on edits', () => {
  // The reveal rule reads the selection and the focus state. Rebuilding on
  // docChanged alone would leave the markers hidden under the cursor.
  const updates = live.match(/update\.docChanged \|\| update\.selectionSet \|\| update\.focusChanged/g) || [];
  assert.equal(updates.length, 2, 'both the markdown and the html plugin need it');
});

test('the HTML text pass skips what the tree calls code', () => {
  // The pass matches raw text, so it cannot tell a real tag from one QUOTED in a
  // fence. `<u>x</u>` inside a code block is an example of the syntax, and
  // hiding its tags eats the thing the author was showing.
  assert.match(live, /codeRanges\.push\(\{ from: node\.from, to: node\.to \}\)/);
  assert.match(live, /if \(overlapsAny\(codeRanges, from, to\)\) continue/);
  assert.match(live, /decorateHtmlInline\(ranges, doc, activeLines, doc\.toString\(\), codeRanges\)/);
});

test('the whole tree is walked, not the viewport', () => {
  // A viewport-only walk rebuilds on every scroll, and ensureSyntaxTree is what
  // stops a long file rendering raw markers past the parser's first pass.
  assert.match(live, /ensureSyntaxTree\(state, doc\.length, 200\)/);
  assert.doesNotMatch(live, /view\.viewport/);
});
