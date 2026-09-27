// Pure helpers for the saved variables' manual order (#676). Electron-free (UMD) so they can be
// unit-tested; the variables manager (panels/variables-admin.js) is the only caller.
//
// The order is ONE list across every scope, and these functions work on the ids of that whole list. A
// scope filter in the manager shows a subset, and a move made there still has one well-defined result:
// the moved row lands directly before or after the row it was dropped on (or stepped past), and every
// row the filter hides keeps its place. Under a TEXT filter the manager does not reorder at all.
//
// The store renumbers from whatever list it is sent and has its own rule for a stale one
// (src/db/saved-variable-order.js). Nothing here decides what is stored — it only computes the list the
// manager asks for and shows while the answer is on its way.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // `ids` with `movedId` taken out and put back directly before/after `targetId`. Anything it cannot do
  // (an unknown id, a row dropped on itself) returns an unchanged copy, so the caller can compare.
  function moveVariableInOrder(ids, movedId, targetId, place) {
    const list = Array.isArray(ids) ? ids.slice() : [];
    if (movedId === targetId) return list;
    const from = list.indexOf(movedId);
    if (from < 0 || list.indexOf(targetId) < 0) return list;
    list.splice(from, 1);
    const to = list.indexOf(targetId);
    list.splice(place === 'after' ? to + 1 : to, 0, movedId);
    return list;
  }

  // One keyboard step (Alt+ArrowUp / Alt+ArrowDown): past the neighbouring VISIBLE row. `delta` is -1 or
  // +1. Returns null at either end of what is shown, so the key does nothing there.
  function stepVariableInOrder(ids, visibleIds, movedId, delta) {
    const shown = Array.isArray(visibleIds) ? visibleIds : [];
    const at = shown.indexOf(movedId);
    if (at < 0) return null;
    const neighbour = shown[at + (delta < 0 ? -1 : 1)];
    if (neighbour == null) return null;
    return moveVariableInOrder(ids, movedId, neighbour, delta < 0 ? 'before' : 'after');
  }

  // SQLite's LOWER() folds ASCII only, and its ORDER BY compares code points; this is that, so "Sort by
  // name" produces exactly the order the list had before #676 (LOWER(name), then the newest edit first).
  function asciiLower(s) {
    return String(s == null ? '' : s).replace(/[A-Z]/g, c => c.toLowerCase());
  }
  function variableIdsByName(rows) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    return list.slice().sort((a, b) => {
      const na = asciiLower(a.name);
      const nb = asciiLower(b.name);
      if (na !== nb) return na < nb ? -1 : 1;
      const ua = String(a.updatedAt || '');
      const ub = String(b.updatedAt || '');
      if (ua !== ub) return ua > ub ? -1 : 1;
      return 0;
    }).map(r => r.id);
  }

  // `rows` put into the order `ids` names. A row the list does not name keeps its relative place after the
  // named ones — the same answer the store gives a stale list, so the screen does not jump when it replies.
  function orderVariableRows(rows, ids) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    const byId = new Map(list.map(r => [r.id, r]));
    const out = [];
    const seen = new Set();
    for (const id of Array.isArray(ids) ? ids : []) {
      const row = byId.get(id);
      if (!row || seen.has(id)) continue;
      seen.add(id);
      out.push(row);
    }
    for (const row of list) if (!seen.has(row.id)) out.push(row);
    return out;
  }

  function sameVariableOrder(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((id, i) => id === b[i]);
  }

  return { moveVariableInOrder, stepVariableInOrder, variableIdsByName, orderVariableRows, sameVariableOrder };
});
