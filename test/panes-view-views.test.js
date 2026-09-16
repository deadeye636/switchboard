// DOM coverage for src/renderer/views/panes-view.js — the file that renders display mode `panes`.
//
// It had none before #343-#346: `npm test` loaded pane-tree.js and nothing else in this mode, which
// is why three defects with lasting damage sat in it behind a green suite.
//
// This file is one quarter of that coverage, split off by subject (#630): the HOSTED VIEWS — every
// main-area surface as a pane tab, the review placeholder, a view tab moving to another window,
// closing a file, where a hosted view comes back scrolled to — plus the empty pane, tiling every
// open session, selection with its bulk actions, and what a dormant session moved into this window
// may be SHOWN as (#332 — the tab it gets is a tab-strip question and lives in -tabs). The other
// three are test/panes-view.test.js
// (the layout), test/panes-view-tabs.test.js (the tab strip) and test/panes-view-drag.test.js (drag
// and drop). The split is mechanical: the harness builds a fresh jsdom per test, so 206 of them in
// one file ran 13-20 s alone and 41 s under the suite's own concurrency, and node's runner
// parallelises across files rather than within one.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  setupPanesDom, layoutSignature, stubWindowItems, menuGroups, menuItem, dragEndAt, windowBox,
} = require('./helpers/panes-dom');

// --- #342: every main-area surface becomes a pane tab ------------------------

// The surfaces and what their tab is called. Projects, Variables and Activity are driven by a
// sidebar tab, so they close through it; the rest close through the viewer teardown.
const MAIN_AREA_SURFACES = [
  ['projects', 'projects-viewer', 'Projects', 'admin'],
  ['variables', 'variables-admin-content', 'Variables', 'admin'],
  ['stats', 'stats-viewer', 'Activity', 'admin'],
  ['workFiles', 'work-files-viewer', 'Work files', 'viewer'],
  // Settings was in this list. It is not a main-area surface any more (#365): it opens in a window of
  // its own, and this page carries neither the element nor the scripts that filled it.
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

// #618: a viewer that is ALREADY adopted still has to come to the front. Re-opening one produces a
// `none` → `flex` pair, and the watcher reads the style at callback time — so both records say
// "visible", and gated on "has no tab yet" that was neither branch. The transcript behind the tab was
// replaced while the pane went on showing the tab last clicked.
test('re-opening an adopted viewer brings its tab to the front (#618)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.enable();
    await h.settle();
    const host = h.document.getElementById('jsonl-viewer');
    host.style.display = 'flex';
    await h.settle();

    // The user reads the transcript, then goes back to the terminal.
    h.panes.show('a');
    await h.settle();
    assert.equal(h.document.querySelector('#terminals .session-tab.active').dataset.tabId, 'term:a');
    assert.ok(h.panes.hasViewTab('jsonl'), 'the Messages tab is still there, just not on top');
    assert.equal(h.document.getElementById('jsonl-viewer').style.display, 'flex', 'still marked visible');

    // …and asks for the messages again. What `showJsonlViewer` does: hide everything, then show itself.
    host.style.display = 'none';
    host.style.display = 'flex';
    await h.settle();

    const active = h.document.querySelector('#terminals .session-tab.active');
    assert.equal(active && active.dataset.tabId, 'view:jsonl', 'the Messages tab is on top again');
  } finally { h.destroy(); }
});

test('a viewer that hides while adopted still loses its tab (#618)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.enable();
    await h.settle();
    const host = h.document.getElementById('jsonl-viewer');
    host.style.display = 'flex';
    await h.settle();
    assert.ok(h.panes.hasViewTab('jsonl'));

    host.style.display = 'none';
    await h.settle();
    assert.equal(h.panes.hasViewTab('jsonl'), false, 'the close half of the watcher is unchanged');
  } finally { h.destroy(); }
});

test('switching from one adopted viewer to another leaves the new one in front (#618)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.enable();
    await h.settle();
    const jsonl = h.document.getElementById('jsonl-viewer');
    const plan = h.document.getElementById('plan-viewer');
    jsonl.style.display = 'flex';
    await h.settle();

    // One batch: `hideAllViewers()` takes the transcript down and the plan viewer shows itself. The
    // watcher answers per kind, closes first, so the order of the records cannot put the wrong one on top.
    jsonl.style.display = 'none';
    plan.style.display = 'flex';
    await h.settle();

    assert.equal(h.panes.hasViewTab('jsonl'), false);
    const active = h.document.querySelector('#terminals .session-tab.active');
    assert.equal(active && active.dataset.tabId, 'view:plan');
  } finally { h.destroy(); }
});

