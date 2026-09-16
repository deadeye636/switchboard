// DOM coverage for src/renderer/views/panes-view.js — the file that renders display mode `panes`.
//
// It had none before #343-#346: `npm test` loaded pane-tree.js and nothing else in this mode, which
// is why three defects with lasting damage sat in it behind a green suite.
//
// This file is one quarter of that coverage, split off by subject (#630): the TAB STRIP — what the
// strip shows and reaches, the tab list and its keyboard model, re-keying a session, the session
// bar, the scrollback of a background tab, what the window reports it is showing, the caret after a
// switch, a reorder along the row, and the subagent overlay. The other three are
// test/panes-view.test.js (the layout), test/panes-view-views.test.js (hosted views, the empty pane,
// selection) and test/panes-view-drag.test.js (drag and drop). The split is mechanical: the harness
// builds a fresh jsdom per test, so 206 of them in one file ran 13-20 s alone and 41 s under the
// suite's own concurrency, and node's runner parallelises across files rather than within one.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  setupPanesDom, paneWith, twoPanes, layoutSignature, startDrag, stubPaneGeometry,
} = require('./helpers/panes-dom');

// --- #349: the strip has to show, reach and clear the tabs it holds ----------

const tabTexts = (h) => [...h.document.querySelectorAll('.pane-strip .session-tab .session-tab-label')]
  .map((l) => l.textContent);

test('activating a tab scrolls it into view (#349)', async () => {
  const h = setupPanesDom();
  try {
    for (let i = 0; i < 12; i++) h.mount('s' + i);
    h.enable();
    await h.settle();
    // jsdom does no layout, so scrollIntoView is recorded rather than measured — what matters is
    // that the active tab is the one asked for, from the strip that holds it.
    const scrolled = [];
    h.window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
    h.panes.show('s7');
    await h.settle();
    const active = h.document.querySelector('.pane-strip .session-tab.active');
    assert.equal(active.dataset.sessionId, 's7');
    assert.ok(scrolled.includes(active), 'the active tab was the element brought into view');
  } finally { h.destroy(); }
});

test('the strip only grows overflow controls when it overflows (#349)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('s1');
    h.enable();
    await h.settle();
    const controls = h.document.querySelector('.pane-strip .session-tabs-controls');
    assert.ok(controls, 'the controls exist');
    assert.equal(controls.classList.contains('visible'), false, 'hidden while everything fits');
    assert.deepEqual([...controls.querySelectorAll('button')].map((b) => b.textContent), ['◀', '▶', '▾']);
  } finally { h.destroy(); }
});

test('the tab list names every tab in the pane and activates the one picked (#349)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('alpha', { name: 'Alpha' });
    h.mount('beta', { name: 'Beta' });
    h.mount('gamma', { name: 'Gamma' });
    h.enable();
    await h.settle();
    h.document.querySelector('.pane-strip .session-tabs-controls button:last-child').click();
    const items = [...h.document.querySelectorAll('.session-tabs-overflow-item')];
    assert.deepEqual(items.map((i) => i.textContent), ['Alpha', 'Beta', 'Gamma']);
    items[0].click();
    await h.settle();
    assert.equal(h.document.querySelector('.pane-strip .session-tab.active').dataset.sessionId, 'alpha');
    assert.equal(h.document.querySelector('.session-tabs-overflow'), null, 'the list closed behind the pick');
  } finally { h.destroy(); }
});

test('the tab list filters (#349)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('alpha', { name: 'Alpha' });
    h.mount('beta', { name: 'Beta' });
    h.enable();
    await h.settle();
    h.document.querySelector('.pane-strip .session-tabs-controls button:last-child').click();
    const input = h.document.querySelector('.session-tabs-overflow-filter');
    input.value = 'bet';
    input.dispatchEvent(new h.window.Event('input'));
    assert.deepEqual([...h.document.querySelectorAll('.session-tabs-overflow-item')].map((i) => i.textContent), ['Beta']);
  } finally { h.destroy(); }
});

test('two tabs with the same name are told apart by their project (#349)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a', { name: 'build' });
    h.mount('b', { name: 'build' });
    h.mount('c', { name: 'deploy' });
    h.sessionMap.get('a').projectPath = '/projects/frontend';
    h.sessionMap.get('b').projectPath = '/projects/api-gateway';
    h.enable();
    await h.settle();
    const labels = tabTexts(h);
    assert.deepEqual(labels, ['build — frontend', 'build — api-gateway', 'deploy']);
  } finally { h.destroy(); }
});

test('the tab tooltip names the project, the backend and the state (#334)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a', { name: 'Auth refactor' });
    h.sessionMap.get('a').projectPath = '/projects/frontend';
    h.sessionMap.get('a').backendId = 'claude';
    h.window.getBackend = (id) => (id === 'claude' ? { id, label: 'Claude' } : null);
    // The state comes from the same source the dot uses, so the two cannot disagree.
    h.window.getSessionStatus = () => ({ className: 'status-busy', label: 'Working' });
    h.enable();
    await h.settle();
    const tab = h.document.querySelector('.session-tab[data-session-id="a"]');
    assert.equal(tab.title, 'Auth refactor\nfrontend · Claude · Working');
  } finally { h.destroy(); }
});

test('close others, close to the right and close all (#349)', async () => {
  const h = setupPanesDom();
  try {
    for (const id of ['t1', 't2', 't3', 't4']) h.mount(id, { running: false });
    h.enable();
    await h.settle();
    // The menu is built for the tab that was right-clicked; drive it through the same entry point.
    const tab = h.document.querySelector('.session-tab[data-session-id="t2"]');
    tab.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const labels = [...h.document.querySelectorAll('.session-tab-menu-item')].map((b) => b.textContent);
    assert.ok(labels.includes('Close others'));
    assert.ok(labels.includes('Close to the right'));
    assert.ok(labels.includes('Close all'));
    // "to the right" of t2 is t3 and t4.
    [...h.document.querySelectorAll('.session-tab-menu-item')].find((b) => b.textContent === 'Close to the right').click();
    await h.settle();
    assert.deepEqual(h.calls.destroySession.sort(), ['t3', 't4']);
    assert.deepEqual([...h.document.querySelectorAll('.pane-strip .session-tab')].map((t) => t.dataset.sessionId), ['t1', 't2']);
  } finally { h.destroy(); }
});

