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
// reorderOnce (#866) is the View menu's one-off re-order under Manual.
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
  // The one name compare: the Alpha sort and the one-off A-Z re-order (#866) both use it.
  function compareLabels(a, b) {
    return labelOf(a).localeCompare(labelOf(b), undefined);
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
        return compareLabels(a, b);
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

  // The order the Activity sort would change, held at the one already on screen (#867). `sorted` is what
  // sortProjects answered, `heldPaths` the paths in the order last drawn. A project the screen already has keeps
  // its place; one it does not have yet goes at the END, in sorted order, because the end is the only place that
  // moves no row under the pointer; one that is gone drops out. The favorites block stays one block when
  // `favoritesFirst` (the divider and the sort both assume it), so a project favorited meanwhile moves up at once.
  function holdProjectOrder(sorted, heldPaths, opts) {
    const favoritesFirst = !!(opts && opts.favoritesFirst);
    const held = Array.isArray(heldPaths) ? heldPaths : [];
    const rank = new Map();
    held.forEach((path, i) => { if (!rank.has(path)) rank.set(path, i); });
    const decorated = sorted.map((p, i) => ({ p, i }));
    decorated.sort((a, b) => {
      if (favoritesFirst) {
        const fa = a.p.favorited ? 0 : 1;
        const fb = b.p.favorited ? 0 : 1;
        if (fa !== fb) return fa - fb;
      }
      const ra = rank.has(a.p.projectPath) ? rank.get(a.p.projectPath) : Infinity;
      const rb = rank.has(b.p.projectPath) ? rank.get(b.p.projectPath) : Infinity;
      if (ra !== rb) return ra - rb;
      return a.i - b.i;
    });
    return decorated.map(d => d.p);
  }

  // Re-order once (#866). The four orders the View menu offers under Manual, as a full saved order.
  //   activity  newest first, the value the Activity sort uses (recencyOf); no activity last
  //   alpha / alpha-desc  the label the sidebar shows (labelOf), locale-aware
  //   added     the date the project was added (`addedAt`), newest first; a project with none falls back to its
  //             OLDEST session (`created`, else `modified`), and one with neither goes last
  // `projects` may hold a project twice (the filtered and the full list): the first wins. Entries of
  // `savedOrder` no project here names are kept after the sorted ones, as moveInProjectOrder keeps them.
  // The favorites block is not handled here: manual mode pins it at render (sortProjects).
  function addedAtOf(p) {
    if (p.addedAt) return p.addedAt;
    let oldest = '';
    for (const s of (p.sessions || [])) {
      const t = s.created || s.modified || '';
      if (t && (!oldest || new Date(t) < new Date(oldest))) oldest = t;
    }
    return oldest;
  }
  function reorderOnce(projects, kind, savedOrder) {
    const seen = new Set();
    const list = [];
    for (const p of (projects || [])) {
      if (p && p.projectPath && !seen.has(p.projectPath)) { seen.add(p.projectPath); list.push(p); }
    }
    const byDate = (dateOf) => (a, b) => {
      const da = dateOf(a), db = dateOf(b);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return new Date(db) - new Date(da);
    };
    const byLabel = compareLabels;
    const compare = {
      activity: byDate(recencyOf),
      alpha: byLabel,
      'alpha-desc': (a, b) => byLabel(b, a),
      added: byDate(addedAtOf),
    }[kind];
    if (!compare) return null;
    const decorated = list.map((p, i) => ({ p, i }));
    decorated.sort((x, y) => compare(x.p, y.p) || x.i - y.i);
    const order = decorated.map(d => d.p.projectPath);
    const known = new Set(order);
    for (const path of (Array.isArray(savedOrder) ? savedOrder : [])) {
      if (typeof path === 'string' && path && !known.has(path)) { known.add(path); order.push(path); }
    }
    return order;
  }

  // Did the projects both lists hold change their order relative to each other? An added or removed project
  // alone is not a re-order (#868): nothing was swapped, so nothing glides.
  function projectOrderChanged(prevIds, nextIds) {
    const next = new Set(nextIds);
    const prev = new Set(prevIds);
    const a = prevIds.filter(id => next.has(id));
    const b = nextIds.filter(id => prev.has(id));
    return a.length !== b.length || a.some((id, i) => id !== b[i]);
  }

  // Whether a render glides its projects to new places (#868): only the Activity sort, only when the order
  // changed, not under reduced motion and not in a window nobody can see.
  function shouldGlideProjects({ mode, reducedMotion, hidden, prevIds, nextIds }) {
    if (mode !== 'activity' || reducedMotion || hidden) return false;
    return projectOrderChanged(prevIds || [], nextIds || []);
  }

  return { sortProjects, moveInProjectOrder, reorderOnce, holdProjectOrder, projectOrderChanged, shouldGlideProjects };
});
