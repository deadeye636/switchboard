(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // A READ-THROUGH CACHE of what the main process holds (#396), not the record itself. Main writes the
  // record — it sees every event before any window does — and this keeps a copy of the sessions this
  // window draws so the views that read it can stay synchronous.
  //
  // `loaded` is what makes it a cache rather than a guess: a session with no events and a session that
  // has not been fetched yet look identical from `eventsBySession` alone, and answering "nothing
  // happened" for the second is how a recap ends up empty for the one absence it was built for.
  function createTimelineStore({ maxEventsPerSession = 500 } = {}) {
    return { eventsBySession: new Map(), loaded: new Set(), maxEventsPerSession };
  }

  /**
   * Take a session's history from main, replacing whatever this window had.
   *
   * Replacing rather than merging is deliberate: main is the record, and a merge would preserve exactly
   * the divergence this exists to end. Events arrive newest-first with `at` in epoch ms.
   */
  function hydrateTimeline(store, sessionId, events) {
    if (!store || !sessionId) return;
    const list = Array.isArray(events) ? events.slice(0, store.maxEventsPerSession) : [];
    store.eventsBySession.set(sessionId, list);
    store.loaded.add(sessionId);
  }

  /** Has this window fetched this session's history yet? Not the same question as "does it have events". */
  function isTimelineLoaded(store, sessionId) {
    return !!(store && store.loaded && store.loaded.has(sessionId));
  }

  /** Forget a session's copy — it was re-keyed, or it is gone. The record is unaffected. */
  function dropTimeline(store, sessionId) {
    if (!store || !sessionId) return;
    store.eventsBySession.delete(sessionId);
    if (store.loaded) store.loaded.delete(sessionId);
  }

  /**
   * Put one event at the front of a session's copy.
   *
   * The only caller left is the `timeline-appended` listener — this window does not invent events any
   * more, it is told about them. An event for a session this window has not fetched is dropped: adding
   * it would create a one-event history that looks complete and is not.
   */
  function addTimelineEvent(store, sessionId, kind, label, options = {}) {
    if (!store || !sessionId) return null;
    if (store.loaded && !store.loaded.has(sessionId)) return null;
    const event = {
      id: options.id != null ? options.id : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  // `at` is epoch ms from main and an ISO string from anything older; `new Date` reads both.
  function formatTimelineEvent(event) {
    const date = new Date(event.at);
    const time = Number.isFinite(date.getTime())
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
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
    hydrateTimeline,
    isTimelineLoaded,
    dropTimeline,
    addTimelineEvent,
    getTimelineEvents,
    formatTimelineEvent,
    filterTimelineEvents,
    getTimelineKinds,
  };
});
