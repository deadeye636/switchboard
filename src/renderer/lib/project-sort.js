// Pure helper: order the sidebar's project list by the chosen mode.
// Electron-free (UMD) so it can be unit-tested. See issue #17 (sorting the project list).
//
// Rules (stable sort over a copy):
//   1. unless favoritesOwnList: favorited projects first
//   2. missing projects last        (not in manual mode)
//   3. empty projects (no sessions) last (not in manual mode)
//   4. by mode: activity = newest session first; alpha = display label;
//      manual = projectOrder index (unknown → end, tiebreak by activity)
//
// Manual mode keeps only rule 1 (#772): the user placed every project by hand, and a rule that moves one
// back after the drop reads as a drop that did nothing. Favorites stay pinned because their block has a
// visible divider and the drag never offers a position across it.
//
// moveInProjectOrder (#773) is the other half of manual mode: the saved order after one drag, moving only the
// dragged project. Called by the drop in shell/sidebar-events.js.
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
    // The newest VISIBLE session or the project's own lastActivity — whichever is
    // NEWER (#306). lastActivity counts archived sessions too, so archiving the
    // newest one hides a row without moving the project. It used to be
    // `visible || lastActivity`, which reordered the sidebar on every archive.
    const shown = (p.sessions && p.sessions[0] && p.sessions[0].modified) || '';
    const known = p.lastActivity || '';
    if (!shown) return known;
    if (!known) return shown;
    return new Date(shown) >= new Date(known) ? shown : known;
  }
  // "No recency at all" = a genuinely never-used empty folder. These sink to the
  // bottom; an all-archived project keeps its recency via lastActivity, so it is
  // NOT treated as empty here and stays at its natural position.
  function isEmptyOf(p) {
    return !recencyOf(p);
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
        return labelOf(a).localeCompare(labelOf(b), undefined);
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
      if (mode === 'manual') {
        const mc = modeCompare(a, b);
        return mc !== 0 ? mc : da.i - db.i;
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

  // The saved manual order after one drag (#773). Only the dragged project moves: it is placed next to the
  // neighbour it was dropped beside, and every other entry keeps its place — including projects the sidebar
  // is not rendering right now (a filter, a search, a hidden project). The order used to be re-read from the
  // rendered groups, which dropped every hidden project out of it.
  // `knownPaths` are every project the list knows, in the order the render would put them; the ones the saved
  // order does not hold yet are appended in that order, which is where the render already shows them.
  function moveInProjectOrder(savedOrder, knownPaths, dragged, target, after) {
    const order = [];
    const seen = new Set();
    const add = (p) => { if (typeof p === 'string' && p && !seen.has(p)) { seen.add(p); order.push(p); } };
    // A duplicate keeps its LAST place, the one sortProjects ranks it by (its index map takes the last write).
    const saved = Array.isArray(savedOrder) ? savedOrder : [];
    saved.filter((p, i) => saved.lastIndexOf(p) === i).forEach(add);
    // Entries no list knows are kept, never pruned: a hidden project is in no list here, and dropping it
    // is exactly what lost its place. The order grows by one short path per project ever seen.
    (Array.isArray(knownPaths) ? knownPaths : []).forEach(add);
    add(target);
    if (!dragged || dragged === target) return order;
    const from = order.indexOf(dragged);
    if (from !== -1) order.splice(from, 1);
    const at = order.indexOf(target);
    order.splice(after ? at + 1 : at, 0, dragged);
    return order;
  }

  return { sortProjects, moveInProjectOrder };
});
