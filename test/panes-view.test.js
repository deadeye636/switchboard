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

// --- #342: every main-area surface becomes a pane tab ------------------------

// The surfaces and what their tab is called. Projects, Variables and Activity are driven by a
// sidebar tab, so they close through it; the rest close through the viewer teardown.
const MAIN_AREA_SURFACES = [
  ['projects', 'projects-viewer', 'Projects', 'admin'],
  ['variables', 'variables-admin-content', 'Variables', 'admin'],
  ['stats', 'stats-viewer', 'Activity', 'admin'],
  ['workFiles', 'work-files-viewer', 'Work files', 'viewer'],
  ['settings', 'settings-viewer', 'Settings', 'viewer'],
  ['tasks', 'tasks-viewer', 'Tasks', 'viewer'],
  ['bookmarks', 'bookmarks-viewer', 'Bookmarks', 'viewer'],
  ['timeline', 'timeline-viewer', 'Timeline', 'viewer'],
  ['jsonl', 'jsonl-viewer', 'Messages', 'viewer'],
  ['plan', 'plan-viewer', 'Plan', 'viewer'],
  ['memory', 'memory-viewer', 'Memory', 'viewer'],
];

for (const [kind, hostId, title, route] of MAIN_AREA_SURFACES) {
  test(`${title} is adopted into a pane instead of rendering behind it (#342)`, async () => {
    const h = setupPanesDom();
    try {
      h.mount('s1');
      h.enable();
      await h.settle();
      // Opening one of these means setting `display` — that is how they announce themselves, and how
      // the pane view learns about them.
      const host = h.document.getElementById(hostId);
      host.style.display = 'flex';
      await h.settle();
      assert.ok(host.classList.contains('pane-hosted'), `${title} was moved into a pane`);
      assert.equal(host.closest('.pane-body') !== null, true, 'and it is inside a pane body');
      const tab = [...h.document.querySelectorAll('.session-tab-view .session-tab-label')]
        .find((l) => l.textContent === title);
      assert.ok(tab, `a tab labelled ${title}`);
    } finally { h.destroy(); }
  });
}

// Closing the tab has to take the route that surface's OWN × takes: `closeAdminView` for the three a
// sidebar tab drives, the viewer teardown for the rest. `variables-admin-content` is the one the issue
// flags as absent from `hideAllViewers`, so the wrong route there means it is never hidden at all.
for (const [, hostId, title, route] of MAIN_AREA_SURFACES) {
  test(`closing ${title} takes the ${route} route (#342)`, async () => {
    const h = setupPanesDom();
    try {
      h.mount('s1');
      h.enable();
      await h.settle();
      h.document.getElementById(hostId).style.display = 'flex';
      await h.settle();
      h.calls.closeAdminView = 0;
      h.calls.hideAllViewers = 0;
      [...h.document.querySelectorAll('.session-tab-view .session-tab-close')][0].click();
      await h.settle();
      if (route === 'admin') {
        assert.equal(h.calls.closeAdminView, 1, `${title} goes back through its sidebar tab`);
        assert.equal(h.calls.hideAllViewers, 0, 'not through the viewer teardown');
      } else {
        assert.equal(h.calls.hideAllViewers, 1, `${title} goes through the viewer teardown`);
        assert.equal(h.calls.closeAdminView, 0, 'and does not touch the sidebar tab');
      }
      // Either way the element ends up hidden and back home.
      const host = h.document.getElementById(hostId);
      assert.equal(host.style.display, 'none', `${title} is hidden`);
      assert.equal(host.parentElement.id, 'main', 'and back in #main');
    } finally { h.destroy(); }
  });
}

