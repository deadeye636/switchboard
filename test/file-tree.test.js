'use strict';

// The List / Tree layout helper of the changed-file lists (#894): how a group's files become flat tree rows, where folder
// chains are joined, what a fold hides, which folders a path sits in, and that a missing or throwing storage reads as
// the default. The two pages that draw with it are `test/session-changes-details-page.test.js` and
// `test/changed-files-page.test.js`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FILE_LIST_LAYOUT_KEY, fileTreeRows, fileTreeAncestors, readFileListLayout, writeFileListLayout,
} = require('../src/renderer/lib/file-tree.js');

const shape = (rows) => rows.map((r) => (r.kind === 'dir' ? `${'  '.repeat(r.depth)}${r.name}/ (${r.count})` : `${'  '.repeat(r.depth)}${r.name}`));
const byPath = (p) => p;

test('folders come first, each level sorted by name, and a chain of single folders is one row', () => {
  const rows = fileTreeRows(['src/renderer/shell/b.js', 'src/renderer/shell/a.js', 'src/app/x.js', 'README.md', 'docs/specs/README.md'], byPath);
  assert.deepEqual(shape(rows), [
    'docs/specs/ (1)',
    '  README.md',
    'src/ (3)',
    '  app/ (1)',
    '    x.js',
    '  renderer/shell/ (2)',
    '    a.js',
    '    b.js',
    'README.md',
  ]);
  assert.equal(rows.find((r) => r.name === 'renderer/shell').path, 'src/renderer/shell', 'a joined row carries the full path');
});

test('a folder that holds a file is not joined with the folder below it', () => {
  assert.deepEqual(shape(fileTreeRows(['a/one.js', 'a/b/two.js'], byPath)), ['a/ (2)', '  b/ (1)', '    two.js', '  one.js']);
});

test('a folded folder keeps its row and hides what is under it', () => {
  const rows = fileTreeRows(['src/a/x.js', 'src/a/y.js', 'src/b.js'], byPath, (p) => p === 'src/a');
  assert.deepEqual(shape(rows), ['src/ (3)', '  a/ (2)', '  b.js']);
  assert.equal(rows[1].collapsed, true);
});

test('items keep their identity and empty paths are dropped', () => {
  const items = [{ p: 'a/x.js' }, { p: '' }, { p: null }];
  const rows = fileTreeRows(items, (i) => i.p);
  assert.equal(rows.filter((r) => r.kind === 'file').length, 1);
  assert.equal(rows.find((r) => r.kind === 'file').item, items[0]);
});

test('the folders a path sits in, outermost first', () => {
  assert.deepEqual(fileTreeAncestors('src/renderer/shell/a.js'), ['src', 'src/renderer', 'src/renderer/shell']);
  assert.deepEqual(fileTreeAncestors('README.md'), []);
});

test('the stored layout reads as list unless it says tree, and a throwing storage is harmless', () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  assert.equal(readFileListLayout(storage), 'list');
  writeFileListLayout(storage, 'tree');
  assert.equal(mem.get(FILE_LIST_LAYOUT_KEY), 'tree');
  assert.equal(readFileListLayout(storage), 'tree');
  writeFileListLayout(storage, 'something');
  assert.equal(readFileListLayout(storage), 'list');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readFileListLayout(broken), 'list');
  assert.doesNotThrow(() => writeFileListLayout(broken, 'tree'));
  assert.equal(readFileListLayout(null), 'list');
});
