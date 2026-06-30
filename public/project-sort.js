// Pure helper: order the sidebar's project list by the chosen mode.
// Electron-free (UMD) so it can be unit-tested. See docs/project-sidebar-plan.md "## 17".
//
// Rules (stable sort over a copy):
//   1. unless favoritesOwnList: favorited projects first
//   2. missing projects last
//   3. empty projects (no sessions) last
//   4. by mode: activity = newest session first; alpha = display label;
//      manual = projectOrder index (unknown → end, tiebreak by activity)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function shortNameOf(p) {
    return (p.projectPath || '').split('/').filter(Boolean).slice(-2).join('/');
  }
  function labelOf(p) {
    const custom = typeof p.displayName === 'string' ? p.displayName.trim() : '';
    return custom || shortNameOf(p);
  }
  function recencyOf(p) {
    return (p.sessions && p.sessions[0] && p.sessions[0].modified) || '';
  }
  function isEmptyOf(p) {
    return !p.sessions || p.sessions.length === 0;
  }

  function sortProjects(projects, opts) {
    opts = opts || {};
    const favoritesOwnList = !!opts.favoritesOwnList;
    const mode = opts.projectSortMode || 'activity';
    const order = Array.isArray(opts.projectOrder) ? opts.projectOrder : [];
    const orderIndex = new Map(order.map((path, i) => [path, i]));

    // Decorate with a stable original index so equal keys keep input order.
    const decorated = projects.map((p, i) => ({ p, i }));

    function modeCompare(a, b) {
      if (mode === 'alpha') {
        return labelOf(a).localeCompare(labelOf(b), 'de');
      }
      if (mode === 'manual') {
        const ai = orderIndex.has(a.projectPath) ? orderIndex.get(a.projectPath) : Infinity;
        const bi = orderIndex.has(b.projectPath) ? orderIndex.get(b.projectPath) : Infinity;
        if (ai !== bi) return ai - bi;
        // tiebreak: activity (newest first)
        return recencyOf(b).localeCompare(recencyOf(a));
      }
      // activity (default): newest first
      return recencyOf(b).localeCompare(recencyOf(a));
    }

    decorated.sort((da, db) => {
      const a = da.p, b = db.p;
      if (!favoritesOwnList) {
        const fa = a.favorited ? 0 : 1;
        const fb = b.favorited ? 0 : 1;
        if (fa !== fb) return fa - fb;
      }
      const ma = a.missing ? 1 : 0;
      const mb = b.missing ? 1 : 0;
      if (ma !== mb) return ma - mb;
      const ea = isEmptyOf(a) ? 1 : 0;
      const eb = isEmptyOf(b) ? 1 : 0;
      if (ea !== eb) return ea - eb;
      const mc = modeCompare(a, b);
      if (mc !== 0) return mc;
      return da.i - db.i; // stable
    });

    return decorated.map(d => d.p);
  }

  return { sortProjects };
});
