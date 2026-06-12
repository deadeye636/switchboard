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
      inInbox: true,
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

    const openEntry = getMapValue(runtime.openSessions, sessionId);
    if (openEntry && openEntry.closed) return STATUS.exited;

    return STATUS.idle;
  }

  function sessionActivityTime(session, runtime = {}) {
    const lastActivity = getMapValue(runtime.lastActivityTime, session.sessionId);
    const value = lastActivity || session.modified || session.created;
    const time = value ? new Date(value).getTime() : 0;
    return Number.isFinite(time) ? time : 0;
  }

  function getAttentionInboxItems(sessions, runtime = {}) {
    return sessions
      .map(session => ({ session, status: getSessionStatus(session, runtime) }))
      .filter(item => item.status.inInbox)
      .sort((a, b) => {
        if (a.status.priority !== b.status.priority) return b.status.priority - a.status.priority;
        return sessionActivityTime(b.session, runtime) - sessionActivityTime(a.session, runtime);
      });
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

  return {
    getSessionStatus,
    getAttentionInboxItems,
    getStatusCounts,
    getFilteredSessionsByStatus,
  };
});
