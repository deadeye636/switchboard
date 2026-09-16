// DOM coverage for src/renderer/views/panes-view.js — the file that renders display mode `panes`.
//
// It had none before #343-#346: `npm test` loaded pane-tree.js and nothing else in this mode, which
// is why three defects with lasting damage sat in it behind a green suite.
//
// This file is one quarter of that coverage, split off by subject (#630): DRAGGING AND DROPPING —
// a tab dragged out into a window of its own, a tab dropped onto another Switchboard window, a
// session dragged out of the sidebar, the drop zones, what this window answers about a drag it is
// not part of, and the landing it cannot name — plus the pane menu, which moves a whole pane the
// same places a drag does. The other three are test/panes-view.test.js (the layout),
// test/panes-view-tabs.test.js (the tab strip) and test/panes-view-views.test.js (hosted views).
// The split is mechanical: the harness builds a fresh jsdom per test, so 206 of them in one file
// ran 13-20 s alone and 41 s under the suite's own concurrency, and node's runner parallelises
// across files rather than within one.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  setupPanesDom, stubWindowItems, menuGroups, menuItem, dragEndAt, windowBox, stubPaneGeometry,
} = require('./helpers/panes-dom');

// --- #340: the pane menu's two subjects, and moving a whole pane -------------

// Both halves of the move as the renderer sees them: `detachSession` makes the window and answers
// with its id, `moveSessionToWindow` sends the rest after it. Recorded rather than performed — what
// panes-view owes is the sequence, and the handover itself is detach-window.js's (and main's).
function stubWindowMoves(h, { windowId = '7', detachOk = true, moveOk = true } = {}) {
  const calls = { detached: [], moved: [] };
  h.window.detachSession = async (sessionId) => {
    calls.detached.push(sessionId);
    return detachOk ? windowId : null;
  };
  h.window.moveSessionToWindow = async (sessionId, target) => {
    calls.moved.push([sessionId, target]);
    return moveOk;
  };
  return calls;
}

const menuItems = (h) => [...h.document.querySelectorAll('.session-tab-menu-item')].map((b) => b.textContent);

test('the pane menu says which subject each group acts on (#340)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a', { name: 'Auth refactor' });
    stubWindowItems(h);
    h.document.querySelector('.pane-more-btn').click();
    await h.settle();

    assert.deepEqual(menuGroups(h), ['Pane', 'Session · Auth refactor'],
      'two headings, and the session one names the session it means');
    // The order is what makes the headings mean anything: everything under "Pane" acts on the pane.
    const items = menuItems(h);
    assert.deepEqual(items.slice(0, 5),
      ['Split right', 'Split down', 'Distribute evenly', 'Move pane to new window', 'Close pane']);
    assert.ok(items.indexOf('Move to new window') > items.indexOf('Close pane'),
      'the session block comes after the pane block, under its own heading');
  } finally { h.destroy(); }
});

test('a pane with nothing that can travel offers no session group at all (#340)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.panes.splitActivePane('right'); // the new pane starts empty
    await h.settle();
    stubWindowItems(h);
    h.document.querySelector('.pane.pane-active .pane-more-btn').click();
    await h.settle();

    // "Layout" is there because a second pane exists — but no "Session", which is the point.
    assert.deepEqual(menuGroups(h), ['Pane', 'Layout'], 'no session, so no session heading');
    assert.equal(menuItem(h, 'Move pane to new window').disabled, true,
      'and the pane move says so by being disabled rather than doing nothing');
    assert.equal(menuItems(h).includes('Move to new window'), false);
  } finally { h.destroy(); }
});

test('moving a pane takes every session in it — the first makes the window, the rest follow (#340)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    await h.open('b');
    await h.open('c');
    const calls = stubWindowMoves(h, { windowId: '7' });

    h.document.querySelector('.pane-more-btn').click();
    await h.settle();
    menuItem(h, 'Move pane to new window').click();
    await h.settle();

    assert.deepEqual(calls.detached, ['a'], 'the first tab is what creates the window');
    assert.deepEqual(calls.moved, [['b', '7'], ['c', '7']], 'and the rest go to the window it answered with');
    assert.deepEqual(h.calls.dialogs, [], 'nothing was left behind, so nothing had to be asked');
  } finally { h.destroy(); }
});

