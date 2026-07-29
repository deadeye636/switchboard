const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MIN_PANE_FRACTION,
  createTree,
  isLeaf,
  isBranch,
  nodeAt,
  pathOfLeaf,
  leaves,
  leafOfTab,
  splitLeaf,
  addTab,
  setActiveTab,
  replaceTab,
  closeTab,
  removeLeaf,
  moveTab,
  resizeSash,
  pruneTabs,
  serialize,
  deserialize,
} = require('../src/renderer/views/pane-tree');

const term = (id, ref = id) => ({ id, kind: 'terminal', ref });
const ids = (tree) => leaves(tree).map((l) => l.id);
const sizes = (branch) => branch.children.map((c) => Number(c.size.toFixed(4)));

// A one-leaf tree with two terminal tabs, the shape the app starts from.
function base() {
  return createTree('p1', [term('t1'), term('t2')]);
}

test('a fresh tree is a single leaf holding its tabs, first one active', () => {
  const tree = base();
  assert.ok(isLeaf(tree));
  assert.equal(tree.size, 1);
  assert.equal(tree.activeTabId, 't1');
  assert.deepEqual(ids(tree), ['p1']);
});

test('splitting the root leaf wraps it in a branch on the direction axis', () => {
  const right = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2', tab: term('t3') });
  assert.ok(isBranch(right));
  assert.equal(right.orientation, 'row');
  assert.deepEqual(ids(right), ['p1', 'p2']);
  assert.deepEqual(sizes(right), [0.5, 0.5]);

  const down = splitLeaf(base(), 'p1', 'down', { newLeafId: 'p2' });
  assert.equal(down.orientation, 'col');
});

test('splitting left/up puts the new pane before the split one', () => {
  const left = splitLeaf(base(), 'p1', 'left', { newLeafId: 'p2' });
  assert.deepEqual(ids(left), ['p2', 'p1']);
  const up = splitLeaf(base(), 'p1', 'up', { newLeafId: 'p2' });
  assert.deepEqual(ids(up), ['p2', 'p1']);
});

test('the new pane carries the tab it was split with, and it is active there', () => {
  const tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2', tab: term('t3') });
  const fresh = nodeAt(tree, pathOfLeaf(tree, 'p2'));
  assert.deepEqual(fresh.tabs.map((t) => t.id), ['t3']);
  assert.equal(fresh.activeTabId, 't3');
  // …and it is gone from nowhere: the split pane keeps what it had.
  assert.deepEqual(nodeAt(tree, pathOfLeaf(tree, 'p1')).tabs.map((t) => t.id), ['t1', 't2']);
});

test('a split along the parent axis inserts a sibling instead of nesting', () => {
  let tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2' });
  tree = splitLeaf(tree, 'p2', 'right', { newLeafId: 'p3' });
  assert.ok(isBranch(tree));
  assert.equal(tree.children.length, 3, 'three panes side by side, not a nested branch');
  assert.ok(tree.children.every(isLeaf));
  assert.deepEqual(ids(tree), ['p1', 'p2', 'p3']);
});

test('a split across the parent axis nests a perpendicular branch', () => {
  let tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2' });
  tree = splitLeaf(tree, 'p2', 'down', { newLeafId: 'p3' });
  assert.equal(tree.orientation, 'row');
  assert.equal(tree.children.length, 2);
  const nested = tree.children[1];
  assert.ok(isBranch(nested));
  assert.equal(nested.orientation, 'col');
  assert.deepEqual(ids(tree), ['p1', 'p2', 'p3']);
});

test('sibling sizes always sum to 1 after a split', () => {
  let tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2' });
  tree = splitLeaf(tree, 'p1', 'right', { newLeafId: 'p3' });
  const sum = tree.children.reduce((s, c) => s + c.size, 0);
  assert.equal(Number(sum.toFixed(6)), 1);
});

test('an unknown leaf, direction or missing id leaves the tree untouched', () => {
  const tree = base();
  assert.deepEqual(splitLeaf(tree, 'nope', 'right', { newLeafId: 'p2' }), tree);
  assert.deepEqual(splitLeaf(tree, 'p1', 'sideways', { newLeafId: 'p2' }), tree);
  assert.deepEqual(splitLeaf(tree, 'p1', 'right', {}), tree);
});

