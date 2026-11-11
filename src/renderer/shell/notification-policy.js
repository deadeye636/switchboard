(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Flood guard (#847). Every session gets its own OS notification, so a burst of transitions (a swarm
  // of agents finishing together) must not turn into a wall of toasts. At most FLOOD_MAX individual
  // notifications go out per FLOOD_WINDOW_MS; the rest of that batch folds into ONE summary entry. A
  // sliding window of emission times (kept by the caller) rather than a fixed "quiet period" because the
  // old throttle swallowed whole batches - a session that needed you 3 s after another was never announced.
  const FLOOD_MAX = 5;
  const FLOOD_WINDOW_MS = 10000;

  function toSet(value) {
    if (value instanceof Set) return value;
    if (Array.isArray(value)) return new Set(value);
    if (value && typeof value.has === 'function' && typeof value.forEach === 'function') {
      return value;
    }
    return new Set();
  }

  // Session ids present in `nextSet` that were not in `prevSet` — i.e. the ones
  // that just transitioned into this state.
  function newcomers(prevSet, nextSet) {
    const result = [];
    nextSet.forEach((id) => {
      if (!prevSet.has(id)) result.push(id);
    });
    return result;
  }

  function oneNotification(kind, sessionId, describeSession) {
    const info = (typeof describeSession === 'function' && describeSession(sessionId)) || {};
    const name = info.name || 'Session';
    const what = kind === 'attention' ? 'needs your attention' : 'is ready for review';
    return {
      kind,
      sessionId,
      sessionIds: [sessionId],
      title: name,
      body: info.project ? `${info.project} · ${what}` : what,
      project: info.project || '',
      projectKey: info.projectKey || '',
    };
  }

  function summaryNotification(kind, sessionIds) {
    const count = sessionIds.length;
    const what = kind === 'attention' ? 'need your attention' : 'are ready for review';
    return {
      kind: 'summary',
      summary: true,
      sessionIds,
      title: 'Switchboard',
      body: `${count} more session${count === 1 ? '' : 's'} ${what}`,
    };
  }

  // Decide whether/what to notify based on attention/ready transitions, window focus, user settings and
  // the flood guard. Pure: no DOM, no Electron.
  //
  //   prev/next:       { attention: Set|string[], ready: Set|string[] } snapshots
  //   settings:        { enabled, notifyOnReady } (sound handled by spec 02)
  //   recent:          emission times (ms) of earlier individual notifications - the flood guard's state
  //   describeSession: (sessionId) => { name, project, projectKey } - the caller knows the sessions
  // returns: {
  //   notifications: [{ kind, sessionId, sessionIds, title, body, project, projectKey }  // one per session
  //                   | { kind: 'summary', summary: true, sessionIds, title, body }],     // the folded rest
  //   cleared:   session ids that left the announced set, so their OS entry should go,
  //   clearSummary: true when nothing is announced any more (the summary entry should go),
  //   badgeCount,
  // }
  // A session that was already announced and fires again simply appears in `notifications` again; the
  // main process replaces its entry by id.
  function decideNotifications(options) {
    const opts = options || {};
    const settings = opts.settings || {};
    const enabled = settings.enabled !== false; // default on
    const notifyOnReady = !!settings.notifyOnReady; // default off

    const prevAttention = toSet(opts.prev && opts.prev.attention);
    const nextAttention = toSet(opts.next && opts.next.attention);
    const prevReady = toSet(opts.prev && opts.prev.ready);
    const nextReady = toSet(opts.next && opts.next.ready);

    // The "Enable notifications" toggle governs the whole surface, badge
    // included - when off there is nothing to show.
    const badgeCount = enabled ? nextAttention.size + (notifyOnReady ? nextReady.size : 0) : 0;
    const result = { notifications: [], cleared: [], clearSummary: false, badgeCount };

    // A session the user has looked at (or that went away) leaves the sets; its toast goes with it. This
    // runs even while focused - looking at a session is exactly what focuses the window.
    const announced = (attention, ready) => {
      const out = new Set();
      if (enabled) {
        attention.forEach((id) => out.add(id));
        if (notifyOnReady) ready.forEach((id) => out.add(id));
      }
      return out;
    };
    const wasAnnounced = announced(prevAttention, prevReady);
    const isAnnounced = announced(nextAttention, nextReady);
    wasAnnounced.forEach((id) => {
      if (!isAnnounced.has(id)) result.cleared.push(id);
    });
    result.clearSummary = isAnnounced.size === 0 && wasAnnounced.size > 0;

    // Disabled or focused -> never raise a notification. When focused the badge
    // still reflects the live count.
    if (!enabled || opts.windowFocused) return result;

    const newAttention = newcomers(prevAttention, nextAttention);
    const pending = newAttention.map((id) => ({ kind: 'attention', id }));
    if (notifyOnReady) {
      const seen = new Set(newAttention);
      newcomers(prevReady, nextReady).forEach((id) => {
        if (!seen.has(id)) pending.push({ kind: 'ready', id });
      });
    }
    if (pending.length === 0) return result;

    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const recent = Array.isArray(opts.recent) ? opts.recent : [];
    const used = recent.filter((t) => now - t < FLOOD_WINDOW_MS).length;
    const budget = Math.max(0, FLOOD_MAX - used);

    pending.slice(0, budget).forEach(({ kind, id }) => {
      result.notifications.push(oneNotification(kind, id, opts.describeSession));
    });
    const folded = pending.slice(budget);
    if (folded.length > 0) {
      // "need your attention" unless every folded one is only "ready".
      const kind = folded.some((p) => p.kind === 'attention') ? 'attention' : 'ready';
      result.notifications.push(summaryNotification(kind, folded.map((p) => p.id)));
    }
    return result;
  }

  return { decideNotifications, FLOOD_MAX, FLOOD_WINDOW_MS };
});