test('a pane holding a view tab moves the view too, and asks nothing (#340, #364)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    await h.open('b');
    // A kind that may travel: singleton and it names a loader. Messages does not — it is per-session,
    // so a zero-argument loader cannot say what it should show.
    h.panes.openViewTab('memory', { nearSessionId: 'a' });
    await h.settle();
    const calls = stubWindowMoves(h);
    const views = [];
    h.window.api.openViewInWindow = (...args) => { views.push(args); return Promise.resolve({ ok: true }); };

    h.document.querySelector('.pane-more-btn').click();
    await h.settle();
    menuItem(h, 'Move pane to new window').click();
    await h.settle();
    await h.settle();

    // #364 made a view travel. Nothing is left behind any more, so there is nothing to warn about —
    // the question existed only to name what could not come along.
    assert.equal(h.calls.dialogs.length, 0, 'nothing stays, so nothing is asked');
    assert.deepEqual(calls.detached, ['a']);
    assert.deepEqual(calls.moved, [['b', '7']]);
    assert.equal(views.length, 1, 'the view followed the sessions');
    assert.equal(views[0][1], 'memory');
    assert.equal(views[0][0], '7', 'into the window the first session made');
    assert.equal(h.panes.hasViewTab('memory'), false, 'and this window let go of it');
  } finally { h.destroy(); }
});

test('a pane that would leave something behind still asks first (#340)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.panes.openViewTab('jsonl', { nearSessionId: 'a' });
    await h.settle();
    const calls = stubWindowMoves(h);
    h.answers.confirm = false;
    // A view travels since #364, so make one that must NOT: a diff owes the CLI an answer only this
    // renderer can give (spec 16 §4.3), so it stays and is named before anything moves.
    h.panes.openViewTab('diff', { ref: 'diff-1' });
    await h.settle();
    h.window.api.openViewInWindow = () => Promise.resolve({ ok: true });

    h.document.querySelector('.pane-more-btn').click();
    await h.settle();
    menuItem(h, 'Move pane to new window').click();
    await h.settle();

    assert.deepEqual(calls.detached, [], 'a cancel is a real cancel — the question comes before anything runs');
    assert.deepEqual(calls.moved, []);
  } finally { h.destroy(); }
});

test('a refused detach moves none of the sessions after it (#340)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    await h.open('b');
    const calls = stubWindowMoves(h, { detachOk: false });

    h.document.querySelector('.pane-more-btn').click();
    await h.settle();
    menuItem(h, 'Move pane to new window').click();
    await h.settle();

    assert.deepEqual(calls.detached, ['a']);
    assert.deepEqual(calls.moved, [], 'there is no window to send them to');
  } finally { h.destroy(); }
});

test('from a detached window the pane moves back to main, not into a third one (#340)', async () => {
  const h = setupPanesDom({ detached: true, detachedSessionId: 'a' });
  try {
    h.enable();
    await h.open('a');
    await h.open('b');
    const calls = stubWindowMoves(h);

    h.document.querySelector('.pane-more-btn').click();
    await h.settle();
    assert.equal(menuItem(h, 'Move pane to new window'), undefined);
    menuItem(h, 'Move pane to main window').click();
    await h.settle();

    // No detach: `detachSession` is the main window's half of the file, and main is already there.
    assert.deepEqual(calls.detached, []);
    assert.deepEqual(calls.moved, [['a', 'main'], ['b', 'main']]);
  } finally { h.destroy(); }
});

test('a view tab on top does not hide the pane\'s sessions from the … menu (#340)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a', { name: 'Auth refactor' });
    h.panes.openViewTab('jsonl'); // opening a view makes it the active tab
    await h.settle();
    stubWindowItems(h);

    h.document.querySelector('.pane-more-btn').click();
    await h.settle();
    // The `…` button's menu belongs to the PANE, so the session block is about what the pane holds —
    // not about whichever tab happens to be in front.
    assert.deepEqual(menuGroups(h), ['Pane', 'Session · Auth refactor']);

    // A right-click is the other case: it named a tab, and a view tab has no session to act on.
    h.document.querySelector('.pane-strip .session-tab-view')
      .dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await h.settle();
    assert.deepEqual(menuGroups(h), ['Pane'], 'the menu answers about the tab that was clicked');
  } finally { h.destroy(); }
});

