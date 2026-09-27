// #677 — one reader for "which scripts does this page load".
//
// `test/helpers/page-scripts.js` is the only place a test may spell a pattern over a `<script>` or `<link>`
// tag. The copies it replaced were each flagged by CodeQL as `js/bad-tag-filter`, and they had already
// drifted apart in what spacing they accepted. This file pins what the helper reads, and refuses a new copy
// anywhere else under `test/` — a walk, not a list, so a test file written tomorrow is covered today.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pageRefsOf, scriptSrcsOf, pageScripts } = require('./helpers/page-scripts');
const { stripComments } = require('./helpers/strip-comments');

const TEST_DIR = __dirname;
const HELPER = path.join(TEST_DIR, 'helpers', 'page-scripts.js');

test('reads every script src in document order, whatever the spacing and attribute order', () => {
  const html = [
    '<link rel="stylesheet" href="style.css">',
    '<script src="a.js"></script>',
    '<script   src = "b.js" ></script>',
    '<script defer src="c.js"></script>',
    '<script type="module" src="d.js" async></script>',
    '<script data-src="not-a-ref.js"></script>',
    '<script>inline()</script>',
    '<SCRIPT SRC="e.js"></SCRIPT>',
    "<script src='f.js'></script>",
    '<script src=g.js></script>',
  ].join('\n');
  assert.deepEqual(scriptSrcsOf(html), ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js', 'g.js']);
  assert.deepEqual(pageRefsOf(html).map(r => `${r.tag}:${r.ref}`),
    ['link:style.css', 'script:a.js', 'script:b.js', 'script:c.js', 'script:d.js', 'script:e.js',
      'script:f.js', 'script:g.js']);
});

test('reads the real pages', () => {
  for (const page of ['index.html', 'settings.html', 'changed-files.html', 'diff-window.html']) {
    const srcs = pageScripts(page);
    assert.ok(srcs.length > 0, `${page} should load at least one script`);
    assert.ok(srcs.every(s => s.endsWith('.js')), `${page}: every script ref should be a .js file`);
  }
  assert.ok(pageScripts('index.html').length > 20, 'index.html loads the whole renderer');
});

// A line that names a `<script` or `<link` tag (however the `<` is spelled in a pattern) AND builds or runs
// a pattern. Line-based on purpose: it errs towards catching, and a false positive costs one line of review
// here. Checked against realistic copies below, so the guard is tested in both directions.
const TAG = /(?:<|\[<\]|\\x3c)(?:\\s[*+?]?)*(?:script|link)\b/i;
const PATTERN_USE = /matchAll\(|\.match\(|\.exec\(|\.test\(|RegExp\(|\.replace\(|\.split\(|=\s*\/|\(\s*\//;
const COPY = { test: (line) => TAG.test(line) && PATTERN_USE.test(line) };

test('the copy detector catches the shapes the old copies had', () => {
  for (const shape of [
    'const srcs = [...html.matchAll(/<script\\s+src="([^"]+)"><\\/script>/g)].map(m => m[1]);',
    'for (const m of html.matchAll(/<script src="([^"]+)"><\\/script>/g)) {',
    'assert.match(html, /<script\\s+src="x\\.js"><\\/script>/);',
    'const re = /<script\\b[^>]*\\bsrc\\s*=\\s*"([^"]+)"|<link\\b[^>]*>/gi;',
    'const re = new RegExp(\'<script[^>]*src="([^"]+)"\', \'g\');',
    'const re = /^\\s*<script src="([^"]+)"/gm;',
    'const re = /(<script)[^>]*src="([^"]+)"/g;',
    'const re = /<\\s*script[^>]*src="([^"]+)"/g;',
    'const re = /[<]script[^>]*src="([^"]+)"/g;',
    'const re = new RegExp(String.raw`<script[^>]*src="([^"]+)"`, "g");',
  ]) {
    assert.ok(COPY.test(shape), `should catch: ${shape}`);
  }
  for (const fine of [
    "const html = '<script src=\"a.js\"></script>';",
    'el.innerHTML = `<script>1</script>`;',
    'const n = a / b; const t = "<script";',
  ]) {
    assert.ok(!COPY.test(fine), `should not catch: ${fine}`);
  }
});

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'fixtures' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

test('no test keeps its own copy of the pattern — it asks test/helpers/page-scripts.js', () => {
  const offenders = [];
  for (const file of walk(TEST_DIR)) {
    if (file === HELPER || file === __filename) continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    code.split('\n').forEach((line, i) => {
      if (COPY.test(line)) offenders.push(`${path.relative(TEST_DIR, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [],
    'a tag pattern over a page belongs in test/helpers/page-scripts.js — call pageScripts(page), '
    + 'scriptSrcsOf(html) or pageRefsOf(html) instead of writing another one');
});
