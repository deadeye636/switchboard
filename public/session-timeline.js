(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function createTimelineStore({ maxEventsPerSession = 80 } = {}) {
    return { eventsBySession: new Map(), maxEventsPerSession };
  }

  function addTimelineEvent(store, sessionId, kind, label, options = {}) {
    if (!store || !sessionId) return null;
    const event = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      sessionId,
      kind,
      label,
      detail: options.detail || '',
      at: options.at || new Date().toISOString(),
    };
    const events = store.eventsBySession.get(sessionId) || [];
    events.unshift(event);
    if (events.length > store.maxEventsPerSession) {
      events.length = store.maxEventsPerSession;
    }
    store.eventsBySession.set(sessionId, events);
    return event;
  }

  function getTimelineEvents(store, sessionId) {
    return store?.eventsBySession?.get(sessionId) || [];
  }

  function formatTimelineEvent(event) {
    const date = new Date(event.at);
    const time = Number.isFinite(date.getTime())
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
    return {
      time,
      label: event.label || event.kind,
      detail: event.detail || '',
      kind: event.kind,
    };
  }

  function filterTimelineEvents(events, { query = '', kind = 'all' } = {}) {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    return events.filter(event => {
      if (kind && kind !== 'all' && event.kind !== kind) return false;
      if (!normalizedQuery) return true;
      return [event.kind, event.label, event.detail]
        .some(value => String(value || '').toLowerCase().includes(normalizedQuery));
    });
  }

  function getTimelineKinds(events) {
    const seen = new Set();
    const kinds = [];
    for (const event of events) {
      if (!event.kind || seen.has(event.kind)) continue;
      seen.add(event.kind);
      kinds.push(event.kind);
    }
    return kinds;
  }

  return {
    createTimelineStore,
    addTimelineEvent,
    getTimelineEvents,
    formatTimelineEvent,
    filterTimelineEvents,
    getTimelineKinds,
  };
});