test('a view tab on top survives the pane losing every session it had (#340)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.panes.openViewTab('jsonl');
    await h.settle();
    const clearsBefore = h.calls.clearActiveTerminalView;

    // What a pane move leaves behind: the sessions are rendered by another window now, so their tabs
    // are gone and nothing in this pane is live. The view tab the move promised to leave alone is on
    // top, and `clearActiveTerminalView` would hide the viewer behind it — which the watcher answers
    // by closing the tab. The pane would end up empty after a dialog said it would not.
    h.unmount('a');
    h.panes.dropSession('a');
    h.panes.showActiveOrPlaceholder();
    await h.settle();

    assert.equal(h.calls.clearActiveTerminalView, clearsBefore, 'nothing cleared the view that is on screen');
    assert.ok(h.panes.hasViewTab('jsonl'), 'and the tab is still there');
  } finally { h.destroy(); }
});

// --- #352: dragging a tab out into a window of its own -----------------------

async function draggableTab(h) {
  h.enable();
  await h.open('a');
  await h.open('b');
  windowBox(h);
  const tab = h.document.querySelector('.pane-strip .session-tab[data-session-id="a"]');
  const start = new h.window.MouseEvent('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(start, 'dataTransfer', { value: { setData() {}, types: [], effectAllowed: '' } });
  tab.dispatchEvent(start);
  return tab;
}

test('a tab dropped on the desktop asks for a window of its own (#352)', async () => {
  const h = setupPanesDom();
  try {
    const tab = await draggableTab(h);
    const detached = [];
    h.window.detachSession = (id) => { detached.push(id); };

    dragEndAt(h, tab, { screenX: 1400, screenY: 400 }); // past the right edge of the window box
    await h.settle(); // the tear-off asks main which window is there first (#360)
    assert.deepEqual(detached, ['a']);
  } finally { h.destroy(); }
});

test('a drop inside the window is not a tear-off (#352)', async () => {
  const h = setupPanesDom();
  try {
    const tab = await draggableTab(h);
    const detached = [];
    h.window.detachSession = (id) => { detached.push(id); };

    // `dropEffect: 'none'` is also what a drop on a non-target part of OUR window reports — without
    // the position check every mis-aimed drag would open a window.
    dragEndAt(h, tab, { screenX: 500, screenY: 400 });
    assert.deepEqual(detached, [], 'inside the box');

    // …and a position that cannot be trusted (0/0, which some platforms report) must not either.
    dragEndAt(h, tab, { screenX: 0, screenY: 0 });
    assert.deepEqual(detached, []);

    // A drop the layout DID take reports an effect, and that is the ordinary tab move.
    dragEndAt(h, tab, { screenX: 1400, screenY: 400, dropEffect: 'move' });
    assert.deepEqual(detached, []);
  } finally { h.destroy(); }
});

test('a view that cannot be filled elsewhere says so instead of vanishing (#352, #364)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.panes.openViewTab('jsonl');
    await h.settle();
    windowBox(h);
    const detached = [];
    h.window.detachSession = (id) => { detached.push(id); };

    const viewTab = h.document.querySelector('.pane-strip .session-tab-view');
    const start = new h.window.MouseEvent('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'dataTransfer', { value: { setData() {}, types: [], effectAllowed: '' } });
    viewTab.dispatchEvent(start);
    dragEndAt(h, viewTab, { screenX: 1400, screenY: 400 });
    await h.settle();

    assert.deepEqual(detached, [], 'a view is not a session and never detaches');
    assert.equal(h.calls.toasts.length, 1, 'and the drag ending nowhere is explained');
    // #364 let views travel — but only the ones a receiving window can fill. Messages is per-session,
    // so no zero-argument loader can say what it should show, and it stays.
    assert.match(h.calls.toasts[0].message, /cannot be filled in another window/);
    assert.ok(h.panes.hasViewTab('jsonl'), 'the tab is still there');
  } finally { h.destroy(); }
});

