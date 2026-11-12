// Re-ordering a manual project list once (#866): the pure orders in lib/project-sort.js (`reorderOnce`), the
// View menu entries (shell/view-menu.js) and the write + Undo (shell/sidebar-sort.js `_reorderProjectsOnce`).

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { reorderOnce, sortProjects } = require('../src/renderer/lib/project-sort.js');

const REN = path.join(__dirname, '..', 'src', 'renderer');

function P(projectPath, { modified, created, addedAt, displayName, lastActivity, empty = false } = {}) {
  return {
    projectPath, displayName, addedAt, lastActivity,
    sessions: empty ? [] : [{ modified: modified || '2026-01-01', created: created || modified || '2026-01-01' }],
  };
}

test('activity: newest first, a project with no activity last', () => {
  const r = reorderOnce([
    P('a/none', { empty: true }), P('a/old', { modified: '2026-01-01' }), P('a/new', { modified: '2026-06-01' }),
  ], 'activity', []);
  assert.deepStrictEqual(r, ['a/new', 'a/old', 'a/none']);
});

test('alpha and alpha-desc follow the shown name, locale-aware', () => {
  const list = [P('x/b'), P('y/a', { displayName: 'Zed' }), P('z/Ä'), P('w/c')];
  const asc = reorderOnce(list, 'alpha', []);
  assert.deepStrictEqual(asc, ['w/c', 'x/b', 'z/Ä', 'y/a']);   // labels: "w/c" < "x/b" < "z/Ä" < "Zed" (the custom name wins)
  assert.deepStrictEqual(reorderOnce(list, 'alpha-desc', []), asc.slice().reverse());
});

test('added: newest date added first; none falls back to the oldest session; neither goes last', () => {
  const r = reorderOnce([
    P('p/seeded', { modified: '2026-05-10', created: '2026-02-01' }),   // no addedAt: oldest session 2026-02-01
    P('p/dated', { addedAt: '2026-04-01T00:00:00Z', modified: '2026-06-01' }),
    P('p/nothing', { empty: true }),
    P('p/newest', { addedAt: '2026-07-01T00:00:00Z' }),
  ], 'added', []);
  assert.deepStrictEqual(r, ['p/newest', 'p/dated', 'p/seeded', 'p/nothing']);
});

test('the order keeps saved entries no project names, drops duplicates, and rejects an unknown kind', () => {
  const r = reorderOnce([P('a', { modified: '2026-02-01' }), P('b', { modified: '2026-03-01' }), P('a')], 'activity', ['gone', 'a']);
  assert.deepStrictEqual(r, ['b', 'a', 'gone']);
  assert.equal(reorderOnce([P('a')], 'nope', []), null);
});

test('a manual render of the new order draws it (favorites stay a block)', () => {
  const list = [P('a/x', { modified: '2026-01-01' }), P('b/y', { modified: '2026-03-01' }), P('c/z', { modified: '2026-02-01' })];
  const order = reorderOnce(list, 'activity', []);
  assert.deepStrictEqual(
    sortProjects(list, { projectSortMode: 'manual', projectOrder: order }).map(p => p.projectPath),
    ['b/y', 'c/z', 'a/x']);
});

// --- the wiring ---

function setup({ mode = 'manual', projects = [P('a/x', { modified: '2026-01-01' }), P('b/y', { modified: '2026-03-01' })], order = ['a/x', 'b/y'] } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div class="bar"><button id="view-menu-btn"></button></div>'
    + '<div id="sidebar-content"></div><button id="r"></button></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  const renders = [];
  const toasts = [];
  Object.assign(window, {
    sidebarContent: window.document.getElementById('sidebar-content'), resortBtn: window.document.getElementById('r'),
    projectSortMode: mode, favoritesOwnList: false, projectOrder: order.slice(),
    cachedAllProjects: projects, cachedProjects: projects.slice(0, 1),
    refreshSidebar: (o) => renders.push(o),
    holdProjectOrder: () => [], reorderOnce,
    showControlToast: (t) => { t.removed = false; toasts.push(t); return { remove: () => { t.removed = true; } }; },
    savedProjectSortMode: 'manual', savedFavoritesOwnList: false, sortOverride: null,
  });
  vm.runInContext(fs.readFileSync(path.join(REN, 'shell/sidebar-sort.js'), 'utf8'), ctx, { filename: 'shell/sidebar-sort.js' });
  vm.runInContext(fs.readFileSync(path.join(REN, 'shell/view-menu.js'), 'utf8'), ctx, { filename: 'shell/view-menu.js' });
  return { window, renders, toasts, destroy: () => window.close() };
}

test('menu: the once entries show under Manual only', () => {
  const h = setup();
  try {
    h.window.document.getElementById('view-menu-btn').click();
    const kinds = [...h.window.document.querySelectorAll('[data-once]')].map(e => e.dataset.once);
    assert.deepStrictEqual(kinds, ['activity', 'alpha', 'alpha-desc', 'added']);
    h.window.document.getElementById('view-menu-btn').click();
    h.window.projectSortMode = 'activity';
    h.window.document.getElementById('view-menu-btn').click();
    assert.equal(h.window.document.querySelectorAll('[data-once]').length, 0);
  } finally { h.destroy(); }
});

test('menu: a click writes the order through _persistProjectOrder, re-sorts and offers Undo that restores', () => {
  const h = setup();
  try {
    h.window.document.getElementById('view-menu-btn').click();
    h.window.document.querySelector('[data-once="activity"]').click();
    assert.deepStrictEqual(JSON.parse(h.window.localStorage.getItem('projectOrder')), ['b/y', 'a/x']);
    assert.deepStrictEqual([...h.window.projectOrder], ['b/y', 'a/x']);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(h.renders)), [{ resort: true }]);
    assert.equal(h.window.document.querySelector('.view-menu'), null, 'the menu closes');
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0].actionLabel, 'Undo');
    h.toasts[0].onAction();
    assert.deepStrictEqual(JSON.parse(h.window.localStorage.getItem('projectOrder')), ['a/x', 'b/y']);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(h.renders)), [{ resort: true }, { resort: true }]);
  } finally { h.destroy(); }
});

test('outside Manual nothing is written', () => {
  const h = setup({ mode: 'activity' });
  try {
    assert.equal(h.window._reorderProjectsOnce('alpha'), false);
    assert.equal(h.window.localStorage.getItem('projectOrder'), null);
    assert.equal(h.toasts.length, 0);
  } finally { h.destroy(); }
});

test('Undo goes away once anything else writes the order (a drag), and a second sort retires the first Undo', () => {
  const h = setup();
  try {
    h.window._reorderProjectsOnce('activity');
    h.window._persistProjectOrder(['a/x', 'b/y']);   // what a drag does
    assert.equal(h.toasts[0].removed, true, 'the drag retires the Undo');
    h.window._reorderProjectsOnce('alpha');
    h.window._reorderProjectsOnce('alpha-desc');
    assert.equal(h.toasts[1].removed, true, 'the earlier toast is gone');
    assert.equal(h.toasts[2].removed, false);
  } finally { h.destroy(); }
});
