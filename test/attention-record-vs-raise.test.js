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