// #363 reversed this. It used to mean "back to the main window" when asked from a detached window,
// because `detachSession` was defined below detach-window.js's early return and did not exist there
// at all. One gesture then meant two different things depending on which window the drag started in,
// while the main window was already reachable by name from the tab's own menu. Now a drop on empty
// space means the same thing everywhere: a window of its own, at the point it was dropped.
test('from a detached window the gesture still means "a window of its own" (#363)', async () => {
  const h = setupPanesDom({ detached: true, detachedSessionId: 'a' });
  try {
    const tab = await draggableTab(h);
    const moved = [];
    const detached = [];
    h.window.moveSessionToWindow = (id, target) => { moved.push([id, target]); };
    h.window.detachSession = (id, at) => { detached.push([id, at]); };

    dragEndAt(h, tab, { screenX: 1400, screenY: 400 });
    await h.settle();
    assert.deepEqual(moved, [], 'the main window is the menu\'s job, not the gesture\'s');
    assert.equal(detached.length, 1);
    assert.equal(detached[0][0], 'a');
    // The drop point travels with it (#362), or the new window cannot open where it was dropped.
    // Field by field: the object comes from the jsdom realm, so its prototype is not this one's and
    // deepEqual refuses it even when the structure matches.
    assert.equal(detached[0][1].point.x, 1400);
    assert.equal(detached[0][1].point.y, 400);
  } finally { h.destroy(); }
});

// --- #360: dropping a tab onto another Switchboard window --------------------

test('a tab dropped on another Switchboard window moves into it (#360)', async () => {
  const h = setupPanesDom();
  try {
    const tab = await draggableTab(h);
    const detached = [];
    const moved = [];
    h.window.detachSession = (id) => { detached.push(id); };
    h.window.moveSessionToWindow = (id, target) => { moved.push([id, target]); };
    h.window.api.windowAtScreenPoint = async () => '4';

    dragEndAt(h, tab, { screenX: 1400, screenY: 400 });
    await h.settle();

    assert.deepEqual(moved, [['a', '4']], 'the same move the menu offers by name');
    assert.deepEqual(detached, [], 'no window of its own — it landed on one that exists');
  } finally { h.destroy(); }
});

test('a drop over nothing still detaches (#360)', async () => {
  const h = setupPanesDom();
  try {
    const tab = await draggableTab(h);
    const detached = [];
    h.window.detachSession = (id) => { detached.push(id); };
    h.window.api.windowAtScreenPoint = async () => null; // the desktop, or another application

    dragEndAt(h, tab, { screenX: 1400, screenY: 400 });
    await h.settle();
    assert.deepEqual(detached, ['a']);
  } finally { h.destroy(); }
});

test('a drop that cannot be resolved moves nothing (#360)', async () => {
  const h = setupPanesDom();
  try {
    const tab = await draggableTab(h);
    const detached = [];
    const moved = [];
    h.window.detachSession = (id) => { detached.push(id); };
    h.window.moveSessionToWindow = (id, target) => { moved.push([id, target]); };
    h.window.api.windowAtScreenPoint = async () => { throw new Error('older main process'); };

    dragEndAt(h, tab, { screenX: 1400, screenY: 400 });
    await h.settle();

    // A guess here is what moves a session somewhere the user did not aim at — the defect this fixes.
    assert.deepEqual(detached, []);
    assert.deepEqual(moved, []);
  } finally { h.destroy(); }
});

test('the point sent to main carries the box this renderer measured (#360)', async () => {
  const h = setupPanesDom();
  try {
    const tab = await draggableTab(h); // sets the window box to 0,0 1000×800
    const asked = [];
    h.window.api.windowAtScreenPoint = async (point, box) => { asked.push([point, box]); return null; };
    h.window.detachSession = () => {};

    dragEndAt(h, tab, { screenX: 1400, screenY: 400 });
    await h.settle();

    // Compared as JSON: these objects were built inside the jsdom realm, so their prototype is not
    // this one's and `deepEqual` fails on identical values.
    assert.equal(JSON.stringify(asked),
      JSON.stringify([[{ x: 1400, y: 400 }, { x: 0, y: 0, width: 1000, height: 800 }]]),
      'main converts the point against this same window\'s real bounds');
  } finally { h.destroy(); }
});

// --- #373: a session dragged out of the sidebar lands where it was dropped ------
//
// The drop is a tab move that happens to start outside the tree, so it has to land the way a tab
// move does — at a position, or by splitting a pane — rather than always in the active one.