test('a bulk close asks once before it stops processes (#349)', async () => {
  const h = setupPanesDom();
  try {
    for (const id of ['t1', 't2', 't3']) h.mount(id, { type: 'terminal' });
    h.enable();
    await h.settle();
    const tab = h.document.querySelector('.session-tab[data-session-id="t1"]');
    tab.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    [...h.document.querySelectorAll('.session-tab-menu-item')].find((b) => b.textContent === 'Close others').click();
    await h.settle();
    assert.equal(h.calls.dialogs.length, 1, 'one question for the set');
    assert.match(h.calls.dialogs[0].message, /stops 2 running processes/);
    assert.deepEqual(h.calls.stopSession.sort(), ['t2', 't3']);
  } finally { h.destroy(); }
});

test('cancelling a bulk close leaves every tab alone (#349)', async () => {
  const h = setupPanesDom();
  try {
    for (const id of ['t1', 't2']) h.mount(id, { type: 'terminal' });
    h.enable();
    await h.settle();
    h.answers.confirm = false;
    const tab = h.document.querySelector('.session-tab[data-session-id="t1"]');
    tab.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    [...h.document.querySelectorAll('.session-tab-menu-item')].find((b) => b.textContent === 'Close all').click();
    await h.settle();
    assert.deepEqual(h.calls.destroySession, []);
    assert.equal(h.document.querySelectorAll('.pane-strip .session-tab').length, 2);
  } finally { h.destroy(); }
});

test('a menu replaced within the same tick does not leak its dismiss listeners (#349)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('s1');
    h.enable();
    await h.settle();
    const added = [];
    const removed = [];
    const origAdd = h.document.addEventListener.bind(h.document);
    const origRemove = h.document.removeEventListener.bind(h.document);
    h.document.addEventListener = (t, fn, c) => { if (t === 'mousedown' || t === 'keydown') added.push(fn); origAdd(t, fn, c); };
    h.document.removeEventListener = (t, fn, c) => { if (t === 'mousedown' || t === 'keydown') removed.push(fn); origRemove(t, fn, c); };
    const more = h.document.querySelector('.pane-more-btn');
    for (let i = 0; i < 5; i++) more.click();     // five opens inside one tick
    await h.settle();
    h.document.querySelector('.pane-more-btn').dispatchEvent(
      new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await h.settle();
    assert.ok(added.length <= 2, `only the live menu arms a pair, got ${added.length}`);
  } finally { h.destroy(); }
});

// --- #348: the window that RENDERS a session re-keys it ----------------------

test('rekeySessionState moves every table a session is keyed by (#348)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('old');
    h.enable();
    await h.settle();
    const entry = h.openSessions.get('old');
    assert.equal(h.window.rekeySessionState('old', 'new'), true);
    await h.settle();
    assert.equal(h.openSessions.get('new'), entry, 'the same live entry, under the new key');
    assert.equal(h.openSessions.has('old'), false);
    assert.equal(h.sessionMap.has('new'), true);
    assert.equal(h.sessionMap.has('old'), false);
    assert.equal(entry.session.sessionId, 'new');
    // …and the pane tab followed, which is what a detached window in panes mode was missing.
    assert.ok(h.document.querySelector('.session-tab[data-session-id="new"]'));
    assert.equal(h.document.querySelector('.session-tab[data-session-id="old"]'), null);
  } finally { h.destroy(); }
});

test('a window that does not render the session says so and changes nothing (#348)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('mine');
    h.enable();
    await h.settle();
    assert.equal(h.window.rekeySessionState('someone-elses', 'new'), false);
    assert.equal(h.openSessions.has('mine'), true);
    assert.equal(h.openSessions.has('new'), false);
    // A no-op id move is not a move either.
    assert.equal(h.window.rekeySessionState('mine', 'mine'), false);
    assert.equal(h.openSessions.has('mine'), true);
  } finally { h.destroy(); }
});

test('a detached window re-keys its own session the way the main one does (#348)', async () => {
  // The detached window learns about the move through `detached-session-rekeyed`, not
  // `session-forked` — which is addressed to the main window alone. Both now run the same function,
  // so this asserts the shared half against a window built as a detached one.
  const h = setupPanesDom({ detached: true, detachedSessionId: 'old' });
  try {
    h.mount('old');
    h.enable();
    await h.settle();
    assert.equal(h.window.isDetachedWindow(), true);
    assert.equal(h.window.rekeySessionState('old', 'new'), true);
    await h.settle();
    assert.equal(h.openSessions.has('new'), true, 'output under the new id now finds an entry here');
    assert.ok(h.document.querySelector('.session-tab[data-session-id="new"]'));
    assert.equal(h.rawStored(), null, 'and it still writes no layout');
  } finally { h.destroy(); }
});

// --- #351: the strip has to be a tab list, and usable without a mouse --------

test('the strip announces itself as a tab list with selectable tabs (#351)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a', { name: 'Alpha' });
    h.mount('b', { name: 'Beta' });
    h.enable();
    await h.settle();
    const list = h.document.querySelector('.pane-strip .session-tabs-list');
    assert.equal(list.getAttribute('role'), 'tablist');
    assert.equal(list.getAttribute('aria-orientation'), 'horizontal');
    const tabs = [...list.querySelectorAll('.session-tab')];
    assert.equal(tabs.length, 2);
    for (const t of tabs) {
      assert.equal(t.getAttribute('role'), 'tab');
      assert.ok(t.getAttribute('aria-label'), 'every tab has a name');
      assert.ok(t.id, 'and an id the panel can point at');
    }
    assert.deepEqual(tabs.map((t) => t.getAttribute('aria-selected')), ['false', 'true']);
    // The pane body is the panel, labelled by whichever tab is on top.
    const body = h.document.querySelector('.pane-body');
    assert.equal(body.getAttribute('role'), 'tabpanel');
    assert.equal(body.getAttribute('aria-labelledby'), tabs[1].id);
  } finally { h.destroy(); }
});