test('closing a PANE that holds an admin view closes the view too (#342)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a', { running: false });
    h.enable();
    await h.settle();
    h.panes.splitActivePane('right');
    await h.settle();
    // The view opens into the new, empty pane — so closing that pane is the only thing taking it down.
    const host = h.document.getElementById('variables-admin-content');
    host.style.display = 'flex';
    await h.settle();
    const paneId = host.closest('.pane').dataset.paneId;
    h.calls.closeAdminView = 0;
    await h.panes.closePane(paneId);
    await h.settle();
    assert.equal(h.calls.closeAdminView, 1, 'the pane close ran the surface\'s own route');
    assert.equal(host.style.display, 'none', 'so it is not left covering the workspace');
    assert.equal(host.parentElement.id, 'main', 'and it went home rather than with the pane');
    assert.equal(h.document.querySelectorAll('.session-tab-view').length, 0);
  } finally { h.destroy(); }
});

test('closing the tab hands the surface back home, with the layout intact (#342)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.enable();
    await h.settle();
    h.panes.splitActivePane('right');
    await h.open('b');
    const before = layoutSignature(h);
    const host = h.document.getElementById('projects-viewer');
    const home = host.parentElement;

    host.style.display = 'flex';
    await h.settle();
    assert.notEqual(host.parentElement, home, 'it left home for a pane');

    [...h.document.querySelectorAll('.session-tab-view .session-tab-close')][0].click();
    await h.settle();
    assert.equal(host.parentElement, home, 'and went back to the exact slot');
    assert.equal(host.classList.contains('pane-hosted'), false);
    assert.equal(layoutSignature(h), before, 'no pane lost, no split changed');
  } finally { h.destroy(); }
});

test('leaving panes mode returns every hosted surface home (#342)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('s1');
    h.enable();
    await h.settle();
    const host = h.document.getElementById('variables-admin-content');
    const home = host.parentElement;
    host.style.display = 'flex';
    await h.settle();
    assert.notEqual(host.parentElement, home);
    h.disable();
    assert.equal(host.parentElement, home, 'a mode switch must not take the app\'s only Variables panel');
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
  p.style.flexGrow,
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

test('a dormant tab is not created for a session it cannot name (#332)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    // No record: `buildTab` reads the name from sessionMap, so the tab would be an unnamed
    // placeholder the user cannot identify. The caller hands the claim back instead.
    assert.equal(h.panes.openDormantTab('ghost'), false);
    await h.settle();
    assert.equal(h.document.querySelectorAll('.session-tab').length, 1);
  } finally { h.destroy(); }
});

test('moving the same dormant session in twice activates its tab rather than adding a second (#332)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    h.sessionMap.set('dorm-1', { sessionId: 'dorm-1', name: 'Dormant one', type: 'agent' });
    h.panes.openDormantTab('dorm-1');
    await h.settle();
    h.window.panesView.show('live-1');
    await h.settle();

    assert.equal(h.panes.openDormantTab('dorm-1'), true);
    await h.settle();
    const tabs = [...h.document.querySelectorAll('.session-tab')];
    assert.equal(tabs.length, 2);
    const dormant = tabs.find((el) => el.querySelector('.session-tab-label').textContent === 'Dormant one');
    assert.equal(dormant.getAttribute('aria-selected'), 'true');
  } finally { h.destroy(); }
});

test('show() still refuses a session that is not mounted (#332)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    h.sessionMap.set('dorm-1', { sessionId: 'dorm-1', name: 'Dormant one', type: 'agent' });
    // The dormant path is deliberately its own entry point. Relaxing `show` instead would mean every
    // showSession for an unmounted session silently created a tab.
    assert.equal(h.panes.show('dorm-1'), false);
    await h.settle();
    assert.equal(h.document.querySelectorAll('.session-tab').length, 1);
  } finally { h.destroy(); }
});

