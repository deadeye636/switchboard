// Guards for the gated reveal heal (#525, and #118 which it must not undo).
//
// The heal runs inside a WebGL renderer that `node --test` cannot create, so what is asserted here is the
// shape of the decision, not the pixels. Each of these is a silent failure: a reveal that wipes the shared
// atlas again brings back the unbounded glyph array, and a reveal that skips the model rebuild brings back
// the scrambled glyphs — neither shows up in any other test, and both look fine until minutes of
// alternating use.
//
// The behaviour itself is verified by driving the running app: reveal a busy session twice, open a second
// session, switch to it, switch back, and read the atlas's glyph count between switches.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'terminal', 'terminal-manager.js'),
  'utf8',
);

// The function body, so an assertion cannot be satisfied by some other part of the file.
function forceRepaintBody() {
  const start = source.indexOf('function forceRepaint(entry)');
  assert.notEqual(start, -1, 'forceRepaint is gone — the reveal heal has to live somewhere');
  const end = source.indexOf('\n}', start);
  return source.slice(start, end);
}

test('the shared atlas is wiped only inside a branch, never unconditionally', () => {
  const body = forceRepaintBody();
  assert.match(body, /if \([^)]*_atlasStructureAtPaint[^)]*\)[\s\S]*clearTextureAtlas\(\)/,
    'clearTextureAtlas must sit behind the structure comparison');
  // An `else` has to exist: the reveal that does NOT wipe still has to heal something.
  assert.match(body, /\}\s*else\s*\{/, 'the non-wiping branch is missing');
});

test('the non-wiping branch rebuilds this terminal\'s own model', () => {
  const body = forceRepaintBody();
  const elseBranch = body.slice(body.indexOf('} else {'));
  assert.match(elseBranch, /renderer\.clear\(\)/,
    'a repaint alone re-looks-up nothing: WebGL skips every unchanged cell, so the model must be cleared');
});

test('an unreadable atlas or renderer falls back to the old always-wipe behaviour', () => {
  const body = forceRepaintBody();
  assert.match(body, /structure === null/, 'a null structure has to force the wipe');
  assert.match(body, /typeof renderer\?\.clear !== 'function'/,
    'a renderer without clear() has to force the wipe rather than heal nothing');
});

test('the structure signature carries page count and canvas size, and NOT page.version', () => {
  const start = source.indexOf('function atlasStructure(entry)');
  assert.notEqual(start, -1, 'atlasStructure is gone');
  const body = source.slice(start, source.indexOf('\n}', start));
  assert.match(body, /_pages\.length/);
  assert.match(body, /canvas\.width/);
  assert.match(body, /canvas\.height/);
  // xterm bumps page.version on every glyph added, so a signature carrying it would differ on every
  // reveal and gate nothing — the exact mistake this guard exists to catch.
  assert.doesNotMatch(body, /\.version/, 'page.version must stay out of the signature');
});

test('the reveal callers still go through forceRepaint', () => {
  const panes = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'views', 'panes-view.js'),
    'utf8',
  );
  // With the semicolon, so the function's own declaration does not count as a call site.
  const reveals = source.match(/forceRepaint\(entry\);/g) || [];
  assert.ok(reveals.length >= 2, `expected both reveal paths to call forceRepaint, found ${reveals.length}`);
  assert.match(panes, /forceRepaint\(active\.entry\)/);
});
