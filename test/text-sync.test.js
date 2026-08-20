'use strict';
// #452 — applying an external rewrite to an open document without moving the reader.
//
// The old reload replaced the whole document, which is why the cursor jumped and the view scrolled away.
// These are the decisions that stop it, checked with strings rather than with an editor: the change that
// actually happened, where a position lands afterwards, and whether a reader was following the end.
const test = require('node:test');
const assert = require('node:assert/strict');

const { textSyncChange, mapPosition, isPinnedToBottom } = require('../src/renderer/views/text-sync');

/** Applying the returned change to the old text must reproduce the new text — the property that matters. */
function apply(oldText, change) {
  if (!change) return oldText;
  return oldText.slice(0, change.from) + change.insert + oldText.slice(change.to);
}

test('identical text is not a change', () => {
  assert.equal(textSyncChange('same', 'same'), null);
  assert.equal(textSyncChange('', ''), null);
});

test('a change touches only what moved', () => {
  const before = '# Plan\n\nstep one\nstep two\n';
  const c = textSyncChange(before, '# Plan\n\nstep ONE\nstep two\n');
  assert.equal(c.from, before.indexOf('one'), 'the change starts where the words diverge');
  assert.equal(c.to, before.indexOf('one') + 3);
  assert.equal(c.insert, 'ONE');
  assert.equal(apply('# Plan\n\nstep one\nstep two\n', c), '# Plan\n\nstep ONE\nstep two\n');
});

test('appending leaves the head alone', () => {
  const before = '# Plan\n\nstep one\n';
  const after = before + 'step two\n';
  const c = textSyncChange(before, after);
  assert.equal(c.from, before.length, 'nothing before the end is touched');
  assert.equal(c.to, before.length, 'an append deletes nothing');
  assert.equal(c.insert, 'step two\n');
});

test('deleting produces an empty insert', () => {
  const c = textSyncChange('a\nb\nc\n', 'a\nc\n');
  assert.equal(c.insert, '');
  assert.equal(apply('a\nb\nc\n', c), 'a\nc\n');
});

test('repeated surroundings do not produce a negative range', () => {
  // The naive head+tail trim overlaps here: both share "aa" at each end.
  const before = 'aaaa';
  const after = 'aaaaaa';
  const c = textSyncChange(before, after);
  assert.ok(c.to >= c.from, `from ${c.from} to ${c.to}`);
  assert.equal(apply(before, c), after);
});

test('a change into and out of an empty document round-trips', () => {
  assert.equal(apply('', textSyncChange('', 'hello')), 'hello');
  assert.equal(apply('hello', textSyncChange('hello', '')), '');
});

test('a boundary never lands inside a surrogate pair', () => {
  // Two different emoji share their leading surrogate, so a naive prefix match cuts between the halves.
  const before = 'x\u{1F600}y';
  const after = 'x\u{1F680}y';
  const c = textSyncChange(before, after);
  const result = apply(before, c);
  assert.equal(result, after);
  assert.equal([...result].length, 3, 'no lone surrogate survived');
});

test('a position before the change does not move', () => {
  const c = { from: 10, to: 13, insert: 'ONE' };
  assert.equal(mapPosition(0, c), 0);
  assert.equal(mapPosition(10, c), 10);
});

test('a position after the change shifts by the length difference', () => {
  const c = { from: 10, to: 13, insert: 'ONE LONGER' };
  assert.equal(mapPosition(20, c), 20 + ('ONE LONGER'.length - 3));
});

test('a position inside the change lands at the end of what replaced it', () => {
  const c = { from: 10, to: 20, insert: 'abc' };
  assert.equal(mapPosition(15, c), 13);
});

test('no change leaves a position alone, and junk does not throw', () => {
  assert.equal(mapPosition(7, null), 7);
  assert.equal(mapPosition(-5, { from: 0, to: 0, insert: '' }), 0);
});

test('a reader at the end is following the writer', () => {
  assert.equal(isPinnedToBottom(900, 100, 1000), true);
  assert.equal(isPinnedToBottom(880, 100, 1000), true, 'a few pixels short still counts');
  assert.equal(isPinnedToBottom(0, 100, 1000), false, 'someone reading the top is not');
});

test('a document shorter than its viewport is always at the end', () => {
  assert.equal(isPinnedToBottom(0, 500, 200), true);
});
