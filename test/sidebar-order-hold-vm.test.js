// Holding the Activity order under the pointer (#867): the pure rule in lib/project-sort.js
// (`holdProjectOrder`) and the decision in shell/sidebar-sort.js (`applyProjectOrderHold`).
//
// WHY THIS EXISTS:
//   applyProjectOrderHold decides whether a render draws the order already on screen or the freshly sorted
//   one. Hover is stubbed (jsdom has no pointer), so this pins the decision, and the click test in the demo
//   instance pins the real pointer.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { sortProjects, holdProjectOrder } = require('../src/renderer/lib/project-sort.js');

const REN = path.join(__dirname, '..', 'src', 'renderer');

function P(projectPath, { fav = false, modified = '2026-01-01' } = {}) {
  return { projectPath, favorited: fav, sessions: [{ modified }] };
}
const paths = (arr) => arr.map(p => p.projectPath);

// --- the pure rule ---

test('hold: a project that rose in the sort keeps its drawn place', () => {
  const sorted = sortProjects([
    P('a', { modified: '2026-01-01' }), P('b', { modified: '2026-02-01' }), P('c', { modified: '2026-06-01' }),
  ], { projectSortMode: 'activity' });
  assert.deepStrictEqual(paths(sorted), ['c', 'b', 'a']);
  assert.deepStrictEqual(paths(holdProjectOrder(sorted, ['a', 'b', 'c'])), ['a', 'b', 'c']);
});

test('hold: a project the screen does not have yet goes at the end, in sorted order', () => {
  const sorted = [P('n2'), P('n1'), P('a'), P('b')];
  assert.deepStrictEqual(paths(holdProjectOrder(sorted, ['b', 'a'])), ['b', 'a', 'n2', 'n1']);
});

test('hold: a vanished project drops out and the rest keep their order', () => {
  assert.deepStrictEqual(paths(holdProjectOrder([P('a'), P('c')], ['c', 'b', 'a'])), ['c', 'a']);
});

test('hold: favorites stay one block when favoritesFirst, even for a project favorited meanwhile', () => {
  const sorted = [P('b', { fav: true }), P('a'), P('c')];
  assert.deepStrictEqual(paths(holdProjectOrder(sorted, ['a', 'b', 'c'], { favoritesFirst: true })), ['b', 'a', 'c']);
  assert.deepStrictEqual(paths(holdProjectOrder(sorted, ['a', 'b', 'c'], { favoritesFirst: false })), ['a', 'b', 'c']);
});

test('hold: nothing held leaves the sorted order', () => {
  assert.deepStrictEqual(paths(holdProjectOrder([P('x'), P('y')], [])), ['x', 'y']);
});

// --- the decision ---

function setup({ mode = 'activity', screen = ['a', 'b', 'c'] } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="sidebar-content"></div><button id="r"></button></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  const content = window.document.getElementById('sidebar-content');
  let hover = false;
  const realMatches = window.Element.prototype.matches;
  content.matches = (sel) => (sel === ':hover' ? hover : realMatches.call(content, sel));
  const renders = [];
  Object.assign(window, {
    sidebarContent: content, resortBtn: window.document.getElementById('r'),
    projectSortMode: mode, favoritesOwnList: false,
    sortedOrder: screen.map(projectPath => ({ projectPath })),
    refreshSidebar: () => renders.push('render'),
    holdProjectOrder,
  });
  vm.runInContext(fs.readFileSync(path.join(REN, 'shell/sidebar-sort.js'), 'utf8'), ctx, { filename: 'shell/sidebar-sort.js' });
  const fn = vm.runInContext('applyProjectOrderHold', ctx);
  const hold = (sorted, resort) => fn(sorted.map(projectPath => ({ projectPath })), resort).map(p => p.projectPath);
  const holdProjects = (sorted, resort) => fn(sorted, resort);
  // The real renderProjects (shell/sidebar.js) with its drawing stubbed out: what it hands to
  // appendProjectGroups is the order that reaches the screen.
  const render = (data, resort, keepProjectOrder) => {
    if (!ctx.__wired) {
      vm.runInContext(fs.readFileSync(path.join(REN, 'shell/sidebar.js'), 'utf8'), ctx, { filename: 'shell/sidebar.js' });
      window.drawn = [];
      vm.runInContext('buildAttentionInbox = () => null; finalizeSidebar = () => {};'
        + 'appendProjectGroups = (c, ps, r, out) => { drawn.push(ps.map(p => p.projectPath)); };', ctx);
      window.sortProjects = sortProjects;
      window.projectOrder = [];
      ctx.__wired = true;
    }
    vm.runInContext('renderProjects', ctx)(data.map(p => ({ ...p })), resort, keepProjectOrder);
    return [...window.drawn[window.drawn.length - 1]];
  };
  return { window, hold, holdProjects, render, renders, setHover: (v) => { hover = v; }, destroy: () => window.close() };
}

test('#867: under the pointer the drawn order is kept; off the pointer the sorted order is drawn', () => {
  const h = setup();
  try {
    h.setHover(true);
    assert.deepEqual(h.hold(['c', 'a', 'b']), ['a', 'b', 'c']);
    h.setHover(false);
    assert.deepEqual(h.hold(['c', 'a', 'b']), ['c', 'a', 'b']);
  } finally { h.destroy(); }
});