test('the accessible name carries the state a sighted user reads from the dot (#351)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('live', { name: 'Live' });
    h.mount('stopped', { name: 'Stopped', running: false });
    h.enable();
    await h.settle();
    const nameOf = (sid) => h.document.querySelector(`.session-tab[data-session-id="${sid}"]`).getAttribute('aria-label');
    assert.equal(nameOf('live'), 'Live, running');
    assert.equal(nameOf('stopped'), 'Stopped, stopped');
  } finally { h.destroy(); }
});

test('the strip is ONE tab stop, and the close buttons are not (#351)', async () => {
  const h = setupPanesDom();
  try {
    for (const id of ['a', 'b', 'c']) h.mount(id);
    h.enable();
    await h.settle();
    const tabs = [...h.document.querySelectorAll('.pane-strip .session-tab')];
    assert.deepEqual(tabs.map((t) => t.tabIndex), [-1, -1, 0], 'only the active tab is reachable by Tab');
    for (const btn of h.document.querySelectorAll('.session-tab-close')) {
      assert.equal(btn.tabIndex, -1, 'a close button is not a tab stop of its own');
      assert.ok(btn.getAttribute('aria-label').startsWith('Close '), 'but it is still named');
    }
  } finally { h.destroy(); }
});

test('arrows move focus inside the strip without activating anything (#351)', async () => {
  const h = setupPanesDom();
  try {
    for (const id of ['a', 'b', 'c']) h.mount(id);
    h.enable();
    await h.settle();
    const list = h.document.querySelector('.pane-strip .session-tabs-list');
    const tabs = [...list.querySelectorAll('.session-tab')];
    const selectedBefore = tabs.map((t) => t.getAttribute('aria-selected'));
    h.calls.showSession.length = 0;   // the setup already showed one; only the arrows are on trial
    tabs[2].focus();
    const press = (key, opts = {}) => tabs.find((t) => t === h.document.activeElement)
      .dispatchEvent(new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));

    press('ArrowLeft');
    assert.equal(h.document.activeElement.dataset.sessionId, 'b');
    press('Home');
    assert.equal(h.document.activeElement.dataset.sessionId, 'a');
    press('End');
    assert.equal(h.document.activeElement.dataset.sessionId, 'c');
    // Focus is not selection: nothing was opened on the way.
    assert.deepEqual([...list.querySelectorAll('.session-tab')].map((t) => t.getAttribute('aria-selected')), selectedBefore);
    assert.deepEqual(h.calls.showSession, []);
  } finally { h.destroy(); }
});

test('Enter selects the focused tab, Delete closes it (#351)', async () => {
  const h = setupPanesDom();
  try {
    for (const id of ['a', 'b', 'c']) h.mount(id, { running: false });
    h.enable();
    await h.settle();
    let tabs = [...h.document.querySelectorAll('.pane-strip .session-tab')];
    tabs[0].focus();
    tabs[0].dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await h.settle();
    assert.equal(h.document.querySelector('.session-tab.active').dataset.sessionId, 'a');

    tabs = [...h.document.querySelectorAll('.pane-strip .session-tab')];
    tabs[1].focus();
    tabs[1].dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    await h.settle();
    assert.deepEqual(h.calls.destroySession, ['b']);
  } finally { h.destroy(); }
});

test('Shift+F10 opens the menu for the FOCUSED tab, not the active one (#351)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a'); h.mount('b');
    h.enable();
    await h.settle();
    const tabs = [...h.document.querySelectorAll('.pane-strip .session-tab')];
    tabs[0].focus();
    tabs[0].dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    const menu = h.document.querySelector('.session-tab-menu');
    assert.ok(menu, 'a menu opened');
    // A tab menu carries the tab items; the pane-only menu does not.
    assert.ok([...menu.querySelectorAll('.session-tab-menu-item')].some((b) => b.textContent === 'Stop & close'));
  } finally { h.destroy(); }
});