test('addTab inserts at the requested index and focuses the new tab', () => {
  const tree = addTab(base(), 'p1', term('t3'), 1);
  assert.deepEqual(tree.tabs.map((t) => t.id), ['t1', 't3', 't2']);
  assert.equal(tree.activeTabId, 't3');
});

test('addTab appends by default and refuses a duplicate id', () => {
  const appended = addTab(base(), 'p1', term('t3'));
  assert.deepEqual(appended.tabs.map((t) => t.id), ['t1', 't2', 't3']);
  assert.deepEqual(addTab(base(), 'p1', term('t2')), base());
});

test('setActiveTab only accepts a tab the pane actually holds', () => {
  assert.equal(setActiveTab(base(), 'p1', 't2').activeTabId, 't2');
  assert.equal(setActiveTab(base(), 'p1', 'ghost').activeTabId, 't1');
});

test('replaceTab swaps a tab in place, keeping its position (#346)', () => {
  const tree = replaceTab(base(), 'p1', 't1', term('t9'));
  assert.deepEqual(tree.tabs.map((t) => t.id), ['t9', 't2']);
  assert.deepEqual(tree.tabs[0], term('t9'));
});

test('replaceTab carries the active flag with the tab it replaces (#346)', () => {
  // t1 is active → the replacement is.
  assert.equal(replaceTab(base(), 'p1', 't1', term('t9')).activeTabId, 't9');
  // t2 is not → the focus stays on t1.
  assert.equal(replaceTab(base(), 'p1', 't2', term('t9')).activeTabId, 't1');
});

test('replaceTab refuses an unknown tab, a missing replacement and a duplicate id (#346)', () => {
  assert.deepEqual(replaceTab(base(), 'p1', 'ghost', term('t9')), base());
  assert.deepEqual(replaceTab(base(), 'ghost', 't1', term('t9')), base());
  assert.deepEqual(replaceTab(base(), 'p1', 't1', null), base());
  assert.deepEqual(replaceTab(base(), 'p1', 't1', { kind: 'terminal' }), base());
  // t2 is already in this pane — replacing t1 with it would make two tabs share an id.
  assert.deepEqual(replaceTab(base(), 'p1', 't1', term('t2')), base());
});

test('replaceTab finds the tab in a nested pane (#346)', () => {
  const tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2', tab: term('t3') });
  const next = replaceTab(tree, 'p2', 't3', term('t4'));
  assert.equal(leafOfTab(next, 't4').id, 'p2');
  assert.equal(leafOfTab(next, 't3'), null);
});

test('closing the active tab focuses its successor, then the last one', () => {
  const three = addTab(base(), 'p1', term('t3'));       // t1 t2 t3, active t3
  const mid = setActiveTab(three, 'p1', 't2');
  assert.equal(closeTab(mid, 'p1', 't2').activeTabId, 't3', 'successor takes over');
  const last = setActiveTab(three, 'p1', 't3');
  assert.equal(closeTab(last, 'p1', 't3').activeTabId, 't2', 'no successor → the new last');
});

test('closing an inactive tab leaves the focus alone', () => {
  assert.equal(closeTab(base(), 'p1', 't2').activeTabId, 't1');
});

test('the last tab of a pane takes the pane with it, and the neighbour takes the space', () => {
  let tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2', tab: term('t3') });
  tree = closeTab(tree, 'p2', 't3');
  assert.ok(isLeaf(tree), 'the branch collapsed back to the surviving pane');
  assert.equal(tree.id, 'p1');
  assert.equal(tree.size, 1);
});

test('a three-pane row loses one pane and the other two keep their proportions', () => {
  let tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2', tab: term('t3') });
  tree = splitLeaf(tree, 'p2', 'right', { newLeafId: 'p3', tab: term('t4') });
  tree = closeTab(tree, 'p2', 't3');
  assert.deepEqual(ids(tree), ['p1', 'p3']);
  assert.equal(Number(tree.children.reduce((s, c) => s + c.size, 0).toFixed(6)), 1);
});

