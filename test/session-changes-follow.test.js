'use strict';
// What makes an open Changes group read again (#870, spec 47 section 4, "Triggers"): the poller's status for the
// session's checkout when it MOVED, and a scan write for a session of its lineage. Main only sends
// `session-changes-updated` { sessionId }; the window asks again. A fake poller and fake windows stand in for both.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const sc = require('../src/app/session-changes');
const { makeCheckout, makeProvider, makeExec, makeStore, makeCtx } = require('./helpers/session-changes-fakes');

const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function fakeWindow(id) {
  const sent = [];
  const handlers = new Map();
  let added = 0;
  return {
    id, sent, destroyed: false,
    get listenersAdded() { return added; },
    send(ch, payload) { sent.push([ch, payload]); },
    isDestroyed() { return this.destroyed; },
    once(ev, fn) { added++; handlers.set(ev, fn); },
    on(ev, fn) { added++; handlers.set(ev, fn); },
    fire(ev, ...args) { const fn = handlers.get(ev); if (fn) fn(...args); },
  };
}

function setup(extra = {}) {
  const root = makeCheckout();
  roots.push(root);
  const { exec } = makeExec({});
  const store = makeStore();
  const sessions = [
    { sessionId: 'S', folder: 'F', projectPath: root, startedAt: '2026-11-16T08:00:00.000Z' },
    { sessionId: 'C', folder: 'F', projectPath: root, startedAt: '2026-11-16T09:00:00.000Z', lineageParentId: 'S', lineageKind: 'clear' },
    { sessionId: 'Z', folder: 'G', projectPath: root, startedAt: '2026-11-16T09:00:00.000Z' },
    { sessionId: 'A', folder: 'F', projectPath: root, parentSessionId: 'S', startedAt: '2026-11-16T08:30:00.000Z' },
  ];
  const listeners = new Set();
  const folders = new Map();     // what the poller follows for main-side subscribers: key -> cwd
  let cached = 'cached' in extra ? extra.cached : { branch: 'main', ahead: 0, files: [] };
  const ctx = {
    ...makeCtx({ root, sessions, provider: makeProvider(root), exec, store }),
    getVcsStatus: () => cached,
    onVcsStatus: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    followFolder: (key, cwd) => { if (cwd) folders.set(key, cwd); else folders.delete(key); },
  };
  sc.init(ctx);
  return {
    root, listeners, folders,
    status(summary, cwd = root) { cached = summary; for (const fn of [...listeners]) fn(cwd, summary); },
  };
}

const updates = (w) => w.sent.filter(([ch]) => ch === 'session-changes-updated').map(([, p]) => p.sessionId);

test('following sends nothing by itself; a status push that changes the status sends one notice', () => {
  const env = setup();
  const w = fakeWindow(1);
  assert.deepEqual(sc.follow('S', w), { ok: true });
  assert.equal(env.listeners.size, 1);
  assert.deepEqual(updates(w), []);
  env.status({ branch: 'main', ahead: 0, files: [{ path: 'a.js', kind: 'modified' }] });
  assert.deepEqual(updates(w), ['S']);
});

test('a push that reads the same as the last status sends nothing', () => {
  const env = setup();
  const w = fakeWindow(1);
  sc.follow('S', w);
  env.status({ branch: 'main', ahead: 0, files: [] });   // the poll reports every poll, this is the status already held
  env.status({ branch: 'main', ahead: 0, files: [] });
  assert.deepEqual(updates(w), []);
  env.status({ branch: 'main', ahead: 1, files: [] });
  env.status({ branch: 'main', ahead: 1, files: [] });
  assert.deepEqual(updates(w), ['S']);
});

test('a push for another directory does not count', () => {
  const env = setup();
  const w = fakeWindow(1);
  sc.follow('S', w);
  env.status({ branch: 'dev', ahead: 5, files: [] }, 'elsewhere');
  assert.deepEqual(updates(w), []);
});

test('unfollow ends the subscription, calls forget and drops the poller listener', () => {
  const env = setup();
  const w = fakeWindow(1);
  sc.follow('S', w);
  sc.unfollow('S', w);
  assert.equal(env.listeners.size, 0);
  env.status({ branch: 'x', ahead: 0, files: [] });
  assert.deepEqual(updates(w), []);
});

test('forget runs when the last window of a session lets go, not before', async () => {
  setup();
  const a = fakeWindow(1);
  const b = fakeWindow(2);
  sc.follow('S', a);
  sc.follow('S', b);
  await sc.state('S');                 // keeps the row targets of the answer
  assert.equal(sc._hasTargets('S'), true);
  sc.unfollow('S', a);
  assert.deepEqual(sc._followedSessions(), ['S']);
  assert.equal(sc._hasTargets('S'), true);
  sc.unfollow('S', b);
  assert.deepEqual(sc._followedSessions(), []);
  assert.equal(sc._hasTargets('S'), false);
});