test('the sash is focusable, resizes with the arrows and resets with Home (#351)', async () => {
  const h = setupPanesDom();
  try {
    await twoPanes(h);
    const sash = h.document.querySelector('.pane-sash');
    assert.equal(sash.tabIndex, 0, 'the separator role finally has something behind it');
    assert.equal(sash.getAttribute('aria-valuenow'), '50');
    assert.ok(sash.getAttribute('aria-label'));

    sash.focus();
    sash.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    let now = Number(h.document.querySelector('.pane-sash').getAttribute('aria-valuenow'));
    assert.equal(now, 45, 'one step to the left');
    assert.equal(h.document.activeElement.classList.contains('pane-sash'), true,
      'and the focus followed the rebuilt element');

    h.document.querySelector('.pane-sash').dispatchEvent(
      new h.window.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
    now = Number(h.document.querySelector('.pane-sash').getAttribute('aria-valuenow'));
    assert.equal(now, 46, 'Shift is a nudge');

    h.document.querySelector('.pane-sash').dispatchEvent(
      new h.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    now = Number(h.document.querySelector('.pane-sash').getAttribute('aria-valuenow'));
    assert.equal(now, 50, 'Home distributes evenly — the reset the pointer path never had');
  } finally { h.destroy(); }
});

test('what changes is announced (#351)', async () => {
  const h = setupPanesDom();
  try {
    await twoPanes(h);
    const region = h.document.getElementById('pane-live-region');
    assert.ok(region, 'panes have their own live region, so the attention summary cannot clobber it');
    h.document.querySelector('.pane-sash').focus();
    h.document.querySelector('.pane-sash').dispatchEvent(
      new h.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    assert.match(region.textContent, /percent/);
  } finally { h.destroy(); }
});

// --- #350: the keyboard model ------------------------------------------------

// Lay four panes out in a 2×2 grid and tell the harness where each one is, so the spatial
// neighbour choice has real geometry to read. jsdom does no layout, so the rectangles are supplied.
async function grid2x2(h) {
  // A session lands in the ACTIVE pane when it is mounted (adoptOrphans) — `show()` only activates a
  // tab where it already is. So each pane is filled after the split that created it.
  h.mount('a');
  h.enable();
  await h.settle();
  h.panes.splitActivePane('right');   // a | (new, active)
  await h.open('b');
  h.panes.splitActivePane('down');    // a | b over (new, active)
  await h.open('c');
  h.panes.focusPaneByIndex(1);        // back to a
  h.panes.splitActivePane('down');    // a over (new, active) | b over c
  await h.open('d');
  const panes = [...h.document.querySelectorAll('.pane')];
  assert.equal(panes.length, 4, 'four panes');
  // Left column top/bottom, right column top/bottom — the order buildNode produces for this tree.
  const boxes = {
    a: { left: 0, top: 0, width: 500, height: 400 },
    d: { left: 0, top: 400, width: 500, height: 400 },
    b: { left: 500, top: 0, width: 500, height: 400 },
    c: { left: 500, top: 400, width: 500, height: 400 },
  };
  for (const pane of panes) {
    const sid = pane.querySelector('.session-tab').dataset.sessionId;
    const box = boxes[sid];
    pane.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height });
  }
  const paneOf = (sid) => h.document.querySelector(`.session-tab[data-session-id="${sid}"]`).closest('.pane').dataset.paneId;
  return { paneOf, activeSid: () => h.document.querySelector('.pane.pane-active .session-tab').dataset.sessionId };
}

test('pane arrows move to the neighbour on screen, not the next leaf in render order (#350)', async () => {
  const h = setupPanesDom();
  try {
    const g = await grid2x2(h);
    h.panes.focusPaneByIndex(1);                 // top-left
    assert.equal(g.activeSid(), 'a');
    assert.equal(h.panes.focusNeighbourPane('right'), true);
    assert.equal(g.activeSid(), 'b', 'right of top-left is top-right');
    assert.equal(h.panes.focusNeighbourPane('down'), true);
    assert.equal(g.activeSid(), 'c', 'down from top-right is bottom-right');
    assert.equal(h.panes.focusNeighbourPane('left'), true);
    assert.equal(g.activeSid(), 'd', 'left of bottom-right is bottom-left');
    assert.equal(h.panes.focusNeighbourPane('up'), true);
    assert.equal(g.activeSid(), 'a', 'up from bottom-left is top-left');
  } finally { h.destroy(); }
});

test('an arrow off the edge of the layout does nothing instead of wrapping (#350)', async () => {
  const h = setupPanesDom();
  try {
    const g = await grid2x2(h);
    h.panes.focusPaneByIndex(1);
    assert.equal(g.activeSid(), 'a');
    assert.equal(h.panes.focusNeighbourPane('left'), false, 'nothing to the left of the leftmost pane');
    assert.equal(g.activeSid(), 'a', 'and the focus did not move');
    assert.equal(h.panes.focusNeighbourPane('up'), false);
    assert.equal(g.activeSid(), 'a');
  } finally { h.destroy(); }
});

test('zoom fills the area and puts the layout back untouched (#350)', async () => {
  const h = setupPanesDom();
  try {
    await twoPanes(h);
    const before = layoutSignature(h);
    const target = h.document.querySelector('.pane.pane-active').dataset.paneId;

    assert.equal(h.panes.toggleZoom(), true);
    assert.equal(h.panes.isZoomed(), true);
    assert.equal(h.document.getElementById('terminals').classList.contains('pane-zoomed'), true);
    assert.equal(h.document.querySelector('.pane.pane-zoom-target').dataset.paneId, target);
    assert.equal(h.document.querySelectorAll('.pane').length, 2, 'the other pane is still in the tree');

    assert.equal(h.panes.toggleZoom(), true);
    assert.equal(h.panes.isZoomed(), false);
    assert.equal(h.document.getElementById('terminals').classList.contains('pane-zoomed'), false);
    assert.equal(h.document.querySelector('.pane.pane-zoom-target'), null);
    assert.equal(layoutSignature(h), before, 'the arrangement came back exactly as it was');
  } finally { h.destroy(); }
});

test('a rebuild keeps the zoom, and losing the pane drops it (#350)', async () => {
  const h = setupPanesDom();
  try {
    await twoPanes(h);
    h.panes.toggleZoom();                    // the pane holding b
    h.panes.render();
    assert.equal(h.document.getElementById('terminals').classList.contains('pane-zoomed'), true,
      'a rebuild re-asserts the zoom');
    // The zoomed pane goes away with its only tab.
    h.window.destroySession('b');
    await h.settle();
    assert.equal(h.panes.isZoomed(), false);
    assert.equal(h.document.getElementById('terminals').classList.contains('pane-zoomed'), false);
  } finally { h.destroy(); }
});

test('a split leaves zoom, so the new pane is not hidden behind it (#350)', async () => {
  const h = setupPanesDom();
  try {
    await twoPanes(h);
    h.panes.toggleZoom();
    h.panes.splitActivePane('down');
    await h.settle();
    assert.equal(h.panes.isZoomed(), false);
  } finally { h.destroy(); }
});

test('tab navigation stays inside the focused pane (#350)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('x1'); h.mount('x2');
    h.enable();
    await h.settle();
    h.panes.splitActivePane('right');
    await h.open('y1');
    await h.open('y2');
    const activeSid = () => h.document.querySelector('.pane.pane-active .session-tab.active').dataset.sessionId;
    assert.equal(activeSid(), 'y2');
    assert.equal(h.panes.navigateTabInPane(-1), true);
    await h.settle();
    assert.equal(activeSid(), 'y1', 'stepped inside this pane');
    assert.equal(h.panes.navigateTabInPane(-1), true);
    await h.settle();
    assert.equal(activeSid(), 'y2', 'wraps within the pane rather than leaving it');
    // The other pane never became active.
    assert.equal(h.document.querySelectorAll('.pane.pane-active').length, 1);
  } finally { h.destroy(); }
});

