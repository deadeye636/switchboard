(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // How long after emitting notifications we suppress further ones, so a burst
  // of transitions coalesces into a single OS notification instead of spamming.
  const COALESCE_WINDOW_MS = 4000;

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

  function buildNotification(kind, sessionIds) {
    const count = sessionIds.length;
    if (kind === 'attention') {
      return {
        kind: 'attention',
        sessionIds,
        title: 'Switchboard',
        body:
          count === 1
            ? 'A session needs your attention'
            : `${count} sessions need your attention`,
      };
    }
    return {
      kind: 'ready',
      sessionIds,
      title: 'Switchboard',
      body:
        count === 1
          ? 'A session is ready for review'
          : `${count} sessions are ready for review`,
    };
  }

  // Decide whether/what to notify based on attention/ready transitions, window
  // focus, user settings, and a coalescing throttle. Pure: no DOM, no Electron.
  //
  //   prev/next: { attention: Set|string[], ready: Set|string[] } snapshots
  //   settings:  { enabled, notifyOnReady } (sound handled by spec 02)
  // returns: { notifications: [{ kind, sessionIds, title, body }], badgeCount }
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
    // included — when off there is nothing to show.
    const badgeCount = enabled ? nextAttention.size + (notifyOnReady ? nextReady.size : 0) : 0;
    const result = { notifications: [], badgeCount };

    // Disabled or focused → never raise a notification. When focused the badge
    // still reflects the live count.
    if (!enabled || opts.windowFocused) return result;

    // Throttle: a recent emission suppresses this batch (the badge still updates).
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    if (typeof opts.lastNotifiedAt === 'number' && now - opts.lastNotifiedAt < COALESCE_WINDOW_MS) {
      return result;
    }

    const newAttention = newcomers(prevAttention, nextAttention);
    if (newAttention.length > 0) {
      result.notifications.push(buildNotification('attention', newAttention));
    }

    if (notifyOnReady) {
      const newReady = newcomers(prevReady, nextReady);
      if (newReady.length > 0) {
        result.notifications.push(buildNotification('ready', newReady));
      }
    }

    return result;
  }

  return { decideNotifications, COALESCE_WINDOW_MS };
});
