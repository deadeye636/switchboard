// vm.runInContext tests for the announce gate — only the MAIN window may announce (#390).
//
// WHY THIS EXISTS:
//   Every window that loads the shell runs the same renderer: the attention engine, the notification
//   funnel, all of it. A window of its own therefore reaches window.api.setBadge and setTraySummary as
//   readily as the main window does — and neither IPC handler looks at which window sent it, so the
//   last writer wins. Its attention sets are always empty, so what it actually sends is "0 waiting",
//   clearing the badge the main window set a moment earlier.
//
//   That is a live defect on its own. It becomes worse the moment a window of its own learns which of
//   its sessions are waiting (#395): it would then announce every event a second time — its own badge,
//   its own tray tooltip, its own native notification, its own chime. The one-inbox decision behind the
//   away recap exists precisely to prevent that, and a gate is the only thing that keeps it true when
//   the second window stops having empty sets.
//
//   Both halves are pinned separately, because a gate that covers only the sound or only the badge
//   leaves the other half of the second inbox standing.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

function setup({ detached = false } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();

  const sent = { notify: [], badge: [], tray: [] };
  const soundChecks = [];

  Object.assign(window, {
    attentionSessions: new Set(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map(),
    attentionReason: new Map(),
    finishedAt: new Map(),
    activePtyIds: new Set(),
    openSessions: new Map(),
    sessionMap: new Map(),
    lastActivityTime: new Map(),
  });
  window.activeSessionId = null;
  window.appGlobalSettings = { notifications: { sound: true } };
  window.refreshSessionStatusViews = () => {};
  window.recordTimelineEvent = () => {};
  window.getAllKnownSessionsForStatus = () => [];
  window.reduceAttention = (prev, next) => next;
  window.openSession = () => {};
  window.clearNotifications = () => {};
  window.sessionRowEls = (sessionId, root = window.document) =>
    root.querySelectorAll(`.session-item[data-session-id="${sessionId}"]`);

  // The pure policy and the sound predicate both say yes, so anything that does NOT reach the OS is
  // the gate's doing and not a decision made further down.
  window.decideNotifications = () => ({
    notifications: [{ title: 'x', body: 'y', sessionIds: ['s1'] }],
    badgeCount: 1,
  });
  window.shouldPlayAttentionSound = (args) => { soundChecks.push(args); return false; };

  window.api = {
    notify: (payload) => sent.notify.push(payload),
    setBadge: (count) => sent.badge.push(count),
    setTraySummary: (text) => sent.tray.push(text),
    onFocusSession: () => {},
  };

  // What detach-window.js sets from the URL, and the only thing the gate reads.
  if (detached) window.isDetachedWindow = () => true;

  for (const file of ['shell/attention-engine.js', 'shell/native-notifications.js']) {
    vm.runInContext(fs.readFileSync(path.join(REN, ...file.split('/')), 'utf8'), ctx, { filename: file });
  }

  const call = name => vm.runInContext(name, ctx);
  return { call, sent, soundChecks, window, destroy: () => window.close() };
}

// --- The badge, the tray and the notification ---

test('the main window announces to the OS', () => {
  const t = setup();
  try {
    t.call('syncNativeNotifications')();
    assert.equal(t.sent.notify.length, 1);
    assert.deepEqual(t.sent.badge, [1]);
    assert.equal(t.sent.tray.length, 1);
  } finally { t.destroy(); }
});

test('a window of its own sends no notification, no badge and no tray summary', () => {
  const t = setup({ detached: true });
  try {
    t.call('syncNativeNotifications')();
    assert.deepEqual(t.sent.notify, [], 'a second native toast for one event is the second inbox');
    assert.deepEqual(t.sent.badge, [], 'the badge it would send is 0 — it clears what main set');
    assert.deepEqual(t.sent.tray, []);
  } finally { t.destroy(); }
});

test('a window of its own stays silent when it regains focus', () => {
  // The focus listeners call the same funnel, so a click into the second window used to reset the badge
  // without any session changing state at all.
  const t = setup({ detached: true });
  try {
    t.window.dispatchEvent(new t.window.Event('focus'));
    t.window.dispatchEvent(new t.window.Event('blur'));
    assert.deepEqual(t.sent.badge, []);
    assert.deepEqual(t.sent.tray, []);
  } finally { t.destroy(); }
});

// --- The chime ---

test('the main window asks whether to play the attention chime', () => {
  const t = setup();
  try {
    t.call('applyAttention')('s1', { kind: 'needs-attention', reason: 'waiting', source: 'hook' });
    assert.equal(t.soundChecks.length, 1);
  } finally { t.destroy(); }
});

test('a window of its own never reaches the chime', () => {
  const t = setup({ detached: true });
  try {
    t.call('applyAttention')('s1', { kind: 'needs-attention', reason: 'waiting', source: 'hook' });
    assert.deepEqual(t.soundChecks, [],
      'gated before the predicate, so a sound setting cannot re-open it');
    assert.equal(t.window.attentionSessions.has('s1'), true,
      'recording still happens — the gate is about announcing, not about knowing');
  } finally { t.destroy(); }
});
