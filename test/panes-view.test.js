// DOM coverage for src/renderer/views/panes-view.js — the file that renders display mode `panes`.
//
// It had none before #343-#346: `npm test` loaded pane-tree.js and nothing else in this mode, which
// is why three defects with lasting damage sat in it behind a green suite.
//
// This file is one quarter of that coverage, split off by subject (#630): the LAYOUT — the harness
// itself, switching the mode on and off, the detached window that must not write the layout,
// closing a pane, the sashes, the sizes, the keyboard move mode, undo and saved layouts, the
// retired tabs mode arriving here, and the smaller findings of #352 that belong to none of the
// other three. The other
// three are test/panes-view-tabs.test.js (the tab strip), test/panes-view-views.test.js (hosted
// views, the empty pane, selection) and test/panes-view-drag.test.js (drag and drop). The split is
// mechanical: the harness builds a fresh jsdom per test, so 206 of them in one file ran 13-20 s
// alone and 41 s under the suite's own concurrency, and node's runner parallelises across files
// rather than within one.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  setupPanesDom, paneWith, twoPanes, startDrag, menuItem,
} = require('./helpers/panes-dom');

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

// --- #369: a mode switch carries the open sessions across, in order ---
//
// Coming out of grid the tabs should read the way the cards did. `openSessions` is mount order, which
// is a different list the moment anything was opened out of sidebar order — so the switch hands the
// order in and the adoption uses it once.

test('#369: arriving sessions become tabs in the order the switch names', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.mount('b');
    h.mount('c');
    h.panes.applySettings({ sessionDisplayMode: 'panes' }, { adoptOrder: ['c', 'a', 'b'] });
    await h.settle();
    const tabs = [...h.document.querySelectorAll('#terminals .session-tab')].map((t) => t.dataset.tabId);
    assert.deepEqual(tabs, ['term:c', 'term:a', 'term:b']);
    assert.equal(h.document.querySelectorAll('#terminals .pane').length, 1, 'and all in ONE pane');
  } finally { h.destroy(); }
});

test('#369: a session the order does not name still arrives, at the end', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.mount('b');
    // 'b' was mounted after the order was captured — dropping it would lose a live session.
    h.panes.applySettings({ sessionDisplayMode: 'panes' }, { adoptOrder: ['a'] });
    await h.settle();
    const tabs = [...h.document.querySelectorAll('#terminals .session-tab')].map((t) => t.dataset.tabId);
    assert.deepEqual(tabs, ['term:a', 'term:b']);
  } finally { h.destroy(); }
});

test('#369: an order naming a session that is gone does not strand the rest', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.panes.applySettings({ sessionDisplayMode: 'panes' }, { adoptOrder: ['ghost', 'a'] });
    await h.settle();
    const tabs = [...h.document.querySelectorAll('#terminals .session-tab')].map((t) => t.dataset.tabId);
    assert.deepEqual(tabs, ['term:a']);
  } finally { h.destroy(); }
});

test('#369: the order is spent by one switch and does not reorder later adoptions', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.mount('b');
    h.panes.applySettings({ sessionDisplayMode: 'panes' }, { adoptOrder: ['b', 'a'] });
    await h.settle();
    assert.deepEqual(
      [...h.document.querySelectorAll('#terminals .session-tab')].map((t) => t.dataset.tabId),
      ['term:b', 'term:a'],
    );
    // A session mounted afterwards lands where a mount always lands, not back through the old order.
    await h.open('c');
    await h.settle();
    const tabs = [...h.document.querySelectorAll('#terminals .session-tab')].map((t) => t.dataset.tabId);
    assert.equal(tabs.length, 3);
    assert.equal(tabs[0], 'term:b', 'the switch order is not re-applied');
  } finally { h.destroy(); }
});

test('#379: a window with no session of its own starts with no tab', async () => {
  // A window opened on a VIEW, or one the last run left behind, has no session (#370). Building the
  // opening tab from that `null` made a real tab — nameless, nothing behind it, and saved into the
  // layout so a restore made it again.
  const h = setupPanesDom({ detached: true });
  try {
    h.enable();
    await h.settle();
    assert.equal(h.document.querySelectorAll('#terminals .session-tab').length, 0);
  } finally { h.destroy(); }
});

test('#379: a view opened in such a window is its only tab', async () => {
  const h = setupPanesDom({ detached: true });
  try {
    h.enable();
    await h.settle();
    h.panes.openViewTab('stats', { ref: null, load: false });
    await h.settle();
    const tabs = [...h.document.querySelectorAll('#terminals .session-tab')].map((t) => t.dataset.tabId);
    assert.deepEqual(tabs, ['view:stats']);
  } finally { h.destroy(); }
});

