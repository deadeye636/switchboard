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

test('only an explicit grid choice is grid (#374)', () => {
  assert.equal(resolveSessionDisplayMode('grid'), 'grid');
  assert.equal(resolveSessionDisplayMode('legacy'), 'grid', 'the legacy spelling of grid mode');
});

test('panes is what a stored nothing means, and what an unknown value falls to (#374)', () => {
  // The default moved from grid to panes, and this function IS the default: nothing rewrites the
  // database, so an install that never saved settings has to land on panes the first time the setting
  // is read. One that has saved carries its own answer either way.
  assert.equal(resolveSessionDisplayMode(undefined), 'panes');
  assert.equal(resolveSessionDisplayMode(null), 'panes');
  assert.equal(resolveSessionDisplayMode(''), 'panes');
  // A value nobody recognises falls to the DEFAULT rather than to grid — which is the whole of the
  // change. 'Tabs' is the wrong case and so is not the retired mode's stored spelling; it is simply
  // unknown, and unknown now means panes.
  assert.equal(resolveSessionDisplayMode('Tabs'), 'panes');
});

test('the mosaic is refused in panes mode, and for the retired mode that resolves to it', () => {
  assert.equal(gridAllowedForMode('panes'), false);
  // #357: tabs is retired and a stored value still says so. It resolves to panes, so it is blocked
  // for the same reason — not by a leftover entry in the blocked list.
  assert.equal(gridAllowedForMode('tabs'), false);
});

test('grid mode allows it, and only a stored grid mode does (#374)', () => {
  assert.equal(gridAllowedForMode('grid'), true);
  assert.equal(gridAllowedForMode('legacy'), true, 'the stored spelling of the same mode');
  // A missing value used to fall back to grid and allow the mosaic. It falls back to panes now, and
  // the mosaic is refused there for the reason the blocked list exists.
  assert.equal(gridAllowedForMode(undefined), false);
  assert.equal(gridAllowedForMode(null), false);
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

// --- #369: the detached-window refusal belongs in the funnel too ---
//
// `toggleGridView` has always refused in a window of its own: the mosaic would auto-mount every
// running session there, a second xterm on each live PTY, and its `gridViewActive` flag lands in the
// localStorage both windows share. A mode switch reaches `showGridView` directly, past the toggle, so
// the refusal has to hold at the funnel — spec 17 §3 records that both grid paths were found by
// review rather than by testing, which is exactly the shape this guards against.

test('#369: showGridView refuses in a window of its own', () => {
  const g = loadGridView('');
  try {
    Object.defineProperty(g.window, 'isDetachedWindow', { value: () => true, writable: true, configurable: true });
    g.call();
    assert.equal(g.seen.paletteClosed, 0, 'the gate returned before the body of the function');
    assert.equal(g.window.gridViewActive, false);
    assert.equal(g.window.localStorage.getItem('gridViewActive'), null, 'and wrote no flag into the shared origin');
  } finally { g.dom.window.close(); }
});

test('#369: the main window is unaffected by that refusal', () => {
  const g = loadGridView('');
  try {
    Object.defineProperty(g.window, 'isDetachedWindow', { value: () => false, writable: true, configurable: true });
    g.call();
    assert.equal(g.seen.paletteClosed, 1);
  } finally { g.dom.window.close(); }
});
