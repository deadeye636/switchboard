'use strict';
// Every `<script>`/`<link>` an HTML page names must exist, and they must load in the same order as before.
//
// The renderer has no modules and no bundler, by design. `index.html` lists ~74 plain `<script src>` tags
// and **the order is load-bearing**: a file that reads another's global has to come after it. There is no
// import graph to check that, and no test loads the page — so both halves of "the page's script list is
// correct" were verified by nothing at all. A wrong path is a blank window; a wrong order is an
// `undefined` thrown somewhere far from the tag that caused it, and the suite stays green through both.
//
// The two halves, and why each has bitten or nearly bitten:
//
//   RESOLVES — `index.html` reaches OUT of its own folder for its vendored libs
//   (`../node_modules/@xterm/…`, 8 scripts + 1 stylesheet). Any change to where this file lives silently
//   invalidates all nine. A structure pass (#214) that counted three of them and fixed "the three" would
//   have shipped a window with no terminal and no morphdom.
//
//   ORDER — nothing else records it. The sequence lives only in the file, so any edit that reorders tags
//   (a merge, a careless insert, a codemod) is invisible until a user clicks the wrong thing.
//
// Written against the INVARIANT, not the location: paths resolve relative to each HTML file's own
// directory, and the snapshot holds basenames. So this test keeps working when `public/` moves to
// `src/renderer/` and when files are sorted into subfolders — the very passes it exists to guard.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGES = ['index.html', 'settings.html', 'changed-files.html'];

/** Where the renderer's pages live. One constant, so a move is a one-line change here. */
function pageDir() {
  for (const dir of [path.join(ROOT, 'public'), path.join(ROOT, 'src', 'renderer')]) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  assert.fail('no renderer directory found (looked for public/ and src/renderer/)');
}

/** The `src` of every `<script>` and the `href` of every stylesheet `<link>`, in document order. */
function refsOf(html) {
  const out = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*"([^"]+)"|<link\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1] || m[2]);
  return out;
}

const dirCache = new Map();
function entriesOf(dir) {
  if (!dirCache.has(dir)) {
    try { dirCache.set(dir, fs.readdirSync(dir)); } catch { dirCache.set(dir, null); }
  }
  return dirCache.get(dir);
}

/**
 * Case-SENSITIVE existence, for EVERY path segment.
 *
 * `fs.existsSync` says yes to `Sidebar.js` on Windows, and Linux is what ships — but checking only the
 * filename is not enough: `../node_modules/@Xterm/xterm/lib/xterm.js` would pass just as happily, because
 * the wrong case is in a *directory*. That gap grows the moment scripts live in subfolders
 * (`shell/icons.js`), which is exactly the move this test exists to guard. So walk down from the repo
 * root and compare each segment against its parent's real listing.
 */
function existsExact(file) {
  const rel = path.relative(ROOT, file);
  if (rel.startsWith('..')) return false;              // outside the repo: not ours to vouch for
  let cur = ROOT;
  for (const seg of rel.split(path.sep)) {
    const entries = entriesOf(cur);
    if (!entries || !entries.includes(seg)) return false;
    cur = path.join(cur, seg);
  }
  return true;
}

for (const page of PAGES) {
  test(`${page}: every script and stylesheet it names exists`, () => {
    const dir = pageDir();
    const refs = refsOf(fs.readFileSync(path.join(dir, page), 'utf8'));
    assert.ok(refs.length > 0, `${page} names no scripts at all — did the parser break?`);

    const missing = refs.filter(ref => !existsExact(path.resolve(dir, ref)));
    assert.deepEqual(missing, [], `${page} points at files that do not exist (or differ in case)`);
  });
}

test('index.html loads its vendored libs from node_modules', () => {
  const dir = pageDir();
  const refs = refsOf(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'));
  const vendored = refs.filter(r => r.includes('node_modules/'));

  // Counted, because "fix the ../node_modules paths" is a job you do by grepping, and a grep that finds
  // 3 of 9 leaves you with a page that half-loads. If a lib is added or dropped, update the number.
  assert.equal(vendored.length, 9, 'expected 9 vendored refs (xterm + 5 addons, morphdom, dompurify, xterm.css)');

  // The resolves-check above already proves they land somewhere real; this pins WHERE, so that moving the
  // page without re-depthing `../` fails here instead of in front of a user.
  for (const ref of vendored) {
    const resolved = path.resolve(dir, ref);
    assert.ok(
      resolved.startsWith(path.join(ROOT, 'node_modules') + path.sep),
      `${ref} must resolve into the repo's node_modules, got ${resolved}`,
    );
  }
});

test('the script order is the order the snapshot recorded', () => {
  const dir = pageDir();
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'script-order.json'), 'utf8'));

  for (const page of PAGES) {
    const refs = refsOf(fs.readFileSync(path.join(dir, page), 'utf8'));
    const names = refs.filter(r => r.endsWith('.js')).map(r => path.basename(r));

    assert.deepEqual(
      names,
      snapshot[page],
      `${page}'s script order changed.\n\n` +
      'If that was deliberate, update test/fixtures/script-order.json. If it was not, something ' +
      'reordered the tags — the renderer has no modules, so order decides which globals exist when.',
    );
  }
});