test('#379: a window detached WITH a session still opens on its tab', async () => {
  const h = setupPanesDom({ detached: true, detachedSessionId: 's1' });
  try {
    h.mount('s1');
    h.enable();
    await h.settle();
    const tabs = [...h.document.querySelectorAll('#terminals .session-tab')].map((t) => t.dataset.tabId);
    assert.deepEqual(tabs, ['term:s1']);
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

test('a visible terminal is refitted even when the window never paints a frame (#355)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.enable();
    await h.settle();
    // An occluded or minimised window gets no `requestAnimationFrame` at all — measured with
    // `document.hidden === true`, a pane zoomed to a 1043 px box kept its terminal at 8 columns
    // indefinitely. Take rAF away entirely and the fit must still land.
    h.window.requestAnimationFrame = () => 0;
    h.calls.safeFit.length = 0;
    h.window.dispatchEvent(new h.window.Event('resize'));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(h.calls.safeFit.length, 1, 'the fit ran on the timer instead of the frame');
  } finally { h.destroy(); }
});

test('the coalescing still holds when the frame never comes (#355)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.enable();
    await h.settle();
    h.window.requestAnimationFrame = () => 0;
    h.calls.safeFit.length = 0;
    for (let i = 0; i < 8; i++) h.window.dispatchEvent(new h.window.Event('resize'));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(h.calls.safeFit.length, 1, `eight resizes, one fit — got ${h.calls.safeFit.length}`);
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

// --- #345: a sash drag must never strand `pane-sashing` on <body> ------------

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

// --- #352: resetting the sizes ----------------------------------------------

// The share each pane got, read off the DOM the way the user sees it (`buildNode` writes
// `flex: <size> 1 0`). Reading localStorage instead would mean waiting out the persist debounce.
const paneShares = (h) => [...h.document.querySelectorAll('.pane')].map((p) => p.style.flexGrow);

test('double-clicking a sash resets its branch, like Home does (#352)', async () => {
  const h = setupPanesDom();
  try {
    await twoPanes(h);
    // Drag it off centre first — there is nothing to reset from an even layout.
    h.pointer(h.document.querySelector('.pane-sash'), 'pointerdown', { x: 500, y: 300 });
    h.pointer(h.window, 'pointermove', { x: 300, y: 300 });
    h.pointer(h.window, 'pointerup', { x: 300, y: 300 });
    await h.settle();
    const moved = paneShares(h);
    assert.notEqual(moved[0], moved[1], `the drag moved the boundary (${moved.join(' / ')})`);

    h.document.querySelector('.pane-sash')
      .dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await h.settle();
    assert.equal(h.document.querySelectorAll('.pane').length, 2, 'both panes are still there');
    assert.deepEqual(paneShares(h), ['0.5', '0.5']);
    h.disable();
    assert.deepEqual(h.readStored().children.map((c) => c.size), [0.5, 0.5], 'and it was persisted');
  } finally { h.destroy(); }
});

test('"Distribute evenly" evens the whole tree from the pane menu (#352)', async () => {
  const h = setupPanesDom();
  try {
    await twoPanes(h);
    h.panes.splitActivePane('down'); // a nested branch, so "the whole tree" means something
    await h.settle();
    h.pointer(h.document.querySelector('.pane-sash'), 'pointerdown', { x: 500, y: 300 });
    h.pointer(h.window, 'pointermove', { x: 300, y: 300 });
    h.pointer(h.window, 'pointerup', { x: 300, y: 300 });
    await h.settle();
    assert.notEqual(paneShares(h)[0], '0.5');

    h.document.querySelector('.pane.pane-active .pane-more-btn').click();
    await h.settle();
    menuItem(h, 'Distribute evenly').click();
    await h.settle();

    h.disable();
    const stored = h.readStored();
    assert.deepEqual(stored.children.map((c) => c.size), [0.5, 0.5]);
    const nested = stored.children.find((c) => c.type === 'branch');
    assert.deepEqual(nested.children.map((c) => c.size), [0.5, 0.5], 'the nested branch too');
  } finally { h.destroy(); }
});

test('"Distribute evenly" is disabled while there is only one pane (#352)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.document.querySelector('.pane-more-btn').click();
    await h.settle();
    assert.equal(menuItem(h, 'Distribute evenly').disabled, true);
  } finally { h.destroy(); }
});

// --- #352: undo, and saved layouts -------------------------------------------

const paneIds = (h) => [...h.document.querySelectorAll('.pane')].map((p) => p.dataset.paneId);

test('undo puts back the arrangement a split changed (#352)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    const before = paneIds(h);
    h.panes.splitActivePane('right');
    await h.settle();
    assert.equal(paneIds(h).length, 2);

    assert.equal(h.panes.undoLayout(), true);
    await h.settle();
    assert.deepEqual(paneIds(h), before);
  } finally { h.destroy(); }
});