test('the root pane survives its last tab — the tree is never empty', () => {
  let tree = closeTab(base(), 'p1', 't1');
  tree = closeTab(tree, 'p1', 't2');
  assert.ok(isLeaf(tree));
  assert.equal(tree.id, 'p1');
  assert.deepEqual(tree.tabs, []);
  assert.equal(tree.activeTabId, null);
});

test('closing an unknown pane or tab changes nothing', () => {
  assert.deepEqual(closeTab(base(), 'nope', 't1'), base());
  assert.deepEqual(closeTab(base(), 'p1', 'ghost'), base());
});

test('removeLeaf takes a whole pane, tabs and all', () => {
  let tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2', tab: term('t3') });
  tree = addTab(tree, 'p2', term('t4'));
  tree = removeLeaf(tree, 'p2');
  assert.ok(isLeaf(tree));
  assert.equal(tree.id, 'p1');
  assert.deepEqual(tree.tabs.map((t) => t.id), ['t1', 't2']);
});

test('removeLeaf empties the root pane instead of deleting the tree', () => {
  const tree = removeLeaf(base(), 'p1');
  assert.ok(isLeaf(tree));
  assert.equal(tree.id, 'p1');
  assert.deepEqual(tree.tabs, []);
  assert.equal(tree.size, 1);
});

test('removeLeaf ignores an unknown pane', () => {
  assert.deepEqual(removeLeaf(base(), 'ghost'), base());
});

test('moveTab carries a tab into another pane at the requested index', () => {
  let tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2', tab: term('t3') });
  tree = moveTab(tree, { fromLeafId: 'p1', toLeafId: 'p2', tabId: 't2', index: 0 });
  assert.deepEqual(nodeAt(tree, pathOfLeaf(tree, 'p1')).tabs.map((t) => t.id), ['t1']);
  const target = nodeAt(tree, pathOfLeaf(tree, 'p2'));
  assert.deepEqual(target.tabs.map((t) => t.id), ['t2', 't3']);
  assert.equal(target.activeTabId, 't2');
});

test('moving the last tab out removes the source pane but keeps the tab', () => {
  let tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2', tab: term('t3') });
  tree = moveTab(tree, { fromLeafId: 'p2', toLeafId: 'p1', tabId: 't3' });
  assert.ok(isLeaf(tree));
  assert.deepEqual(tree.tabs.map((t) => t.id), ['t1', 't2', 't3']);
});

test('moveTab within one pane reorders it', () => {
  const tree = moveTab(base(), { fromLeafId: 'p1', toLeafId: 'p1', tabId: 't1', index: 2 });
  assert.deepEqual(tree.tabs.map((t) => t.id), ['t2', 't1']);
  assert.equal(tree.activeTabId, 't1');
});

// The index is a gap in the list the caller is looking at — the one that still holds
// the dragged tab. Reading it as a post-removal index put a rightward drag one slot
// too far and made "drop it last" unreachable (#313).
test('moveTab reads the index as a gap in the pre-move list', () => {
  const three = () => createTree('p1', [term('t1'), term('t2'), term('t3')]);
  const order = (index) => moveTab(three(), { fromLeafId: 'p1', toLeafId: 'p1', tabId: 't1', index })
    .tabs.map((t) => t.id);
  assert.deepEqual(order(0), ['t1', 't2', 't3'], 'the gap before itself is a no-op');
  assert.deepEqual(order(1), ['t1', 't2', 't3'], 'the gap after itself is a no-op');
  assert.deepEqual(order(2), ['t2', 't1', 't3'], 'between t2 and t3');
  assert.deepEqual(order(3), ['t2', 't3', 't1'], 'past the last tab');
});

test('moveTab leftwards keeps the index it was given', () => {
  const tree = createTree('p1', [term('t1'), term('t2'), term('t3')]);
  const moved = moveTab(tree, { fromLeafId: 'p1', toLeafId: 'p1', tabId: 't3', index: 1 });
  assert.deepEqual(moved.tabs.map((t) => t.id), ['t1', 't3', 't2']);
});

test('moveTab with no index appends, in either pane', () => {
  const within = moveTab(base(), { fromLeafId: 'p1', toLeafId: 'p1', tabId: 't1' });
  assert.deepEqual(within.tabs.map((t) => t.id), ['t2', 't1']);
  let across = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2', tab: term('t3') });
  across = addTab(across, 'p2', term('t4'));
  across = moveTab(across, { fromLeafId: 'p1', toLeafId: 'p2', tabId: 't1' });
  assert.deepEqual(nodeAt(across, pathOfLeaf(across, 'p2')).tabs.map((t) => t.id), ['t3', 't4', 't1']);
});