test('the boot reconcile fills a dormant tab in behind what the window shows (#332)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    h.sessionMap.set('dorm-1', { sessionId: 'dorm-1', name: 'Dormant one', type: 'agent' });

    // `adoptOwnedSessions` runs at the end of a detached window's boot, after the boot path has already
    // decided what to show. A tab it adds must not take the front — `addTab` makes what it adds active,
    // so this is the case that would silently move it.
    assert.equal(h.panes.openDormantTab('dorm-1', { activate: false }), true);
    await h.settle();

    const tabs = [...h.document.querySelectorAll('.session-tab')];
    assert.equal(tabs.length, 2, 'the tab exists');
    const byLabel = (text) => tabs.find((el) => el.querySelector('.session-tab-label').textContent === text);
    assert.equal(byLabel('Dormant one').getAttribute('aria-selected'), 'false');
    assert.equal(byLabel('live-1').getAttribute('aria-selected'), 'true',
      'the session the window was showing keeps the front');
    // And the live one still has its terminal on screen, rather than the dormant placeholder.
    assert.equal(h.document.querySelectorAll('.pane-empty-launch').length, 0);
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

// The session block, as detach-window.js contributes it (#327). The harness does not load that file,
// so without this the pane menu would be asserted against a renderer missing half of it.
function stubWindowItems(h) {
  h.window.appendWindowItems = (sessionId, addItem) => {
    const anchor = addItem('Move to new window', () => {}, { disabled: !sessionId });
    addItem('Move to “Notes”', () => {}, { before: anchor.nextSibling });
  };
}

const menuGroups = (h) => [...h.document.querySelectorAll('.session-tab-menu-label')].map((el) => el.textContent);
const menuItems = (h) => [...h.document.querySelectorAll('.session-tab-menu-item')].map((b) => b.textContent);
const menuItem = (h, label) => [...h.document.querySelectorAll('.session-tab-menu-item')]
  .find((b) => b.textContent === label);

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

    assert.deepEqual(menuGroups(h), ['Pane'], 'no session, so no session heading');
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

test('a pane holding a view tab says what stays before it moves anything (#340)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    await h.open('b');
    h.panes.openViewTab('jsonl', { nearSessionId: 'a' });
    await h.settle();
    const calls = stubWindowMoves(h);

    h.document.querySelector('.pane-more-btn').click();
    await h.settle();
    menuItem(h, 'Move pane to new window').click();
    await h.settle();

    assert.equal(h.calls.dialogs.length, 1, 'it asked');
    assert.match(h.calls.dialogs[0].message, /Messages stays/, 'and named what cannot come along');
    assert.deepEqual(calls.detached, ['a']);
    assert.deepEqual(calls.moved, [['b', '7']]);
    // The view tab is still where it was: a singleton belongs to this renderer, and moving it is not
    // something the other window could take.
    assert.ok(h.panes.hasViewTab('jsonl'), 'the view stayed in the pane it was in');
  } finally { h.destroy(); }
});

test('cancelling that question moves nothing at all (#340)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.panes.openViewTab('jsonl', { nearSessionId: 'a' });
    await h.settle();
    const calls = stubWindowMoves(h);
    h.answers.confirm = false;

    h.document.querySelector('.pane-more-btn').click();
    await h.settle();
    menuItem(h, 'Move pane to new window').click();
    await h.settle();

    assert.equal(h.calls.dialogs.length, 1);
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

// --- #352: an empty pane offers a way out and a way to fill it ---------------

const emptyActions = (h) => [...h.document.querySelectorAll('.pane.pane-active .pane-empty-actions button')]
  .map((b) => b.textContent);

test('an empty pane offers New session and Close pane (#352)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a', { projectPath: '/projects/demo' });
    h.window.activeSessionId = 'a'; // the sidebar sets this in the app; `open` alone does not
    h.window.cachedProjects = [{ projectPath: '/projects/demo', name: 'demo' }];
    const opened = [];
    h.window.showNewSessionPopover = (project) => { opened.push(project.projectPath); };
    h.panes.splitActivePane('right');
    await h.settle();

    const empty = h.document.querySelector('.pane.pane-active .pane-empty');
    assert.ok(empty, 'the new pane draws the empty state');
    assert.deepEqual(emptyActions(h), ['New session', 'Close pane']);

    // The project is the active session's — an empty pane names none, and that is the one the user
    // is working in.
    h.document.querySelector('.pane.pane-active .pane-empty-actions button').click();
    await h.settle();
    assert.deepEqual(opened, ['/projects/demo']);
  } finally { h.destroy(); }
});

