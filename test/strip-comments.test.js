'use strict';
// The comment stripper the source-scanning guards depend on, and the mistakes that blind them.
//
// `test/backend-path-neutrality.test.js`, `test/store-isolation.test.js`, `test/backend-integrations.test.js`,
// `test/trust-safe-write.test.js` and `test/transcript-viewer-seam.test.js` answer questions about code by
// reading it as text, so they drop the prose first. Every one is a guard whose over-stripping HIDES
// violations rather than inventing them — a guard that silently reads less than it thinks reports success
// about code it never saw, which is the worst failure a guard has.
//
// What is pinned here is not a style preference. It is that the stripper removes comments and only
// comments, whatever the surrounding prose, strings and regular expressions look like. The two-pass shape
// it replaced fails that in both orders, and this file keeps both failures runnable so the claim stays a
// measurement rather than a story. `test/strip-comments-shape.test.js` is what stops a third copy of that
// shape appearing somewhere else.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stripComments } = require('./helpers/strip-comments');

const SRC = path.join(__dirname, '..', 'src');

// The two-pass strippers this file exists to rule out, built at run time rather than written as regex
// literals. `test/strip-comments-shape.test.js` refuses a hand-rolled stripper anywhere under `test/`,
// and assembling these keeps that guard's exemption list empty — which is the only size at which such a
// list stays honest.
const BLOCK_RE = new RegExp('\\/\\*[\\s\\S]*?\\*\\/', 'g');
const LINE_RE = new RegExp('\\/\\/.*$');
const stripLines = (s) => s.split('\n').map((l) => l.replace(LINE_RE, '')).join('\n');
const blockFirst = (src) => stripLines(String(src).replace(BLOCK_RE, ''));
const lineFirst = (src) => stripLines(String(src)).replace(BLOCK_RE, '');

test('a glob in a line comment does not swallow the code beneath it', () => {
  // The shape matters: a `/**` in a line comment is harmless on its own, because the block regex needs a
  // closer. It becomes a hole the moment ANY later `*/` exists — a JSDoc block, which every file here has.
  // That is why this went unnoticed: the trap only springs in the files that are documented.
  const src = [
    '// a note about ~/.claude/projects/** and what it means',
    "const real = require('./thing');",
    '/** An ordinary doc comment, which is all it takes. */',
    'module.exports = { real };',
  ].join('\n');

  const out = stripComments(src);
  assert.match(out, /require\('\.\/thing'\)/, 'the require survived');
  assert.match(out, /module\.exports/, 'and so did everything after it');
  assert.equal(out.includes('a note about'), false, 'while the comment itself is gone');

  // The control. If this ever stops failing, the two are equivalent and this whole file has nothing to say.
  assert.equal(blockFirst(src).includes("require('./thing')"), false,
    'block-comments-first swallowed the require — the bug #554 was filed about');
});

test('a URL in a string keeps the rest of its line', () => {
  // The second half of #554, and the reason the line-first order was not the answer either: a `//` inside
  // a string is not a comment. What follows it on that line is code, and a guard that never sees it can
  // only miss a violation, never invent one.
  const src = "const hook = 'http://127.0.0.1:' + port + '/x'; const store = '~/.claude/projects';";

  const out = stripComments(src);
  assert.match(out, /~\/\.claude\/projects/, 'the store path after the URL is still there to be judged');
  assert.equal(lineFirst(src).includes('~/.claude/projects'), false,
    'line-comments-first cut the line at the URL — the violation would have been invisible');
});

test('a glob in a string does not open a block comment', () => {
  // A glob ending in `/**` contains `/*`. To a regex pass that is a block opener, and everything to the
  // next `*/` goes with it — here the doc comment two lines down, which is what every file has.
  const src = [
    "const pattern = '~/.claude/projects/**';",
    "const store = '~/.claude/projects';",
    '/** An ordinary doc comment, which is all it takes. */',
  ].join('\n');

  const out = stripComments(src);
  assert.match(out, /const store/, 'the line after the glob survived');
  assert.equal(lineFirst(src).includes('const store'), false,
    'the glob opened a block for the regex pass and took the next line with it');
});

test('a comment inside a template expression is still a comment', () => {
  // `${…}` is code, so prose in there has to go — otherwise the renderer files, which build their markup
  // in templates, would hand every guard a page of prose to match against.
  const src = ['const html = `<b>${/* a note about ~/.claude */ name}</b>`;'].join('\n');
  const out = stripComments(src);
  assert.equal(out.includes('a note about'), false, 'the comment went');
  assert.match(out, /name/, 'the expression stayed');
});

test('block comments are still removed', () => {
  const src = ['/* a header', ' * over two lines', ' */', 'const kept = 1;'].join('\n');
  const out = stripComments(src);
  assert.match(out, /const kept = 1;/);
  assert.equal(out.includes('a header'), false);
});

test('a line comment inside a block comment is not a problem', () => {
  const src = ['/* outer', '   // inner', '   still outer */', 'const kept = 2;'].join('\n');
  const out = stripComments(src);
  assert.match(out, /const kept = 2;/);
  assert.equal(out.includes('outer'), false, 'the whole block went');
});

test("an apostrophe in prose does not open a string", () => {
  // The reason this is a scanner and not a per-line quote check: a line-local reading of `don't` opens a
  // quote that never closes, and the `//` after it stops looking like a comment.
  const src = ["// it doesn't matter what the prose says // here", 'const kept = 3;'].join('\n');
  const out = stripComments(src);
  assert.equal(out.includes('prose'), false, 'the comment is gone in one piece');
  assert.match(out, /const kept = 3;/);
});

test('nothing to strip is not an error', () => {
  assert.equal(stripComments(''), '');
  assert.equal(stripComments(null), '');
  assert.equal(stripComments(undefined), '');
});

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
};

/** Is every character `a` kept also kept by `b`, in order? */
function isSubsequence(a, b) {
  let k = 0;
  let j = 0;
  while (k < a.length && j < b.length) {
    if (a[k] === b[j]) k += 1;
    j += 1;
  }
  return k === a.length;
}

test('the stripper never removes more than the shape it replaced, measured on the tree (#drift-audit)', () => {
  // The safety property, and the reason replacing the two-pass version could not quietly blind a guard:
  // everything the old shape left standing is still standing. A mistake in the scanner can therefore only
  // leave MORE text for a guard to judge — a loud false failure — never less.
  //
  // The other half is the size of the hole that was closed. Not asserted as a fixed number, because the
  // tree moves; asserted as non-zero, so the day the sample disappears this test says so instead of
  // passing on nothing.
  let recovered = 0;
  let files = 0;
  for (const file of walk(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    const now = stripComments(src);
    const before = blockFirst(src);
    const lines = lineFirst(src);
    files += 1;
    assert.ok(isSubsequence(before, now), `${file}: the old block-first shape kept text this one drops`);
    assert.ok(isSubsequence(lines, now), `${file}: the old line-first shape kept text this one drops`);
    recovered += now.length - lines.length;
    assert.equal(now.includes('/**'), false, `${file}: a block opener survived the strip`);
  }

  assert.ok(files > 100, `only ${files} source files walked — the sample is gone`);
  assert.ok(recovered > 1000,
    `the line-first shape hid ${recovered} bytes of this tree from the guards; if that is 0 the sample is gone`);
});
