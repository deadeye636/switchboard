// public/backend-registry.js — renderer-side cache of the backend registry + the session→backend map.
//
// Loaded once at startup (and refreshed after a settings/profile change) so the sidebar, launch picker
// and stats can resolve a session's backend synchronously, without an IPC round-trip per row.
//
// Provenance (§5.7): a session's backend is resolved from the AUTHORITATIVE cached row
// (`session.backendId`, written by the scanner) FIRST; the launch-time overlay map is only a fallback
// for a session that has just been launched and not yet scanned.
//
// Mixed mode (§ glossary): badges stay OFF while the user only runs the default backend — the app must
// look untouched for a Claude-only user. Badge every row as soon as ≥2 distinct backends have sessions,
// or exactly one that isn't the default launch target.
(function () {
  'use strict';

  window._backendsById = {};        // id -> descriptor
  window._sessionBackendMap = {};   // sessionId -> {backendId, profileId}   (launch overlay)
  window._defaultBackendId = 'claude';
  window._showAllBadges = false;

  async function refreshBackendCaches() {
    try {
      const res = await window.api.backends.list();
      const list = (res && res.backends) || [];
      const byId = {};
      for (const b of list) byId[b.id] = b;
      window._backendsById = byId;
      window._defaultBackendId = (res && res.defaultLaunchTarget) || 'claude';
    } catch (_) { /* leave the previous cache in place */ }

    try {
      window._sessionBackendMap = (await window.api.sessionBackends.getAll()) || {};
    } catch (_) { /* ditto */ }

    return window._backendsById;
  }

  // Only `ready && enabled` backends may appear in launch surfaces / be counted as live (§5.8).
  function launchableBackends() {
    return Object.values(window._backendsById).filter(b => b.status === 'ready' && b.enabled);
  }

  function getBackend(id) {
    return window._backendsById[id] || null;
  }

  // §5.8: only a `ready && enabled` backend counts as one the user actually runs. A disabled backend
  // keeps its cached sessions (disable ≠ erase) but stops making the app "mixed mode".
  function isBackendEnabled(id) {
    const b = window._backendsById[id];
    return !!(b && b.status === 'ready' && b.enabled);
  }

  // Resolve a session's backend id. Authoritative cached column first, overlay second, default last.
  function sessionBackendId(session) {
    if (!session) return window._defaultBackendId;
    if (session.backendId) return session.backendId;
    const id = session.sessionId || session.id;
    const mapped = id && window._sessionBackendMap[id];
    if (mapped && mapped.backendId) return mapped.backendId;
    return 'claude'; // a session with no provenance predates the multi-LLM era -> it is Claude
  }

  /**
   * Mixed-mode decision. `sessions` = the currently known sessions.
   *   0 distinct backends            -> no badges
   *   >= 2 distinct backends         -> badge everything (you need to tell them apart)
   *   exactly 1, and it IS the default-> no badges (a single-backend user sees an unchanged app)
   *   exactly 1, and it is NOT default-> badge it (it is not what you'd assume)
   */
  function computeShowAllBadges(sessions) {
    const distinct = new Set();
    for (const s of sessions || []) distinct.add(sessionBackendId(s));
    let show;
    if (distinct.size === 0) show = false;
    else if (distinct.size >= 2) show = true;
    else show = !distinct.has(window._defaultBackendId);
    window._showAllBadges = show;
    return show;
  }

  window.refreshBackendCaches = refreshBackendCaches;
  window.launchableBackends = launchableBackends;
  window.getBackend = getBackend;
  window.isBackendEnabled = isBackendEnabled;
  window.sessionBackendId = sessionBackendId;
  window.computeShowAllBadges = computeShowAllBadges;
})();
