'use strict';
// #864 — a tab FOLLOWS its conversation to a child row (Hermes' /branch, a fork from a rewind, a compression
// continuation). The backend answers `followLiveSession`; watch/adopt.js applies it through the shared re-key.
const test = require('node:test');
const assert = require('node:assert/strict');

const adopt = require('../src/watch/adopt');

function backendWith(follow, over = {}) {
  return {
    id: 'hermes', label: 'Hermes', axis: 'B',
    matchLiveSession: () => null,
    liveRefFor: (id) => id,
    liveState: () => 'idle',
    followLiveSession: follow,
    ...over,
  };
}

function setup({ backend, sessions }) {
  const activeSessions = new Map(sessions);
  const rekeys = [];
  const sent = [];
  adopt.liveStoreRef.clear();
  adopt.liveBusy.clear();
  adopt.init({
    activeSessions,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } }),
    backends: { get: () => backend },
    sessionBackends: { get: () => ({ backendId: 'hermes' }), rekeySession() {} },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    // What main.js wires to session-transitions: the move itself, as the real one does it.
    rekeyLiveSession: (from, session, to, origin, reason) => {
      rekeys.push([from, to, origin, reason]);
      session.realSessionId = to;
      activeSessions.delete(from);
      activeSessions.set(to, session);
    },
  });
  return { activeSessions, rekeys, sent };
}

const tab = (over = {}) => ({ _openedAt: Date.now(), _resumed: true, projectPath: '/p', ...over });

test('a tab follows a branch to the child row: re-keyed with the reason, the claim and busy latch moved', () => {
  const asked = [];
  const { activeSessions, rekeys } = setup({
    sessions: [['parent', tab()]],
    backend: backendWith((ref, opts) => { asked.push([ref, opts]); return ref === 'parent' ? { sessionId: 'child', ref: 'child', reason: 'fork' } : null; }),
  });
  adopt.updateBackendLiveStates();
  assert.deepEqual(rekeys, [['parent', 'child', 'store', 'fork']]);
  assert.ok(activeSessions.has('child') && !activeSessions.has('parent'));
  assert.equal(adopt.liveStoreRef.get('child'), 'child');
  assert.equal(adopt.liveStoreRef.has('parent'), false, 'the old claim is gone');
  assert.ok(Number.isFinite(asked[0][1].sinceMs), 'the tab\'s own start bounds a branch');
  // The next flush asks about the child and finds nothing further.
  adopt.updateBackendLiveStates();
  assert.equal(rekeys.length, 1);
  assert.equal(asked[asked.length - 1][0], 'child');
});

test('a compression continuation is followed with the "adopted" reason', () => {
  const { rekeys } = setup({
    sessions: [['root', tab()]],
    backend: backendWith((ref) => (ref === 'root' ? { sessionId: 'tip', ref: 'tip', reason: 'adopted' } : null)),
  });
  adopt.updateBackendLiveStates();
  assert.deepEqual(rekeys, [['root', 'tip', 'store', 'adopted']]);
});

test('the busy latch of the old id follows the tab', () => {
  const { sent } = setup({
    sessions: [['parent', tab()]],
    backend: backendWith((ref) => (ref === 'parent' ? { sessionId: 'child', ref: 'child', reason: 'fork' } : null),
      { liveState: () => 'busy' }),
  });
  adopt.liveBusy.set('parent', true);
  adopt.updateBackendLiveStates();
  assert.equal(adopt.liveBusy.get('child'), true);
  assert.equal(adopt.liveBusy.has('parent'), false);
  assert.equal(sent.some(([ch]) => ch === 'cli-busy-state'), false, 'no edge: it was busy and still is');
});

test('a child another live tab already holds is not taken', () => {
  const { rekeys, activeSessions } = setup({
    sessions: [['parent', tab()], ['child', tab()]],
    backend: backendWith((ref) => (ref === 'parent' ? { sessionId: 'child', ref: 'child', reason: 'fork' } : null)),
  });
  adopt.updateBackendLiveStates();
  assert.equal(rekeys.length, 0);
  assert.ok(activeSessions.has('parent') && activeSessions.has('child'));
});

test('a backend that declares no follow leaves the tab where it is', () => {
  const none = setup({ sessions: [['parent', tab()]], backend: backendWith(undefined) });
  adopt.updateBackendLiveStates();
  assert.equal(none.rekeys.length, 0);
});

test('a throwing follow hook does not stop busy/idle', () => {
  const { rekeys } = setup({
    sessions: [['parent', tab()]],
    backend: backendWith(() => { throw new Error('boom'); }),
  });
  assert.doesNotThrow(() => adopt.updateBackendLiveStates());
  assert.equal(rekeys.length, 0);
  assert.equal(adopt.liveBusy.get('parent'), false);
});
