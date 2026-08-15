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

  // What the next launch brings back, in TWO lists, because "what was open" and "what was running" are not
  // the same state (#438). Closing a tab does not stop its process: the session stays live — counted by the
  // quit guard, drawn as running in the sidebar — while nothing renders it. Collected from the tabs alone,
  // the quit killed such a session and the next launch never started it again.
  //
  //   sessions — had a tab. Reopened with its tab, exactly as before.
  //   headless — was only RUNNING. Its process is started again and nothing is mounted, so the app comes
  //              back in the state it was closed in rather than in a busier one. The sidebar marks it
  //              running and a click reattaches it with its scrollback.
  //
  // `running` is what the caller believes was live without a tab — it knows about detached windows, this
  // does not. De-duplicated against the tabs, so a session that had both is a tab and nothing else.
  function collectUpdateRestartState(openSessions, { activeSessionId = null, gridViewActive = false, running = [] } = {}) {
    const sessions = [];
    const headless = [];
    const seen = new Set();
    const take = (session, into) => {
      if (!session || !session.sessionId || !session.projectPath) return;
      // A plain terminal has no transcript to resume — reopening one would be a fresh shell wearing the old
      // session's name, which reads as "your work came back" when nothing did.
      if (session.type === 'terminal') return;
      if (seen.has(session.sessionId)) return;
      seen.add(session.sessionId);
      into.push({
        sessionId: session.sessionId,
        projectPath: session.projectPath,
      });
    };
    if (openSessions && typeof openSessions[Symbol.iterator] === 'function') {
      for (const [, entry] of openSessions) {
        if (!entry || entry.closed) continue;
        take(entry.session, sessions);
      }
    }
    for (const session of running || []) take(session, headless);
    // Only a session we actually MOUNT can be focused again on the next launch. A plain terminal (filtered
    // out above), a session whose file is gone, or one coming back headless would otherwise leave the
    // restore pointing at something it is not going to show.
    const restorable = new Set(sessions.map((s) => s.sessionId));
    return {
      activeSessionId: restorable.has(activeSessionId) ? activeSessionId : null,
      gridViewActive: !!gridViewActive,
      sessions,
      headless,
      savedAt: new Date().toISOString(),
    };
  }

  // Worth acting on at all? A state carrying only headless entries still is: those processes have to be
  // started even though no tab comes back with them. Tolerates a blob written before `headless` existed.
  function hasRestorableUpdateSessions(state) {
    if (!state) return false;
    const tabs = Array.isArray(state.sessions) ? state.sessions.length : 0;
    const bare = Array.isArray(state.headless) ? state.headless.length : 0;
    return tabs + bare > 0;
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
