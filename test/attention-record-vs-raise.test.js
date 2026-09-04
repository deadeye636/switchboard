// vm.runInContext tests for shell/attention-engine.js — what this window RAISES, and what it no longer
// records (#391, then #396).
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
// WHAT #396 CHANGED, and why these tests still matter:
//   The RECORD moved to the main process, which sees the same edges one step earlier and holds them
//   where they survive this window (`src/app/timeline.js`, `test/timeline-signal.test.js`). So this
//   engine writes no events at all now — and the harness below deliberately does NOT define
//   `recordTimelineEvent`, so a call that creeps back in fails here with a ReferenceError rather than
//   quietly re-creating the second writer the two copies drifted between.
//
//   What this file pins is the half that did NOT move: which sessions get the inbox flag, the ready
//   class, the reason and the chime — all still focus-dependent, all still the main window's alone.
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
  // `recordTimelineEvent` is deliberately NOT defined (#396). It no longer exists in the renderer, and
  // the engine must not reach for it: if it does, these tests fail loudly instead of the app growing a
  // second writer nobody notices. `timeline` therefore stays empty — it is the assertion, not a spy.
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

test('a turn ending writes no event HERE any more', () => {
  const t = setup({ activeSessionId: 's1' });
  try {
    t.call('setActivity')('s1', true);
    t.call('setActivity')('s1', false);
    assert.deepEqual(t.timeline, [],
      'the record is the main process\'s since #396 — a second writer is how the copies drifted');
    assert.equal(t.window.finishedAt.has('s1'), true,
      'what stays is the status this window draws from: the finish stamp the running-inbox reads');
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

test('an unfocused session finishing is raised', () => {
  const t = setup({ activeSessionId: 'other' });
  try {
    t.call('setActivity')('s1', true);
    t.call('setActivity')('s1', false);
    assert.equal(t.ready('s1'), true);
    assert.deepEqual(t.timeline, [], 'raised here, recorded there');
  } finally { t.destroy(); }
});

// --- The agent asking for something ---

test('a focused session gets no inbox flag from needs-attention', () => {
  const t = setup({ activeSessionId: 's1' });
  try {
    t.call('applyAttention')('s1', { kind: 'needs-attention', reason: 'waiting', source: 'hook' });
    assert.deepEqual(t.timeline, []);
    assert.equal(t.attention('s1'), false, 'no inbox flag for a session in front of the user');
    assert.equal(t.window.attentionReason.has('s1'), false,
      'and no reason kept either — the focused path stays free of side effects');
    assert.deepEqual(t.sounds, [], 'no chime for a session the user is looking at');
  } finally { t.destroy(); }
});

test('an unfocused needs-attention is raised exactly once', () => {
  const t = setup({ activeSessionId: 'other' });
  try {
    t.call('applyAttention')('s1', { kind: 'needs-attention', reason: 'waiting', source: 'hook' });
    assert.equal(t.attention('s1'), true);
    assert.equal(t.sounds.length, 1);
    assert.deepEqual(t.timeline, []);
  } finally { t.destroy(); }
});

// --- What the whole thing is for ---
//
// The recap reads the record, and the record is main's. So this asserts on the events main writes for
// a turn that ended (`src/app/timeline.js` — `idle` then `response-ready`, with no focus condition),
// rather than on events the engine no longer produces. The behaviour under test is unchanged; where
// the input comes from is not.

test('the recap reports a session that finished while it was in front', () => {
  const leftAt = new Date(Date.now() - 60_000);
  const summary = buildAwaySummary({
    events: [
      { sessionId: 's1', kind: 'response-ready', label: 'Ready for review', at: new Date() },
      { sessionId: 's1', kind: 'idle', label: 'Agent idle', at: new Date() },
    ],
    lastViewedAt: leftAt,
    now: new Date(),
  });
  assert.equal(summary.waitingOnYou, true,
    'this is the defect: the session you were working in when you left said nothing');
  assert.equal(summary.hasChanges, true);
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
    assert.deepEqual(t.timeline, []);
  } finally { t.destroy(); }
});

test('a relayed end-of-turn updates this window\'s status and flags nothing', () => {
  const t = setup();
  try {
    t.call('recordAttentionSignal')('s1', { kind: 'busy', source: 'osc0' });
    t.call('recordAttentionSignal')('s1', { kind: 'ready', source: 'osc9' });

    assert.equal(t.window.sessionBusyState.get('s1'), false);
    assert.equal(t.window.finishedAt.has('s1'), true);
    assert.equal(t.ready('s1'), false,
      '"waiting for you" is an inbox statement, and the inbox is the main window\'s');
  } finally { t.destroy(); }
});

test('a relayed needs-attention raises no flag, keeps no reason and plays no chime', () => {
  const t = setup();
  try {
    t.call('recordAttentionSignal')('s1', { kind: 'needs-attention', reason: 'waiting', source: 'hook' });
    assert.equal(t.attention('s1'), false);
    assert.equal(t.window.attentionReason.has('s1'), false);
    assert.deepEqual(t.sounds, []);
  } finally { t.destroy(); }
});

test('a relayed signal this window has no surface for changes nothing', () => {
  const t = setup();
  try {
    t.call('recordAttentionSignal')('s1', { kind: 'subagent-live-start', source: 'hook' });
    assert.equal(t.window.sessionBusyState.has('s1'), false,
      'the subagent strip lives in the sidebar, which is not here');
  } finally { t.destroy(); }
});

test('an empty signal changes nothing', () => {
  const t = setup();
  try {
    t.call('recordAttentionSignal')('s1', null);
    t.call('recordAttentionSignal')(null, { kind: 'busy' });
    assert.equal(t.window.sessionBusyState.size, 0);
  } finally { t.destroy(); }
});

test('the recap in such a window can say something is waiting', () => {
  // Same shift as above: the events are the ones main writes for a turn that ended. What #395 fixed is
  // that a window of its own hears about that turn at all — which is now a fact about routing
  // (`app/detach.js`) and the record (`app/timeline.js`), not about what this engine writes.
  const leftAt = new Date(Date.now() - 60_000);
  const summary = buildAwaySummary({
    events: [{ sessionId: 's1', kind: 'response-ready', label: 'Ready for review', at: new Date() }],
    lastViewedAt: leftAt,
    now: new Date(),
  });
  assert.equal(summary.waitingOnYou, true, 'the whole point of #395');
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

// --- #529: a CLI blocked on its own prompt has stopped working -----------------------------------------
//
// "Needs You" is a main-window statement and stays one. "Working" is drawn wherever the session is, and a
// session waiting on a question is not working — so the ACTIVITY half of a waiting signal has to reach
// the window that renders it, even though the inbox half must not.
//
// This is the half the first pass missed: `recordAttentionSignal` had an empty `needs-attention` branch,
// so a detached window kept the spinner turning behind a flag it cannot see.

test('a waiting signal stops the spinner in the window that renders the session (#529)', () => {
  const t = setup({ activeSessionId: 'other' });
  try {
    t.call('recordAttentionSignal')('s1', { kind: 'busy', reason: 'terminal binding', source: 'bind' });
    assert.equal(t.window.sessionBusyState.get('s1'), true, 'the turn started');

    t.call('recordAttentionSignal')('s1', { kind: 'needs-attention', reason: 'Waiting for you to confirm', source: 'bind', busy: false });
    assert.equal(t.window.sessionBusyState.get('s1'), false, 'and the waiting prompt ended it');
  } finally { t.destroy(); }
});

test('a window that only records still raises nothing (#529)', () => {
  // The activity edge is all it takes. The inbox flag, the reason and the chime stay with the main
  // window — a second window announcing is #390, and this must not become a way back into it.
  const t = setup({ activeSessionId: 'other' });
  try {
    t.call('recordAttentionSignal')('s1', { kind: 'needs-attention', reason: 'Waiting for your input', source: 'bind', busy: false });
    assert.equal(t.attention('s1'), false, 'no inbox flag');
    assert.equal(t.window.attentionReason.has('s1'), false, 'no reason kept');
    assert.deepEqual(t.sounds, [], 'no chime');
    assert.deepEqual(t.timeline, [], 'and no event written here');
  } finally { t.destroy(); }
});

test('an attention signal WITHOUT an activity edge leaves the row alone (#529)', () => {
  // Every other source sends no `busy` field, and those must keep the behaviour they had: this window
  // has nothing to do with an attention signal it may not raise.
  const t = setup({ activeSessionId: 'other' });
  try {
    t.call('recordAttentionSignal')('s1', { kind: 'busy', reason: 'x', source: 'hook' });
    t.call('recordAttentionSignal')('s1', { kind: 'needs-attention', reason: 'Claude needs permission', source: 'hook' });
    assert.equal(t.window.sessionBusyState.get('s1'), true, 'still working — a permission prompt is not an idle edge');
  } finally { t.destroy(); }
});

test('the main window raises AND stops the spinner for a waiting signal (#529)', () => {
  const t = setup({ activeSessionId: 'other' });
  try {
    t.call('applyAttention')('s1', { kind: 'busy', reason: 'terminal binding', source: 'bind' });
    assert.equal(t.window.sessionBusyState.get('s1'), true);

    // Both halves reach the main window on their own channels — the attention signal raises the flag,
    // the busy edge that main sends alongside it stops the spinner. Driven separately here because that
    // is how they arrive.
    t.call('applyAttention')('s1', { kind: 'needs-attention', reason: 'Waiting for you to choose', source: 'bind', busy: false });
    t.call('setExactActivity')('s1', false);

    assert.equal(t.attention('s1'), true, 'flagged');
    assert.equal(t.window.attentionReason.get('s1').reason, 'Waiting for you to choose');
    assert.equal(t.window.sessionBusyState.get('s1'), false, 'and not working');
  } finally { t.destroy(); }
});