test('#867: an explicit resort, and the other sort modes, are never held', () => {
  const h = setup();
  try {
    h.setHover(true);
    assert.deepEqual(h.hold(['c', 'a', 'b'], true), ['c', 'a', 'b']);
  } finally { h.destroy(); }
  const m = setup({ mode: 'manual' });
  try {
    m.setHover(true);
    assert.deepEqual(m.hold(['c', 'a', 'b']), ['c', 'a', 'b']);
  } finally { m.destroy(); }
});

test('#867: a popover opened from the list holds without the pointer; an unrelated one does not', () => {
  const h = setup();
  try {
    // The composer's hidden completion box (session/composer-completion.js) is a bare `.popover`.
    const stray = h.window.document.createElement('div');
    stray.className = 'popover variable-palette composer-completion';
    stray.hidden = true;
    h.window.document.body.appendChild(stray);
    assert.deepEqual(h.hold(['c', 'a', 'b']), ['c', 'a', 'b'], 'a hidden bare .popover holds nothing');
    stray.hidden = false;
    assert.deepEqual(h.hold(['c', 'a', 'b']), ['c', 'a', 'b'], 'nor does a visible one that is not the list\'s');
    const pop = h.window.document.createElement('div');
    pop.className = 'new-session-popover';
    pop.dataset.projectList = '1';
    h.window.document.body.appendChild(pop);
    assert.deepEqual(h.hold(['c', 'a', 'b']), ['a', 'b', 'c']);
    pop.style.display = 'none';
    assert.deepEqual(h.hold(['c', 'a', 'b']), ['c', 'a', 'b'], 'a hidden list popover holds nothing');
  } finally { h.destroy(); }
});

test('#867: a group whose spelling changed since the last draw keeps its place', () => {
  const h = setup({ screen: ['C:/x/a', 'C:/x/b', 'C:/x/c'] });
  try {
    h.window.findProjectGroup = require('../src/renderer/lib/project-name.js').findProjectGroup;
    h.setHover(true);
    // `a` now arrives as c:/x/a, but its sessions still carry the old spelling.
    const sorted = [
      { projectPath: 'C:/x/c' },
      { projectPath: 'c:/x/a', sessions: [{ projectPath: 'C:/x/a' }] },
      { projectPath: 'C:/x/b' },
    ];
    assert.deepEqual(h.holdProjects(sorted).map(p => p.projectPath), ['c:/x/a', 'C:/x/b', 'C:/x/c']);
  } finally { h.destroy(); }
});

test('#867: a hidden window re-arms nothing, and resumes when it is shown again', async () => {
  const h = setup();
  try {
    h.setHover(true);
    h.hold(['c', 'a', 'b']);
    h.window.document.body.classList.add('window-hidden');
    await new Promise(r => setTimeout(r, 450));
    assert.equal(h.renders.length, 0, 'nothing ran while hidden');
    h.setHover(false);
    h.window.document.body.classList.remove('window-hidden');
    h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 450));
    assert.equal(h.renders.length, 1);
  } finally { h.destroy(); }
});

test('#867: while the list stays in use the timer re-arms, and stops once nothing is pending', async () => {
  const h = setup();
  try {
    h.setHover(true);
    h.hold(['c', 'a', 'b']);
    await new Promise(r => setTimeout(r, 700));
    assert.equal(h.renders.length, 0, 'still held');
    h.hold(['a', 'b', 'c']); // a render that matches the screen: nothing pending any more
    h.setHover(false);
    await new Promise(r => setTimeout(r, 450));
    assert.equal(h.renders.length, 0);
  } finally { h.destroy(); }
});

test('#867: the held re-order is applied by one plain render after the delay, once nothing holds', async () => {
  const h = setup();
  try {
    h.setHover(true);
    h.hold(['c', 'a', 'b']);
    h.setHover(false);
    assert.equal(h.renders.length, 0, 'not applied at once');
    await new Promise(r => setTimeout(r, 450));
    assert.equal(h.renders.length, 1);
  } finally { h.destroy(); }
});

// The wiring in shell/sidebar.js: renderProjects -> applyProjectOrderHold.
test('#867: renderProjects draws the held order; an in-list action holds, an explicit resort does not', () => {
  const h = setup();
  try {
    const data = [
      { projectPath: 'a', sessions: [{ modified: '2026-01-01' }] },
      { projectPath: 'b', sessions: [{ modified: '2026-02-01' }] },
      { projectPath: 'c', sessions: [{ modified: '2026-06-01' }] },
    ];
    h.setHover(true);
    assert.deepEqual(h.render(data, false), ['a', 'b', 'c'], 'a background render keeps the drawn order');
    assert.deepEqual(h.render(data, true, true), ['a', 'b', 'c'], 'a pin or favorite click keeps it too');
    assert.deepEqual(h.render(data, true), ['c', 'b', 'a'], 'Refresh and sort changes do not hold');
  } finally { h.destroy(); }
});

test('#867: a hold with no pending change schedules nothing', async () => {
  const h = setup();
  try {
    h.setHover(true);
    h.hold(['a', 'b', 'c']);
    h.setHover(false);
    await new Promise(r => setTimeout(r, 450));
    assert.equal(h.renders.length, 0);
  } finally { h.destroy(); }
});