test('undo puts back a closed pane, and a resize, in order (#352)', async () => {
  const h = setupPanesDom();
  try {
    await twoPanes(h);
    h.pointer(h.document.querySelector('.pane-sash'), 'pointerdown', { x: 500, y: 300 });
    h.pointer(h.window, 'pointermove', { x: 300, y: 300 });
    h.pointer(h.window, 'pointerup', { x: 300, y: 300 });
    await h.settle();
    const resized = paneShares(h);
    assert.notEqual(resized[0], '0.5');

    await h.panes.closePane(paneIds(h)[1]);
    await h.settle();
    assert.equal(paneIds(h).length, 1, 'the pane went');

    h.panes.undoLayout();
    await h.settle();
    assert.equal(paneIds(h).length, 2, 'and came back');
    assert.deepEqual(paneShares(h), resized, 'at the size it had');

    h.panes.undoLayout();
    await h.settle();
    assert.deepEqual(paneShares(h), ['0.5', '0.5'], 'one more step undoes the resize');
  } finally { h.destroy(); }
});

test('undo does nothing with an empty stack, and says so in the menu (#352)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.panes.splitActivePane('right');
    await h.settle();
    h.document.querySelector('.pane.pane-active .pane-more-btn').click();
    await h.settle();
    assert.equal(menuItem(h, 'Undo layout change').disabled, false);

    assert.equal(h.panes.undoLayout(), true);
    assert.equal(h.panes.undoLayout(), false, 'nothing left to undo');
  } finally { h.destroy(); }
});

test('a saved layout comes back by name, and Shift-click deletes it (#352)', async () => {
  const h = setupPanesDom();
  try {
    await twoPanes(h);
    h.answers.confirm = 'Two panes'; // the prompt resolves with the text, not a boolean

    h.document.querySelector('.pane.pane-active .pane-more-btn').click();
    await h.settle();
    menuItem(h, 'Save layout…').click();
    await h.settle();
    assert.equal(h.calls.dialogs[0].prompt.placeholder, 'Layout name');

    // Collapse to one pane, then restore the saved arrangement.
    await h.panes.closePane(paneIds(h)[1]);
    await h.settle();
    assert.equal(paneIds(h).length, 1);

    h.document.querySelector('.pane.pane-active .pane-more-btn').click();
    await h.settle();
    const restore = menuItem(h, 'Restore “Two panes”');
    assert.ok(restore, 'the saved layout is in the menu');
    restore.click();
    await h.settle();
    assert.equal(paneIds(h).length, 2, 'the arrangement is back');

    // Shift-click is the delete. A second listener could not do this — listeners on one element run
    // in registration order whatever their phase — so the entry's own handler reads the modifier.
    h.document.querySelector('.pane.pane-active .pane-more-btn').click();
    await h.settle();
    menuItem(h, 'Restore “Two panes”')
      .dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
    await h.settle();

    h.document.querySelector('.pane.pane-active .pane-more-btn').click();
    await h.settle();
    assert.equal(menuItem(h, 'Restore “Two panes”'), undefined, 'gone from the menu');
  } finally { h.destroy(); }
});

test('a detached window never writes a saved layout (#352, #344)', async () => {
  const h = setupPanesDom({ detached: true, detachedSessionId: 'a' });
  try {
    h.enable();
    await h.open('a');
    h.answers.confirm = 'From a detached window';
    h.document.querySelector('.pane-more-btn').click();
    await h.settle();
    menuItem(h, 'Save layout…')?.click();
    await h.settle();
    // It shares this origin's localStorage with the main window and owns no arrangement — the same
    // rule the tree itself follows.
    assert.equal(h.window.localStorage.getItem('panePresets'), null);
  } finally { h.destroy(); }
});

// --- #356: the keyboard move mode --------------------------------------------

// Two panes side by side WITH geometry: `neighbourPaneId` reads bounding rectangles, and jsdom has
// none, so a move mode test without these would find no neighbour in any direction.
async function twoPanesWithBoxes(h) {
  await twoPanes(h);
  const panes = [...h.document.querySelectorAll('.pane')];
  const boxes = [
    { left: 0, top: 0, width: 500, height: 800 },
    { left: 500, top: 0, width: 500, height: 800 },
  ];
  panes.forEach((pane, i) => {
    const box = boxes[i];
    pane.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height });
  });
  return panes;
}

test('move mode needs a second pane, and says so (#356)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    assert.equal(h.panes.enterTabMoveMode(), false, 'one pane, nowhere to move to');
    assert.equal(h.panes.isTabMoveModeActive(), false);
  } finally { h.destroy(); }
});

