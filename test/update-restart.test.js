const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectUpdateRestartState,
  hasRestorableUpdateSessions,
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
