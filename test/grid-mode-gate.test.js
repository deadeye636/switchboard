// The mosaic may only run in `sessionDisplayMode: grid` (#343). Turning it on inside panes mode
// pulled every terminal container out of its pane and left both layouts live at once — persisted,
// so it survived the restart, with the visible way out hidden by CSS in that mode.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const { gridAllowedForMode, gridAllowedInDom, resolveSessionDisplayMode } = require('../src/renderer/views/grid-layout');

const body = (...classes) => ({ classList: { contains: (c) => classes.includes(c) } });

// --- What a stored display mode means (#357) ---------------------------------

test('a stored tabs mode resolves to panes, which is what it rendered', () => {
  // The migration IS this function: nothing rewrites the database, so an install that never opens
  // settings has to land on panes the first time the setting is read.
  assert.equal(resolveSessionDisplayMode('tabs'), 'panes');
  assert.equal(resolveSessionDisplayMode('panes'), 'panes');
});

test('every other stored value is grid, including the ones that were never written', () => {
  assert.equal(resolveSessionDisplayMode('grid'), 'grid');
  assert.equal(resolveSessionDisplayMode('legacy'), 'grid', 'the legacy spelling of grid mode');
  assert.equal(resolveSessionDisplayMode(undefined), 'grid');
  assert.equal(resolveSessionDisplayMode(null), 'grid');
  assert.equal(resolveSessionDisplayMode(''), 'grid');
  assert.equal(resolveSessionDisplayMode('Tabs'), 'grid', 'the stored value is lower case; this is not it');
});

test('the mosaic is refused in panes mode, and for the retired mode that resolves to it', () => {
  assert.equal(gridAllowedForMode('panes'), false);
  // #357: tabs is retired and a stored value still says so. It resolves to panes, so it is blocked
  // for the same reason — not by a leftover entry in the blocked list.
  assert.equal(gridAllowedForMode('tabs'), false);
});

test('grid mode allows it, and so does every spelling that means grid mode', () => {
  assert.equal(gridAllowedForMode('grid'), true);
  // 'legacy' is the stored spelling of the same mode, and a missing value falls back to it.
  assert.equal(gridAllowedForMode('legacy'), true);
  assert.equal(gridAllowedForMode(undefined), true);
  assert.equal(gridAllowedForMode(null), true);
});

test('the DOM gate reads the body classes the mode chain sets', () => {
  assert.equal(gridAllowedInDom(body('display-mode-panes')), false);
  // `display-mode-tabs` is not in the list because nothing sets it any more (#357). A body that
  // somehow carried it would be a body from before the upgrade, and the mode chain rewrites it.
  assert.equal(gridAllowedInDom(body()), true);
  // A class that merely starts the same way is not the mode.
  assert.equal(gridAllowedInDom(body('display-mode-panes-something')), true);
});

test('a body without a class list does not block the toggle', () => {
  // The chord must keep working if it ever runs before the mode chain touched <body>.
  assert.equal(gridAllowedInDom(null), true);
  assert.equal(gridAllowedInDom({}), true);
});

// --- The gate where it actually has to hold: showGridView ---------------------
//
// The toggle chord is one of five ways into the mosaic. The others — the boot restore, the launch
// restore, `showSession`'s grid branch and the auto-mount rebuild — all call `showGridView()`
// directly, and that function is what WRITES `gridViewActive` and its localStorage flag. Gating only
// the chord left the state that survives a restart entirely reachable.

const GRID_SRC = path.join(__dirname, '..', 'src', 'renderer', 'views', 'grid-view.js');

// Load grid-view.js far enough to call showGridView(). Only the gate is exercised, so the globals
// beyond it are deliberately absent: `closeVariablePalette` is the first statement past the gate, so
// whether it ran is the honest answer to "did the gate hold".
function loadGridView(bodyClass) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body class="${bodyClass}"><div id="terminals"></div></body></html>`, {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const seen = { paletteClosed: 0 };
  const stubs = {
    ...Object.fromEntries(['openSessions', 'sessionMap', 'gridCards'].map((k) => [k, new Map()])),
    activePtyIds: new Set(),
    activeSessionId: null,
    gridViewActive: false,
    sortedOrder: [],
    cachedProjects: [],
    isMac: false,
    terminalsEl: window.document.getElementById('terminals'),
    sidebarContent: window.document.createElement('div'),
    normalizeShortcuts: () => ({}),
    closeVariablePalette: () => { seen.paletteClosed++; },
  };
  for (const [k, v] of Object.entries(stubs)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }
  const ctx = dom.getInternalVMContext();
  for (const rel of ['renderer/views/grid-layout.js', 'renderer/views/grid-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8'), ctx, { filename: rel });
  }
  return { window, seen, dom, call: () => { try { window.showGridView(); } catch { /* past the gate */ } } };
}

test('showGridView refuses in panes mode, and writes no flag (#343)', () => {
  const g = loadGridView('display-mode-panes');
  try {
    g.call();
    assert.equal(g.seen.paletteClosed, 0, 'the gate returned before the body of the function');
    assert.equal(g.window.gridViewActive, false);
    assert.equal(g.window.localStorage.getItem('gridViewActive'), null, 'no persisted flag to survive a restart');
  } finally { g.dom.window.close(); }
});

test('showGridView still runs in grid mode (#343)', () => {
  const g = loadGridView('');
  try {
    g.call();
    assert.equal(g.seen.paletteClosed, 1, 'the gate let grid mode through');
  } finally { g.dom.window.close(); }
});

// `grid-view.js` reads this file's exports as bare globals, which only works because grid-layout.js
// spreads them onto the window. A UMD export that stopped doing that would make the gate silently
// throw instead of gating.
test('the gate helpers reach grid-view.js as bare globals (#343)', () => {
  const g = loadGridView('');
  try {
    assert.equal(typeof g.window.gridAllowedInDom, 'function');
    assert.equal(typeof g.window.gridAllowedForMode, 'function');
  } finally { g.dom.window.close(); }
});