// #619: an instanced view's ref carries the session it was opened from, so a `/clear` renames its tab.
test('re-keying an instanced view renames its tab in place (#619)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.mount('b');
    h.enable();
    await h.settle();
    h.panes.openViewTab('preview', { ref: 'old\u0000/x/notes.md', nearSessionId: 'a' });
    await h.settle();
    // The pane DOM is rebuilt on render, so the pane is compared by the tabs it holds, in order.
    const stripOfActive = () => [...h.document.querySelector('#terminals .session-tab.active')
      .parentElement.querySelectorAll('.session-tab')].map((t) => t.dataset.tabId);
    const before = stripOfActive();

    assert.equal(h.panes.rekeyViewRef('preview', 'old\u0000/x/notes.md', 'new\u0000/x/notes.md'), true);
    await h.settle();

    assert.equal(h.panes.hasViewTab('preview', 'old\u0000/x/notes.md'), false);
    assert.ok(h.panes.hasViewTab('preview', 'new\u0000/x/notes.md'));
    const active = h.document.querySelector('#terminals .session-tab.active');
    assert.equal(active && active.dataset.tabId, 'view:preview:new\u0000/x/notes.md', 'still the tab on top');
    assert.deepEqual(stripOfActive(),
      before.map((id) => (id === 'view:preview:old\u0000/x/notes.md' ? 'view:preview:new\u0000/x/notes.md' : id)),
      'and in the same place in the same strip');
  } finally { h.destroy(); }
});

test('re-keying an instanced view onto a ref that already has a tab retires the old one (#619)', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.enable();
    await h.settle();
    h.panes.openViewTab('preview', { ref: 'old\u0000/x/notes.md' });
    h.panes.openViewTab('preview', { ref: 'new\u0000/x/notes.md' });
    await h.settle();

    assert.equal(h.panes.rekeyViewRef('preview', 'old\u0000/x/notes.md', 'new\u0000/x/notes.md'), true);
    await h.settle();

    assert.equal(h.panes.hasViewTab('preview', 'old\u0000/x/notes.md'), false);
    assert.ok(h.panes.hasViewTab('preview', 'new\u0000/x/notes.md'));
    assert.equal(h.document.querySelectorAll('#terminals .session-tab[data-tab-id^="view:preview:"]').length, 1);
  } finally { h.destroy(); }
});

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

// --- #403: the placeholder must not paint over an open review --------------------------------------
//
// A review has no tab of its own (#398) — it rides on its session's pane, over the terminal underneath.
// A session with no process draws the "not running / Launch" placeholder in that same rect, absolutely
// positioned like the review host and appended after it, so it simply won. Measured on a dormant session
// with one review open: the host in the DOM at full size, nothing hidden, nothing thrown, and
// `elementFromPoint` at its centre returning the placeholder.

test('an open review keeps the pane, rather than being painted over by the launch placeholder (#403)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    h.sessionMap.set('dorm-1', { sessionId: 'dorm-1', name: 'Dormant one', type: 'agent' });

    const reviewHost = h.document.createElement('div');
    reviewHost.className = 'fp-instance';
    h.window.filePanelReviewHostFor = (sessionId) => (sessionId === 'dorm-1' ? reviewHost : null);

    assert.equal(h.panes.openDormantTab('dorm-1'), true);
    await h.settle();

    const body = h.document.querySelector('.pane.pane-active .pane-body');
    assert.ok(body.contains(reviewHost), 'the review is in the pane');
    assert.equal(reviewHost.classList.contains('pane-hosted-hidden'), false, 'and it is the visible one');
    assert.equal(h.document.querySelectorAll('.pane-empty-launch').length, 0,
      'the placeholder does not go in on top of it');

    // Answering it gives the pane back: the same render, now with nothing to show for that session.
    h.window.filePanelReviewHostFor = () => null;
    h.panes.render();
    await h.settle();
    assert.equal(h.document.querySelectorAll('.pane-empty-launch').length, 1,
      'and the Launch placeholder is reachable again once no review is open');
  } finally { h.destroy(); }
});

