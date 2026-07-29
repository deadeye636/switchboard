// DOM coverage for src/renderer/views/panes-view.js — the file that renders display mode `panes`.
//
// It had none before #343-#346: `npm test` loaded pane-tree.js and nothing else in this mode, which
// is why three defects with lasting damage sat in it behind a green suite.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { setupPanesDom } = require('./helpers/panes-dom');

// --- The harness itself ------------------------------------------------------

test('enabling panes mode builds a pane and moves the mounted container into it', async () => {
  const h = setupPanesDom();
  try {
    h.mount('s1');
    h.enable();
    await h.settle();
    const panes = h.document.querySelectorAll('.pane');
    assert.equal(panes.length, 1);
    const container = h.openSessions.get('s1').element;
    assert.ok(panes[0].contains(container), 'the live container is inside the pane body');
    assert.ok(h.document.body.classList.contains('display-mode-panes'));
  } finally { h.destroy(); }
});

test('leaving panes mode hands every container back to #terminals', async () => {
  const h = setupPanesDom();
  try {
    h.mount('s1');
    h.enable();
    await h.settle();
    h.disable();
    const container = h.openSessions.get('s1').element;
    assert.equal(container.parentElement.id, 'terminals');
    assert.equal(h.document.querySelectorAll('.pane').length, 0);
    assert.equal(h.document.body.classList.contains('display-mode-panes'), false);
  } finally { h.destroy(); }
});

// --- #344: a detached window must not write the layout -----------------------

test('a detached window does not write the pane layout when panes mode is torn down (#344)', async () => {
  // The main window's arrangement, as it sits in the shared localStorage.
  const mainLayout = JSON.stringify({
    type: 'branch',
    orientation: 'row',
    size: 1,
    children: [
      { type: 'leaf', id: 'pane-1', tabs: [{ id: 'term:a', kind: 'terminal', ref: 'a' }], activeTabId: 'term:a', size: 0.5 },
      { type: 'leaf', id: 'pane-2', tabs: [{ id: 'term:b', kind: 'terminal', ref: 'b' }], activeTabId: 'term:b', size: 0.5 },
    ],
  });
  const h = setupPanesDom({ detached: true, detachedSessionId: 'c', storedTree: mainLayout });
  try {
    h.mount('c');
    h.enable();
    await h.settle();
    // The detached window builds its own one-leaf tree and must leave the stored one alone.
    assert.equal(h.rawStored(), mainLayout);
    // The display-mode change every window receives — this is the write that used to land.
    h.disable();
    assert.equal(h.rawStored(), mainLayout, 'the teardown must not overwrite the main window layout');
  } finally { h.destroy(); }
});

test('the main window still persists its layout on teardown (#344)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('s1');
    h.enable();
    await h.settle();
    h.panes.splitActivePane('right');
    h.disable();
    const stored = h.readStored();
    assert.equal(stored.type, 'branch');
    assert.equal(stored.children.length, 2);
  } finally { h.destroy(); }
});

test('a detached window persists nothing at all, on any path (#344)', async () => {
  const h = setupPanesDom({ detached: true, detachedSessionId: 's1' });
  try {
    h.mount('s1');
    h.enable();
    await h.settle();
    h.panes.splitActivePane('right');
    h.disable();
    assert.equal(h.rawStored(), null, 'no layout key written by a detached window');
  } finally { h.destroy(); }
});

// --- #347: closing a pane decides about processes the way closing a tab does --

// A pane of its own holding `ids`, so `closePane` has something to close that is not the last pane.
async function paneWith(h, ids, opts = {}) {
  h.mount('keep-me');
  h.enable(opts);
  await h.settle();
  h.panes.splitActivePane('right');
  for (const id of ids) { h.mount(id, opts.mountAs || {}); h.panes.show(id); }
  await h.settle();
  const paneId = h.document.querySelector(`.session-tab[data-session-id="${ids[0]}"]`).closest('.pane').dataset.paneId;
  return paneId;
}