test('the close chords act on the focused pane (#350)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a', { running: false });
    h.enable();
    await h.settle();
    h.panes.splitActivePane('right');
    await h.open('b', { running: false });
    await h.open('c', { running: false });
    assert.equal(h.panes.closeActiveTab(), true);
    await h.settle();
    assert.deepEqual(h.calls.destroySession, ['c']);
    assert.equal(await h.panes.closeActivePane(), true);
    await h.settle();
    assert.deepEqual(h.calls.destroySession.sort(), ['b', 'c']);
    assert.equal(h.document.querySelectorAll('.pane').length, 1, 'the pane went with its tabs');
  } finally { h.destroy(); }
});

test('the last pane refuses the close chord (#350)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.enable();
    await h.settle();
    assert.equal(h.panes.closeActivePane(), false);
    assert.equal(h.document.querySelectorAll('.pane').length, 1);
  } finally { h.destroy(); }
});

// --- #346: a session that moves to a new id keeps its tab -------------------

// The renderer's own re-key, as session-ipc.js performs it, so the harness sees the same state the
// panes view is called in.
function rekey(h, oldId, newId) {
  const entry = h.openSessions.get(oldId);
  entry.session.sessionId = newId;
  h.openSessions.delete(oldId);
  h.openSessions.set(newId, entry);
  h.sessionMap.delete(oldId);
  h.sessionMap.set(newId, entry.session);
  if (h.activePtyIds.delete(oldId)) h.activePtyIds.add(newId);
  if (h.window.activeSessionId === oldId) h.window.activeSessionId = newId;
  h.panes.rekeySession(oldId, newId);
}

test('a session that moves to a new id keeps its tab in the same pane (#346)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('old');
    h.mount('other');
    h.enable();
    await h.settle();
    // Two panes, the moving session on the right — so a re-adoption into the active pane would be
    // visible as a change of pane, not just of tab.
    h.panes.splitActivePane('right');
    h.panes.show('old');
    await h.settle();
    const paneOfOld = h.document.querySelector('.session-tab[data-session-id="old"]').closest('.pane').dataset.paneId;

    rekey(h, 'old', 'new');
    await h.settle();

    const tab = h.document.querySelector('.session-tab[data-session-id="new"]');
    assert.ok(tab, 'the strip names the new id');
    assert.equal(h.document.querySelector('.session-tab[data-session-id="old"]'), null,
      'and no longer the retired one');
    assert.equal(tab.closest('.pane').dataset.paneId, paneOfOld, 'still the same pane');
    assert.equal(tab.classList.contains('active'), true, 'still the pane\'s active tab');
    // The container is where the tab is, so the pane shows the terminal rather than its empty state.
    const body = tab.closest('.pane').querySelector('.pane-body');
    assert.ok(body.contains(h.openSessions.get('new').element));
    assert.equal(body.querySelector('.pane-empty'), null);
  } finally { h.destroy(); }
});

test('the re-key keeps the tab at its position in the strip (#346)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.mount('old');
    h.mount('c');
    h.enable();
    await h.settle();
    const before = [...h.document.querySelectorAll('.session-tab')].map((t) => t.dataset.sessionId);
    assert.deepEqual(before, ['a', 'old', 'c']);
    rekey(h, 'old', 'new');
    await h.settle();
    const after = [...h.document.querySelectorAll('.session-tab')].map((t) => t.dataset.sessionId);
    assert.deepEqual(after, ['a', 'new', 'c']);
  } finally { h.destroy(); }
});

test('the stored layout is written with the new id, so a restart restores it (#346)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('old');
    h.enable();
    await h.settle();
    rekey(h, 'old', 'new');
    await h.settle();
    h.disable();
    const stored = JSON.stringify(h.readStored());
    assert.ok(stored.includes('term:new'), 'the new id is in the stored tree');
    assert.ok(!stored.includes('term:old'), 'the retired id is not');
  } finally { h.destroy(); }
});

test('re-keying a session with no tab changes nothing (#346)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('s1');
    h.enable();
    await h.settle();
    assert.equal(h.panes.rekeySession('never-had-a-tab', 'x'), false);
    assert.equal(h.document.querySelectorAll('.session-tab').length, 1);
  } finally { h.destroy(); }
});

test('a re-key onto an id that already has a tab retires the old one (#346)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('old');
    h.mount('taken');
    h.enable();
    await h.settle();
    // Both tabs exist; the move lands on the id the second tab already holds.
    rekey(h, 'old', 'taken');
    await h.settle();
    const ids = [...h.document.querySelectorAll('.session-tab')].map((t) => t.dataset.sessionId);
    assert.deepEqual(ids, ['taken'], 'one tab per session, and the retired id is gone');
  } finally { h.destroy(); }
});

test('a collision across panes leaves the session in the pane that already had the tab (#346)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('old');
    h.mount('taken');
    h.enable();
    await h.settle();
    h.panes.splitActivePane('right');
    h.panes.show('taken');
    await h.settle();
    const takenPane = h.document.querySelector('.session-tab[data-session-id="taken"]').closest('.pane').dataset.paneId;
    rekey(h, 'old', 'taken');
    await h.settle();
    // Documented consequence of the collision branch: the surviving tab stays where the user put it,
    // which is a different pane than the retiring one was in. It needs two live sessions to share an
    // id, so no real CLI can produce it — but the behaviour should not be a surprise if it ever does.
    const tabs = [...h.document.querySelectorAll('.session-tab')];
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].closest('.pane').dataset.paneId, takenPane);
  } finally { h.destroy(); }
});