test('a move with an unknown pane or tab is a no-op', () => {
  const tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2', tab: term('t3') });
  assert.deepEqual(moveTab(tree, { fromLeafId: 'p1', toLeafId: 'ghost', tabId: 't1' }), tree);
  assert.deepEqual(moveTab(tree, { fromLeafId: 'p1', toLeafId: 'p2', tabId: 'ghost' }), tree);
});

test('leafOfTab finds the pane holding a tab', () => {
  const tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2', tab: term('t3') });
  assert.equal(leafOfTab(tree, 't3').id, 'p2');
  assert.equal(leafOfTab(tree, 't1').id, 'p1');
  assert.equal(leafOfTab(tree, 'ghost'), null);
});

test('resizeSash moves the boundary between two neighbours only', () => {
  let tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2' });
  tree = splitLeaf(tree, 'p2', 'right', { newLeafId: 'p3' });
  const before = sizes(tree);
  const after = resizeSash(tree, [], 0, 0.1);
  assert.equal(Number((after.children[0].size - before[0]).toFixed(4)), 0.1);
  assert.equal(Number((after.children[1].size - before[1]).toFixed(4)), -0.1);
  assert.equal(after.children[2].size, before[2], 'the third pane is not touched');
});

test('resizeSash clamps at MIN_PANE_FRACTION instead of collapsing a pane', () => {
  const tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2' });
  const shoved = resizeSash(tree, [], 0, 5);
  assert.equal(Number(shoved.children[1].size.toFixed(4)), MIN_PANE_FRACTION);
  assert.equal(Number(shoved.children[0].size.toFixed(4)), Number((1 - MIN_PANE_FRACTION).toFixed(4)));
});

test('resizeSash ignores a bad path, a bad index or a zero delta', () => {
  const tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2' });
  assert.deepEqual(resizeSash(tree, [0], 0, 0.1), tree, 'a leaf has no sash');
  assert.deepEqual(resizeSash(tree, [], 1, 0.1), tree, 'no sash after the last child');
  assert.deepEqual(resizeSash(tree, [], 0, 0), tree);
  assert.deepEqual(resizeSash(tree, [], 0, NaN), tree);
});

test('pruneTabs drops what the caller no longer recognises, panes and all', () => {
  let tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2', tab: term('gone') });
  tree = pruneTabs(tree, (tab) => tab.ref !== 'gone');
  assert.ok(isLeaf(tree));
  assert.deepEqual(tree.tabs.map((t) => t.id), ['t1', 't2']);
});

test('a serialize → deserialize round trip returns the same tree', () => {
  let tree = splitLeaf(base(), 'p1', 'right', { newLeafId: 'p2', tab: term('t3') });
  tree = splitLeaf(tree, 'p2', 'down', { newLeafId: 'p3', tab: { id: 't4', kind: 'preview', ref: 'a/b.md' } });
  tree = resizeSash(tree, [], 0, 0.15);
  assert.deepEqual(deserialize(serialize(tree)), tree);
});

test('deserialize drops a duplicate leaf id rather than loading two panes under one name (#352)', () => {
  // No UI path makes this; a hand-edited store or a merge of two saved layouts does. What it costs
  // if it loads: removeLeaf takes the FIRST match, so "Close pane" can close the wrong pane.
  const tree = deserialize({
    type: 'branch',
    orientation: 'row',
    children: [
      { type: 'leaf', id: 'p1', tabs: [term('t1')], activeTabId: 't1', size: 0.5 },
      { type: 'leaf', id: 'p1', tabs: [term('t2')], activeTabId: 't2', size: 0.5 },
    ],
  });
  assert.deepEqual(ids(tree), ['p1']);
  assert.ok(isLeaf(tree), 'the branch collapsed to the one pane that survived');
  assert.deepEqual(tree.tabs.map((t) => t.id), ['t1'], 'the first one wins, the second is dropped');
});

