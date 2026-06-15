(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const UPDATE_RESTART_STATE_KEY = 'pendingUpdateRestartState';

  function collectUpdateRestartState(openSessions, { activeSessionId = null, gridViewActive = false } = {}) {
    const sessions = [];
    if (openSessions && typeof openSessions[Symbol.iterator] === 'function') {
      for (const [, entry] of openSessions) {
        const session = entry?.session;
        if (!session || entry.closed || session.type === 'terminal') continue;
        if (!session.sessionId || !session.projectPath) continue;
        sessions.push({
          sessionId: session.sessionId,
          projectPath: session.projectPath,
        });
      }
    }
    return {
      activeSessionId,
      gridViewActive: !!gridViewActive,
      sessions,
      savedAt: new Date().toISOString(),
    };
  }

  function hasRestorableUpdateSessions(state) {
    return !!state && Array.isArray(state.sessions) && state.sessions.length > 0;
  }

  return {
    UPDATE_RESTART_STATE_KEY,
    collectUpdateRestartState,
    hasRestorableUpdateSessions,
  };
});