test('move mode marks its pane and moves the active tab (#356)', async () => {
  const h = setupPanesDom();
  try {
    await twoPanesWithBoxes(h); // 'a' in pane-1, 'b' in pane-2, side by side
    h.panes.focusPaneByIndex(1);
    await h.settle();

    assert.equal(h.panes.enterTabMoveMode(), true);
    assert.equal(h.panes.isTabMoveModeActive(), true);
    assert.ok(h.document.querySelector('.pane.pane-move-mode'), 'the pane says it is in the mode');

    assert.equal(h.panes.moveTabInDirection('right'), true);
    await h.settle();
    // 'a' followed the move into pane-2, and pane-1 collapsed with its last tab (#309 O10).
    const panes = [...h.document.querySelectorAll('.pane')];
    assert.equal(panes.length, 1);
    assert.deepEqual(
      [...panes[0].querySelectorAll('.session-tab[data-session-id]')].map((t) => t.dataset.sessionId).sort(),
      ['a', 'b']);
    // Nothing left to move between, so the mode ended itself rather than running with no target.
    assert.equal(h.panes.isTabMoveModeActive(), false);
  } finally { h.destroy(); }
});

test('a direction with no pane in it moves nothing (#356)', async () => {
  const h = setupPanesDom();
  try {
    await twoPanesWithBoxes(h);
    h.panes.focusPaneByIndex(1);
    h.panes.enterTabMoveMode();
    await h.settle();

    assert.equal(h.panes.moveTabInDirection('up'), false, 'nothing above in a row layout');
    await h.settle();
    assert.equal(h.document.querySelectorAll('.pane').length, 2, 'the layout is untouched');
    assert.equal(h.panes.isTabMoveModeActive(), true, 'and the mode is still running');
  } finally { h.destroy(); }
});

test('a move made by the mode is undoable (#356)', async () => {
  const h = setupPanesDom();
  try {
    await twoPanesWithBoxes(h);
    h.panes.focusPaneByIndex(1);
    h.panes.enterTabMoveMode();
    h.panes.moveTabInDirection('right');
    await h.settle();
    assert.equal(h.document.querySelectorAll('.pane').length, 1);

    h.panes.undoLayout();
    await h.settle();
    assert.equal(h.document.querySelectorAll('.pane').length, 2, 'both panes are back');
  } finally { h.destroy(); }
});

test('the mode survives a rebuild, and keeps its marker (#356)', async () => {
  const h = setupPanesDom();
  try {
    await twoPanesWithBoxes(h);
    h.panes.focusPaneByIndex(1);
    h.panes.enterTabMoveMode();
    await h.settle();
    const marked = h.document.querySelector('.pane.pane-move-mode').dataset.paneId;

    // This mode renders constantly — a status tick, a session adopted, a settings change — and a
    // rebuild throws the marker class away. Driven in the running app, a mode that ended on any
    // render was over before the first arrow key: it has to survive one instead.
    h.panes.render();
    await h.settle();
    assert.equal(h.panes.isTabMoveModeActive(), true, 'still running');
    assert.equal(h.document.querySelector('.pane.pane-move-mode').dataset.paneId, marked,
      'and the marker came back on the same pane');
  } finally { h.destroy(); }
});

test('leaving panes mode leaves the move mode too (#356)', async () => {
  const h = setupPanesDom();
  try {
    await twoPanesWithBoxes(h);
    h.panes.focusPaneByIndex(1);
    h.panes.enterTabMoveMode();
    await h.settle();
    h.disable();
    assert.equal(h.panes.isTabMoveModeActive(), false, 'the panes it was navigating are gone');
  } finally { h.destroy(); }
});

// --- #357: the retired tabs mode arrives here ---

test('a stored tabs mode turns panes on, in one pane (#357)', async () => {
  const h = setupPanesDom();
  try {
    // The migration is a resolve on read, so nothing rewrote this value: an install that never opens
    // settings still has 'tabs' in its database and has to land in panes, NOT fall through to grid.
    // The unit test covers the resolver; this covers the wiring it sits in.
    h.panes.applySettings({ sessionDisplayMode: 'tabs' });
    await h.settle();
    assert.equal(h.panes.active(), true);
    assert.equal(h.document.body.classList.contains('display-mode-panes'), true);
    assert.equal(h.document.body.classList.contains('display-mode-tabs'), false,
      'nothing sets that class any more — the mode it belonged to is gone');

    await h.open('live-1');
    await h.settle();
    // One pane is what tabs mode rendered, so that is what the upgrade has to produce.
    assert.equal(h.document.querySelectorAll('.pane').length, 1);
    assert.deepEqual([...h.panes.sessionIdsInLayout()], ['live-1']);
  } finally { h.destroy(); }
});