test('a dormant session with no review still gets the launch placeholder (#403)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('live-1');
    h.sessionMap.set('dorm-1', { sessionId: 'dorm-1', name: 'Dormant one', type: 'agent' });
    h.window.filePanelReviewHostFor = () => null;

    assert.equal(h.panes.openDormantTab('dorm-1'), true);
    await h.settle();
    assert.equal(h.document.querySelectorAll('.pane-empty-launch').length, 1);
  } finally { h.destroy(); }
});

// --- A dormant session moved into this window (#332) -------------------------------------------
//
// Its sibling — that a dormant session arriving gets a TAB at all — sits with the rest of the tab
// strip in test/panes-view-tabs.test.js. The two halves were interleaved in the file these came from
// and the split of #630 put them either side of a file boundary; neither is the whole answer alone.

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

// --- #356: tile every open session -------------------------------------------

test('tiling gives every open session a pane of its own (#356)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    for (const id of ['a', 'b', 'c', 'd']) await h.open(id);
    // All four landed in one pane, which is what "open" does without a layout.
    assert.equal(h.document.querySelectorAll('.pane').length, 1);

    assert.equal(h.panes.tileAllSessions(), true);
    await h.settle();
    assert.equal(h.document.querySelectorAll('.pane').length, 4);
    assert.deepEqual(
      [...h.document.querySelectorAll('.pane')].map((p) => p.querySelectorAll('.session-tab').length),
      [1, 1, 1, 1], 'one tab each');
  } finally { h.destroy(); }
});

test('tiling keeps the order the user already sees (#356)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    for (const id of ['a', 'b', 'c']) await h.open(id);
    h.panes.tileAllSessions();
    await h.settle();
    assert.deepEqual(
      [...h.document.querySelectorAll('.pane .session-tab[data-session-id]')].map((t) => t.dataset.sessionId),
      ['a', 'b', 'c'], 'no reordering the user could not name');
  } finally { h.destroy(); }
});

test('tiling is undoable, and does not ask first (#356)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    for (const id of ['a', 'b', 'c']) await h.open(id);
    h.panes.splitActivePane('right');
    await h.settle();
    const before = h.document.querySelectorAll('.pane').length;

    h.panes.tileAllSessions();
    await h.settle();
    assert.deepEqual(h.calls.dialogs, [], 'no confirm for something one click reverses');
    assert.equal(h.document.querySelectorAll('.pane').length, 3);

    h.panes.undoLayout();
    await h.settle();
    assert.equal(h.document.querySelectorAll('.pane').length, before, 'the arrangement came back');
  } finally { h.destroy(); }
});

test('tiling leaves view tabs out of the arrangement (#356)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    await h.open('b');
    h.panes.openViewTab('jsonl');
    await h.settle();

    h.panes.tileAllSessions();
    await h.settle();
    // Two panes, one per session. A pane invented to hold a preview is a pane nobody asked for — the
    // view keeps its tab wherever the rebuild leaves it, but it does not get a pane of its own.
    assert.equal(h.document.querySelectorAll('.pane').length, 2);
    assert.equal(h.panes.hasViewTab('jsonl'), false, 'the view tab is not carried into the new tree');
  } finally { h.destroy(); }
});

test('"Tile all sessions" appears once there is something to tile (#356)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    stubWindowItems(h);
    h.document.querySelector('.pane-more-btn').click();
    await h.settle();
    // One session in one pane, nothing arranged yet: the whole Layout group is absent, which is the
    // rule it already had — an entry that could do nothing is worse than no entry.
    assert.deepEqual(menuGroups(h), ['Pane', 'Session · a']);
    assert.equal(menuItem(h, 'Tile all sessions'), undefined);

    await h.open('b');
    h.document.querySelector('.pane.pane-active .pane-more-btn').click();
    await h.settle();
    const tile = menuItem(h, 'Tile all sessions');
    assert.ok(tile, 'two sessions, so there is an arrangement to make');
    assert.equal(tile.disabled, false);
  } finally { h.destroy(); }
});

// --- #356: selection and bulk actions ----------------------------------------

const tabEl = (h, sessionId) =>
  h.document.querySelector(`.pane-strip .session-tab[data-session-id="${sessionId}"]`);
const clickTab = (h, sessionId, mods = {}) =>
  tabEl(h, sessionId).dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true, ...mods }));
const selectionBar = (h) => h.document.getElementById('pane-selection-bar');
const barButtons = (h) => [...(selectionBar(h)?.querySelectorAll('button') || [])].map((b) => b.textContent);

