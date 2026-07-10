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
    // Only a session we actually store can be focused again on the next launch.
    // A plain terminal (filtered out above) or a session whose file is gone would
    // otherwise leave the restore without a focus target.
    const restorable = new Set(sessions.map((s) => s.sessionId));
    return {
      activeSessionId: restorable.has(activeSessionId) ? activeSessionId : null,
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

  // Which session gets the view after a restore. The one that had focus at quit,
  // as long as it came back; otherwise the first restored session, so the view
  // never lands on whatever the reopen loop happened to finish with. Pure:
  // `isOpen` tells us which ids actually made it back.
  function resolveRestoreFocusId(state, restored, isOpen) {
    const open = typeof isOpen === 'function' ? isOpen : () => true;
    const wanted = state && state.activeSessionId;
    if (wanted && open(wanted)) return wanted;
    for (const session of restored || []) {
      const id = session && session.sessionId;
      if (id && open(id)) return id;
    }
    return null;
  }

  return {
    UPDATE_RESTART_STATE_KEY,
    OPEN_SESSIONS_STATE_KEY,
    collectUpdateRestartState,
    hasRestorableUpdateSessions,
    selectRestorableSessions,
    resolveRestoreFocusId,
  };
});