test('a destroyed window and a main-frame navigation each end its follow', () => {
  const env = setup();
  const w = fakeWindow(1);
  sc.follow('S', w);
  w.fire('destroyed');
  assert.equal(env.listeners.size, 0);
  const n = fakeWindow(2);
  sc.follow('S', n);
  n.fire('did-start-navigation', {}, 'url', true, true);    // in place: stays
  assert.equal(env.listeners.size, 1);
  n.fire('did-start-navigation', {}, 'url', false, true);   // a real navigation: ends
  assert.equal(env.listeners.size, 0);
  env.status({ branch: 'x', ahead: 0, files: [] });
  assert.deepEqual(updates(n), []);
});

test('a destroyed window is dropped when a push would reach it', () => {
  const env = setup();
  const w = fakeWindow(1);
  sc.follow('S', w);
  w.destroyed = true;
  env.status({ branch: 'x', ahead: 0, files: [] });
  assert.deepEqual(sc._followedSessions(), []);
  assert.equal(env.listeners.size, 0);
});

test('a scan write for the followed session or its lineage sends one notice; another session sends none', () => {
  setup();
  const w = fakeWindow(1);
  sc.follow('S', w);
  sc.noteScanWrite(['Z']);
  assert.deepEqual(updates(w), []);
  sc.noteScanWrite(['S']);
  assert.deepEqual(updates(w), ['S']);
  sc.noteScanWrite(['C', 'Z']);   // a /clear child continues the timeline
  assert.deepEqual(updates(w), ['S', 'S']);
});

test('two windows following one session each get the notice; a scan write with nothing followed does nothing', () => {
  const env = setup();
  const a = fakeWindow(1);
  const b = fakeWindow(2);
  sc.noteScanWrite(['S']);
  sc.follow('S', a);
  sc.follow('S', b);
  env.status({ branch: 'x', ahead: 0, files: [] });
  assert.deepEqual(updates(a), ['S']);
  assert.deepEqual(updates(b), ['S']);
});

test('an unknown session is not followed', () => {
  const env = setup();
  assert.deepEqual(sc.follow('nope', fakeWindow(1)), { ok: false });
  assert.deepEqual(sc._followedSessions(), []);
  assert.equal(env.folders.size, 0);
});

test('a subagent\'s scan write notifies the followed parent', () => {
  setup();
  const w = fakeWindow(1);
  sc.follow('S', w);
  sc.noteScanWrite(['A']);
  assert.deepEqual(updates(w), ['S']);
});

test('the first status after none was held notifies: the opening read had no untracked files to show', () => {
  const env = setup({ cached: null });
  const w = fakeWindow(1);
  sc.follow('S', w);
  env.status({ branch: 'main', ahead: 0, files: [] });
  assert.deepEqual(updates(w), ['S']);
  env.status({ branch: 'main', ahead: 0, files: [] });   // the same status again: nothing moved
  assert.deepEqual(updates(w), ['S']);
  env.status({ branch: 'main', ahead: 2, files: [] });
  assert.deepEqual(updates(w), ['S', 'S']);
});

test('following registers the folder with the poller itself; each session has its own key', () => {
  const env = setup();
  const w = fakeWindow(1);
  sc.follow('S', w);
  sc.follow('Z', w);                       // two Changes groups in one window: neither overwrites the other
  assert.deepEqual([...env.folders.keys()].sort(), ['changes:S', 'changes:Z']);
  assert.equal(env.folders.get('changes:S'), env.root);
  sc.unfollow('S', w);                     // ending one keeps the other
  assert.deepEqual([...env.folders.keys()], ['changes:Z']);
  assert.deepEqual(sc._followedSessions(), ['Z']);
  sc.unfollow('Z', w);
  assert.equal(env.folders.size, 0);
});

test('a window that goes, or navigates, releases every folder it held', () => {
  const env = setup();
  const w = fakeWindow(1);
  sc.follow('S', w);
  sc.follow('Z', w);
  w.fire('destroyed');
  assert.equal(env.folders.size, 0);
  const n = fakeWindow(2);
  sc.follow('S', n);
  sc.follow('Z', n);
  n.fire('did-start-navigation', {}, 'url', false, true);
  assert.equal(env.folders.size, 0);
  assert.deepEqual(sc._followedSessions(), []);
});

test('a folder two windows follow is released only when the last lets go', () => {
  const env = setup();
  const a = fakeWindow(1);
  const b = fakeWindow(2);
  sc.follow('S', a);
  sc.follow('S', b);
  sc.unfollow('S', a);
  assert.equal(env.folders.size, 1);
  sc.unfollow('S', b);
  assert.equal(env.folders.size, 0);
});

test('re-following after a navigation does not add window listeners again', () => {
  setup();
  const w = fakeWindow(1);
  sc.follow('S', w);
  const wired = w.listenersAdded;
  assert.ok(wired > 0);
  for (let i = 0; i < 3; i++) {
    w.fire('did-start-navigation', {}, 'url', false, true);
    assert.deepEqual(sc._followedSessions(), []);
    sc.follow('S', w);
    assert.deepEqual(sc._followedSessions(), ['S']);
  }
  assert.equal(w.listenersAdded, wired);
});
