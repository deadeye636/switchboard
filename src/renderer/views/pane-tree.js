// --- Pane tree: the layout model behind `sessionDisplayMode = panes` (#309) ---
// Pure data. No DOM, no globals — the renderer half (building the panes, moving
// terminal containers, the drag gestures) lives elsewhere; this file is the model
// those talk to, and the one the node tests exercise.
//
// Loaded as a classic <script> in the renderer, where it exposes ONE global —
// `PaneTree` — and require()-d by node tests, which take the same object. The
// namespace is deliberate: grid-layout.js spreads its exports onto the global
// scope, but names like `addTab`, `closeTab` or `serialize` are far too generic
// for that. Keep this file free of DOM/browser APIs.
//
// Shape (mirrors VS Code's vs/base/browser/ui/grid/grid.ts):
//   leaf   { type:'leaf', id, tabs:[{ id, kind, ref }], activeTabId, size }
//   branch { type:'branch', orientation:'row'|'col', children:[node], size }
// `size` is a FRACTION of the parent's extent, never pixels — a layout saved on a
// 4K screen has to restore sanely on a laptop (#309 O8). Sibling sizes sum to 1.
//
// A tab is a TYPED VIEW, not a session id (#309 O11/O12): `kind` says what it
// renders, `ref` is the thing it renders (a session id for a terminal, a path for
// a preview). That is what lets a preview sit in the same tree as a terminal.
//
// Branches carry no id. They are addressed by PATH — an array of child indices from
// the root — so nothing here has to invent identifiers, which keeps every operation
// deterministic and the tests free of id plumbing. Leaves do carry an id, because
// the DOM and the drag gestures need a stable handle on a pane.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PaneTree = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // What a tab can render. A tab whose kind is not in here is dropped on load
  // rather than mounted — an unknown kind means a downgrade or a corrupt store.
  // What a tab can render. A tab whose kind is not in here is dropped on load rather than mounted —
  // an unknown kind means a downgrade or a corrupt store. The list mirrors `VIEW_KINDS` in
  // panes-view.js (#342 added the remaining main-area surfaces); a kind in one and not the other is
  // not an error today, because a view tab is never restored from the store, but it is a trap.
  const TAB_KINDS = [
    'terminal', 'preview', 'diff', 'plan', 'stats', 'memory', 'jsonl',
    'projects', 'variables', 'workFiles', 'settings', 'tasks', 'bookmarks', 'timeline',
  ];

  // Smallest share of its parent a pane may be squeezed to by a sash drag. Below
  // this the tab strip stops being usable, and a pane that reaches 0 is impossible
  // to grab again with the mouse.
  const MIN_PANE_FRACTION = 0.05;

  // Which axis a split direction implies, and whether the new pane goes before the
  // existing one. 'row' = children side by side, 'col' = stacked.
  const SPLIT_AXIS = {
    left: { orientation: 'row', before: true },
    right: { orientation: 'row', before: false },
    up: { orientation: 'col', before: true },
    down: { orientation: 'col', before: false },
  };

  const isLeaf = (node) => !!node && node.type === 'leaf';
  const isBranch = (node) => !!node && node.type === 'branch';
  const clone = (node) => JSON.parse(JSON.stringify(node));

  function makeLeaf(id, tabs = [], activeTabId = null, size = 1) {
    const list = tabs.slice();
    const active = list.some((t) => t.id === activeTabId) ? activeTabId : (list[0] ? list[0].id : null);
    return { type: 'leaf', id, tabs: list, activeTabId: active, size };
  }

  // A tree is never empty: the root starts as one leaf, and the last leaf survives
  // even when its last tab closes (the pane goes, the window stays — #309 O10).
  function createTree(leafId, tabs = []) {
    return makeLeaf(leafId, tabs, tabs[0] ? tabs[0].id : null, 1);
  }

  // --- Addressing -----------------------------------------------------------
  // A path is the list of child indices from the root: [] is the root, [0,1] is the
  // second child of the first child. `nodeAt` returns null for a path that has run
  // off the tree, so callers never have to pre-validate one.

  function nodeAt(tree, path) {
    let node = tree;
    for (const i of path) {
      if (!isBranch(node) || !node.children[i]) return null;
      node = node.children[i];
    }
    return node || null;
  }

  // Path of the leaf with this id, or null. Depth-first, first match wins — ids are
  // unique by contract, and a duplicate would be a caller bug, not a shape to support.
  function pathOfLeaf(tree, leafId, path = []) {
    if (isLeaf(tree)) return tree.id === leafId ? path : null;
    if (!isBranch(tree)) return null;
    for (let i = 0; i < tree.children.length; i++) {
      const hit = pathOfLeaf(tree.children[i], leafId, path.concat(i));
      if (hit) return hit;
    }
    return null;
  }

  // Every leaf, in render order (left-to-right, top-to-bottom).
  function leaves(node, out = []) {
    if (isLeaf(node)) out.push(node);
    else if (isBranch(node)) node.children.forEach((c) => leaves(c, out));
    return out;
  }

  // The leaf currently holding a tab, or null — the drag gestures ask this before
  // they know where a dragged tab came from.
  function leafOfTab(tree, tabId) {
    return leaves(tree).find((l) => l.tabs.some((t) => t.id === tabId)) || null;
  }

  // Replace the node at `path`, returning a new tree. `next` may be null, which
  // removes the node from its parent (see collapse below).
  function replaceAt(tree, path, next) {
    if (!path.length) return next;
    const copy = clone(tree);
    let parent = copy;
    for (let i = 0; i < path.length - 1; i++) parent = parent.children[path[i]];
    const idx = path[path.length - 1];
    if (next === null) parent.children.splice(idx, 1);
    else parent.children[idx] = next;
    return copy;
  }

  // --- Sizes ----------------------------------------------------------------

  // Rescale a sibling list so the sizes sum to 1, keeping their proportions. Used
  // after an insert or a removal, where the remaining panes should keep their
  // relative widths rather than jump back to even.
  function normalizeSizes(children) {
    const total = children.reduce((sum, c) => sum + (Number(c.size) > 0 ? Number(c.size) : 0), 0);
    if (!(total > 0)) {
      const even = 1 / Math.max(1, children.length);
      children.forEach((c) => { c.size = even; });
      return children;
    }
    children.forEach((c) => { c.size = (Number(c.size) > 0 ? Number(c.size) : 0) / total; });
    return children;
  }

  // A branch with a single child carries no information — replace it with that
  // child, which inherits its size. Without this, closing panes would leave a tower
  // of one-child branches that every later split would have to walk through.
  function collapse(node) {
    if (!isBranch(node)) return node;
    const children = node.children.map(collapse);
    if (children.length === 1) {
      const only = children[0];
      only.size = node.size;
      return only;
    }
    return { ...node, children };
  }

  // --- Operations -----------------------------------------------------------
  // All of these are (tree, args) → new tree. They never mutate the input, and an
  // unknown id or an illegal argument is a no-op returning a copy: a dropped drag
  // must not be able to destroy a layout.

  // Split `leafId` in `direction`, putting `tab` into the new pane. `newLeafId` is
  // supplied by the caller so this stays deterministic (no id generation in here).
  //
  // The rule is VS Code's: when the direction's axis already matches the parent
  // branch, insert a sibling; otherwise wrap the leaf in a new perpendicular branch.
  // Both cases give the new pane half of the split pane's share.
  function splitLeaf(tree, leafId, direction, { newLeafId, tab } = {}) {
    const axis = SPLIT_AXIS[direction];
    const path = pathOfLeaf(tree, leafId);
    if (!axis || !path || !newLeafId) return clone(tree);

    const target = nodeAt(tree, path);
    const tabs = tab ? [tab] : [];
    const half = target.size / 2;
    const fresh = makeLeaf(newLeafId, tabs, tabs[0] ? tabs[0].id : null, half);
    const shrunk = { ...clone(target), size: half };

    const parentPath = path.slice(0, -1);
    const parent = parentPath.length || isBranch(tree) ? nodeAt(tree, parentPath) : null;

    if (isBranch(parent) && parent.orientation === axis.orientation) {
      const copy = clone(tree);
      const parentCopy = nodeAt(copy, parentPath);
      const idx = path[path.length - 1];
      parentCopy.children[idx] = shrunk;
      parentCopy.children.splice(axis.before ? idx : idx + 1, 0, fresh);
      normalizeSizes(parentCopy.children);
      return copy;
    }

    const branch = {
      type: 'branch',
      orientation: axis.orientation,
      size: target.size,
      children: axis.before ? [fresh, shrunk] : [shrunk, fresh],
    };
    normalizeSizes(branch.children);
    return replaceAt(tree, path, branch);
  }

  /**
   * Build a fresh tree that gives every tab a pane of its own, `columns` panes wide (#356).
   *
   * This is a COMMAND, not a mode: grid arranges continuously and panes are arranged by hand, so what
   * "auto-tiling" means here is one act that produces an arrangement the user then owns and can edit.
   *
   * Column-major, like grid's flow: with seven tabs in three columns the columns hold 3, 2 and 2 —
   * filling left to right so the extra ones land at the start, which is where the eye goes.
   *
   * Leaf ids are `pane-1…N` in visual order. They are generated here rather than passed in (the one
   * exception to this file's rule) because the caller cannot know the count until the split is decided,
   * and the whole tree is being replaced anyway — nothing outside holds the old ids.
   */
  function tileTabs(tabs, columns) {
    const list = (Array.isArray(tabs) ? tabs : []).filter(Boolean);
    if (!list.length) return createTree('pane-1', []);
    const cols = Math.max(1, Math.min(Math.floor(Number(columns) || 1), list.length));
    if (cols === 1 && list.length === 1) return createTree('pane-1', [list[0]]);

    // How many rows each column takes: the remainder is spread over the first columns, one each, so no
    // column is ever more than one pane taller than its neighbour.
    const base = Math.floor(list.length / cols);
    const extra = list.length % cols;
    const children = [];
    let at = 0;
    let id = 0;
    for (let c = 0; c < cols; c++) {
      const rows = base + (c < extra ? 1 : 0);
      const leaves = [];
      for (let r = 0; r < rows; r++) {
        const tab = list[at++];
        leaves.push(makeLeaf('pane-' + (++id), [tab], tab.id, 1 / rows));
      }
      children.push(leaves.length === 1
        ? { ...leaves[0], size: 1 / cols }
        : { type: 'branch', orientation: 'col', size: 1 / cols, children: leaves });
    }
    if (children.length === 1) return { ...children[0], size: 1 };
    return { type: 'branch', orientation: 'row', size: 1, children };
  }

  // Add a tab to a pane at `index` (default: last) and make it active — opening
  // something always shows it.
  function addTab(tree, leafId, tab, index = -1) {
    const path = pathOfLeaf(tree, leafId);
    if (!path || !tab || !tab.id) return clone(tree);
    const leaf = clone(nodeAt(tree, path));
    if (leaf.tabs.some((t) => t.id === tab.id)) return clone(tree);
    const at = index < 0 || index > leaf.tabs.length ? leaf.tabs.length : index;
    leaf.tabs.splice(at, 0, tab);
    leaf.activeTabId = tab.id;
    return replaceAt(tree, path, leaf);
  }

  // Set the active tab of a pane. Unknown tab → no-op.
  function setActiveTab(tree, leafId, tabId) {
    const path = pathOfLeaf(tree, leafId);
    if (!path) return clone(tree);
    const leaf = clone(nodeAt(tree, path));
    if (!leaf.tabs.some((t) => t.id === tabId)) return clone(tree);
    leaf.activeTabId = tabId;
    return replaceAt(tree, path, leaf);
  }

  // Swap one tab for another IN PLACE — same pane, same position in the strip, and still the pane's
  // active tab when it was (#346). A live session that moves to a new id keeps its place in the
  // layout this way; closing the old tab and adding a new one would send it to whichever pane
  // happens to be active. Unknown tab, or a replacement whose id already sits in this pane, is a
  // no-op.
  function replaceTab(tree, leafId, tabId, next) {
    const path = pathOfLeaf(tree, leafId);
    if (!path || !next || !next.id) return clone(tree);
    const leaf = clone(nodeAt(tree, path));
    const idx = leaf.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return clone(tree);
    if (next.id !== tabId && leaf.tabs.some((t) => t.id === next.id)) return clone(tree);
    leaf.tabs[idx] = { id: next.id, kind: next.kind, ref: next.ref };
    if (leaf.activeTabId === tabId) leaf.activeTabId = next.id;
    return replaceAt(tree, path, leaf);
  }

  // Close a tab. When it was the pane's last one the pane goes and its siblings
  // take the space (#309 O10) — except for the root pane, which stays behind empty
  // so the tree always has somewhere to open the next tab.
  function closeTab(tree, leafId, tabId) {
    const path = pathOfLeaf(tree, leafId);
    if (!path) return clone(tree);
    const leaf = clone(nodeAt(tree, path));
    const idx = leaf.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return clone(tree);

    leaf.tabs.splice(idx, 1);
    if (leaf.tabs.length) {
      if (leaf.activeTabId === tabId) {
        // Focus the neighbour that took the closed tab's place, else the new last one.
        leaf.activeTabId = (leaf.tabs[idx] || leaf.tabs[leaf.tabs.length - 1]).id;
      }
      return replaceAt(tree, path, leaf);
    }

    if (!path.length) return makeLeaf(leaf.id, [], null, 1);

    const parentPath = path.slice(0, -1);
    const pruned = replaceAt(tree, path, null);
    const parent = nodeAt(pruned, parentPath);
    if (isBranch(parent)) normalizeSizes(parent.children);
    return collapse(pruned);
  }

  // Remove a whole pane, tabs and all — the "Close pane" action, and the tidy-up
  // after its last tab was closed elsewhere. The root pane cannot go: the tree
  // always keeps somewhere to open the next tab.
  function removeLeaf(tree, leafId) {
    const path = pathOfLeaf(tree, leafId);
    if (!path) return clone(tree);
    if (!path.length) return makeLeaf(leafId, [], null, 1);
    const parentPath = path.slice(0, -1);
    const pruned = replaceAt(tree, path, null);
    const parent = nodeAt(pruned, parentPath);
    if (isBranch(parent)) normalizeSizes(parent.children);
    return collapse(pruned);
  }

  // Move a tab between panes (or within one). `index` is the gap in the target's tab
  // list **as the caller sees it now**, before the tab is lifted out. Moving the last
  // tab out of a pane removes that pane, exactly as closing it would — the tab
  // survives, the pane does not.
  function moveTab(tree, { fromLeafId, toLeafId, tabId, index = -1 } = {}) {
    const fromPath = pathOfLeaf(tree, fromLeafId);
    const toPath = pathOfLeaf(tree, toLeafId);
    if (!fromPath || !toPath) return clone(tree);
    const source = nodeAt(tree, fromPath);
    const tab = source.tabs.find((t) => t.id === tabId);
    if (!tab) return clone(tree);

    if (fromLeafId === toLeafId) {
      const leaf = clone(source);
      const at = leaf.tabs.findIndex((t) => t.id === tabId);
      leaf.tabs.splice(at, 1);
      // Lifting the tab out shifts every gap to its right one slot left, so an
      // index past the source has to shift with it. Without this a rightward drag
      // lands one tab too far, and a drop on the last tab lands past the end —
      // which is why "move a tab to the end" appeared impossible (#313).
      const wanted = index > at ? index - 1 : index;
      const to = wanted < 0 || wanted > leaf.tabs.length ? leaf.tabs.length : wanted;
      leaf.tabs.splice(to, 0, tab);
      leaf.activeTabId = tab.id;
      return replaceAt(tree, fromPath, leaf);
    }

    // Close first: the target's path can shift when the source pane collapses, so
    // it is looked up again on the intermediate tree rather than reused.
    const without = closeTab(tree, fromLeafId, tabId);
    if (!pathOfLeaf(without, toLeafId)) return clone(tree);
    return addTab(without, toLeafId, tab, index);
  }

  // Drag the sash between children `index` and `index + 1` of the branch at `path`.
  // `delta` is a fraction of the branch's extent. Both neighbours keep at least
  // MIN_PANE_FRACTION; everything else in the branch is untouched, which is what
  // makes a drag feel local instead of reflowing the whole row.
  // Give every child of a branch the same share (#351 — the keyboard's reset, and the "distribute
  // evenly" the pointer path has never had). NOT a sequence of `resizeSash` calls: that one moves a
  // single boundary and clamps against its immediate neighbour's slack, so walking it left to right
  // stalls the moment one neighbour is already at the floor — which is exactly the squeezed layout
  // someone reaches for a reset from. Above 1/MIN_PANE_FRACTION children an even share IS below the
  // floor; even is still even, and there is no arrangement of that many panes that is not.
  function distributeEvenly(tree, path) {
    const branch = nodeAt(tree, path);
    if (!isBranch(branch)) return clone(tree);
    const next = clone(branch);
    const even = 1 / next.children.length;
    for (const child of next.children) child.size = even;
    return replaceAt(tree, path, next);
  }

  // Every branch in the tree gets an even share, not just one (#352). This is VS Code's "Even Editor
  // Group Sizes", and its semantics are per LEVEL: two panes beside a column of two end up 1/2 and
  // 1/4 each, not four quarters. Making them literally equal would mean re-shaping the tree, which
  // would move panes the user arranged deliberately — a reset of the SIZES is what is being asked for.
  function distributeAllEvenly(tree) {
    let next = clone(tree);
    const walk = (node, path) => {
      if (!isBranch(node)) return;
      next = distributeEvenly(next, path);
      // Read the children back out of the tree being built: `distributeEvenly` returns a new tree
      // each time, so `node`'s own children are a snapshot from before this level was rewritten.
      const rewritten = nodeAt(next, path);
      rewritten.children.forEach((child, i) => walk(child, path.concat(i)));
    };
    walk(next, []);
    return next;
  }

  function resizeSash(tree, path, index, delta) {
    const branch = nodeAt(tree, path);
    if (!isBranch(branch) || index < 0 || index + 1 >= branch.children.length) return clone(tree);
    const d = Number(delta);
    if (!Number.isFinite(d) || d === 0) return clone(tree);

    const a = branch.children[index].size;
    const b = branch.children[index + 1].size;
    const lo = MIN_PANE_FRACTION - a;      // most we may shrink `a` by
    const hi = b - MIN_PANE_FRACTION;      // most we may grow `a` by
    const applied = Math.max(lo, Math.min(hi, d));
    if (applied === 0) return clone(tree);

    const next = clone(branch);
    next.children[index].size = a + applied;
    next.children[index + 1].size = b - applied;
    return replaceAt(tree, path, next);
  }

  // Drop every tab the caller no longer recognises (a session that vanished while
  // the app was closed, a file that moved). Panes emptied by the sweep disappear
  // like any other emptied pane.
  // `keepEmptyPanes` stops a pane that loses its last tab from disappearing with it (#352). An UNDO
  // restores an arrangement, and a pane the sweep empties there is the same thing a fresh split
  // produces — the user just said "put it back", so removing it would answer a different request.
  // Every other caller wants the collapse, which is why it is the default.
  function pruneTabs(tree, isValid, { keepEmptyPanes = false } = {}) {
    const keep = typeof isValid === 'function' ? isValid : () => true;
    let next = clone(tree);
    for (const leaf of leaves(clone(tree))) {
      const survivors = leaf.tabs.filter(keep);
      if (survivors.length === leaf.tabs.length) continue;
      if (keepEmptyPanes && !survivors.length) {
        const path = pathOfLeaf(next, leaf.id);
        if (!path) continue;
        const emptied = clone(nodeAt(next, path));
        emptied.tabs = [];
        emptied.activeTabId = null;
        next = replaceAt(next, path, emptied);
        continue;
      }
      for (const tab of leaf.tabs) {
        if (!keep(tab)) next = closeTab(next, leaf.id, tab.id);
      }
    }
    return next;
  }

  // --- Persistence ----------------------------------------------------------
  // The serialised form IS the tree — one shape, so a save/load round trip cannot
  // drift from what the renderer walks.

  function serialize(tree) {
    return clone(tree);
  }

  // Rebuild a tree from stored (possibly hand-edited, possibly older) data. Anything
  // that does not typecheck is dropped rather than repaired halfway: a single leaf
  // with no tabs is a valid, usable layout, so there is always a floor to fall back
  // to. `fallbackLeafId` names that floor.
  function deserialize(data, fallbackLeafId = 'pane-1') {
    // Ids have to be UNIQUE across the whole tree, and stored data is the one place they might not
    // be (#352). Nothing in the UI can produce a duplicate; a hand-edited store, a merge of two
    // saved layouts or a downgrade can. What it costs when they get through: `removeLeaf` takes the
    // FIRST leaf with that id, so "Close pane" can close a pane other than the one clicked, and a
    // duplicate TAB id makes a tab that cannot be closed at all, because `dropSession` removes the
    // first match and the second one is re-rendered untouched. A dropped duplicate is a layout the
    // user can fix in a second; a duplicate that loads is a pane that lies about which one it is.
    const seen = { leaves: new Set(), tabs: new Set() };
    const parsed = parseNode(data, 1, seen);
    return parsed || makeLeaf(fallbackLeafId, [], null, 1);
  }

  function parseNode(node, size, seen) {
    if (!node || typeof node !== 'object') return null;
    const ownSize = Number(node.size) > 0 ? Number(node.size) : size;

    if (node.type === 'leaf') {
      if (typeof node.id !== 'string' || !node.id) return null;
      if (seen.leaves.has(node.id)) return null;   // a second pane under a name already taken
      seen.leaves.add(node.id);
      const tabs = [];
      for (const t of Array.isArray(node.tabs) ? node.tabs : []) {
        if (!isValidTab(t) || seen.tabs.has(t.id)) continue;
        seen.tabs.add(t.id);
        tabs.push({ id: t.id, kind: t.kind, ref: t.ref });
      }
      return makeLeaf(node.id, tabs, node.activeTabId, ownSize);
    }

    if (node.type === 'branch') {
      const orientation = node.orientation === 'col' ? 'col' : 'row';
      const kids = Array.isArray(node.children) ? node.children : [];
      const children = kids.map((c) => parseNode(c, 1 / Math.max(1, kids.length), seen)).filter(Boolean);
      if (!children.length) return null;
      normalizeSizes(children);
      return collapse({ type: 'branch', orientation, size: ownSize, children });
    }

    return null;
  }

  function isValidTab(t) {
    return !!t && typeof t.id === 'string' && !!t.id && TAB_KINDS.includes(t.kind);
  }

  return {
    TAB_KINDS,
    MIN_PANE_FRACTION,
    SPLIT_AXIS,
    createTree,
    isLeaf,
    isBranch,
    nodeAt,
    pathOfLeaf,
    leaves,
    leafOfTab,
    splitLeaf,
    tileTabs,
    addTab,
    setActiveTab,
    replaceTab,
    closeTab,
    removeLeaf,
    moveTab,
    resizeSash,
    distributeEvenly,
    distributeAllEvenly,
    pruneTabs,
    serialize,
    deserialize,
  };
});