test('leaving panes mode mid-drag does not carry pane-sashing into the next mode (#345)', async () => {
  const h = setupPanesDom();
  try {
    await startDrag(h);
    h.pointer(h.window, 'pointermove', { x: 400, y: 400 });
    // A display-mode change is broadcast to every window, so it can land while the button is down.
    // `disable()` tears the pane DOM down without going through render(), and the CSS that kills
    // pointer events is not scoped to panes mode — so the class would follow into tabs mode.
    h.disable();
    assert.equal(h.document.body.classList.contains('pane-sashing'), false);
  } finally { h.destroy(); }
});

test('a second sash gesture does not leave the first one running (#345)', async () => {
  const h = setupPanesDom();
  try {
    const sash = await startDrag(h);
    h.pointer(sash, 'pointerdown', { x: 500, y: 400 });
    h.pointer(h.window, 'pointerup', { x: 500, y: 400 });
    assert.equal(h.document.body.classList.contains('pane-sashing'), false,
      'one pointerup ends whatever gesture is live');
  } finally { h.destroy(); }
});

// --- A dormant session moved into this window (#332) -------------------------------------------
//
// The only path that puts an UNMOUNTED session into the tree. `show` refuses one (it is the choke
// point every showSession goes through, and a phantom tab there would be worse than a declined move)
// and `adoptOrphans` walks `openSessions`, so a session moved in with no process had nowhere to land.

test('a dormant session moved in gets a tab, and the pane offers Launch (#332)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    // What a moved-in dormant session looks like from the renderer's side: a record and no mount.
    h.sessionMap.set('dorm-1', { sessionId: 'dorm-1', name: 'Dormant one', type: 'agent' });

    assert.equal(h.panes.openDormantTab('dorm-1'), true);
    await h.settle();

    const labels = [...h.document.querySelectorAll('.session-tab-label')].map((el) => el.textContent);
    assert.deepEqual(labels, ['live-1', 'Dormant one']);
    const tab = [...h.document.querySelectorAll('.session-tab')]
      .find((el) => el.querySelector('.session-tab-label').textContent === 'Dormant one');
    assert.equal(tab.classList.contains('session-tab-dormant'), true);
    assert.equal(tab.getAttribute('aria-selected'), 'true',
      'the user moved it here — showing it is the feedback that the move happened');
    // The placeholder, not an empty pane: this is the one state where opening the session spawns a
    // CLI, so the button says so instead of a tab click doing it silently (#318).
    assert.equal(h.document.querySelectorAll('.pane-empty-launch').length, 1);
  } finally { h.destroy(); }
});

// --- The session bar (#358) ---------------------------------------------------
//
// The row under the tabs. It used to carry the name, the terminal's own title (usually the same
// sentence again) and the full session id, and no project — so the one fact that tells two sessions
// with the same summary apart was the one missing.

test('the pane bar shows the name and the project, and nothing twice (#358)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    const { session } = await h.open('s1', { name: 'Auth refactor' });
    session.projectPath = '/srv/projects/api-gateway';
    session.aiTitle = 'Refactor the auth middleware';
    h.openSessions.get('s1').ptyTitle = 'claude — running tests';
    h.panes.render();
    await h.settle();

    assert.equal(h.document.querySelectorAll('.pane-actionbar-pty').length, 0, 'the second title is gone');
    assert.equal(h.document.querySelectorAll('.pane-actionbar-id').length, 0, 'the id is off the row');
    assert.equal(h.document.querySelector('.pane-actionbar-name').textContent, 'Auth refactor');
    assert.equal(h.document.querySelector('.pane-actionbar-project').textContent, 'api-gateway');

    // Everything that left the row is reachable without leaving it.
    const title = h.document.querySelector('.pane-actionbar-name').title;
    assert.match(title, /Refactor the auth middleware/, 'the AI title behind the rename');
    assert.match(title, /claude — running tests/, 'the terminal\'s own title');
    assert.match(title, /\bs1\b/, 'the session id');
    assert.match(title, /Click to rename/, 'and the affordance the row does not spell out');
  } finally { h.destroy(); }
});

test('clicking the pane bar name renames the session, with the pane bar as the element (#358)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('s1', { name: 'Auth refactor' });
    h.panes.render();
    await h.settle();

    // The same call the tabs-mode header makes, so an empty name means the same thing in both places.
    // The pane owes the call with ITS element and ITS session; the editing itself is app.js's.
    h.pointer(h.document.querySelector('.pane-actionbar-name'), 'mousedown');
    await h.settle();
    assert.deepEqual(h.calls.renames, [['pane-actionbar-name', 's1', true]]);
  } finally { h.destroy(); }
});

test('a pane bar for a session without a project shows no empty divider (#358)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('s1');
    h.panes.render();
    await h.settle();
    assert.equal(h.document.querySelectorAll('.pane-actionbar-project').length, 0);
    assert.equal(h.document.querySelectorAll('.pane-actionbar-name').length, 1);
  } finally { h.destroy(); }
});

test('renaming works on the FIRST press in a pane that is not focused (#358)', async () => {
  const h = setupPanesDom();
  try {
    // Two panes, and the press lands in the one that is not active. Focusing it routes through
    // showSession → show() → scheduleRender, whose microtask rebuilds that bar — so a `click` handler
    // never ran: the node its mousedown landed on had already left the document.
    await paneWith(h, ['s2']);
    h.panes.show('keep-me');
    await h.settle();
    const target = h.document.querySelector('.session-tab[data-session-id="s2"]')
      .closest('.pane').querySelector('.pane-actionbar-name');

    h.pointer(target, 'mousedown');
    await h.settle();

    assert.equal(h.calls.renames.length, 1, 'one press is enough');
    assert.equal(h.calls.renames[0][1], 's2', 'and it renames the session that was pressed');
    assert.equal(h.calls.renames[0][2], true, 'on an element that is actually in the document');
    assert.equal(h.window.isSessionRenaming(), true);
    // This is what makes the assertion above a regression test rather than a restatement: the node the
    // handler's closure captured is gone by the time the rename starts, so passing it — which is what the
    // code did — hands the edit an element no longer in the document.
    assert.equal(target.isConnected, false, 'the pressed node did not survive the focus');
    assert.notEqual(h.renameState.el, target, 'so the edit runs in the element that replaced it');
  } finally { h.destroy(); }
});

