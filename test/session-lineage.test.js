'use strict';
// The Claude /clear parent resolver (#223). It is deliberately conservative: it re-keys ONLY when there is
// exactly one live session in the folder — the one that unambiguously cleared. With two or more, no
// folder-local signal (mtime, cwd, gitBranch) can tell the true parent from a bystander that just went idle
// (the parent's think-time before /clear puts its transcript's freeze OUTSIDE any birth window in ~95% of
// real clears, and a bystander frozen inside the window would be mis-picked — a mis-key collapses two tabs
// onto one id, worse than bailing). So these tests pin: one candidate → high, anything else → none.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveClearParent } = require('../src/session/session-lineage');

test('exactly one live session in the folder is the one that cleared → high', () => {
  assert.deepEqual(resolveClearParent({ candidates: [{ id: 'A' }] }), { parentId: 'A', confidence: 'high' });
});

test('no candidates → none', () => {
  assert.deepEqual(resolveClearParent({ candidates: [] }), { parentId: null, confidence: 'none' });
  assert.deepEqual(resolveClearParent({}), { parentId: null, confidence: 'none' });
});

test('two or more live sessions → none (never a guess — a mis-key is worse than the bail)', () => {
  assert.deepEqual(resolveClearParent({ candidates: [{ id: 'A' }, { id: 'B' }] }), { parentId: null, confidence: 'none' });
  assert.deepEqual(resolveClearParent({ candidates: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] }), { parentId: null, confidence: 'none' });
});

// The failure the conservative rule exists to prevent: two sessions live, one is a bystander that just
// finished a turn. There is no input that makes resolveClearParent pick the bystander (or anyone) when more
// than one session is live — it always bails, so nothing can be mis-keyed.
test('with a bystander present it never resolves anyone (no mis-key path exists)', () => {
  assert.equal(resolveClearParent({ candidates: [{ id: 'parent' }, { id: 'bystander' }] }).confidence, 'none');
});
