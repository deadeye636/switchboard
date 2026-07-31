// vm.runInContext tests for shell/attention-engine.js — recording a turn's end does not depend on
// focus, raising it still does (#391).
//
// WHY THIS EXISTS:
//   The recap answers one question: what happened while I was away. It reads two timeline kinds to
//   decide whether anything is waiting — and both used to be recorded only for a session the user was
//   NOT looking at. The engine wrote them inside the same branch that decides whether to flag the
//   inbox, so the commonest case there is — work in a session, walk away from it, come back — left no
//   trace at all and the recap reported nothing waiting.
//
//   The two statements are different: "this turn ended" is a fact about the session, "and you were not
//   looking" is a fact about the user. Only the second one may gate the inbox, the badge and the chime.
//
//   The last test closes the loop through the pure recap builder, because that is the behaviour the
//   issue is about — the engine writing an event is only the means.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');
const { buildAwaySummary } = require(path.join(REN, 'shell', 'away-summary.js'));

function setup({ activeSessionId = null } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();

  const timeline = [];
  const sounds = [];

  Object.assign(window, {
    attentionSessions: new Set(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map(),
    attentionReason: new Map(),
    finishedAt: new Map(),
    activePtyIds: new Set(),
    openSessions: new Map(),
    lastActivityTime: new Map(),
  });
  window.activeSessionId = activeSessionId;
  window.appGlobalSettings = { notifications: { sound: true } };
  window.refreshSessionStatusViews = () => {};
  window.recordTimelineEvent = (sessionId, kind, label, detail) =>
    timeline.push({ sessionId, kind, label, detail, at: new Date() });
  window.getAllKnownSessionsForStatus = () => [];
  window.reduceAttention = (prev, next) => next;
  window.shouldPlayAttentionSound = () => { sounds.push(true); return false; };
  window.sessionRowEls = (sessionId, root = window.document) =>
    root.querySelectorAll(`.session-item[data-session-id="${sessionId}"]`);

  vm.runInContext(fs.readFileSync(path.join(REN, 'shell', 'attention-engine.js'), 'utf8'), ctx,
    { filename: 'shell/attention-engine.js' });

  const call = name => vm.runInContext(name, ctx);
  return {
    call, timeline, sounds, window,
    kinds: id => timeline.filter(e => e.sessionId === id).map(e => e.kind),
    ready: id => window.responseReadySessions.has(id),
    attention: id => window.attentionSessions.has(id),
    destroy: () => window.close(),
  };
}

// --- The turn ending ---

test('a focused session finishing records response-ready', () => {
  const t = setup({ activeSessionId: 's1' });
  try {
    t.call('setActivity')('s1', true);
    t.call('setActivity')('s1', false);
    assert.ok(t.kinds('s1').includes('response-ready'),
      'the recap has nothing to report without this event');
  } finally { t.destroy(); }
});

test('a focused session finishing is still not flagged as ready', () => {
  const t = setup({ activeSessionId: 's1' });
  try {
    t.call('setActivity')('s1', true);
    t.call('setActivity')('s1', false);
    assert.equal(t.ready('s1'), false,
      'the user is looking at it — recording is not raising');
  } finally { t.destroy(); }
});

test('an unfocused session finishing records and raises', () => {
  const t = setup({ activeSessionId: 'other' });
  try {
    t.call('setActivity')('s1', true);
    t.call('setActivity')('s1', false);
    assert.ok(t.kinds('s1').includes('response-ready'));
    assert.equal(t.ready('s1'), true);
  } finally { t.destroy(); }
});

test('the response-ready detail no longer claims the session was unfocused', () => {
  const t = setup({ activeSessionId: 's1' });
  try {
    t.call('setActivity')('s1', true);
    t.call('setActivity')('s1', false);
    const event = t.timeline.find(e => e.kind === 'response-ready');
    assert.doesNotMatch(event.detail, /focus/i,
      'it is recorded for the focused case too, so the old wording would be a lie');
  } finally { t.destroy(); }
});

// --- The agent asking for something ---

test('a focused session records needs-attention without an inbox flag', () => {
  const t = setup({ activeSessionId: 's1' });
  try {
    t.call('applyAttention')('s1', { kind: 'needs-attention', reason: 'waiting', source: 'hook' });
    assert.deepEqual(t.kinds('s1'), ['needs-attention']);
    assert.equal(t.attention('s1'), false, 'no inbox flag for a session in front of the user');
    assert.equal(t.window.attentionReason.has('s1'), false,
      'and no reason kept either — the focused path stays free of side effects');
    assert.deepEqual(t.sounds, [], 'no chime for a session the user is looking at');
  } finally { t.destroy(); }
});

test('an unfocused needs-attention is recorded exactly once', () => {
  const t = setup({ activeSessionId: 'other' });
  try {
    t.call('applyAttention')('s1', { kind: 'needs-attention', reason: 'waiting', source: 'hook' });
    assert.deepEqual(t.kinds('s1'), ['needs-attention'],
      'one event, not one per branch — the record moved, it was not duplicated');
    assert.equal(t.attention('s1'), true);
    assert.equal(t.sounds.length, 1);
  } finally { t.destroy(); }
});

// --- What the whole thing is for ---

test('the recap reports the session that finished while it was in front', () => {
  const t = setup({ activeSessionId: 's1' });
  try {
    const leftAt = new Date(Date.now() - 60_000);
    t.call('setActivity')('s1', true);
    t.call('setActivity')('s1', false);

    const summary = buildAwaySummary({
      events: t.timeline.filter(e => e.sessionId === 's1'),
      lastViewedAt: leftAt,
      now: new Date(),
    });
    assert.equal(summary.waitingOnYou, true,
      'this is the defect: the session you were working in when you left said nothing');
    assert.equal(summary.hasChanges, true);
  } finally { t.destroy(); }
});

// --- #395: the record-only twin, for a window that renders a session without owning the inbox -----
//
// The same vocabulary arrives on a channel the main window never receives. Everything it does must be
// visible only inside that window: its timeline, its own status map, its own tabs. Nothing may reach
// the sets the inbox, the badge and the chime are computed from — that is what keeps one inbox one.

test('a relayed busy signal makes the session working here', () => {
  const t = setup();
  try {
    t.call('recordAttentionSignal')('s1', { kind: 'busy', source: 'osc0' });
    assert.equal(t.window.sessionBusyState.get('s1'), true,
      'this is what the tabs read — without it a working session is drawn as idle');
    assert.deepEqual(t.kinds('s1'), ['busy']);
  } finally { t.destroy(); }
});

test('a relayed end-of-turn records what the recap needs and flags nothing', () => {
  const t = setup();
  try {
    t.call('recordAttentionSignal')('s1', { kind: 'busy', source: 'osc0' });
    t.call('recordAttentionSignal')('s1', { kind: 'ready', source: 'osc9' });

    assert.ok(t.kinds('s1').includes('response-ready'));
    assert.equal(t.window.sessionBusyState.get('s1'), false);
    assert.equal(t.ready('s1'), false,
      '"waiting for you" is an inbox statement, and the inbox is the main window\'s');
  } finally { t.destroy(); }
});

test('a relayed needs-attention records without an inbox flag, a reason or a chime', () => {
  const t = setup();
  try {
    t.call('recordAttentionSignal')('s1', { kind: 'needs-attention', reason: 'waiting', source: 'hook' });
    assert.deepEqual(t.kinds('s1'), ['needs-attention']);
    assert.equal(t.attention('s1'), false);
    assert.equal(t.window.attentionReason.has('s1'), false);
    assert.deepEqual(t.sounds, []);
  } finally { t.destroy(); }
});

test('a relayed signal this window has no surface for is ignored', () => {
  const t = setup();
  try {
    t.call('recordAttentionSignal')('s1', { kind: 'subagent-live-start', source: 'hook' });
    assert.deepEqual(t.kinds('s1'), [], 'the subagent strip lives in the sidebar, which is not here');
  } finally { t.destroy(); }
});

test('nothing is recorded for an empty signal', () => {
  const t = setup();
  try {
    t.call('recordAttentionSignal')('s1', null);
    t.call('recordAttentionSignal')(null, { kind: 'busy' });
    assert.deepEqual(t.timeline, []);
  } finally { t.destroy(); }
});

test('the recap in such a window can finally say something is waiting', () => {
  const t = setup();
  try {
    const leftAt = new Date(Date.now() - 60_000);
    t.call('recordAttentionSignal')('s1', { kind: 'busy', source: 'osc0' });
    t.call('recordAttentionSignal')('s1', { kind: 'idle', source: 'osc0' });

    const summary = buildAwaySummary({
      events: t.timeline.filter(e => e.sessionId === 's1'),
      lastViewedAt: leftAt,
      now: new Date(),
    });
    assert.equal(summary.waitingOnYou, true, 'the whole point of #395');
  } finally { t.destroy(); }
});

// --- The ready-guard, and why the busy carry must not go round it (#395, #252) --------------------

test('the record half deliberately has no ready-guard', () => {
  // It is the half that writes what happened, so it takes what it is given. That is exactly why its
  // callers matter: everything that could contradict the ready state has to come through setActivity.
  const t = setup({ activeSessionId: 'other' });
  try {
    t.call('setActivity')('s1', true);
    t.call('setActivity')('s1', false);
    assert.equal(t.ready('s1'), true);

    t.call('recordActivityEdge')('s1', true);
    assert.equal(t.window.sessionBusyState.get('s1'), true, 'no guard here — by design');
  } finally { t.destroy(); }
});

test('a window taking a busy session cannot contradict a ready flag', () => {
  // The busy carried with a handover comes from the title-spinner latch, which is the guess the guard
  // exists to disbelieve. This file runs in EVERY window, main included, and main is the one that marks
  // sessions ready — so going round the guard here recreates the state of #252, which nothing short of
  // the PTY dying could clear.
  const t = setup({ activeSessionId: 'other' });
  try {
    t.call('setActivity')('s1', true);
    t.call('setActivity')('s1', false);
    assert.equal(t.ready('s1'), true);

    t.call('setActivity')('s1', true);   // what adoptSession does when the handover says "busy"
    assert.equal(t.ready('s1'), true, 'still ready');
    assert.equal(t.window.sessionBusyState.get('s1'), false, 'and not working at the same time');
  } finally { t.destroy(); }
});

test('the handover in detach-window.js goes through the guarded door', () => {
  // A source check, because that file has no harness: the failure it pins is a call that LOOKS right.
  const src = fs.readFileSync(path.join(REN, 'shell', 'detach-window.js'), 'utf8');
  assert.doesNotMatch(src, /recordActivityEdge\s*\(/,
    'the busy carry must call setActivity — the record half skips the ready-guard');
});
