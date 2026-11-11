(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Flood guard (#847). Every session gets its own OS notification, so a burst of transitions (a swarm
  // of agents finishing together) must not turn into a wall of toasts. At most FLOOD_MAX individual
  // notifications go out per FLOOD_WINDOW_MS; the rest folds into ONE summary entry that counts every
  // folded session still waiting and is shown at most once per window. A
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
  //   prevSettings:    the settings the PREVIOUS snapshot was announced under (default: `settings`), so
  //                    turning notifications off still clears what the old settings had announced
  //   recent:          emission times (ms) of earlier individual notifications - the flood guard's state
  //   summary:         { ids, shownCount, shownAt } - the summary's state, returned as `summary` (see below)
  //   fresh:           true on the renderer's first sync: ask main to drop entries a previous renderer left
  //   describeSession: (sessionId) => { name, project, projectKey } - the caller knows the sessions
  // returns: {
  //   notifications: [{ kind, sessionId, sessionIds, title, body, project, projectKey }  // one per session
  //                   | { kind: 'summary', summary: true, sessionIds, title, body }],     // the folded rest
  //   cleared:   session ids that left the announced set, so their OS entry should go,
  //   clearSummary: true when every session folded into the summary has left the sets (it should go),
  //   clearAll: true when `fresh` (main drops every entry it still holds),
  //   summary: the state to pass back next time: ids = folded sessions still announced, shownCount = the
  //            count on screen, shownAt = when it was last shown. The summary is (re)shown only when more
  //            sessions are folded than it shows AND the flood window since shownAt has passed; otherwise
  //            the count waits for the next sync that is allowed to show it,
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
    const result = {
      notifications: [], cleared: [], clearSummary: false, clearAll: !!opts.fresh, badgeCount,
    };

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
    const prevSettings = opts.prevSettings || settings;
    const wasEnabled = prevSettings.enabled !== false;
    const wasNotifyOnReady = !!prevSettings.notifyOnReady;
    const wasAnnounced = new Set();
    if (wasEnabled) {
      prevAttention.forEach((id) => wasAnnounced.add(id));
      if (wasNotifyOnReady) prevReady.forEach((id) => wasAnnounced.add(id));
    }
    const isAnnounced = announced(nextAttention, nextReady);
    wasAnnounced.forEach((id) => {
      if (!isAnnounced.has(id)) result.cleared.push(id);
    });

    // The summary stands for the folded sessions that are still announced. Once none is left it goes.
    const prevSummary = opts.summary || {};
    const folded = new Set((Array.isArray(prevSummary.ids) ? prevSummary.ids : []).filter((id) => isAnnounced.has(id)));
    let shownCount = Math.min(prevSummary.shownCount || 0, folded.size);
    let shownAt = typeof prevSummary.shownAt === 'number' ? prevSummary.shownAt : null;
    if (folded.size === 0 && (prevSummary.shownCount || 0) > 0) {
      result.clearSummary = true;
    }
    const finish = () => {
      result.summary = { ids: [...folded], shownCount, shownAt };
      return result;
    };

    // Disabled or focused -> never raise a notification. When focused the badge
    // still reflects the live count.
    if (!enabled || opts.windowFocused) return finish();

    const newAttention = newcomers(prevAttention, nextAttention);
    const pending = newAttention.map((id) => ({ kind: 'attention', id }));
    if (notifyOnReady) {
      const seen = new Set(newAttention);
      newcomers(prevReady, nextReady).forEach((id) => {
        if (!seen.has(id)) pending.push({ kind: 'ready', id });
      });
    }

    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const recent = Array.isArray(opts.recent) ? opts.recent : [];
    const used = recent.filter((t) => now - t < FLOOD_WINDOW_MS).length;
    const budget = Math.max(0, FLOOD_MAX - used);

    pending.slice(0, budget).forEach(({ kind, id }) => {
      result.notifications.push(oneNotification(kind, id, opts.describeSession));
      folded.delete(id); // it has its own entry now
    });
    pending.slice(budget).forEach(({ id }) => folded.add(id));
    shownCount = Math.min(shownCount, folded.size);
    if (folded.size === 0 && (prevSummary.shownCount || 0) > 0) result.clearSummary = true;
    const summaryDue = folded.size > shownCount && (shownAt === null || now - shownAt >= FLOOD_WINDOW_MS);
    if (summaryDue) {
      // "need your attention" unless every folded one is only "ready".
      const kind = [...folded].some((id) => nextAttention.has(id)) ? 'attention' : 'ready';
      result.notifications.push(summaryNotification(kind, [...folded]));
      // A new summary replaces the old one by id; a clear in the same sync would take the new one down
      // right after it was shown (the caller sends the notifies first, then the clear).
      result.clearSummary = false;
      shownCount = folded.size;
      shownAt = now;
    }
    return finish();
  }

  return { decideNotifications, FLOOD_MAX, FLOOD_WINDOW_MS };
});
