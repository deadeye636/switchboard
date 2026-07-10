// Tests for the session visit history (#36).
//
// The load-bearing rule: navigating *via back* must not rewrite the history.
// Getting that wrong is the classic browser-history bug — the forward tail
// disappears the moment you step backwards, and back/forward degenerates into
// "toggle between the last two".

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_HISTORY_CAP,
  createSessionHistory,
  visitSession,
  pruneHistory,
  canGoBack,
  canGoForward,
  historyBack,
  historyForward,
} = require('../public/session-history');

const alive = () => true;

function historyOf(ids, { cap } = {}) {
  const store = createSessionHistory(cap ? { cap } : {});
  for (const id of ids) visitSession(store, id);
  return store;
}

// --- Recording ---------------------------------------------------------------

test('a fresh history has nowhere to go', () => {
  const store = createSessionHistory();
  assert.equal(store.cursor, -1);
  assert.equal(canGoBack(store), false);
  assert.equal(canGoForward(store), false);
  assert.equal(historyBack(store, alive), null);
  assert.equal(historyForward(store, alive), null);
});

test('visits accumulate and the cursor tracks the newest entry', () => {
  const store = historyOf(['a', 'b', 'c']);
  assert.deepEqual(store.entries, ['a', 'b', 'c']);
  assert.equal(store.cursor, 2);
  assert.equal(canGoBack(store), true);
  assert.equal(canGoForward(store), false, 'nothing ahead of the newest entry');
});

test('re-visiting the current session is a no-op', () => {
  // Guards against a re-render or a redundant focus call stacking duplicates.
  const store = historyOf(['a', 'b']);
  visitSession(store, 'b');
  visitSession(store, 'b');
  assert.deepEqual(store.entries, ['a', 'b']);
  assert.equal(store.cursor, 1);
});

test('re-visiting an earlier session appends it rather than jumping the cursor', () => {
  const store = historyOf(['a', 'b', 'a']);
  assert.deepEqual(store.entries, ['a', 'b', 'a']);
  assert.equal(store.cursor, 2);
});

test('visiting from the middle abandons the forward tail', () => {
  const store = historyOf(['a', 'b', 'c']);
  historyBack(store, alive); // at 'b'
  visitSession(store, 'd');
  assert.deepEqual(store.entries, ['a', 'b', 'd'], "'c' is gone");
  assert.equal(canGoForward(store), false);
});

test('the history is capped, dropping the oldest entries', () => {
  const store = historyOf(['a', 'b', 'c', 'd'], { cap: 3 });
  assert.deepEqual(store.entries, ['b', 'c', 'd']);
  assert.equal(store.cursor, 2, 'cursor still points at the newest entry');
  assert.equal(DEFAULT_HISTORY_CAP, 50);
});

// --- Back / forward ----------------------------------------------------------

test('back then forward returns to where it started', () => {
  const store = historyOf(['a', 'b', 'c']);
  assert.equal(historyBack(store, alive), 'b');
  assert.equal(historyBack(store, alive), 'a');
  assert.equal(historyBack(store, alive), null, 'cannot go past the oldest entry');
  assert.equal(historyForward(store, alive), 'b');
  assert.equal(historyForward(store, alive), 'c');
  assert.equal(historyForward(store, alive), null, 'cannot go past the newest entry');
});

test('stepping back does not rewrite the history', () => {
  // The whole point: back/forward moves the cursor, it does not record a visit.
  const store = historyOf(['a', 'b', 'c']);
  historyBack(store, alive);
  historyBack(store, alive);
  assert.deepEqual(store.entries, ['a', 'b', 'c'], 'entries untouched');
  assert.equal(store.cursor, 0);
  assert.equal(canGoForward(store), true, 'the forward tail survived');
});

// --- Dead entries ------------------------------------------------------------

test('back skips a session that no longer exists', () => {
  const store = historyOf(['a', 'gone', 'c']);
  const isAlive = (id) => id !== 'gone';
  assert.equal(historyBack(store, isAlive), 'a');
  assert.deepEqual(store.entries, ['a', 'c'], 'the dead entry is dropped, not just skipped');
});

test('pruning keeps the cursor on the entry it pointed at', () => {
  const store = historyOf(['a', 'b', 'c', 'd']);
  historyBack(store, alive); // cursor at 'c'
  pruneHistory(store, (id) => id !== 'a');
  assert.deepEqual(store.entries, ['b', 'c', 'd']);
  assert.equal(store.entries[store.cursor], 'c', 'still pointing at c');
});

test('pruning the current entry falls back to the nearest survivor before it', () => {
  const store = historyOf(['a', 'b', 'c']);
  historyBack(store, alive); // cursor at 'b'
  pruneHistory(store, (id) => id !== 'b');
  assert.deepEqual(store.entries, ['a', 'c']);
  assert.equal(store.entries[store.cursor], 'a');
});

test('a history whose sessions are all gone is emptied', () => {
  const store = historyOf(['a', 'b']);
  pruneHistory(store, () => false);
  assert.deepEqual(store.entries, []);
  assert.equal(store.cursor, -1);
  assert.equal(historyBack(store, () => false), null);
});

test('back returns null when only the current session survives', () => {
  const store = historyOf(['gone', 'b']);
  assert.equal(historyBack(store, (id) => id !== 'gone'), null);
  assert.deepEqual(store.entries, ['b']);
});

// --- Guards ------------------------------------------------------------------

test('visitSession ignores a missing store or id', () => {
  const store = createSessionHistory();
  visitSession(store, null);
  visitSession(null, 'a');
  assert.deepEqual(store.entries, []);
});

test('navigation without an isAlive function still moves the cursor', () => {
  const store = historyOf(['a', 'b']);
  assert.equal(historyBack(store), 'a');
  assert.equal(historyForward(store), 'b');
});
