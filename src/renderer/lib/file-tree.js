// The List / Tree layout of a changed-file list (#894). Electron-free (UMD), no DOM, no IPC.
//
// Both changed-file windows draw with it: the session's Details window (`session-changes.js`) and the standalone changes
// window (`changed-files.js`). A tree is built from ONE group's files (a status group, a split block) and handed back
// FLAT, a dir row before the rows under it, so a page keeps its rows as siblings: a diff pane is still the next sibling
// of its file row, which both pages rely on. A chain of folders that each hold only one folder and no file is one row
// (`src/renderer/shell`). Paths are repo-relative and `/`-separated as main hands them over; nothing here touches disk.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const FILE_LIST_LAYOUTS = Object.freeze([['list', 'List'], ['tree', 'Tree']]);
  // One key for both windows, so a choice made in one is the other's too. Listed in docs/settings-reference.md.
  const FILE_LIST_LAYOUT_KEY = 'changedFilesLayout';

  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  const segmentsOf = (p) => String(p == null ? '' : p).split('/').filter(Boolean);

  // items -> { dirs: Map<name, node>, files: [{ name, item }] }, folder chains already joined.
  function buildFileTree(items, pathOf) {
    const rootNode = { name: '', path: '', dirs: new Map(), files: [] };
    for (const item of items || []) {
      const parts = segmentsOf(pathOf(item));
      if (!parts.length) continue;
      let node = rootNode;
      for (const part of parts.slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: node.path ? node.path + '/' + part : part, dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push({ name: parts[parts.length - 1], item });
    }
    for (const child of rootNode.dirs.values()) compact(child);
    return rootNode;
  }

  // A folder that holds exactly one folder and no file takes that folder's place, its name the joined path.
  function compact(node) {
    while (node.files.length === 0 && node.dirs.size === 1) {
      const only = node.dirs.values().next().value;
      node.name = node.name + '/' + only.name;
      node.path = only.path;
      node.dirs = only.dirs;
      node.files = only.files;
    }
    for (const child of node.dirs.values()) compact(child);
  }

  function countFiles(node) {
    let n = node.files.length;
    for (const child of node.dirs.values()) n += countFiles(child);
    return n;
  }

  // The tree as rows, folders first and then files, each by name. A folded folder's row is there, what is under it is not.
  // dir row:  { kind: 'dir', path, name, depth, count, collapsed }   file row: { kind: 'file', item, name, depth }
  function flattenFileTree(tree, isCollapsed) {
    const rows = [];
    const folded = typeof isCollapsed === 'function' ? isCollapsed : () => false;
    (function walk(node, depth) {
      for (const child of [...node.dirs.values()].sort((a, b) => byName(a.name, b.name))) {
        const collapsed = !!folded(child.path);
        rows.push({ kind: 'dir', path: child.path, name: child.name, depth, count: countFiles(child), collapsed });
        if (!collapsed) walk(child, depth + 1);
      }
      for (const f of node.files.slice().sort((a, b) => byName(a.name, b.name))) rows.push({ kind: 'file', item: f.item, name: f.name, depth });
    })(tree, 0);
    return rows;
  }

  function fileTreeRows(items, pathOf, isCollapsed) {
    return flattenFileTree(buildFileTree(items, pathOf), isCollapsed);
  }

  // The folders a path sits in, outermost first: what has to be unfolded for its row to be drawn.
  function fileTreeAncestors(path) {
    const parts = segmentsOf(path).slice(0, -1);
    return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  }

  // The stored choice. Storage can be missing or throw (a cleared or blocked profile); the answer is then the default.
  function readFileListLayout(storage) {
    try {
      const v = storage && storage.getItem(FILE_LIST_LAYOUT_KEY);
      return v === 'tree' ? 'tree' : 'list';
    } catch { return 'list'; }
  }
  function writeFileListLayout(storage, layout) {
    try { if (storage) storage.setItem(FILE_LIST_LAYOUT_KEY, layout === 'tree' ? 'tree' : 'list'); } catch { /* kept for this window only */ }
  }

  return {
    FILE_LIST_LAYOUTS, FILE_LIST_LAYOUT_KEY,
    buildFileTree, flattenFileTree, fileTreeRows, fileTreeAncestors, readFileListLayout, writeFileListLayout,
  };
});
