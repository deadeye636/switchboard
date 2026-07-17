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

  /**
   * The backend to fall back on when nobody has said which one — the first LAUNCHABLE one (#212).
   *
   * There are exactly two honest reasons to reach for a backend id nobody named, and this is one of
   * them; the other is reading a record that predates the multi-LLM era, which is `sessionBackendId`'s
   * job below and says so. Everything else used to write `|| 'claude'`, which is a guess: Claude can be
   * disabled (#162), and a default pointing at a disabled backend is a spawn that gets refused — the
   * launch popover offering a row that cannot start, the profile editor binding a template to a base
   * the user switched off.
   *
   * `launchableBackends()` keeps registration order, so "first" means the same thing here as it does in
   * Settings > Backends and in the launch picker. Returns '' when nothing is launchable at all: every
   * backend can be disabled (§5.8), and '' is the honest answer — a caller must not turn it into a
   * different backend's id.
   */
  function firstLaunchableBackendId() {
    const list = launchableBackends();
    return list.length ? list[0].id : '';
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
   * Mixed-mode decision: does EVERY session row carry a provider badge?
   *
   * It follows the backends you RUN — the ones that are ready and enabled — not the sessions that happen
   * to be on screen. Deriving it from the visible sessions made the badges come and go with the list: a
   * user running Claude and Codex saw them vanish the moment the Codex rows were filtered out, scrolled
   * past the fold, or simply not started yet, and the remaining Claude rows then looked like the rows of a
   * single-backend app. If you run more than one CLI, you always need to know which one you are looking at.
   *
   *   >= 2 enabled backends           -> badge everything (you need to tell them apart)
   *   exactly 1, and it IS the default -> no badges (a single-backend user sees an unchanged app)
   *   exactly 1, and it is NOT default -> badge it (it is not what you would assume)
   *
   * `sessions` is only the fallback for the moment before the backend probes have answered: with nothing
   * known about the backends, what the sessions say is all there is. A session whose backend is not the
   * default is badged individually anyway (see buildSessionItem), so nothing is ever unlabelled.
   */
  function computeShowAllBadges(sessions) {
    const enabled = launchableBackends();
    let show;
    if (enabled.length >= 2) {
      show = true;
    } else if (enabled.length === 1) {
      show = enabled[0].id !== window._defaultBackendId;
    } else {
      const distinct = new Set();
      for (const s of sessions || []) distinct.add(sessionBackendId(s));
      show = distinct.size >= 2 || (distinct.size === 1 && !distinct.has(window._defaultBackendId));
    }
    window._showAllBadges = show;
    return show;
  }

  window.refreshBackendCaches = refreshBackendCaches;
  window.launchableBackends = launchableBackends;
  window.getBackend = getBackend;
  window.firstLaunchableBackendId = firstLaunchableBackendId;
  window.isBackendEnabled = isBackendEnabled;
  window.sessionBackendId = sessionBackendId;
  window.computeShowAllBadges = computeShowAllBadges;
})();