test('#373: a running session dropped on a pane lands there and is attached to', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    // What a sidebar row is from the tree's side: a record, a live process, and no tab.
    h.sessionMap.set('from-sidebar', { sessionId: 'from-sidebar', name: 'From sidebar', type: 'agent' });
    h.activePtyIds.add('from-sidebar');

    assert.equal(h.panes.dropSessionInto('from-sidebar', 'pane-1', -1), true);
    await h.settle();

    assert.deepEqual([...h.document.querySelectorAll('.session-tab-label')].map((el) => el.textContent),
      ['live-1', 'From sidebar']);
    // Attached, not spawned: the session has a process and this is the ordinary open path.
    assert.deepEqual(h.calls.openSession.map((c) => c[0]), ['from-sidebar']);
  } finally { h.destroy(); }
});

test('#373: the drop position is the one the caret showed', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    await h.open('live-2');
    h.sessionMap.set('from-sidebar', { sessionId: 'from-sidebar', name: 'From sidebar', type: 'agent' });
    h.activePtyIds.add('from-sidebar');

    // Index 1: between the two, which is what a caret on the gap means.
    h.panes.dropSessionInto('from-sidebar', 'pane-1', 1);
    await h.settle();
    assert.deepEqual([...h.document.querySelectorAll('.session-tab-label')].map((el) => el.textContent),
      ['live-1', 'From sidebar', 'live-2'],
      'inserted at the index, not appended — a tab move places, and so does this');
  } finally { h.destroy(); }
});

test('#373: dropped on a pane edge, the pane splits and the session opens in the new one', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    h.sessionMap.set('from-sidebar', { sessionId: 'from-sidebar', name: 'From sidebar', type: 'agent' });
    h.activePtyIds.add('from-sidebar');

    assert.equal(h.panes.dropSessionIntoSplit('from-sidebar', 'pane-1', 'right'), true);
    await h.settle();

    assert.equal(h.document.querySelectorAll('#terminals .pane').length, 2, 'the pane split');
    const strips = [...h.document.querySelectorAll('#terminals .pane')]
      .map((p) => [...p.querySelectorAll('.session-tab-label')].map((el) => el.textContent));
    assert.deepEqual(strips, [['live-1'], ['From sidebar']],
      'the dropped session is alone in the new pane, and the old one keeps what it had');
  } finally { h.destroy(); }
});

test('#373: a session with no process arrives dormant, and the drop starts nothing', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    // A record and no process — the sidebar lists these exactly like the running ones.
    h.sessionMap.set('dorm-1', { sessionId: 'dorm-1', name: 'Dormant one', type: 'agent' });

    assert.equal(h.panes.dropSessionInto('dorm-1', 'pane-1', -1), true);
    await h.settle();

    const tab = [...h.document.querySelectorAll('.session-tab')]
      .find((el) => el.querySelector('.session-tab-label').textContent === 'Dormant one');
    assert.equal(tab.classList.contains('session-tab-dormant'), true);
    // The whole point: a drag is not a launch. The placeholder's button is where a CLI begins (#318).
    assert.deepEqual(h.calls.openSession, [], 'nothing was opened, so nothing was spawned');
    assert.equal(h.document.querySelectorAll('.pane-empty-launch').length, 1);
  } finally { h.destroy(); }
});

test('#373: a session already in the tree is MOVED, never mounted twice', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    await h.open('live-2');
    h.panes.splitActivePane('right');
    await h.settle();
    // From the DOM, not from storage: the layout write is debounced, so a stored read here still
    // describes the tree before the split.
    const panes = [...h.document.querySelectorAll('#terminals .pane')];
    const target = panes[panes.length - 1].dataset.paneId;
    h.calls.openSession.length = 0;

    h.panes.dropSessionInto('live-1', target, -1);
    await h.settle();

    // One tab for it, in the pane it was dropped on. Two would be two xterms on one PTY.
    const all = [...h.document.querySelectorAll('.session-tab-label')].map((el) => el.textContent);
    assert.equal(all.filter((t) => t === 'live-1').length, 1);
    const strips = [...h.document.querySelectorAll('#terminals .pane')]
      .map((p) => [...p.querySelectorAll('.session-tab-label')].map((el) => el.textContent));
    assert.deepEqual(strips[strips.length - 1], ['live-1'], 'it moved into the target pane');
    assert.deepEqual(h.calls.openSession, [], 'a move mounts nothing — it is already mounted');
  } finally { h.destroy(); }
});

test('#373: a session the window cannot name is refused rather than dropped blank', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    assert.equal(h.panes.dropSessionInto('ghost', 'pane-1', -1), false);
    await h.settle();
    assert.equal(h.document.querySelectorAll('.session-tab').length, 1);
  } finally { h.destroy(); }
});

