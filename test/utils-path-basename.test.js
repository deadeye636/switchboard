'use strict';
// pathBasename (src/renderer/lib/utils.js, #564): the last segment of a path, whichever separator built it.
// The renderer has no `path` module; a '/'-only split kept a whole Windows path as a tab label.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({ window: {}, document: {}, console });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'utils.js'), 'utf8') +
  '\nthis.__pathBasename = pathBasename;', ctx);
const pathBasename = ctx.__pathBasename;

test('pathBasename handles both separators and mixed ones', () => {
  assert.equal(pathBasename('/p/skills/a/SKILL.md'), 'SKILL.md');
  assert.equal(pathBasename(String.raw`<project>\skills\a\SKILL.md`), 'SKILL.md');
  assert.equal(pathBasename(String.raw`<project>/skills\a/notes.md`), 'notes.md');
});

test('pathBasename ignores trailing separators and answers empty when there is no segment', () => {
  assert.equal(pathBasename('/p/dir/'), 'dir');
  assert.equal(pathBasename(''), '');
  assert.equal(pathBasename('/'), '');
  assert.equal(pathBasename(null), '');
  assert.equal(pathBasename(undefined), '');
});
