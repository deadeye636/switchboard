// vm.runInContext tests for shell/attention-engine.js — "Ready" and "Working" are mutually exclusive,
// and a session that reaches the contradiction anyway can get out of it (#252).
//
// WHY THIS EXISTS:
//   The two states describe the same session at the same instant, so both being set is not a cosmetic
//   glitch: the status chip reads "Ready" while the dot beside it spins "Working". The engine kept them
//   exclusive on every path it owned, and the grid's bulk "mark all ready seen" undo wrote the Set
//   directly, restoring a stale ready flag onto a session that had started a new turn in the meantime.
//
//   What made it a defect worth a P1 rather than a blink was the recovery: setActivity returned early
//   for a ready session on BOTH edges, so the busy→idle edge that would have cleared the busy flag was
//   swallowed too. The session stayed contradictory until its PTY died. These tests pin the guard and
//   the recovery separately, because fixing either alone leaves the bug.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

function setup({ activeSessionId = null } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();

  const state = {
    attentionSessions: new Set(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map(),
    attentionReason: new Map(),
    finishedAt: new Map(),
    activePtyIds: new Set(),
    openSessions: new Map(),
    lastActivityTime: new Map(),
  };
  Object.assign(window, state);
  window.activeSessionId = activeSessionId;
  window.appGlobalSettings = { notifications: { sound: false } };
  window.refreshSessionStatusViews = () => {};
  window.recordTimelineEvent = () => {};
  window.getAllKnownSessionsForStatus = () => [];
  window.reduceAttention = (prev, next) => next;
  // app.js's row lookup (#289) — the engine paints EVERY rendered row of a session, and this DOM has none.
  window.sessionRowEls = (sessionId, root = window.document) =>
    root.querySelectorAll(`.session-item[data-session-id="${sessionId}"]`);

  vm.runInContext(fs.readFileSync(path.join(REN, 'shell', 'attention-engine.js'), 'utf8'), ctx,
    { filename: 'shell/attention-engine.js' });

  const call = name => vm.runInContext(name, ctx);
  return {
    state, call,
    ready: id => state.responseReadySessions.has(id),
    busy: id => state.sessionBusyState.get(id) === true,
    destroy: () => window.close(),
  };
}

// --- The guard: nothing can set "ready" on a session that is working ---

test('a working session cannot be marked ready', () => {
  const t = setup();
  try {
    t.call('setActivity')('s1', true);
    assert.equal(t.busy('s1'), true);

    assert.equal(t.call('markResponseReady')('s1'), false,
      'the call reports that it refused, so a caller can tell');
    assert.equal(t.ready('s1'), false);
  } finally { t.destroy(); }
});

test('an idle session can be marked ready', () => {
  const t = setup();
  try {
    assert.equal(t.call('markResponseReady')('s1'), true);
    assert.equal(t.ready('s1'), true);
    assert.equal(t.busy('s1'), false);
  } finally { t.destroy(); }
});

// This is the sequence the bulk-undo produced: ready → seen → new turn starts → undo. The restore must
// not put the session back to ready, because by then it is working.
test('restoring a stale ready set skips the sessions that went busy meanwhile', () => {
  const t = setup();
  try {
    for (const id of ['a', 'b']) {
      t.call('setActivity')(id, true);
      t.call('setActivity')(id, false);
    }
    assert.equal(t.ready('a') && t.ready('b'), true, 'both finished unfocused → ready');

    const cleared = ['a', 'b'];
    for (const id of cleared) t.state.responseReadySessions.delete(id);
    t.call('setActivity')('b', true);            // b starts a new turn

    for (const id of cleared) t.call('markResponseReady')(id);   // the undo

    assert.equal(t.ready('a'), true, 'a was still idle — it comes back');
    assert.equal(t.ready('b'), false, 'b is working now; it must not also claim to be ready');
    assert.equal(t.busy('b'), true, 'and it keeps saying so');
  } finally { t.destroy(); }
});

// --- The recovery: the contradiction must not be a trap ---

test('a session that is somehow both ready and busy recovers on the next idle edge', () => {
  const t = setup();
  try {
    // Force the state the guard now prevents — the point is that the engine survives it, whatever
    // future path recreates it.
    t.state.sessionBusyState.set('s1', true);
    t.state.responseReadySessions.add('s1');

    t.call('setActivity')('s1', false);

    assert.equal(t.busy('s1'), false,
      'the busy→idle edge must not be swallowed just because the session is flagged ready');
  } finally { t.destroy(); }
});

test('...and an OSC idle signal gets it out too, not just a direct call', () => {
  const t = setup();
  try {
    t.state.sessionBusyState.set('s1', true);
    t.state.responseReadySessions.add('s1');

    t.call('applyAttention')('s1', { kind: 'idle', reason: 'agent went quiet', source: 'osc' });

    assert.equal(t.busy('s1'), false, 'recovery cannot depend on the user focusing the session');
  } finally { t.destroy(); }
});

// --- What the guard must NOT break ---
//
// The early return exists for a reason: the OSC busy heuristic fires on spinner frames, and a session
// waiting to be read should not flicker back to Working over one. Only the exact hook signal clears it.

test('an OSC busy guess still does not drag a ready session back to Working', () => {
  const t = setup();
  try {
    t.call('markResponseReady')('s1');

    t.call('setActivity')('s1', true);

    assert.equal(t.busy('s1'), false, 'the ready session ignores the busy guess');
    assert.equal(t.ready('s1'), true);
  } finally { t.destroy(); }
});

test('an exact hook busy signal does clear ready and starts the turn', () => {
  const t = setup();
  try {
    t.call('markResponseReady')('s1');

    t.call('applyAttention')('s1', { kind: 'busy', reason: 'turn started', source: 'hook' });

    assert.equal(t.ready('s1'), false, 'applyAttention clears ready before setting busy');
    assert.equal(t.busy('s1'), true);
  } finally { t.destroy(); }
});

// The focused session is the one the user is looking at, so it is never "ready for review".
test('a focused session finishing does not become ready', () => {
  const t = setup({ activeSessionId: 's1' });
  try {
    t.call('setActivity')('s1', true);
    t.call('setActivity')('s1', false);

    assert.equal(t.ready('s1'), false);
    assert.equal(t.busy('s1'), false);
  } finally { t.destroy(); }
});
