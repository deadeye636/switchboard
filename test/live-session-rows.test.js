'use strict';
// Which running sessions the window has to invent a row for (#461).
//
// A session whose backend never recorded it is in no index, so the sidebar and `sessionMap` — both built
// from the index — do not have it. It is drawn only out of renderer memory, which a reload empties while
// the process keeps running. The decision about what to invent, hand over and reap lives here so it can
// be driven without a renderer; app.js does the DOM half.

const test = require('node:test');
const assert = require('node:assert/strict');

const { planLiveSessionRows } = require('../src/renderer/session/live-session-rows');

const live = (sessionId, over = {}) => ({ sessionId, projectPath: '/p', backendId: 'hermes', ...over });
const ids = (list) => list.map((e) => e.sessionId);

test('a running session the window knows nothing about gets a row', () => {
  const plan = planLiveSessionRows([live('s1')], { known: new Set(), synthetic: new Set() });

  assert.deepEqual(ids(plan.add), ['s1']);
  assert.deepEqual(plan.drop, []);
});

test('a session the index already holds is left alone', () => {
  // The whole point: this invents rows for what the index cannot see, and never a second one for what it can.
  const plan = planLiveSessionRows([live('s1')], { known: new Set(['s1']), synthetic: new Set() });

  assert.deepEqual(plan.add, []);
});

test('an invented row is re-offered every pass, because the lists it was in are replaced', () => {
  // `loadProjects` swaps both cached lists wholesale on every store write. A row inserted once and then
  // trusted would be gone within the second, which is why this is a recompute and not an accumulation.
  const plan = planLiveSessionRows([live('s1')], { known: new Set(['s1']), synthetic: new Set(['s1']) });

  assert.deepEqual(ids(plan.add), ['s1']);
});

test('an invented row whose process is gone is reaped', () => {
  const plan = planLiveSessionRows([], { known: new Set(['s1']), synthetic: new Set(['s1']) });

  assert.deepEqual(plan.drop, ['s1']);
  assert.deepEqual(plan.add, []);
});

test('adoption needs no special case: the old id is reaped and the new one invented in one pass', () => {
  // A backend that names its own session is re-keyed onto its id. It stops being live under the launch id
  // on the same tick the adopted one appears, so one pass does both — and the window never shows two rows.
  const plan = planLiveSessionRows([live('codex-real')], {
    known: new Set(['temp-1']), synthetic: new Set(['temp-1']),
  });

  assert.deepEqual(plan.drop, ['temp-1']);
  assert.deepEqual(ids(plan.add), ['codex-real']);
});

test('a row the index has taken over is released, not reaped', () => {
  // Once the record is written the session is the index's. Keeping the claim would mean reaping a row that
  // belongs to somebody else the moment the session ends — the cached-answer bug this avoids.
  const plan = planLiveSessionRows([live('s1')], {
    indexedIds: new Set(['s1']), known: new Set(['s1']), synthetic: new Set(['s1']),
  });

  assert.deepEqual(plan.release, ['s1']);
  assert.deepEqual(plan.drop, []);
  assert.deepEqual(plan.add, [], 'and it is not re-offered under the index\'s feet');
});

test('a released row that later exits is no longer this window\'s to reap', () => {
  // The pass after the hand-off: the id is out of `synthetic`, so its disappearance is the index's news.
  const plan = planLiveSessionRows([], { known: new Set(['s1']), synthetic: new Set() });

  assert.deepEqual(plan.drop, []);
});

test('a plain terminal is never invented', () => {
  // It has its own path, and a row without `type: 'terminal'` survives the quit-restore's filter — which
  // would then resume a shell as a CLI session, a fresh shell wearing the old session's name.
  const plan = planLiveSessionRows([live('t1', { isPlainTerminal: true })], {
    known: new Set(), synthetic: new Set(),
  });

  assert.deepEqual(plan.add, []);
});

test('a live entry with nothing to place it is skipped', () => {
  // No project path means no group to insert the row into; a row with no id is not a row.
  const plan = planLiveSessionRows(
    [live('s1', { projectPath: '' }), { sessionId: '', projectPath: '/p' }, null],
    { known: new Set(), synthetic: new Set() },
  );

  assert.deepEqual(plan.add, []);
});

test('no live answer at all reaps every invented row rather than freezing them', () => {
  // What the poll passes when main answered with nothing. An invented row asserts a running process; with
  // no process reported there is nothing left to assert.
  const plan = planLiveSessionRows(null, { known: new Set(['s1']), synthetic: new Set(['s1']) });

  assert.deepEqual(plan.drop, ['s1']);
});

test('called with no state at all it decides nothing', () => {
  const plan = planLiveSessionRows([live('s1')]);
  assert.deepEqual(ids(plan.add), ['s1'], 'a window with no sessions yet still gets the row');
  assert.deepEqual(plan.drop, []);
  assert.deepEqual(plan.release, []);
});