test('deserialize drops a duplicate tab id, wherever the twin sits (#352)', () => {
  // A duplicate tab id makes a tab that cannot be closed: dropSession removes the first match and
  // the second is re-rendered untouched.
  const sameLeaf = deserialize({ type: 'leaf', id: 'p1', tabs: [term('t1'), term('t1'), term('t2')], activeTabId: 't1' });
  assert.deepEqual(sameLeaf.tabs.map((t) => t.id), ['t1', 't2']);

  const acrossLeaves = deserialize({
    type: 'branch',
    orientation: 'row',
    children: [
      { type: 'leaf', id: 'p1', tabs: [term('t1')], activeTabId: 't1', size: 0.5 },
      { type: 'leaf', id: 'p2', tabs: [term('t1'), term('t2')], activeTabId: 't1', size: 0.5 },
    ],
  });
  assert.equal(leafOfTab(acrossLeaves, 't1').id, 'p1', 'the first pane keeps it');
  assert.deepEqual(nodeAt(acrossLeaves, pathOfLeaf(acrossLeaves, 'p2')).tabs.map((t) => t.id), ['t2']);
});

test('a pane left with no tabs by the dedup is not kept as furniture (#352)', () => {
  const tree = deserialize({
    type: 'branch',
    orientation: 'row',
    children: [
      { type: 'leaf', id: 'p1', tabs: [term('t1')], activeTabId: 't1', size: 0.5 },
      { type: 'leaf', id: 'p2', tabs: [term('t1')], activeTabId: 't1', size: 0.5 },
    ],
  });
  // p2's only tab was the duplicate, so p2 loads empty — a valid layout, and the tree still holds it.
  assert.deepEqual(ids(tree), ['p1', 'p2']);
  assert.deepEqual(nodeAt(tree, pathOfLeaf(tree, 'p2')).tabs, []);
});

test('deserialize falls back to one empty pane for garbage', () => {
  for (const junk of [null, undefined, 42, 'tree', {}, { type: 'leaf' }, { type: 'branch', children: [] }]) {
    const tree = deserialize(junk, 'pane-1');
    assert.ok(isLeaf(tree), `${JSON.stringify(junk)} should fall back to a leaf`);
    assert.equal(tree.id, 'pane-1');
    assert.deepEqual(tree.tabs, []);
  }
});

test('deserialize drops tabs of an unknown kind and repairs a stale active tab', () => {
  const tree = deserialize({
    type: 'leaf',
    id: 'p1',
    tabs: [term('t1'), { id: 't2', kind: 'hologram', ref: 'x' }, { kind: 'terminal' }],
    activeTabId: 't2',
    size: 1,
  });
  assert.deepEqual(tree.tabs.map((t) => t.id), ['t1']);
  assert.equal(tree.activeTabId, 't1');
});

test('deserialize normalizes sizes and collapses a one-child branch', () => {
  const tree = deserialize({
    type: 'branch',
    orientation: 'row',
    size: 1,
    children: [{ type: 'leaf', id: 'p1', tabs: [term('t1')], size: 7 }],
  });
  assert.ok(isLeaf(tree));
  assert.equal(tree.id, 'p1');
  assert.equal(tree.size, 1);
});

test('deserialize keeps a branch whose sizes were stored unnormalized', () => {
  const tree = deserialize({
    type: 'branch',
    orientation: 'col',
    size: 1,
    children: [
      { type: 'leaf', id: 'p1', tabs: [term('t1')], size: 3 },
      { type: 'leaf', id: 'p2', tabs: [term('t2')], size: 1 },
    ],
  });
  assert.ok(isBranch(tree));
  assert.deepEqual(sizes(tree), [0.75, 0.25]);
});

test('every operation leaves the input tree untouched', () => {
  const original = base();
  const snapshot = JSON.parse(JSON.stringify(original));
  splitLeaf(original, 'p1', 'right', { newLeafId: 'p2', tab: term('t3') });
  addTab(original, 'p1', term('t9'));
  closeTab(original, 'p1', 't1');
  moveTab(original, { fromLeafId: 'p1', toLeafId: 'p1', tabId: 't1', index: 1 });
  setActiveTab(original, 'p1', 't2');
  pruneTabs(original, () => false);
  assert.deepEqual(original, snapshot);
});