test('closing a pane stops the terminals that closing their tabs would stop (#347)', async () => {
  const h = setupPanesDom();
  try {
    // terminalCloseBehavior defaults to `kill`, so a plain terminal's × ends its shell.
    const paneId = await paneWith(h, ['t1', 't2'], { mountAs: { type: 'terminal' } });
    await h.panes.closePane(paneId);
    await h.settle();
    assert.deepEqual(h.calls.stopSession.sort(), ['t1', 't2'], 'both processes were stopped, not orphaned');
    assert.deepEqual(h.calls.destroySession.sort(), ['t1', 't2']);
  } finally { h.destroy(); }
});

test('closing a pane asks once, naming how many processes it stops (#347)', async () => {
  const h = setupPanesDom();
  try {
    const paneId = await paneWith(h, ['t1', 't2'], { mountAs: { type: 'terminal' } });
    await h.panes.closePane(paneId);
    assert.equal(h.calls.dialogs.length, 1, 'one question for the whole pane, not one per session');
    assert.match(h.calls.dialogs[0].message, /stops 2 running processes/);
    assert.equal(h.calls.dialogs[0].tone, 'danger');
  } finally { h.destroy(); }
});

test('cancelling the question leaves the pane and its sessions alone (#347)', async () => {
  const h = setupPanesDom();
  try {
    const paneId = await paneWith(h, ['t1'], { mountAs: { type: 'terminal' } });
    const panesBefore = h.document.querySelectorAll('.pane').length;
    h.answers.confirm = false;
    await h.panes.closePane(paneId);
    await h.settle();
    assert.deepEqual(h.calls.stopSession, []);
    assert.deepEqual(h.calls.destroySession, []);
    assert.equal(h.document.querySelectorAll('.pane').length, panesBefore, 'the pane is still there');
    assert.equal(h.openSessions.has('t1'), true);
  } finally { h.destroy(); }
});

test('with the keep setting, closing a pane says what stays running instead of asking (#347)', async () => {
  const h = setupPanesDom();
  try {
    const paneId = await paneWith(h, ['t1'], { terminalCloseBehavior: 'keep', mountAs: { type: 'terminal' } });
    await h.panes.closePane(paneId);
    await h.settle();
    assert.deepEqual(h.calls.dialogs, [], 'nothing is stopped, so nothing is asked');
    assert.deepEqual(h.calls.stopSession, [], 'the process is kept, as configured');
    assert.equal(h.calls.toasts.length, 1, 'but the user is told it is still out there');
    assert.match(h.calls.toasts[0].message, /keeps running/);
  } finally { h.destroy(); }
});

test('a pane with nothing running closes without a question (#347)', async () => {
  const h = setupPanesDom();
  try {
    const paneId = await paneWith(h, ['t1'], { mountAs: { type: 'terminal', running: false } });
    await h.panes.closePane(paneId);
    await h.settle();
    assert.deepEqual(h.calls.dialogs, [], 'no process to stop, so no click to spend');
    assert.deepEqual(h.calls.toasts, []);
    assert.deepEqual(h.calls.destroySession, ['t1'], 'the tab still goes');
  } finally { h.destroy(); }
});

test('an agent session follows tabCloseBehavior, not the terminal one (#347)', async () => {
  const h = setupPanesDom();
  try {
    // Default `closeView`: closing an agent tab leaves its process alone, so the pane close must too.
    const paneId = await paneWith(h, ['a1']);
    await h.panes.closePane(paneId);
    await h.settle();
    assert.deepEqual(h.calls.stopSession, []);
    assert.equal(h.calls.toasts.length, 1);
  } finally { h.destroy(); }
});

test('a session that ends while the question is open is not acted on twice (#347)', async () => {
  const h = setupPanesDom();
  try {
    const paneId = await paneWith(h, ['t1', 't2'], { mountAs: { type: 'terminal' } });
    // t2's process exits while the dialog is up, so its tab leaves the tree. The captured leaf is a
    // snapshot of a tree that no longer exists — acting on it would stop an id nothing holds.
    h.answers.whileOpen = () => { h.unmount('t2'); h.panes.dropSession('t2'); };
    await h.panes.closePane(paneId);
    await h.settle();
    assert.deepEqual(h.calls.stopSession, ['t1'], 'only the session still in the pane');
    assert.deepEqual(h.calls.destroySession, ['t1']);
  } finally { h.destroy(); }
});

