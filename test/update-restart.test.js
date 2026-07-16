const test = require('node:test');
const assert = require('node:assert/strict');

const {
  UPDATE_RESTART_STATE_KEY,
  OPEN_SESSIONS_STATE_KEY,
  collectUpdateRestartState,
  hasRestorableUpdateSessions,
  selectRestorableSessions,
  resolveRestoreFocusId,
} = require('../src/renderer/shell/update-restart');

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

test('collectUpdateRestartState drops an activeSessionId that cannot be restored', () => {
  const openSessions = new Map([
    ['s1', { closed: false, session: { sessionId: 's1', projectPath: '/repo/a' } }],
    ['term', { closed: false, session: { sessionId: 'term', projectPath: '/repo/c', type: 'terminal' } }],
  ]);

  // The focused tab is a plain terminal — never part of `sessions`, so keeping it
  // as the focus target would leave the restore without one.
  const onTerminal = collectUpdateRestartState(openSessions, { activeSessionId: 'term' });
  assert.equal(onTerminal.activeSessionId, null);

  const onSession = collectUpdateRestartState(openSessions, { activeSessionId: 's1' });
  assert.equal(onSession.activeSessionId, 's1');
});

test('resolveRestoreFocusId prefers the previously focused session', () => {
  const restored = [{ sessionId: 's1' }, { sessionId: 's2' }];
  const open = new Set(['s1', 's2']);
  assert.equal(resolveRestoreFocusId({ activeSessionId: 's2' }, restored, (id) => open.has(id)), 's2');
});

test('resolveRestoreFocusId falls back to the first restored session', () => {
  const restored = [{ sessionId: 's1' }, { sessionId: 's2' }];
  const open = new Set(['s1', 's2']);

  // Previously focused session did not come back (deleted, or a plain terminal).
  assert.equal(resolveRestoreFocusId({ activeSessionId: 'gone' }, restored, (id) => open.has(id)), 's1');
  assert.equal(resolveRestoreFocusId({ activeSessionId: null }, restored, (id) => open.has(id)), 's1');

  // Skips restored entries that failed to open.
  assert.equal(resolveRestoreFocusId({}, restored, (id) => id === 's2'), 's2');
});

test('resolveRestoreFocusId returns null when nothing is open', () => {
  assert.equal(resolveRestoreFocusId({ activeSessionId: 's1' }, [{ sessionId: 's1' }], () => false), null);
  assert.equal(resolveRestoreFocusId(null, [], () => true), null);
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
