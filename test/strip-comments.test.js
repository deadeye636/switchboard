'use strict';
// The comment stripper two source-scanning guards depend on, and the one ordering mistake that blinds them.
//
// `test/backend-path-neutrality.test.js` and `test/store-isolation.test.js` answer questions about code by
// reading it as text, so they drop the prose first. Both are guards whose over-stripping HIDES violations
// rather than inventing them — a guard that silently reads less than it thinks reports success about code
// it never saw, which is the worst failure a guard has.
//
// This pins the order. It is not a style preference: with block comments removed first, a `/**` inside a
// LINE comment opens a block, and everything to the next `*/` vanishes. Four files in this repo trip that
// on ordinary prose — they mention globs like `~/.claude/projects/**` and `src/backends/**`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stripComments } = require('./helpers/strip-comments');

const SRC = path.join(__dirname, '..', 'src');

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

  // The control, kept inline rather than as a one-off mutation: the other order on the same input. If
  // this ever stops failing, the two are equivalent and this whole file has nothing to say.
  const blockFirst = String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert.equal(blockFirst.includes("require('./thing')"), false,
    'the old order swallowed the require — that is the bug this ordering exists to avoid');
});

test('block comments are still removed', () => {
  const src = ['/* a header', ' * over two lines', ' */', "const kept = 1;"].join('\n');
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

test('nothing to strip is not an error', () => {
  assert.equal(stripComments(''), '');
  assert.equal(stripComments(null), '');
  assert.equal(stripComments(undefined), '');
});

test('the order is what saves real files, measured on the tree (#drift-audit)', () => {
  const NEWLINE = String.fromCharCode(10);
  // A line comment whose `/**` reaches past the end of its own line is the trigger. Counted directly
  // rather than by diffing, because removing a block comment shifts every line index after it.
  const reachesPastItsLine = (src) => {
    let offset = 0;
    let bytes = 0;
    for (const line of src.split(NEWLINE)) {
      const slashes = line.indexOf('//');
      const open = line.indexOf('/**');
      if (slashes !== -1 && open > slashes) {
        const rest = src.slice(offset + open);
        const close = rest.indexOf('*/');
        const swallowed = close === -1 ? rest.length : close + 2;
        const toEndOfLine = line.length - open;
        if (swallowed > toEndOfLine) bytes += swallowed - toEndOfLine;
      }
      offset += line.length + 1;
    }
    return bytes;
  };

  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  };

  let lostByTheOldOrder = 0;
  for (const file of walk(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    lostByTheOldOrder += reachesPastItsLine(src);
    // The order in use must leave a line comment unable to open anything: whatever it removes, a `/**`
    // written as prose cannot be the cause.
    const stripped = stripComments(src);
    assert.equal(stripped.includes('/**'), false, `${file}: a block opener survived the strip`);
  }

  // Not asserted as a fixed number — the tree moves. What is asserted is that the trap is real here, so
  // this test is measuring something rather than passing on an empty set.
  assert.ok(lostByTheOldOrder > 1000,
    `the old order would swallow ${lostByTheOldOrder} bytes of this tree; if that is 0 the sample is gone`);
});