test('a modified click selects, a plain one opens (#356)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    for (const id of ['a', 'b', 'c']) await h.open(id);
    assert.equal(selectionBar(h), null, 'no bar at rest — the mode loses no height');

    clickTab(h, 'a', { ctrlKey: true });
    clickTab(h, 'c', { ctrlKey: true });
    assert.equal(h.panes.selectedTabCount(), 2);
    assert.ok(tabEl(h, 'a').classList.contains('selected'));
    assert.ok(!tabEl(h, 'b').classList.contains('selected'));
    assert.ok(selectionBar(h), 'the bar appeared');
    assert.match(selectionBar(h).textContent, /2 selected/);

    // Ctrl-clicking a selected tab takes it back out.
    clickTab(h, 'a', { ctrlKey: true });
    assert.equal(h.panes.selectedTabCount(), 1);

    // A plain click is how you leave a selection.
    clickTab(h, 'b');
    assert.equal(h.panes.selectedTabCount(), 0);
    assert.equal(selectionBar(h), null);
  } finally { h.destroy(); }
});

test('Shift-click takes the range inside one strip (#356)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    for (const id of ['a', 'b', 'c', 'd']) await h.open(id);
    clickTab(h, 'a', { ctrlKey: true });
    clickTab(h, 'd', { shiftKey: true });
    assert.equal(h.panes.selectedTabCount(), 4, 'a through d');
  } finally { h.destroy(); }
});

test('a view tab cannot be selected (#356)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.panes.openViewTab('jsonl');
    await h.settle();
    h.document.querySelector('.pane-strip .session-tab-view')
      .dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    // No process to stop and no session to tag — including it would mean every action explaining
    // what it did not do to it.
    assert.equal(h.panes.selectedTabCount(), 0);
  } finally { h.destroy(); }
});

test('the bar offers Stop only when something in the selection runs (#356)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a', { running: false });
    await h.open('b', { running: false });
    clickTab(h, 'a', { ctrlKey: true });
    assert.deepEqual(barButtons(h), ['Stop', 'Close', 'Tag…', 'Clear']);
    assert.equal(selectionBar(h).querySelector('button').disabled, true, 'nothing to stop');

    clickTab(h, 'b', { ctrlKey: true });
    h.activePtyIds.add('b');
    h.panes.render();
    await h.settle();
    assert.equal(selectionBar(h).querySelector('button').disabled, false);
  } finally { h.destroy(); }
});

test('Close acts on every selected tab, asking once (#356)', async () => {
  const h = setupPanesDom();
  try {
    // With the close behaviour that ENDS processes, so the one-question rule has something to ask.
    h.enable({ tabCloseBehavior: 'stopSession' });
    for (const id of ['a', 'b', 'c']) await h.open(id);
    clickTab(h, 'a', { ctrlKey: true });
    clickTab(h, 'b', { ctrlKey: true });

    [...selectionBar(h).querySelectorAll('button')].find((b) => b.textContent === 'Close').click();
    await h.settle();
    // Down the path a single tab's × takes, so the configured close behaviour still decides.
    assert.deepEqual(h.calls.destroySession.sort(), ['a', 'b']);
    assert.equal(h.calls.dialogs.length, 1, 'one question for the set, not one per tab');
    assert.equal(h.panes.selectedTabCount(), 0);
  } finally { h.destroy(); }
});

test('Stop asks first and stops only what runs (#356)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    await h.open('b', { running: false });
    clickTab(h, 'a', { ctrlKey: true });
    clickTab(h, 'b', { ctrlKey: true });

    [...selectionBar(h).querySelectorAll('button')].find((b) => b.textContent === 'Stop').click();
    await h.settle();
    assert.equal(h.calls.dialogs.length, 1);
    assert.deepEqual(h.calls.stopSession, ['a'], 'b was not running');
  } finally { h.destroy(); }
});

test('a selection drops tabs the tree no longer has (#356)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    await h.open('b');
    clickTab(h, 'a', { ctrlKey: true });
    clickTab(h, 'b', { ctrlKey: true });
    assert.equal(h.panes.selectedTabCount(), 2);

    // The session exited and took its tab with it.
    h.unmount('a');
    h.panes.dropSession('a');
    await h.settle();
    assert.equal(h.panes.selectedTabCount(), 1, 'a count the user can still explain');
  } finally { h.destroy(); }
});

