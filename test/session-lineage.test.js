'use strict';
// The Claude /clear parent-resolution heuristic (#223 / #193). The signal is the mtime freeze: the parent
// stops writing the instant the child is born, so among several live sessions in one folder the parent is
// the lone one whose last write sits in a tight window just before the child's birth. #223 re-keys only on
// `high`; a wrong guess is worse than bailing, so these tests pin exactly when `high` is (and is not) given.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveClearParent } = require('../src/session/session-lineage');

const BIRTH = 1_000_000_000_000; // a fixed child-birth instant (ms)

test('a lone active session in the folder is the one that cleared → high', () => {
  assert.deepEqual(
    resolveClearParent({ childBirthMs: BIRTH, candidates: [{ id: 'A', mtimeMs: BIRTH - 100 }] }),
    { parentId: 'A', confidence: 'high' },
  );
});

test('no candidates → none', () => {
  assert.deepEqual(resolveClearParent({ childBirthMs: BIRTH, candidates: [] }), { parentId: null, confidence: 'none' });
});

test('the parent froze just before birth; an unrelated session still writing is excluded → high', () => {
  const r = resolveClearParent({
    childBirthMs: BIRTH,
    candidates: [
      { id: 'parent', mtimeMs: BIRTH - 300 },   // wrote just before the clear, then stopped
      { id: 'other', mtimeMs: BIRTH + 4000 },   // kept writing AFTER the birth → signed negative → excluded
    ],
  });
  assert.deepEqual(r, { parentId: 'parent', confidence: 'high' });
});

test('the parent froze just before birth; an unrelated IDLE session is far older → high', () => {
  const r = resolveClearParent({
    childBirthMs: BIRTH,
    candidates: [
      { id: 'parent', mtimeMs: BIRTH - 200 },
      { id: 'idle', mtimeMs: BIRTH - 600_000 },  // last wrote ten minutes ago → outside the window
    ],
  });
  assert.deepEqual(r, { parentId: 'parent', confidence: 'high' });
});

test('two candidates both froze in the window → ambiguous, low (never high, so #223 will bail)', () => {
  const r = resolveClearParent({
    childBirthMs: BIRTH,
    candidates: [
      { id: 'a', mtimeMs: BIRTH - 200 },
      { id: 'b', mtimeMs: BIRTH - 400 },
    ],
  });
  assert.equal(r.confidence, 'low');
  assert.equal(r.parentId, 'a'); // the closest, for #193 display only
});

test('no candidate froze in the window (all still writing, or all stale) → none', () => {
  assert.equal(resolveClearParent({
    childBirthMs: BIRTH,
    candidates: [
      { id: 'a', mtimeMs: BIRTH + 10_000 },   // still writing well past the birth
      { id: 'b', mtimeMs: BIRTH - 600_000 },  // stale
    ],
  }).confidence, 'none');
});

test('a small clock/fs skew around the birth is tolerated', () => {
  const r = resolveClearParent({
    childBirthMs: BIRTH,
    candidates: [
      { id: 'parent', mtimeMs: BIRTH + 500 },   // 500ms after birth — within SKEW, still counts
      { id: 'idle', mtimeMs: BIRTH - 600_000 },
    ],
  });
  assert.deepEqual(r, { parentId: 'parent', confidence: 'high' });
});