test('an empty pane with nothing active offers only Close pane (#352)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.settle();
    h.panes.splitActivePane('right');
    await h.settle();
    // No session anywhere, so there is no project to launch into — and a button that can never be
    // pressed is furniture.
    assert.deepEqual(emptyActions(h), ['Close pane']);
  } finally { h.destroy(); }
});

test('Close pane in the empty state removes it (#352)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.panes.splitActivePane('right');
    await h.settle();
    assert.equal(h.document.querySelectorAll('.pane').length, 2);

    [...h.document.querySelectorAll('.pane-empty-actions button')]
      .find((b) => b.textContent === 'Close pane').click();
    await h.settle();
    assert.equal(h.document.querySelectorAll('.pane').length, 1);
  } finally { h.destroy(); }
});

test('paneCloseEmpty closes an empty pane only when focus moves to another one (#352)', async () => {
  const h = setupPanesDom();
  try {
    h.enable({ paneCloseEmpty: true });
    await h.open('a');
    h.panes.splitActivePane('right');
    await h.settle();
    assert.equal(h.document.querySelectorAll('.pane').length, 2, 'the split is not undone on the spot');

    // Clicking a session that lives in the OTHER pane is the everyday way focus leaves an empty one,
    // and it goes through `show`, not `focusPane` — wiring only the latter left the setting doing
    // nothing on the path people actually take.
    h.panes.show('a');
    await h.settle();
    assert.equal(h.document.querySelectorAll('.pane').length, 1);
  } finally { h.destroy(); }
});

test('an empty pane stays put while paneCloseEmpty is off (#352)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.panes.splitActivePane('right');
    await h.settle();
    h.panes.show('a');
    await h.settle();
    assert.equal(h.document.querySelectorAll('.pane').length, 2);
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

// --- #352: dragging a tab out into a window of its own -----------------------

// A `dragend` as the browser reports one. `screen` is where the pointer was when the drag ended;
// `dropEffect` is what the drop target (if any) accepted.
function dragEndAt(h, el, { screenX, screenY, dropEffect = 'none' }) {
  const ev = new h.window.MouseEvent('dragend', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'screenX', { value: screenX });
  Object.defineProperty(ev, 'screenY', { value: screenY });
  Object.defineProperty(ev, 'dataTransfer', { value: { dropEffect } });
  el.dispatchEvent(ev);
}

// The window box the tear-off measures against. jsdom reports 1024×768 at 0/0 by default; naming it
// here is what lets a test say "outside" and mean it.
function windowBox(h, { x = 0, y = 0, width = 1000, height = 800 } = {}) {
  for (const [k, v] of Object.entries({ screenX: x, screenY: y, outerWidth: width, outerHeight: height })) {
    Object.defineProperty(h.window, k, { value: v, configurable: true });
  }
}

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

test('a view tab dragged out says why instead of vanishing (#352)', async () => {
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

    assert.deepEqual(detached, [], 'the element belongs to this renderer');
    assert.equal(h.calls.toasts.length, 1, 'and the drag ending nowhere is explained');
    assert.match(h.calls.toasts[0].message, /stays in the window/);
    assert.ok(h.panes.hasViewTab('jsonl'), 'the tab is still there');
  } finally { h.destroy(); }
});

test('from a detached window the gesture means "back to main" (#352)', async () => {
  const h = setupPanesDom({ detached: true, detachedSessionId: 'a' });
  try {
    const tab = await draggableTab(h);
    const moved = [];
    h.window.moveSessionToWindow = (id, target) => { moved.push([id, target]); };
    // `detachSession` does not exist in a detached window — its half of detach-window.js never runs.
    h.window.detachSession = undefined;

    dragEndAt(h, tab, { screenX: 1400, screenY: 400 });
    assert.deepEqual(moved, [['a', 'main']]);
  } finally { h.destroy(); }
});