test('leaving panes mode takes the selection and its bar (#356)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    clickTab(h, 'a', { ctrlKey: true });
    assert.ok(selectionBar(h));
    h.disable();
    assert.equal(h.panes.selectedTabCount(), 0);
    assert.equal(selectionBar(h), null);
  } finally { h.destroy(); }
});

// --- #364: a view tab can move to another window ---

test('a view dropped on another window opens there and closes here (#364)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.panes.openViewTab('memory');
    await h.settle();
    windowBox(h);
    const sent = [];
    h.window.api.openViewInWindow = (windowId, kind, ref) => {
      sent.push([windowId, kind, ref]);
      return Promise.resolve({ ok: true });
    };
    h.window.api.windowAtScreenPoint = () => Promise.resolve('2'); // it landed on another window

    const viewTab = h.document.querySelector('.pane-strip .session-tab-view');
    const start = new h.window.MouseEvent('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'dataTransfer', { value: { setData() {}, types: [], effectAllowed: '' } });
    viewTab.dispatchEvent(start);
    dragEndAt(h, viewTab, { screenX: 1400, screenY: 400 });
    await h.settle();
    await h.settle();

    assert.equal(sent.length, 1);
    assert.deepEqual([...sent[0]], ['2', 'memory', null], 'the kind travels, not the element');
    assert.equal(h.panes.hasViewTab('memory'), false, 'and this window lets go of its own');
  } finally { h.destroy(); }
});

test('a view that failed to arrive is not closed here (#364)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.panes.openViewTab('memory');
    await h.settle();
    windowBox(h);
    h.window.api.openViewInWindow = () => Promise.resolve({ ok: false, error: 'no such window' });
    h.window.api.windowAtScreenPoint = () => Promise.resolve('2');

    const viewTab = h.document.querySelector('.pane-strip .session-tab-view');
    const start = new h.window.MouseEvent('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'dataTransfer', { value: { setData() {}, types: [], effectAllowed: '' } });
    viewTab.dispatchEvent(start);
    dragEndAt(h, viewTab, { screenX: 1400, screenY: 400 });
    await h.settle();
    await h.settle();

    // Closing it anyway would be a view the user has to go and find again, after a failure they
    // never saw.
    assert.ok(h.panes.hasViewTab('memory'), 'it stays where it is');
    assert.equal(h.calls.toasts.length, 1);
    assert.match(h.calls.toasts[0].message, /Could not move/);
  } finally { h.destroy(); }
});

test('a view tab holds the same dot slot as a session tab, carrying no state (#364)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.panes.openViewTab('jsonl');
    await h.settle();

    const viewTab = h.document.querySelector('.pane-strip .session-tab-view');
    const dot = viewTab.querySelector('.session-tab-dot');
    assert.ok(dot, 'the slot is there, so the labels line up with the session tabs beside it');
    assert.equal(dot.classList.contains('session-tab-dot-none'), true);
    assert.equal(/status-/.test(dot.className), false, 'a view has no process and must not claim a state');
  } finally { h.destroy(); }
});

test('a sidebar-steered view may leave the window too (#364)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.panes.openViewTab('memory');
    await h.settle();
    windowBox(h);
    const sent = [];
    h.window.api.openViewInWindow = (...args) => { sent.push(args); return Promise.resolve({ ok: true }); };
    h.window.api.windowAtScreenPoint = () => Promise.resolve('2');

    const viewTab = h.document.querySelector('.pane-strip .session-tab-view');
    const start = new h.window.MouseEvent('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'dataTransfer', { value: { setData() {}, types: [], effectAllowed: '' } });
    viewTab.dispatchEvent(start);
    dragEndAt(h, viewTab, { screenX: 1400, screenY: 400 });
    await h.settle();
    await h.settle();

    // It used to be refused: the file list is in the sidebar and a detached window has none, so the
    // editor would arrive with nothing to steer it. Main relays the sidebar's pick to whichever
    // window holds the view instead, so the restriction is gone.
    assert.equal(sent.length, 1);
    // windowId, kind, ref, and the open file — a singleton has no ref to carry its file in, so the
    // file travels beside it or the view arrives blank.
    assert.equal(sent[0][0], '2');
    assert.equal(sent[0][1], 'memory');
    assert.equal(sent[0][2], null);
    assert.equal(h.panes.hasViewTab('memory'), false);
  } finally { h.destroy(); }
});