test('a status edge does not tear an open rename out of the pane (#358)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('s1', { name: 'Auth refactor' });
    h.panes.render();
    await h.settle();
    h.pointer(h.document.querySelector('.pane-actionbar-name'), 'mousedown');
    await h.settle();
    const editing = h.renameState.el;
    editing.textContent = 'half-typed nam';

    // What `refreshSessionStatusViews` calls on ANY session's busy/idle edge — not the user's doing.
    // It used to rebuild the bar unconditionally, which discarded the text and left the rename flag
    // set: every later rename and the header's AI-title refresh were dead until a restart.
    h.panes.refreshChrome();
    await h.settle();

    assert.equal(editing.isConnected, true, 'the element being typed into survives');
    assert.equal(editing.textContent, 'half-typed nam', 'and so does the text');
    assert.deepEqual(h.calls.renameEnds, [], 'nothing ended the edit behind the user');
  } finally { h.destroy(); }
});

test('a full render commits an open rename instead of discarding it (#358)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('s1', { name: 'Auth refactor' });
    h.panes.render();
    await h.settle();
    h.pointer(h.document.querySelector('.pane-actionbar-name'), 'mousedown');
    await h.settle();

    // A render rebuilds every bar, so unlike refreshChrome it cannot step around the edit — the tree
    // itself changed. Same shape as the sash drag it ends two lines above (#345): end the gesture rather
    // than leave it holding an element that is gone.
    h.panes.show('s1');
    h.panes.render();
    await h.settle();

    assert.deepEqual(h.calls.renameEnds, [true], 'committed — the text is the user\'s');
    assert.equal(h.window.isSessionRenaming(), false, 'and the flag is clear for the next rename');
  } finally { h.destroy(); }
});

// --- #352: scrollback of a background pane tab -------------------------------

const scrollbackOf = (h, id) => h.openSessions.get(id).terminal.options.scrollback;

test('a background tab keeps its full scrollback while the setting is off (#352)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    await h.open('b'); // same pane, so `a` is now behind `b`
    assert.equal(scrollbackOf(h, 'a'), 10000, 'the default is the opinion: history is not traded away');
    assert.equal(scrollbackOf(h, 'b'), 10000);
  } finally { h.destroy(); }
});

test('paneBackgroundScrollback shrinks the tab that is not on screen (#352)', async () => {
  const h = setupPanesDom();
  try {
    h.enable({ paneBackgroundScrollback: 2000 });
    await h.open('a');
    await h.open('b');
    assert.equal(scrollbackOf(h, 'a'), 2000, 'behind');
    assert.equal(scrollbackOf(h, 'b'), 10000, 'in front');

    // Coming forward raises it again. What was already trimmed stays gone — xterm cannot restore it,
    // which is the whole reason this is off by default.
    h.panes.show('a');
    await h.settle();
    assert.equal(scrollbackOf(h, 'a'), 10000);
    assert.equal(scrollbackOf(h, 'b'), 2000);
  } finally { h.destroy(); }
});

test('leaving panes mode hands every budget back (#352)', async () => {
  const h = setupPanesDom();
  try {
    h.enable({ paneBackgroundScrollback: 1000 });
    await h.open('a');
    await h.open('b');
    assert.equal(scrollbackOf(h, 'a'), 1000);
    h.disable();
    // Tabs and grid decide this for themselves; a shrunk buffer left behind would apply a panes-mode
    // setting to a mode that never asked for it.
    assert.equal(scrollbackOf(h, 'a'), 10000);
    assert.equal(scrollbackOf(h, 'b'), 10000);
  } finally { h.destroy(); }
});

test('turning the setting off raises the buffers that are already shrunk (#352)', async () => {
  const h = setupPanesDom();
  try {
    h.enable({ paneBackgroundScrollback: 1000 });
    await h.open('a');
    await h.open('b');
    assert.equal(scrollbackOf(h, 'a'), 1000);
    // Nothing else would ever raise it: the per-tab path returns early once the setting is 0, so
    // without this the buffers would stay small for the rest of the session.
    h.enable({ paneBackgroundScrollback: 0 });
    await h.settle();
    assert.equal(scrollbackOf(h, 'a'), 10000);
  } finally { h.destroy(); }
});

// --- #366: what the window is SHOWING, which is not what is mounted ---

test('the layout names the selected tab even when its session is not running (#366)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    h.sessionMap.set('dorm-1', { sessionId: 'dorm-1', name: 'Dormant one', type: 'agent' });
    h.panes.openDormantTab('dorm-1');
    await h.settle();

    // `activeSessionId` is the wrong question here and that is the whole of #366: selecting a tab
    // whose session has no process never reaches `showSession`, so the global still names the
    // running one. The layout knows anyway — the tab is selected in it either way.
    assert.equal(h.panes.shownSessionId(), 'dorm-1');
    assert.deepEqual([...h.panes.sessionIdsInLayout()], ['live-1', 'dorm-1'],
      'a dormant tab is still a tab this window holds');
  } finally { h.destroy(); }
});

test('the layout follows the selection back to a running tab (#366)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    h.sessionMap.set('dorm-1', { sessionId: 'dorm-1', name: 'Dormant one', type: 'agent' });
    h.panes.openDormantTab('dorm-1');
    await h.settle();
    assert.equal(h.panes.shownSessionId(), 'dorm-1');

    // `show` is what `showSession` routes to in this mode — the path a click on a running tab takes.
    // Re-opening an already-mounted session is not a selection and would leave the dormant tab active.
    h.panes.show('live-1');
    await h.settle();
    assert.equal(h.panes.shownSessionId(), 'live-1');
  } finally { h.destroy(); }
});