test('closing a pane twice in a row does not run the teardown twice (#347)', async () => {
  const h = setupPanesDom();
  try {
    const paneId = await paneWith(h, ['t1'], { mountAs: { type: 'terminal' } });
    await Promise.all([h.panes.closePane(paneId), h.panes.closePane(paneId)]);
    await h.settle();
    assert.deepEqual(h.calls.stopSession, ['t1'], 'the second run finds the pane gone');
    assert.deepEqual(h.calls.destroySession, ['t1']);
  } finally { h.destroy(); }
});

test('with stopSession set, an agent pane stops its processes too (#347)', async () => {
  const h = setupPanesDom();
  try {
    const paneId = await paneWith(h, ['a1'], { tabCloseBehavior: 'stopSession' });
    await h.panes.closePane(paneId);
    await h.settle();
    assert.deepEqual(h.calls.stopSession, ['a1']);
    assert.match(h.calls.dialogs[0].message, /stops one running process/);
  } finally { h.destroy(); }
});

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

// --- #352: the smaller findings ----------------------------------------------

test('the focused pane survives a reload, instead of resetting to pane 1 (#352)', async () => {
  const h = setupPanesDom();
  try {
    await twoPanes(h);
    const focused = h.document.querySelector('.pane.pane-active').dataset.paneId;
    assert.notEqual(focused, 'pane-1', 'the split moved focus off the first pane');
    h.disable();                        // writes tree + active leaf
    const tree = h.rawStored();
    const active = h.window.localStorage.getItem('paneActiveLeaf');
    assert.equal(active, focused);

    // A fresh window with the same storage — what a reload is.
    const h2 = setupPanesDom({ storedTree: tree });
    try {
      h2.window.localStorage.setItem('paneActiveLeaf', active);
      h2.mount('a'); h2.mount('b');
      h2.enable();
      await h2.settle();
      assert.equal(h2.document.querySelector('.pane.pane-active').dataset.paneId, focused);
    } finally { h2.destroy(); }
  } finally { h.destroy(); }
});

test('a stored active pane that is not in the tree falls back to the first (#352)', async () => {
  const h = setupPanesDom();
  try {
    h.window.localStorage.setItem('paneActiveLeaf', 'pane-does-not-exist');
    h.mount('a');
    h.enable();
    await h.settle();
    assert.equal(h.document.querySelectorAll('.pane.pane-active').length, 1);
  } finally { h.destroy(); }
});

test('a detached window does not adopt the main window\'s focused pane (#352)', async () => {
  const h = setupPanesDom({ detached: true, detachedSessionId: 's1' });
  try {
    h.window.localStorage.setItem('paneActiveLeaf', 'pane-7');
    h.mount('s1');
    h.enable();
    await h.settle();
    assert.equal(h.document.querySelector('.pane.pane-active').dataset.paneId, 'pane-1');
    assert.equal(h.window.localStorage.getItem('paneActiveLeaf'), 'pane-7', 'and did not write over it');
  } finally { h.destroy(); }
});

test('several resize events in one frame produce one fit pass (#352)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.enable();
    await h.settle();
    h.calls.safeFit.length = 0;
    for (let i = 0; i < 8; i++) h.window.dispatchEvent(new h.window.Event('resize'));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(h.calls.safeFit.length, 1, `eight resize events, one fit — got ${h.calls.safeFit.length}`);
  } finally { h.destroy(); }
});

test('dropping a dormant tab settles the view like every other close does (#352)', async () => {
  const h = setupPanesDom({
    storedTree: JSON.stringify({
      type: 'leaf', id: 'pane-1', size: 1, activeTabId: 'term:gone',
      tabs: [{ id: 'term:gone', kind: 'terminal', ref: 'gone' }],
    }),
  });
  try {
    h.sessionMap.set('gone', { sessionId: 'gone', name: 'gone' });  // known, not mounted
    h.enable();
    await h.settle();
    const tab = h.document.querySelector('.session-tab[data-session-id="gone"]');
    assert.ok(tab, 'the dormant tab is there');
    h.calls.clearActiveTerminalView = 0;
    tab.querySelector('.session-tab-close').click();
    await h.settle();
    assert.equal(h.document.querySelector('.session-tab[data-session-id="gone"]'), null);
    assert.equal(h.calls.clearActiveTerminalView, 1, 'the main area was settled rather than left as it was');
  } finally { h.destroy(); }
});