test('only a view another window could fill may leave (#364)', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    await h.settle();

    // The rule is derived, not listed: a singleton that names a loader can be filled on arrival, so
    // it travels. An instanced kind's host is looked up and never created, and a per-session view has
    // no zero-argument loader that could say what to show — both would arrive blank or not at all.
    for (const kind of ['memory', 'plan', 'workFiles', 'stats', 'projects', 'variables']) {
      assert.equal(h.panes.viewCanLeaveWindow(kind), true, `${kind} names a loader, so it can travel`);
    }
    for (const kind of ['jsonl', 'settings', 'tasks', 'bookmarks', 'timeline']) {
      assert.equal(h.panes.viewCanLeaveWindow(kind), false, `${kind} has no loader — it would arrive blank`);
    }
    // A diff owes the CLI an answer only this renderer can give; a preview has no host to be built
    // from at the far end. Both are instanced, and that is the property the rule reads.
    assert.equal(h.panes.viewCanLeaveWindow('diff'), false);
    assert.equal(h.panes.viewCanLeaveWindow('preview'), false);
  } finally { h.destroy(); }
});

// --- #388: closing a file goes back to the session it was opened from ---
//
// `PaneTree.closeTab` picks the neighbour by position, which is right for a terminal tab and lands on
// whatever happened to sit next to a file. A preview is always opened FROM a session.

test('#388: closing a preview reveals the session it came from, not the neighbour', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.mount('b');
    h.enable();
    await h.settle();
    h.window.filePanelSessionFor = () => 'a';
    h.window.filePanelCloseInstance = () => {};
    h.panes.openViewTab('preview', { ref: '/x/notes.md' });
    await h.settle();

    h.panes.closeViewTab('preview', { ref: '/x/notes.md', closeTheView: true });
    await h.settle();

    const active = h.document.querySelector('#terminals .session-tab.active');
    assert.equal(active && active.dataset.tabId, 'term:a', 'back to the session, not to b');
  } finally { h.destroy(); }
});

test('#421: the file panel\'s own close still knows which session to go back to', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.mount('b');
    h.enable();
    await h.settle();
    // THE CASE: closing a preview with the viewer's own × removes the panel entry FIRST and tells the
    // pane tree afterwards, so the lookup below has nothing left to answer with. That is why the caller
    // passes the session explicitly — without it this landed on the pane's last session.
    h.window.filePanelSessionFor = () => null;
    h.window.filePanelCloseInstance = () => {};
    h.panes.openViewTab('preview', { ref: '/x/notes.md' });
    await h.settle();

    h.panes.closeViewTab('preview', { ref: '/x/notes.md', closeTheView: true, cameFrom: 'a' });
    await h.settle();

    const active = h.document.querySelector('#terminals .session-tab.active');
    assert.equal(active && active.dataset.tabId, 'term:a', 'back to the session it was opened from');
  } finally { h.destroy(); }
});

test('#421: an explicit origin still refuses to jump into another pane', async () => {
  const h = setupPanesDom();
  try {
    h.mount('b');
    h.enable();
    await h.settle();
    h.window.filePanelSessionFor = () => null;
    h.window.filePanelCloseInstance = () => {};
    h.panes.openViewTab('preview', { ref: '/x/notes.md' });
    await h.settle();

    h.panes.closeViewTab('preview', { ref: '/x/notes.md', closeTheView: true, cameFrom: 'not-here' });
    await h.settle();

    const active = h.document.querySelector('#terminals .session-tab.active');
    assert.equal(active && active.dataset.tabId, 'term:b',
      'the same-pane guard holds however the origin was learned');
  } finally { h.destroy(); }
});

test('#388: a session that is no longer in that pane leaves the old behaviour alone', async () => {
  const h = setupPanesDom();
  try {
    h.mount('b');
    h.enable();
    await h.settle();
    // The origin session is not a tab here at all — reaching into another pane would move focus
    // somewhere the user was not looking.
    h.window.filePanelSessionFor = () => 'gone';
    h.window.filePanelCloseInstance = () => {};
    h.panes.openViewTab('preview', { ref: '/x/notes.md' });
    await h.settle();

    h.panes.closeViewTab('preview', { ref: '/x/notes.md', closeTheView: true });
    await h.settle();

    const active = h.document.querySelector('#terminals .session-tab.active');
    assert.equal(active && active.dataset.tabId, 'term:b');
  } finally { h.destroy(); }
});

