const test = require('node:test');
const assert = require('node:assert/strict');

const {
  UPDATE_RESTART_STATE_KEY,
  OPEN_SESSIONS_STATE_KEY,
  collectUpdateRestartState,
  hasRestorableUpdateSessions,
  selectRestorableSessions,
} = require('../public/update-restart');

test('collectUpdateRestartState stores resumable Claude sessions only', () => {
  const state = collectUpdateRestartState(new Map([
    ['s1', { closed: false, session: { sessionId: 's1', projectPath: '/repo/a' } }],
    ['s2', { closed: true, session: { sessionId: 's2', projectPath: '/repo/b' } }],
    ['terminal', { closed: false, session: { sessionId: 'terminal', projectPath: '/repo/c', type: 'terminal' } }],
  ]), {
    activeSessionId: 's1',
    gridViewActive: true,
  });

  assert.equal(state.activeSessionId, 's1');
  assert.equal(state.gridViewActive, true);
  assert.deepEqual(state.sessions, [{ sessionId: 's1', projectPath: '/repo/a' }]);
  assert.equal(hasRestorableUpdateSessions(state), true);
});

test('hasRestorableUpdateSessions returns false for empty state', () => {
  assert.equal(hasRestorableUpdateSessions(null), false);
  assert.equal(hasRestorableUpdateSessions({ sessions: [] }), false);
});

test('update-restart and normal-quit blobs use distinct storage keys', () => {
  assert.equal(UPDATE_RESTART_STATE_KEY, 'pendingUpdateRestartState');
  assert.equal(OPEN_SESSIONS_STATE_KEY, 'persistedOpenSessions');
  assert.notEqual(UPDATE_RESTART_STATE_KEY, OPEN_SESSIONS_STATE_KEY);
});

test('selectRestorableSessions resolves, de-dupes, and skips missing sessions', () => {
  const state = {
    sessions: [
      { sessionId: 's1', projectPath: '/repo/a' },
      { sessionId: 's1', projectPath: '/repo/a' }, // duplicate id
      { sessionId: 'gone', projectPath: '/repo/x' }, // no longer on disk
      { projectPath: '/repo/no-id' }, // malformed
      { sessionId: 's2', projectPath: '/repo/b' },
    ],
  };
  const known = new Map([
    ['s1', { sessionId: 's1' }],
    ['s2', { sessionId: 's2' }],
  ]);

  const picked = selectRestorableSessions(state, { lookup: (id) => known.get(id) });
  assert.deepEqual(picked.map((s) => s.sessionId), ['s1', 's2']);
});

test('selectRestorableSessions skips already-open sessions', () => {
  const state = { sessions: [{ sessionId: 's1' }, { sessionId: 's2' }] };
  const known = new Map([['s1', { sessionId: 's1' }], ['s2', { sessionId: 's2' }]]);
  const open = new Set(['s1']);

  const picked = selectRestorableSessions(state, {
    lookup: (id) => known.get(id),
    isOpen: (id) => open.has(id),
  });
  assert.deepEqual(picked.map((s) => s.sessionId), ['s2']);
});

test('selectRestorableSessions returns empty for malformed input', () => {
  assert.deepEqual(selectRestorableSessions(null, {}), []);
  assert.deepEqual(selectRestorableSessions({ sessions: 'nope' }, {}), []);
  assert.deepEqual(selectRestorableSessions({ sessions: [] }, {}), []);
});
