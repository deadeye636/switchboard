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