test('the status patch ignores view tabs (#352)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('s1');
    h.enable();
    await h.settle();
    h.panes.openViewTab('jsonl', { nearSessionId: 's1' });
    await h.settle();
    assert.ok(h.document.querySelector('.session-tab-view'), 'a view tab is in the strip');
    const asked = [];
    const realGet = h.sessionMap.get.bind(h.sessionMap);
    h.sessionMap.get = (k) => { asked.push(k); return realGet(k); };
    h.panes.patchStatuses();
    assert.ok(!asked.includes(undefined), `no lookup for an absent id, got ${JSON.stringify(asked)}`);
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

// A signature of the whole arrangement: which panes exist, what they hold, and their shares. Zoom is
// a view state, so all of it has to come back byte-identical.
const layoutSignature = (h) => [...h.document.querySelectorAll('.pane')].map((p) => [
  p.dataset.paneId,
  [...p.querySelectorAll('.session-tab')].map((t) => t.dataset.tabId).join(','),
  p.style.flex,
].join('|')).join(' / ');

// Two panes side by side, one session each.
async function twoPanes(h) {
  h.mount('a');
  h.enable();
  await h.settle();
  h.panes.splitActivePane('right');
  await h.open('b');
}

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

// --- #345: a sash drag must never strand `pane-sashing` on <body> ------------

// Two panes side by side with a sash between them, and the gesture started on that sash.
async function startDrag(h) {
  h.mount('s1');
  h.mount('s2');
  h.enable();
  await h.settle();
  h.panes.splitActivePane('right');
  h.panes.show('s2');
  await h.settle();
  const sash = h.document.querySelector('.pane-sash');
  assert.ok(sash, 'a split produced a sash to drag');
  h.pointer(sash, 'pointerdown', { x: 500, y: 400 });
  assert.equal(h.document.body.classList.contains('pane-sashing'), true, 'the drag is running');
  return sash;
}

test('a rebuild during a sash drag does not leave the terminal area dead (#345)', async () => {
  const h = setupPanesDom();
  try {
    const sash = await startDrag(h);
    h.pointer(h.window, 'pointermove', { x: 400, y: 400 });
    // What actually happens in daily use: a background session ends and its tab auto-closes, which
    // rebuilds the tree and takes the sash with it.
    h.window.destroySession('s1');
    await h.settle();
    assert.equal(sash.isConnected, false, 'the rebuild destroyed the sash mid-gesture');
    assert.equal(h.document.body.classList.contains('pane-sashing'), false,
      'the gesture ended with the sash instead of stranding the class');
    // And the pointerup that arrives afterwards, on an element that no longer exists, changes
    // nothing — the ender is idempotent.
    h.pointer(h.window, 'pointerup', { x: 400, y: 400 });
    assert.equal(h.document.body.classList.contains('pane-sashing'), false);
  } finally { h.destroy(); }
});

test('an ordinary sash drag still ends on pointerup and commits its size (#345)', async () => {
  const h = setupPanesDom();
  try {
    await startDrag(h);
    h.pointer(h.window, 'pointermove', { x: 300, y: 400 });
    h.pointer(h.window, 'pointerup', { x: 300, y: 400 });
    assert.equal(h.document.body.classList.contains('pane-sashing'), false);
    // The drag moved the boundary left, so the first pane must have ended up smaller than half.
    h.disable();
    const stored = h.readStored();
    assert.equal(stored.type, 'branch');
    assert.ok(stored.children[0].size < 0.5, `first pane shrank (was ${stored.children[0].size})`);
  } finally { h.destroy(); }
});

test('pointercancel ends a sash drag the same way pointerup does (#345)', async () => {
  const h = setupPanesDom();
  try {
    await startDrag(h);
    h.pointer(h.window, 'pointermove', { x: 400, y: 400 });
    h.pointer(h.window, 'pointercancel', { x: 400, y: 400 });
    assert.equal(h.document.body.classList.contains('pane-sashing'), false);
  } finally { h.destroy(); }
});

test('losing the pointer capture ends a sash drag (#345)', async () => {
  const h = setupPanesDom();
  try {
    await startDrag(h);
    h.pointer(h.window, 'lostpointercapture', {});
    assert.equal(h.document.body.classList.contains('pane-sashing'), false);
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