// --- #376: the drop zones can be hit, and one of them addresses the whole area ---

test('#376: a pane\'s edge zone has a floor in pixels, so a narrow pane is still splittable', () => {
  const h = setupPanesDom();
  try {
    h.enable();
    // A tenth of a narrow pane is a strip too thin to aim at, and missing it MOVES the tab instead of
    // splitting — the wrong kind of wrong, because undoing it takes a second gesture.
    assert.equal(h.panes.edgeDepth(200), 30, 'the floor wins on a narrow pane');
    assert.equal(h.panes.edgeDepth(1200), 120, 'the ratio wins on a wide one');
    // …and never so much that the middle disappears: "move it into this pane" is the commoner intent.
    assert.equal(h.panes.edgeDepth(60), 60 * 0.32);
  } finally { h.destroy(); }
});

test('#376: a session dropped on the outer band lands in a pane across the whole area', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    await h.open('live-2');
    h.panes.splitActivePane('right');
    await h.settle();
    h.sessionMap.set('from-sidebar', { sessionId: 'from-sidebar', name: 'From sidebar', type: 'agent' });
    h.activePtyIds.add('from-sidebar');

    const panesBefore = h.document.querySelectorAll('#terminals .pane').length;
    assert.equal(h.panes.dropSessionIntoRootSplit('from-sidebar', 'down'), true);
    await h.settle();

    assert.equal(h.document.querySelectorAll('#terminals .pane').length, panesBefore + 1);
    // The point of the whole thing: the new pane is under BOTH, not under one column. The DOM says so
    // — the outermost box is a column now, and the row that was there is inside it.
    const layout = h.document.querySelector('#terminals').firstElementChild;
    assert.equal(layout.classList.contains('pane-col'), true,
      'the row was wrapped in a column, so the new pane spans it');
    assert.equal(layout.querySelector('.pane-row') !== null, true, 'and the row itself is intact');
  } finally { h.destroy(); }
});

test('#376: a session already open is MOVED into the new full-width pane, not mounted twice', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    await h.open('live-2');
    h.calls.openSession.length = 0;

    assert.equal(h.panes.dropSessionIntoRootSplit('live-1', 'down'), true);
    await h.settle();

    const strips = [...h.document.querySelectorAll('#terminals .pane')]
      .map((p) => [...p.querySelectorAll('.session-tab-label')].map((el) => el.textContent));
    assert.deepEqual(strips, [['live-2'], ['live-1']], 'it left the pane it was in and is alone below');
    assert.deepEqual(h.calls.openSession, [], 'a move mounts nothing');
  } finally { h.destroy(); }
});

// --- #375: what this window answers about a drag it is not part of -----------
//
// The far window is the only thing that knows where its panes are, so this is the whole of the
// cross-window feature on the receiving side: the answer it gives IS what the drop will do.

test('#375: a point in the middle of a pane body answers "into this pane"', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    stubPaneGeometry(h);
    // Spread first: the answer is built inside the jsdom context, so its prototype is that context's
    // and `deepEqual` compares those too (#364's lesson, in the handoff notes).
    assert.deepEqual({ ...h.panes.dropTargetAt(400, 300) }, { kind: 'tab', leafId: 'pane-1', index: -1 });
  } finally { h.destroy(); }
});

test('#375: a point near a pane edge answers "split it there"', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    stubPaneGeometry(h);
    // Inside the pane's own edge zone (800 * 0.1 = 80) but past the area's outer band (36).
    assert.deepEqual({ ...h.panes.dropTargetAt(60, 300) }, { kind: 'split', leafId: 'pane-1', zone: 'left' });
  } finally { h.destroy(); }
});

test('#375: a point in the outer band answers "across the whole area"', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    stubPaneGeometry(h);
    assert.deepEqual({ ...h.panes.dropTargetAt(10, 300) }, { kind: 'root', zone: 'left' });
  } finally { h.destroy(); }
});

test('#375: a point over nothing answers null, so the caller has no pane to invent', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    stubPaneGeometry(h);
    // Past the area entirely: over the window chrome, or off the window. Null is what stops the
    // caller placing a session in a pane nobody highlighted.
    assert.equal(h.panes.dropTargetAt(-500, -500), null);
  } finally { h.destroy(); }
});

