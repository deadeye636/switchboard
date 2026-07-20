(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const STATUS = {
    needsAttention: {
      key: 'needs-attention',
      label: 'Needs You',
      className: 'status-needs-attention',
      priority: 100,
      inInbox: true,
    },
    responseReady: {
      key: 'response-ready',
      label: 'Ready',
      className: 'status-response-ready',
      priority: 90,
      inInbox: true,
    },
    busy: {
      key: 'busy',
      label: 'Working',
      className: 'status-busy',
      priority: 80,
      // "Working" = agent actively producing output → not the user's turn. The
      // finished signal arrives separately as response-ready (see setActivity in
      // app.js), so the attention inbox stays "your turn" only.
      inInbox: false,
    },
    running: {
      key: 'running',
      label: 'Running',
      className: 'status-running',
      priority: 70,
      inInbox: true,
    },
    exited: {
      key: 'exited',
      label: 'Exited',
      className: 'status-exited',
      priority: 20,
      inInbox: false,
    },
    idle: {
      key: 'idle',
      label: 'Idle',
      className: 'status-idle',
      priority: 10,
      inInbox: false,
    },
  };

  function hasSetValue(setLike, value) {
    return !!setLike && typeof setLike.has === 'function' && setLike.has(value);
  }

  function getMapValue(mapLike, value) {
    return mapLike && typeof mapLike.get === 'function' ? mapLike.get(value) : undefined;
  }

  function getSessionStatus(session, runtime = {}) {
    const sessionId = session.sessionId;
    if (hasSetValue(runtime.attentionSessions, sessionId)) return STATUS.needsAttention;
    if (hasSetValue(runtime.responseReadySessions, sessionId)) return STATUS.responseReady;
    if (getMapValue(runtime.sessionBusyState, sessionId)) return STATUS.busy;
    if (hasSetValue(runtime.activePtyIds, sessionId)) return STATUS.running;

    // Exited outranks pending: a session that crashed after a successful launch stays in pendingSessions
    // until its jsonl appears (which it never will), so checking pending first would report it running
    // forever while its terminal shows the exit banner (#255). A genuinely launching session is NOT
    // closed, so it falls through to the pending→running check below.
    const openEntry = getMapValue(runtime.openSessions, sessionId);
    if (openEntry && openEntry.closed) return STATUS.exited;

    // A session mid-launch has no PTY yet but is about to. The sidebar already sorts it with the running
    // ones (pendingSessions); reporting it as running keeps the indicator honest instead of saying Idle
    // while the row sits at the top. `pendingSessions` is a Map, but .has works the same. Cleared the
    // instant the PTY appears or the launch fails.
    if (hasSetValue(runtime.pendingSessions, sessionId)) return STATUS.running;

    return STATUS.idle;
  }

  function sessionActivityTime(session, runtime = {}) {
    const lastActivity = getMapValue(runtime.lastActivityTime, session.sessionId);
    const value = lastActivity || session.modified || session.created;
    const time = value ? new Date(value).getTime() : 0;
    return Number.isFinite(time) ? time : 0;
  }

  const RUNNING_INBOX_DEFAULT_MINUTES = 5;
  // The mode a caller gets when it passes none (#238). It used to be 'always' here and 'until-read' in
  // app.js — two answers to one question, in two layers. Every real caller builds its runtime through
  // attentionInboxRuntimeFields(), so the fallback was unreachable in the app and the divergence could
  // only ever bite a NEW caller that forgot a field: it would quietly get a different inbox than the
  // setting says. One constant, exported, used by both.
  const RUNNING_INBOX_DEFAULT_MODE = 'until-read';

  // Whether a session's status should appear in the attention inbox. Every status
  // except `running` is fixed via `inInbox`. `running` is user-configurable
  // (runtime.runningInboxMode) because a live-but-idle terminal isn't inherently
  // "your turn":
  //   always       — every running session
  //   never        — none
  //   until-read   — only sessions that finished (busy→idle stamp in runtime.finishedAt)
  //                  and haven't been focused since; stays until opened
  //   after-finish — same gate, but drops once runtime.now - finishedAt exceeds the window
  //                  (and on open — clearNotifications clears the stamp)
  //   timed        — same window as after-finish; differs only outside this pure
  //                  helper: opening the session does NOT clear the stamp, so it
  //                  stays for the full window regardless of being read
  // The finishedAt gate means a session that never worked (no stamp) is never
  // surfaced as running clutter. A caller that passes no mode gets
  // RUNNING_INBOX_DEFAULT_MODE — the same value app.js starts from (#238).
  function inboxIncludes(status, session, runtime) {
    if (status.key !== 'running') return status.inInbox;
    const mode = runtime.runningInboxMode || RUNNING_INBOX_DEFAULT_MODE;
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    const finishedAt = getMapValue(runtime.finishedAt, session.sessionId);
    if (!finishedAt) return false;
    if (mode === 'until-read') return true;
    // after-finish / timed: hide once the window has elapsed. Missing `now` ⇒ keep visible.
    const minutes = runtime.runningInboxMinutes > 0 ? runtime.runningInboxMinutes : RUNNING_INBOX_DEFAULT_MINUTES;
    const now = Number.isFinite(runtime.now) ? runtime.now : finishedAt;
    return (now - finishedAt) < minutes * 60000;
  }

  function getAttentionInboxItems(sessions, runtime = {}) {
    return sessions
      .map(session => ({ session, status: getSessionStatus(session, runtime) }))
      .filter(item => inboxIncludes(item.status, item.session, runtime))
      .sort((a, b) => {
        if (a.status.priority !== b.status.priority) return b.status.priority - a.status.priority;
        return sessionActivityTime(b.session, runtime) - sessionActivityTime(a.session, runtime);
      });
  }

  function getNextAttentionInboxItem(sessions, runtime = {}, currentSessionId = null) {
    const items = getAttentionInboxItems(sessions, runtime);
    if (items.length === 0) return null;
    if (!currentSessionId) return items[0];
    const currentIndex = items.findIndex(item => item.session.sessionId === currentSessionId);
    if (currentIndex === -1 || currentIndex === items.length - 1) return items[0];
    return items[currentIndex + 1];
  }

  function isActiveStatus(status) {
    return status.key === 'busy' || status.key === 'running';
  }

  function getStatusCounts(sessions, runtime = {}) {
    const counts = { all: sessions.length, attention: 0, ready: 0, active: 0 };
    for (const session of sessions) {
      const status = getSessionStatus(session, runtime);
      if (status.key === 'needs-attention') counts.attention++;
      if (status.key === 'response-ready') counts.ready++;
      if (isActiveStatus(status)) counts.active++;
    }
    return counts;
  }

  function getFilteredSessionsByStatus(sessions, runtime = {}, filter = 'all') {
    if (filter === 'all') return sessions;
    return sessions.filter(session => {
      const status = getSessionStatus(session, runtime);
      if (filter === 'attention') return status.key === 'needs-attention';
      if (filter === 'ready') return status.key === 'response-ready';
      if (filter === 'active') return isActiveStatus(status);
      return true;
    });
  }

  // Which sessions should the grid auto-open? Every session with a live PTY
  // (activePtyIds) that isn't already mounted as an open terminal. These are
  // genuinely-running sessions, so surfacing them only reattaches to an existing
  // process — it never spawns a new `claude`. Sessions that are merely on disk
  // but not running are deliberately excluded (auto-starting them would be
  // costly and surprising). Already-open sessions (and closed entries pending
  // cleanup) are skipped so we never double-open.
  function getGridAutoOpenSessionIds(runtime = {}) {
    const active = runtime.activePtyIds;
    if (!active || typeof active[Symbol.iterator] !== 'function') return [];
    const ids = [];
    for (const sessionId of active) {
      const entry = getMapValue(runtime.openSessions, sessionId);
      if (!entry || entry.closed) ids.push(sessionId);
    }
    return ids;
  }

  return {
    RUNNING_INBOX_DEFAULT_MODE,
    RUNNING_INBOX_DEFAULT_MINUTES,
    getSessionStatus,
    getAttentionInboxItems,
    getNextAttentionInboxItem,
    getStatusCounts,
    getFilteredSessionsByStatus,
    getGridAutoOpenSessionIds,
  };
});
