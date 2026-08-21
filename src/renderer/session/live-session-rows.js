// --- Which running sessions this window has to invent a row for (#461) ---
//
// The sidebar list and `sessionMap` are built out of the session INDEX. A session whose backend never
// recorded it is not in there, so after a reload it is a live process with nothing on screen. app.js
// invents a row for such a session out of what main can say about a running process.
//
// The DECISION is here and the DOM work is not, so it can be driven without a renderer. Three answers per
// pass, and the middle one is what makes adoption need no special case anywhere:
//
//   release — ids the index has taken over. This window stops claiming them, so a later exit reaps a row
//             that now belongs to somebody else. Without it the answer would be cached, and a healed row
//             that ended would be pulled off the sidebar under the index's feet.
//   drop    — invented rows whose process is gone. A session re-keyed onto the id its backend chose stops
//             being live under the old one, so the stale row leaves on the same pass its successor arrives.
//   add     — live sessions with no row of their own. Recomputed every pass rather than accumulated:
//             `loadProjects` replaces the cached lists wholesale on every store write, so a row inserted
//             once would be gone within the second.
//
// UMD-wrapped like the other pure renderer helpers: `node --test` requires it, the browser gets globals.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // A plain terminal is not one of these. It has its own path through `loadProjects`, and an invented row
  // for one would be missing `type: 'terminal'` — which is exactly what stops the quit-restore from
  // resuming it as a CLI session, i.e. a fresh shell wearing the old session's name.
  function usable(entry) {
    return !!(entry && entry.sessionId && entry.projectPath && !entry.isPlainTerminal);
  }

  /**
   * @param liveList     what main says is running: [{ sessionId, projectPath, backendId, isPlainTerminal }]
   * @param indexedIds   the ids the index holds, or null when the caller has no fresh answer (the poll)
   * @param synthetic    the ids this window has invented a row for
   * @param known        the ids the window has a session object for at all (`sessionMap`)
   */
  function planLiveSessionRows(liveList, { indexedIds = null, synthetic = null, known = null } = {}) {
    const has = (set, id) => !!(set && typeof set.has === 'function' && set.has(id));
    const live = new Map();
    for (const entry of liveList || []) if (usable(entry)) live.set(entry.sessionId, entry);

    const release = [];
    const drop = [];
    for (const sessionId of (synthetic || [])) {
      if (indexedIds && has(indexedIds, sessionId)) { release.push(sessionId); continue; }
      if (!live.has(sessionId)) drop.push(sessionId);
    }

    const released = new Set(release);
    const add = [];
    for (const [sessionId, entry] of live) {
      // Owned by the index — either it always was, or it was handed over on this very pass.
      if (has(known, sessionId) && !has(synthetic, sessionId)) continue;
      if (released.has(sessionId)) continue;
      add.push(entry);
    }
    return { add, drop, release };
  }

  return { planLiveSessionRows };
});