test('#375: the placement a drop produces is the one that was answered', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    h.sessionMap.set('arriving', { sessionId: 'arriving', name: 'Arriving', type: 'agent' });

    // `mount: false` is what the adopt passes: the tab is made here, the terminal attached by the
    // caller. Two mounts for one arrival would be two xterms racing for one PTY.
    assert.equal(h.panes.applyPlacement('arriving', { kind: 'split', leafId: 'pane-1', zone: 'right' },
      { mount: false }), true);
    await h.settle();

    assert.equal(h.document.querySelectorAll('#terminals .pane').length, 2);
    assert.deepEqual(h.calls.openSession, [], 'the adopt mounts it, not the placement');
  } finally { h.destroy(); }
});

test('#375: a placement naming a pane that is gone reports FAILURE, not a silent nothing', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    h.sessionMap.set('arriving', { sessionId: 'arriving', name: 'Arriving', type: 'agent' });

    // The layout can change between the answer and the drop — that is what an async round trip
    // through a second renderer buys. `addTab` answers a leaf it cannot find by returning the tree
    // unchanged, and a caller told "placed" about that would believe a session had arrived that is
    // nowhere. The adopt reads this `false` and falls back to its own mount.
    assert.equal(h.panes.applyPlacement('arriving', { kind: 'tab', leafId: 'pane-does-not-exist', index: -1 },
      { mount: false }), false);
    await h.settle();
    assert.equal(h.document.querySelectorAll('.session-tab').length, 1, 'and nothing was added anywhere');
  } finally { h.destroy(); }
});

test('#375: a strip placement draws the caret, not a generic pane highlight', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    await h.open('live-2');

    h.panes.showPlacementHint({ kind: 'tab', leafId: 'pane-1', index: 1 });
    assert.equal(h.document.querySelectorAll('.pane-tab-caret').length, 1,
      'the far window shows the gap, the way a local drag does');
    assert.equal(h.document.querySelectorAll('.pane-drop-hint').length, 0);

    // …and a placement with no position is the pane highlight, which is the other statement.
    h.panes.showPlacementHint({ kind: 'tab', leafId: 'pane-1', index: -1 });
    assert.equal(h.document.querySelectorAll('.pane-drop-hint').length, 1);
    assert.equal(h.document.querySelectorAll('.pane-tab-caret').length, 0);
  } finally { h.destroy(); }
});

test('#375: a hint for a pane that is gone leaves nothing drawn', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    h.panes.showPlacementHint({ kind: 'split', leafId: 'pane-gone', zone: 'left' });
    assert.equal(h.document.querySelectorAll('.pane-drop-hint').length, 0);
  } finally { h.destroy(); }
});

// --- #377: the landing this view cannot name is still a landing ---------------
//
// `{ kind: 'window' }` is the far window saying "me, but no pane of mine". It is drawn as a frame
// around the whole window by detach-window.js — which is where it has to live, because the same
// answer has to be drawable in grid mode, where this view is not running. What this file owns is
// the other half: the placement must not be MISTAKEN for a pane here.

test('#377: a whole-window placement places nothing, so the adopt falls back to the active pane', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    h.sessionMap.set('arriving', { sessionId: 'arriving', name: 'Arriving', type: 'agent' });

    assert.equal(h.panes.applyPlacement('arriving', { kind: 'window' }, { mount: false }), false,
      'false is what hands it to the fallback the adopt already has');
    await h.settle();
    assert.equal(h.document.querySelectorAll('.session-tab').length, 1,
      'and nothing was added to a leaf id of undefined');
  } finally { h.destroy(); }
});

test('#377: a whole-window placement draws no pane hint, and clears the one before it', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    h.panes.showPlacementHint({ kind: 'tab', leafId: 'pane-1', index: -1 });
    assert.equal(h.document.querySelectorAll('.pane-drop-hint').length, 1);

    // The pointer left the pane tree for the window's chrome. Leaving the pane highlighted would say
    // the drop still lands there, which is the mismatch this issue is about.
    h.panes.showPlacementHint({ kind: 'window' });
    assert.equal(h.document.querySelectorAll('.pane-drop-hint').length, 0);
    assert.equal(h.document.querySelectorAll('.pane-tab-caret').length, 0);
  } finally { h.destroy(); }
});