test('#388: a singleton view is unaffected — it has no session to go back to', async () => {
  const h = setupPanesDom();
  try {
    h.mount('a');
    h.mount('b');
    h.enable();
    await h.settle();
    let asked = 0;
    h.window.filePanelSessionFor = () => { asked++; return 'a'; };
    h.panes.openViewTab('jsonl', {});
    await h.settle();

    h.panes.closeViewTab('jsonl', { closeTheView: true });
    await h.settle();
    assert.equal(asked, 0, 'the file panel is not asked about a view it does not own');
  } finally { h.destroy(); }
});

// --- #458: a hosted view comes back where it was scrolled to -----------------------------------
//
// A render builds a fresh pane body and MOVES the hosted elements into it; the tab that is not on top
// is additionally `display:none`. Both take the scroll offset with them — an element out of the DOM
// has none to keep. Nothing else about the view is lost (the document, the caret and unsaved edits
// live in CodeMirror and are not touched), which is why the offset is carried by hand.
//
// jsdom performs no layout, so two things are staged here that a browser does for free: the host is
// given a box, and the offset is zeroed by hand while the tab is away — that zeroing IS the bug, and
// without it the test would pass against the unfixed code.

/**
 * Give an element a layout box, so `isLaidOut` counts it as on screen — and NO box while it is
 * hidden, which is the half that matters. `.pane-hosted-hidden` is `display: none !important`, and a
 * browser answers 0 for everything there. A stub that reports a box regardless would have the code
 * capture a hidden element's zeros over the position it is holding, which is the bug this guards.
 */
function giveBox(el, height = 400) {
  const hidden = () => el.classList.contains('pane-hosted-hidden');
  Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => (hidden() ? 0 : height) });
  Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => (hidden() ? 0 : 600) });
}

test('#458: a hosted view keeps its scroll position across a tab switch', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.panes.openViewTab('plan');
    await h.settle();

    const host = h.document.getElementById('plan-viewer');
    assert.equal(host.classList.contains('pane-hosted'), true, 'the plan viewer is hosted in the pane');
    giveBox(host);
    host.scrollTop = 500;

    // Away: the session tab goes on top, so the plan viewer is hidden.
    h.document.querySelector('.pane-strip .session-tab:not(.session-tab-view)').click();
    await h.settle();
    assert.equal(host.classList.contains('pane-hosted-hidden'), true, 'it went out of sight');
    // What the browser does to an element with no layout box, and jsdom does not.
    host.scrollTop = 0;

    // Back.
    h.document.querySelector('.pane-strip .session-tab-view').click();
    await h.settle();
    assert.equal(host.classList.contains('pane-hosted-hidden'), false, 'it is on top again');
    assert.equal(host.scrollTop, 500, 'and it is where it was left');
  } finally { h.destroy(); }
});

test('#458: a hidden view does not record itself as scrolled to the top', async () => {
  // The trap in the other direction. A hidden element reports 0 for everything, so capturing it while
  // it is away would overwrite the very position that is being kept — and the second switch would
  // land at the top, which is the original bug with an extra step.
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.panes.openViewTab('plan');
    await h.settle();

    const host = h.document.getElementById('plan-viewer');
    giveBox(host);
    host.scrollTop = 320;

    for (let i = 0; i < 3; i++) {
      h.document.querySelector('.pane-strip .session-tab:not(.session-tab-view)').click();
      await h.settle();
      host.scrollTop = 0;
      h.document.querySelector('.pane-strip .session-tab-view').click();
      await h.settle();
      assert.equal(host.scrollTop, 320, `still there after switch ${i + 1}`);
    }
  } finally { h.destroy(); }
});

test('#458: a view that was never scrolled is left alone', async () => {
  const h = setupPanesDom();
  try {
    h.enable();
    await h.open('a');
    h.panes.openViewTab('plan');
    await h.settle();

    const host = h.document.getElementById('plan-viewer');
    giveBox(host);

    h.document.querySelector('.pane-strip .session-tab:not(.session-tab-view)').click();
    await h.settle();
    h.document.querySelector('.pane-strip .session-tab-view').click();
    await h.settle();
    assert.equal(host.scrollTop, 0, 'nothing to restore, nothing restored');
  } finally { h.destroy(); }
});
