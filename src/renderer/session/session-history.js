// --- Session visit history (#36) ---
// A browser-style back/forward stack over the sessions the user has *visited*,
// in temporal order. Distinct from navigateSession, which cycles the sidebar's
// spatial order, and from lruOrder (terminal-manager.js), which exists to evict
// terminals: capped at 12, open sessions only, no cursor.
//
// Loaded as a classic <script> in the renderer (exposes globals) AND require()-d
// by node tests (module.exports). Keep this file free of DOM/browser APIs.
//
// `isAlive(sessionId)` is supplied by the caller and decides whether an entry is
// still a navigable target. Entries that fail it are dropped rather than skipped,
// so a session closed long ago never resurfaces.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const DEFAULT_HISTORY_CAP = 50;

  function createSessionHistory({ cap = DEFAULT_HISTORY_CAP } = {}) {
    // entries: oldest → newest. cursor: index of the currently shown session,
    // or -1 when the history is empty.
    return { entries: [], cursor: -1, cap: Math.max(1, Math.floor(cap) || DEFAULT_HISTORY_CAP) };
  }

  // Record a visit. Truncates whatever lay ahead of the cursor — going somewhere
  // new from the middle of the history abandons the forward tail, exactly like a
  // browser. Re-visiting the session already under the cursor is a no-op, so a
  // re-render or a redundant focus call cannot stack duplicates.
  function visitSession(store, sessionId) {
    if (!store || !sessionId) return;
    if (store.entries[store.cursor] === sessionId) return;

    store.entries.length = store.cursor + 1;
    store.entries.push(sessionId);

    // Cap from the old end; the cursor follows the newest entry either way.
    if (store.entries.length > store.cap) {
      store.entries.splice(0, store.entries.length - store.cap);
    }
    store.cursor = store.entries.length - 1;
  }

  // Drop entries whose session no longer exists, keeping the cursor on the same
  // entry it pointed at (or on the nearest surviving one before it).
  function pruneHistory(store, isAlive) {
    if (!store || typeof isAlive !== 'function') return;
    const kept = [];
    let cursor = -1;
    for (let i = 0; i < store.entries.length; i++) {
      const id = store.entries[i];
      if (!isAlive(id)) continue;
      kept.push(id);
      if (i <= store.cursor) cursor = kept.length - 1;
    }
    store.entries = kept;
    store.cursor = Math.min(cursor, kept.length - 1);
  }

  function canGoBack(store) {
    return !!store && store.cursor > 0;
  }

  function canGoForward(store) {
    return !!store && store.cursor >= 0 && store.cursor < store.entries.length - 1;
  }

  // Move the cursor one step and return the session to show, or null when there
  // is nowhere to go. Dead entries are pruned first, so a target is always live.
  function historyBack(store, isAlive) {
    if (!store) return null;
    if (typeof isAlive === 'function') pruneHistory(store, isAlive);
    if (!canGoBack(store)) return null;
    store.cursor -= 1;
    return store.entries[store.cursor];
  }

  function historyForward(store, isAlive) {
    if (!store) return null;
    if (typeof isAlive === 'function') pruneHistory(store, isAlive);
    if (!canGoForward(store)) return null;
    store.cursor += 1;
    return store.entries[store.cursor];
  }

  return {
    DEFAULT_HISTORY_CAP,
    createSessionHistory,
    visitSession,
    pruneHistory,
    canGoBack,
    canGoForward,
    historyBack,
    historyForward,
  };
});
