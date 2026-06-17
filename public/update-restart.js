(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // One-shot blob written right before an auto-update relaunch and consumed on
  // the next boot.
  const UPDATE_RESTART_STATE_KEY = 'pendingUpdateRestartState';
  // Durable blob written on every normal quit so the same set of open sessions
  // can be reopened on the next ordinary launch. Same shape as the update blob;
  // kept under a distinct key so the two restore paths never clobber each other.
  const OPEN_SESSIONS_STATE_KEY = 'persistedOpenSessions';

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

  // Resolve a persisted state blob into the concrete, de-duplicated list of
  // session objects to reopen. Pure: callers inject `lookup` (id → session, or
  // null if it no longer exists on disk) and an optional `isOpen` predicate so
  // already-open sessions are skipped. Shared by both restore paths.
  function selectRestorableSessions(state, { lookup, isOpen } = {}) {
    const result = [];
    if (!state || !Array.isArray(state.sessions)) return result;
    const seen = new Set();
    for (const item of state.sessions) {
      const id = item && item.sessionId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (typeof isOpen === 'function' && isOpen(id)) continue;
      const session = typeof lookup === 'function' ? lookup(id) : item;
      if (session) result.push(session);
    }
    return result;
  }

  return {
    UPDATE_RESTART_STATE_KEY,
    OPEN_SESSIONS_STATE_KEY,
    collectUpdateRestartState,
    hasRestorableUpdateSessions,
    selectRestorableSessions,
  };
});