test('a selected view tab is not a session and is not named as one (#366)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    h.panes.openViewTab('jsonl');
    await h.settle();

    assert.equal(h.panes.shownSessionId(), null, 'a view has no session to name the window after');
    assert.deepEqual([...h.panes.sessionIdsInLayout()], ['live-1'], 'and it is not counted as one');
  } finally { h.destroy(); }
});

// --- The caret after a switch (#425) ----------------------------------------
//
// `show()` only SCHEDULES the render, and the render moves the terminal's container into its pane.
// Focusing before that — which is what the caller used to do — is focusing an element that is about to
// be re-parented, and re-parenting blurs it. So these tests assert WHEN the focus happened, not just
// that it did: the container has to be inside its pane already.

test('#425: switching to a session focuses it AFTER its container is in the pane', async () => {
  const h = setupPanesDom();
  try {
    h.mount('s1');
    h.enable();
    await h.settle();
    await h.open('s2');

    const s2 = h.openSessions.get('s2');
    s2.focusCalls.length = 0;
    h.panes.show('s2');
    await h.settle();

    assert.equal(s2.focusCalls.length, 1, 'the switched-to session gets the caret exactly once');
    assert.match(s2.focusCalls[0].parentClass || '', /pane-body/,
      'focused while already inside its pane — a focus taken before the move is blurred by the move');
  } finally { h.destroy(); }
});

test('#425: an ordinary render does not steal the caret', async () => {
  const h = setupPanesDom();
  try {
    h.mount('s1');
    h.enable();
    await h.settle();

    const s1 = h.openSessions.get('s1');
    s1.focusCalls.length = 0;
    // What a resize, a status repaint or a sash drag ends in. Nobody asked for the caret here, and
    // taking it would pull the user out of the search bar mid-word.
    h.panes.render();
    await h.settle();

    assert.deepEqual(s1.focusCalls, [], 'only a switch may claim the caret');
  } finally { h.destroy(); }
});

test('#425: a queued focus is dropped when that session is no longer on top', async () => {
  const h = setupPanesDom();
  try {
    h.mount('s1');
    h.enable();
    await h.settle();
    await h.open('s2');

    const s1 = h.openSessions.get('s1');
    const s2 = h.openSessions.get('s2');
    s1.focusCalls.length = 0;
    s2.focusCalls.length = 0;

    // Two switches inside one microtask: the render that follows must serve the LAST one. A queued
    // focus that fired anyway would drag the user back to a session they already left.
    h.panes.show('s1');
    h.panes.show('s2');
    await h.settle();

    assert.deepEqual(s1.focusCalls, [], 'the superseded request must not fire');
    assert.equal(s2.focusCalls.length, 1);
  } finally { h.destroy(); }
});

// --- #436: a reorder along the tab row is not a split across the whole area ---
//
// #376's sliver of the outer band crosses the tab strip so the area's TOP edge is sayable at all.
// The reorder gesture runs along exactly that line, so the tabs themselves must not answer it.

test('#436: a point over the tabs answers "reorder", not a split across the whole area', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    await h.open('live-2');
    stubPaneGeometry(h);
    // Two tabs along the left half of a strip 800 wide — the empty space beside them is the band's.
    const tabs = [...h.document.querySelectorAll('.pane-strip .session-tab')];
    tabs.forEach((el, i) => {
      el.getBoundingClientRect = () => ({
        left: i * 150, top: 0, width: 150, height: 30,
        right: (i * 150) + 150, bottom: 30, x: i * 150, y: 0,
      });
    });

    // Inside the 10 px sliver, but over the first tab's right half: the gap after it.
    assert.deepEqual({ ...h.panes.dropTargetAt(100, 5) }, { kind: 'tab', leafId: 'pane-1', index: 1 });
    // Beside the tabs, same height: the band is untouched, so the top edge stays reachable.
    assert.deepEqual({ ...h.panes.dropTargetAt(500, 5) }, { kind: 'root', zone: 'up' });
    // Beside the tabs but PAST the sliver: the strip appends, and the container's 36 px band must not
    // answer over it. Both depths reach this point, so this is the one that tells them apart — and a
    // probe that said "root split" here would highlight a layout the local drop does not perform.
    assert.deepEqual({ ...h.panes.dropTargetAt(500, 15) }, { kind: 'tab', leafId: 'pane-1', index: -1 });
  } finally { h.destroy(); }
});

// --- #500: the subagent overlay has to survive a strip rebuild ---------------
//
// `patchStatuses` set `subagent-active`, and `refreshSessionStatusViews` calls `refreshChrome` right
// after it — which rebuilds the whole strip from `buildTab`. The class therefore lived for the length
// of one function call and the pulse was never seen. The builder sets it now, like the sidebar's row
// builder always has.

test('a rebuilt tab keeps the subagent overlay (#500)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.window.subagentActiveSessions.add('a');
    h.enable();
    await h.settle();

    const tab = () => h.document.querySelector('.session-tab[data-session-id="a"]');
    assert.ok(tab().classList.contains('subagent-active'), 'the builder sets it, not only the patcher');

    // What every status edge does: patch the dots, then rebuild the chrome.
    h.panes.patchStatuses();
    h.panes.refreshChrome();
    assert.ok(tab().classList.contains('subagent-active'),
      'the rebuild used to drop it, which is why the pulse was never visible');
  } finally { h.destroy(); }
});

test('a session with no live subagents carries no overlay (#500)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.enable();
    await h.settle();
    const tab = () => h.document.querySelector('.session-tab[data-session-id="a"]');
    assert.equal(tab().classList.contains('subagent-active'), false);

    // The setting going off empties the set — the overlay has to go with it, on the next rebuild too.
    h.window.subagentActiveSessions.add('a');
    h.panes.refreshChrome();
    assert.ok(tab().classList.contains('subagent-active'));
    h.window.subagentActiveSessions.delete('a');
    h.panes.refreshChrome();
    assert.equal(tab().classList.contains('subagent-active'), false);
  } finally { h.destroy(); }
});
