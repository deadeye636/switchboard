// src/renderer/views/file-panel.js — the preview and the diff, and the accept/reject that answers a CLI's
// `openDiff` over the MCP bridge.
//
// The file had no coverage at all. These cases pin what it does TODAY, before #311 turns its one tab per
// session into one instance per pane tab: the side-panel path is shared by tabs AND grid mode, so the
// behaviour written down here is the behaviour that must survive that change.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupFilePanelDom } = require('./helpers/file-panel-dom');

// The bridge's own payload shape (`handleOpenDiff` in src/servers/mcp-bridge.js).
const diffData = (over = {}) => ({
  tabName: 'proposed change',
  oldFilePath: '/srv/projects/api/README.md',
  oldContent: 'one\ntwo\n',
  newContent: 'one\ntwo\nthree\n',
  ...over,
});

// ── The side panel (tabs / grid mode) ────────────────────────────────

test('the panel builds the split around #terminals and starts closed', () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    const split = h.document.getElementById('terminal-split');
    assert.ok(split, 'the split container exists');
    assert.equal(split.querySelector('#terminals') !== null, true, 'with #terminals inside it');
    assert.equal(h.panel().classList.contains('open'), false);
    // The shell holds nothing until something is opened (#311): an instance is built per preview and per
    // diff, so there is no content to find before the first one arrives.
    assert.equal(h.qa('.fp-content').length, 0);
  } finally { h.destroy(); }
});

test('a diff arriving from the bridge opens the panel and offers accept/reject', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.mount('s1');
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    await h.settle();

    assert.equal(h.panel().classList.contains('open'), true);
    assert.equal(h.q('.fp-diff').style.display, 'flex');
    assert.equal(h.q('.fp-viewer').style.display, 'none');
    assert.equal(h.q('.fp-diff .viewer-toolbar-title').textContent, 'proposed change');
    assert.equal(h.q('.fp-diff .viewer-toolbar-path').textContent, '/srv/projects/api/README.md');
    assert.deepEqual(h.qa('.fp-actions button').map((b) => b.textContent), ['Accept', 'Reject']);
    assert.deepEqual(h.calls.mergeViewers.map((m) => m.mode), ['side-by-side']);
  } finally { h.destroy(); }
});

test('the stored diff mode decides which viewer is built', async () => {
  const h = setupFilePanelDom({ diffMode: 'inline' });
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    await h.settle();
    assert.deepEqual(h.calls.mergeViewers.map((m) => m.mode), ['inline']);
  } finally { h.destroy(); }
});

// ── Accept / reject: what the CLI is told ────────────────────────────

test('Accept answers the bridge, and only once', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    await h.settle();

    h.q('.file-panel-accept-btn').click();
    // The merge viewer hands back exactly `newContent`, so this is an unedited accept.
    assert.deepEqual(h.calls.diffResponses, [['s1', 'diff-1', 'accept', null]]);

    // An answered review gives the surface back (#398) — it used to sit there until the CLI took it
    // down, which left half a terminal covered by a settled question. Closing it must not answer a
    // second time.
    assert.equal(h.qa('.fp-content').length, 0, 'the review is gone');
    assert.equal(h.calls.diffResponses.length, 1, 'and closing it said nothing more');
    assert.equal(h.state('s1').currentTab, null);
  } finally { h.destroy(); }
});

test('Reject answers reject, and never sends content', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    await h.settle();
    h.q('.file-panel-reject-btn').click();
    assert.deepEqual(h.calls.diffResponses, [['s1', 'diff-1', 'reject', null]]);
  } finally { h.destroy(); }
});

test('closing the panel on an unanswered diff rejects it rather than leaving the CLI waiting', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    await h.settle();

    // The panel's own close button. Without the reject, the CLI's tools/call hangs until the bridge's
    // ten-minute timeout — which is why this is not merely tidy-up.
    h.window.closeFilePanel();
    assert.deepEqual(h.calls.diffResponses, [['s1', 'diff-1', 'reject', null]]);
    assert.equal(h.panel().classList.contains('open'), false);
    assert.equal(h.state('s1').currentTab, null);
  } finally { h.destroy(); }
});

test('closing an ANSWERED diff says nothing more', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    await h.settle();
    h.q('.file-panel-accept-btn').click();
    h.window.closeFilePanel();
    assert.deepEqual(h.calls.diffResponses, [['s1', 'diff-1', 'accept', null]], 'no second answer');
  } finally { h.destroy(); }
});

test('the bridge closing a tab by diff id resolves it without answering', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    await h.settle();

    // `close_tab` means the CLI already decided — answering would be a second reply to a settled call.
    h.ipc.closeTab('s1', 'diff-1');
    assert.deepEqual(h.calls.diffResponses, []);
    assert.equal(h.state('s1').currentTab, null);
    assert.equal(h.panel().classList.contains('open'), false);
  } finally { h.destroy(); }
});

test('a close for a diff id that is not showing leaves the panel alone', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    await h.settle();
    h.ipc.closeTab('s1', 'some-other-diff');
    assert.notEqual(h.state('s1').currentTab, null, 'the showing diff stays');
    assert.equal(h.panel().classList.contains('open'), true);
  } finally { h.destroy(); }
});

// ── The preview ──────────────────────────────────────────────────────

test('a preview renders through the ViewerPanel, not the diff half', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.files.set('/srv/projects/api/notes.md', '# notes\n');
    await h.openFileInPanel('s1', '/srv/projects/api/notes.md');
    await h.settle();

    assert.deepEqual(h.calls.reads, ['/srv/projects/api/notes.md']);
    assert.deepEqual(h.calls.viewerOpens, [['notes.md', '/srv/projects/api/notes.md']]);
    assert.equal(h.q('.fp-viewer').style.display, 'flex');
    assert.equal(h.q('.fp-diff').style.display, 'none');
    assert.equal(h.window.filePanelTabLabel('preview', '/srv/projects/api/notes.md'), 'notes.md');
  } finally { h.destroy(); }
});

test('an image is read as a data URL rather than as text (#49)', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    await h.openFileInPanel('s1', '/srv/projects/api/logo.png');
    await h.settle();
    assert.deepEqual(h.calls.reads, [], 'never read as UTF-8');
    assert.deepEqual(h.calls.viewerOpens, [['logo.png', '/srv/projects/api/logo.png']]);
  } finally { h.destroy(); }
});

// ── One tab per session — the state #311 changes ─────────────────────

test('outside panes mode a second preview takes the first one\'s place (#311)', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.files.set('/a.md', 'a');
    h.files.set('/b.md', 'b');
    await h.openFileInPanel('s1', '/a.md');
    await h.settle();
    await h.openFileInPanel('s1', '/b.md');
    await h.settle();

    // The side panel shows one thing at a time and always has — that promise is unchanged by #311, which
    // gives PANES the second instance, not the strip.
    assert.equal(h.state('s1').currentTab.filePath, '/b.md');
    assert.equal(h.calls.viewerDestroys >= 1, true, 'the replaced preview released its editor');
    assert.equal(h.qa('.fp-content').length, 1, 'one instance in the shell, not two stacked');
    assert.equal(h.window.filePanelTabLabel('preview', '/a.md'), null, 'and the first one is gone');
  } finally { h.destroy(); }
});

test('re-opening the SAME file keeps its instance rather than building another (#311)', async () => {
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('s1');
    h.files.set('/a.md', 'a');
    await h.openFileInPanel('s1', '/a.md');
    await h.settle();
    const first = h.q('.fp-content');
    // The bridge re-sends the same file on every session switch. A counter key would stack duplicates
    // nobody asked for; the path as the key lands on the tab that already has it.
    await h.openFileInPanel('s1', '/a.md');
    await h.settle();
    assert.equal(h.qa('.fp-content').length, 1);
    assert.equal(h.q('.fp-content'), first, 'the same instance, not a replacement');
    assert.deepEqual(h.calls.openViewTab.map((c) => c[1].ref), ['/a.md', '/a.md']);
  } finally { h.destroy(); }
});

test('panes mode keeps two previews at once, each its own tab (#311)', async () => {
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('s1');
    h.files.set('/a.md', 'a');
    h.files.set('/b.md', 'b');
    await h.openFileInPanel('s1', '/a.md');
    await h.settle();
    await h.openFileInPanel('s1', '/b.md');
    await h.settle();

    // This is the requirement: two files compared side by side, which one element could never do.
    assert.equal(h.qa('.fp-content').length, 2);
    assert.equal(h.window.filePanelTabLabel('preview', '/a.md'), 'a.md');
    assert.equal(h.window.filePanelTabLabel('preview', '/b.md'), 'b.md');
    assert.deepEqual(h.calls.openViewTab.map((c) => [c[0], c[1].ref]),
      [['preview', '/a.md'], ['preview', '/b.md']]);
    assert.equal(h.calls.viewerDestroys, 0, 'nothing was torn down to make room');
  } finally { h.destroy(); }
});

test('panes mode keeps two diffs at once, and each answers for itself (#311)', async () => {
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData({ oldFilePath: '/a.js' }));
    await h.settle();
    h.ipc.openDiff('s2', 'diff-2', diffData({ oldFilePath: '/b.js', tabName: 'second change' }));
    await h.settle();

    // A diff from one session no longer disappears when another session produces one.
    assert.equal(h.qa('.fp-content').length, 2);
    assert.deepEqual(h.calls.diffResponses, [], 'and neither was answered to make room');

    // Accept in the SECOND instance answers for the second diff and its session, not the first.
    const second = h.qa('.fp-content')[1];
    second.querySelector('.file-panel-accept-btn').click();
    assert.deepEqual(h.calls.diffResponses, [['s2', 'diff-2', 'accept', null]]);

    // …and the first is still there, still unanswered, still reachable.
    assert.equal(h.window.filePanelTabLabel('diff', 'diff-1'), 'proposed change');
    h.qa('.fp-content')[0].querySelector('.file-panel-reject-btn').click();
    assert.deepEqual(h.calls.diffResponses[1], ['s1', 'diff-1', 'reject', null]);
  } finally { h.destroy(); }
});

test('closing one diff tab rejects that one and leaves the others alone (#311)', async () => {
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    h.ipc.openDiff('s1', 'diff-2', diffData({ tabName: 'second' }));
    await h.settle();

    // What the pane tree calls when the user closes that one tab.
    h.window.filePanelCloseInstance('diff', 'diff-1');
    assert.deepEqual(h.calls.diffResponses, [['s1', 'diff-1', 'reject', null]]);
    assert.equal(h.qa('.fp-content').length, 1);
    assert.equal(h.window.filePanelTabLabel('diff', 'diff-2'), 'second');
  } finally { h.destroy(); }
});

test('outside panes mode a second diff replaces the first — and REJECTS it (#311)', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    await h.settle();
    h.ipc.openDiff('s1', 'diff-2', diffData({ tabName: 'second change' }));
    await h.settle();

    assert.equal(h.state('s1').currentTab.diffId, 'diff-2');
    assert.equal(h.q('.fp-diff .viewer-toolbar-title').textContent, 'second change');
    // It used to be orphaned: unreachable, unanswered, and the CLI waited out the bridge's ten-minute
    // timeout. Displacing a diff is a decision about it, so it is answered on the way out.
    assert.deepEqual(h.calls.diffResponses, [['s1', 'diff-1', 'reject', null]]);
    assert.equal(h.qa('.fp-body .cm-merge-view').length, 1, 'one view in the shell, not two');
  } finally { h.destroy(); }
});

// --- #405: the session ended, so the bridge clears its reviews --------------------------------------
//
// `closeAllDiffs` is the channel a session exit now arrives on, not just a CLI's own `closeAllDiffTabs`.
// What has to survive that: the counter, and the pane the reviews were riding on.

test('a session ending clears both its reviews and their counter, and leaves another session\'s alone (#405)', async () => {
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    h.ipc.openDiff('s1', 'diff-2', diffData({ tabName: 'second' }));
    h.ipc.openDiff('s2', 'diff-3', diffData({ tabName: 'other session' }));
    await h.settle();

    const counts = () => h.qa('.fp-review-count').map((el) => el.textContent).filter(Boolean);
    assert.deepEqual(counts(), ['1 of 2', '2 of 2'], 's1 pages through two, s2 has nothing to page');

    h.ipc.closeAllDiffs('s1');
    await h.settle();

    assert.equal(h.window.filePanelReviewHostFor('s1'), null, 's1 has no review left');
    assert.ok(h.window.filePanelReviewHostFor('s2'), "and s2's is untouched");
    assert.deepEqual(counts(), [], 'the counter goes with the reviews it counted');
    assert.deepEqual(h.calls.diffResponses, [],
      'the bridge already answered these — answering again would write into a server that is gone');
  } finally { h.destroy(); }
});

test('a review cleared while a preview holds the panel still rebuilds the pane (#403)', async () => {
  // The review was not the shown entry: a preview opened afterwards takes `shownKey`, and
  // `filePanelReviewHostFor` falls back to the newest review precisely so it stays on screen. Removing
  // that host is a change to the pane either way — and since the launch placeholder is skipped while a
  // review is open, a pane not rebuilt here would be left showing nothing at all.
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    h.files.set('/a.md', 'a');
    await h.openFileInPanel('s1', '/a.md');
    await h.settle();

    assert.equal(h.state('s1').currentTab.filePath, '/a.md', 'the preview is what the panel shows');
    assert.ok(h.window.filePanelReviewHostFor('s1'), 'and the review is still on screen under it');

    const before = h.calls.render || 0;
    h.ipc.closeAllDiffs('s1');
    await h.settle();

    assert.equal(h.window.filePanelReviewHostFor('s1'), null);
    assert.ok((h.calls.render || 0) > before, 'the pane is rebuilt, so the placeholder can come back');
    assert.equal(h.state('s1').currentTab.filePath, '/a.md', 'and the preview is untouched');
  } finally { h.destroy(); }
});

test('each session keeps its own tab, and switching shows that session\'s', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.files.set('/a.md', 'a');
    await h.openFileInPanel('s1', '/a.md');
    await h.settle();

    h.switchPanel('s2');
    assert.equal(h.panel().classList.contains('open'), false, 's2 has nothing to show');

    h.switchPanel('s1');
    assert.equal(h.panel().classList.contains('open'), true, 'and s1 gets its preview back');
    assert.equal(h.state('s1').currentTab.filePath, '/a.md');
  } finally { h.destroy(); }
});

test('a diff for a session that is not on screen is kept, not shown', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s2', 'diff-9', diffData());
    await h.settle();

    assert.equal(h.panel().classList.contains('open'), false, 'the visible session is unaffected');
    assert.equal(h.state('s2').currentTab.diffId, 'diff-9', 'and s2 has it waiting');
    h.switchPanel('s2');
    await h.settle();
    assert.equal(h.panel().classList.contains('open'), true);
  } finally { h.destroy(); }
});

test('closeAllDiffs drops a diff but leaves a preview alone', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.files.set('/a.md', 'a');
    await h.openFileInPanel('s1', '/a.md');
    await h.settle();
    h.ipc.closeAllDiffs('s1');
    assert.notEqual(h.state('s1').currentTab, null, 'a preview is not a diff');

    h.ipc.openDiff('s1', 'diff-1', diffData());
    await h.settle();
    h.ipc.closeAllDiffs('s1');
    assert.equal(h.state('s1').currentTab, null);
    assert.deepEqual(h.calls.diffResponses, [], 'the CLI asked for this, so it is not answered');
  } finally { h.destroy(); }
});

test('a re-keyed session takes its panel state with it (a fork, an accepted plan)', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('old');
    h.files.set('/a.md', 'a');
    await h.openFileInPanel('old', '/a.md');
    await h.settle();

    h.inCtx('rekeyFilePanelState("old", "new")');
    assert.equal(h.state('old'), undefined);
    assert.equal(h.state('new').currentTab.filePath, '/a.md');
  } finally { h.destroy(); }
});

// ── Panes mode: the same element becomes a pane tab (#310) ───────────

test('in panes mode a review rides with its session rather than taking a tab', async () => {
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    await h.settle();

    // #398: a review is read on top and answered in the terminal underneath — the accept/reject
    // buttons belong to the CLI — so a tab of its own promised a separate surface and delivered the
    // same session with an attachment.
    assert.deepEqual(h.calls.openViewTab, [], 'no tab is claimed for it');
    assert.ok(h.calls.render > 0, 'the tree is asked to rebuild instead, which places it');
    assert.equal(h.window.filePanelReviewHostFor('s1'), h.qa('.fp-content')[0],
      'and the pane can find the review of that session');

    assert.equal(h.panel().style.width, '', 'no side-panel width');
    assert.equal(h.document.getElementById('file-panel-resize-handle').style.display, 'none');

    h.window.closeFilePanel();
    assert.deepEqual(h.calls.diffResponses, [['s1', 'diff-1', 'reject', null]], 'closing answers it');
  } finally { h.destroy(); }
});

test('a preview still gets a tab — several files side by side is the point of one', async () => {
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('s1');
    h.files.set('/a.md', 'a');
    await h.openFileInPanel('s1', '/a.md');
    await h.settle();

    assert.deepEqual(h.calls.openViewTab.map((c) => [c[0], c[1].ref]), [['preview', '/a.md']],
      'only the review lost its tab; looking at a file is not answering one');
  } finally { h.destroy(); }
});

test('the side panel keeps its width and its handle when panes mode is off', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.files.set('/a.md', 'a');
    await h.openFileInPanel('s1', '/a.md');
    await h.settle();

    assert.match(h.panel().style.width, /^\d+px$/);
    assert.equal(h.document.getElementById('file-panel-resize-handle').style.display, 'block');
    assert.deepEqual(h.calls.openViewTab, [], 'and it never reaches for the pane tree');
  } finally { h.destroy(); }
});

// ── The IDE-emulation flag ───────────────────────────────────────────

test('the IDE flag is per session and only repaints the sidebar on a real change', () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.inCtx('setSessionMcpActive("s1", true)');
    assert.equal(h.window.isMcpActiveForSession('s1'), true);
    assert.equal(h.window.isMcpActiveForSession('s2'), false);
    const after = h.calls.refreshSidebar;
    h.inCtx('setSessionMcpActive("s1", true)');
    assert.equal(h.calls.refreshSidebar, after, 'setting it again rebuilds nothing');
  } finally { h.destroy(); }
});

test('leaving panes mode collapses to one entry and answers the diffs it drops (#311)', async () => {
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    h.ipc.openDiff('s1', 'diff-2', diffData({ tabName: 'second' }));
    await h.settle();
    assert.equal(h.qa('.fp-content').length, 2);

    // What `panesView.disable()` calls. The pane rebuild has already taken their DOM, so an entry left in
    // the registry would be unreachable AND unanswered — the CLI hang this change exists to prevent.
    h.panesView._active = false;
    h.window.filePanelCollapseToOne();

    assert.deepEqual(h.calls.diffResponses, [['s1', 'diff-1', 'reject', null]], 'the dropped one is answered');
    assert.equal(h.window.filePanelTabLabel('diff', 'diff-2'), 'second', 'the shown one survives');
    assert.equal(h.window.filePanelTabLabel('diff', 'diff-1'), null);
  } finally { h.destroy(); }
});

test('a re-key moves the open entries onto the new session id (#311)', async () => {
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('old');
    h.ipc.openDiff('old', 'diff-1', diffData());
    await h.settle();

    h.inCtx('rekeyFilePanelState("old", "new")');

    // `close_tab` from the CLI arrives under the NEW id after a /clear. Before this it matched nothing,
    // and the diff stayed open with no way to answer it.
    h.ipc.closeTab('new', 'diff-1');
    assert.equal(h.window.filePanelTabLabel('diff', 'diff-1'), null, 'the CLI could close it');
    assert.deepEqual(h.calls.diffResponses, [], 'and closing on the CLI\'s request answers nothing');
  } finally { h.destroy(); }
});

test('an entry answers the bridge under the session id it was re-keyed to (#311)', async () => {
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('old');
    h.ipc.openDiff('old', 'diff-1', diffData());
    await h.settle();
    h.inCtx('rekeyFilePanelState("old", "new")');

    h.q('.file-panel-accept-btn').click();
    assert.deepEqual(h.calls.diffResponses, [['new', 'diff-1', 'accept', null]]);
  } finally { h.destroy(); }
});

// ── #398: several reviews of one session share one surface ──────────

test('one review shows no pager — there is nothing to page through', async () => {
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    await h.settle();

    assert.equal(h.qa('.fp-review-pager')[0].style.display, 'none');
  } finally { h.destroy(); }
});

test('a second review of the same session says it is waiting', async () => {
  // This is what the tab used to say by existing. Without a count, a review behind the visible one is
  // invisible — and it still blocks its CLI.
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData({ oldFilePath: '/a.js' }));
    await h.settle();
    h.ipc.openDiff('s1', 'diff-2', diffData({ oldFilePath: '/b.js', tabName: 'second' }));
    await h.settle();

    const counts = h.qa('.fp-review-count').map((el) => el.textContent);
    assert.deepEqual(counts, ['1 of 2', '2 of 2']);
    assert.deepEqual(h.calls.diffResponses, [], 'and neither was answered to make room for the other');
  } finally { h.destroy(); }
});

test('paging moves which review is on screen and answers nothing', async () => {
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData({ oldFilePath: '/a.js' }));
    await h.settle();
    h.ipc.openDiff('s1', 'diff-2', diffData({ oldFilePath: '/b.js', tabName: 'second' }));
    await h.settle();

    const shown = () => h.state('s1').shownKey;
    assert.match(shown(), /diff-2$/, 'the newest is on screen');

    h.qa('.fp-review-pager')[1].querySelector('button').click();   // ‹ previous
    assert.match(shown(), /diff-1$/);
    assert.deepEqual(h.calls.diffResponses, [], 'paging is not deciding');

    // It wraps: with two open, previous and next both reach the other one.
    h.qa('.fp-review-pager')[0].querySelectorAll('button')[1].click(); // › next
    assert.match(shown(), /diff-2$/);
    assert.deepEqual(h.calls.diffResponses, []);
  } finally { h.destroy(); }
});

test('closing the visible review puts the waiting one on screen', async () => {
  // Without a tab to fall back to, the surface would otherwise go blank while a review is still open
  // and still blocking its CLI. (Accepting does NOT close it — the review stays until the CLI takes it
  // down, which is what close_tab does here.)
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData({ oldFilePath: '/a.js' }));
    await h.settle();
    h.ipc.openDiff('s1', 'diff-2', diffData({ oldFilePath: '/b.js', tabName: 'second' }));
    await h.settle();

    h.qa('.fp-content')[1].querySelector('.file-panel-accept-btn').click();
    assert.deepEqual(h.calls.diffResponses, [['s1', 'diff-2', 'accept', null]]);
    h.ipc.closeTab('s1', 'diff-2');   // the CLI takes its answered review down

    assert.match(h.state('s1').shownKey, /diff-1$/, 'the one still waiting takes the surface');
    assert.equal(h.qa('.fp-review-pager')[0].style.display, 'none',
      'and with one left there is nothing to page through again');
  } finally { h.destroy(); }
});

test('closing a session tab answers every review it still holds (#398)', async () => {
  // A review has no tab of its own any more, so once its session's tab is gone nothing can reach it —
  // invisible AND unanswered is the one state that blocks a CLI for the full timeout.
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData({ oldFilePath: '/a.js' }));
    await h.settle();
    h.ipc.openDiff('s1', 'diff-2', diffData({ oldFilePath: '/b.js', tabName: 'second' }));
    await h.settle();

    h.window.filePanelCloseSessionReviews('s1');

    assert.deepEqual(h.calls.diffResponses, [
      ['s1', 'diff-1', 'reject', null],
      ['s1', 'diff-2', 'reject', null],
    ], 'both are answered, not just the one that was on screen');
    assert.equal(h.qa('.fp-content').length, 0);
  } finally { h.destroy(); }
});

test('switching into panes mode does not give a review a tab after all (#398)', async () => {
  // The same defect from the other side: open a review in tabs mode, switch to panes, and the session
  // had two tabs again — its own and one holding a copy of itself with the diff on top.
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    await h.settle();

    h.window.filePanelReopenInPanes();
    assert.deepEqual(h.calls.openViewTab, [], 'no tab is claimed for the review');
  } finally { h.destroy(); }
});

test('a preview opened over a review does not hide it (#398)', async () => {
  // The preview takes `shownKey` — it has a tab of its own and does not displace the review, which is
  // still unanswered and still blocking its CLI.
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    await h.settle();
    h.files.set('/notes.md', 'hi');
    await h.openFileInPanel('s1', '/notes.md');
    await h.settle();

    assert.ok(h.window.filePanelReviewHostFor('s1'), 'the review is still reachable by the pane');
    assert.deepEqual(h.calls.diffResponses, [], 'and it was not answered to make room');
  } finally { h.destroy(); }
});

// --- #458 outside panes: a switch away and back is not a re-open ------------------------------
//
// The side panel shows one entry at a time and `switchPanel` hides it for the session being left,
// which takes the entry's root out of the DOM. Coming back re-ran `instance.render()` — and render
// used to call `viewerPanel.open()` unconditionally, which writes `tab.content` (the file AS FIRST
// READ) back into the editor. Measured in the running app before this changed: an edit made without
// saving was gone after one switch away and back. What is safe to repeat is the reveal, not the open.

test('#458: switching away and back does not re-open the file', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.files.set('/notes.md', 'first line\nsecond line\n');
    await h.openFileInPanel('s1', '/notes.md');
    await h.settle();
    assert.deepEqual(h.calls.viewerOpens, [['notes.md', '/notes.md']], 'opened once');

    h.switchPanel('s2');
    await h.settle();
    h.switchPanel('s1');
    await h.settle();

    assert.deepEqual(h.calls.viewerOpens, [['notes.md', '/notes.md']],
      'still once — a second open would have overwritten whatever was typed since the first');
  } finally { h.destroy(); }
});

test('#458: a different file in the same panel still opens', async () => {
  // The guard is "this file is already open", not "never open again". Getting that wrong would leave
  // the panel showing the previous document under the new one's name.
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.files.set('/a.md', 'A');
    h.files.set('/b.md', 'B');
    await h.openFileInPanel('s1', '/a.md');
    await h.settle();
    await h.openFileInPanel('s1', '/b.md');
    await h.settle();

    assert.deepEqual(h.calls.viewerOpens, [['a.md', '/a.md'], ['b.md', '/b.md']]);
  } finally { h.destroy(); }
});

test('#458: the side panel comes back where it was scrolled to', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    h.switchPanel('s1');
    h.files.set('/notes.md', 'x\n'.repeat(400));
    await h.openFileInPanel('s1', '/notes.md');
    await h.settle();

    const root = h.panel().firstElementChild;
    const scroller = root.querySelector('.fp-viewer');
    scroller.scrollTop = 640;

    h.switchPanel('s2');
    await h.settle();
    assert.equal(h.panel().firstElementChild, null, 'the root left the DOM');
    // What a browser does to a detached element, and jsdom does not.
    scroller.scrollTop = 0;

    h.switchPanel('s1');
    await h.settle();
    assert.equal(root.querySelector('.fp-viewer').scrollTop, 640, 'and it is back where it was');
  } finally { h.destroy(); }
});

// The side panel's width drag re-fits the terminal beside it with its own `fitAddon.fit()` — it does
// not go through safeFit, so it owes the selection the same treatment (#459): a narrower terminal
// re-wraps the buffer, and a selection left pointing at those cells copies text nobody selected.

test('#459: the width drag drops a selection when the terminal loses columns', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    const entry = h.mount('s1', { cols: 95, colsAfterFit: 74 });
    h.switchPanel('s1');
    entry.terminal.selected = true;

    h.inCtx('refitActiveTerminal()');
    await h.frame();

    assert.equal(h.calls.fits > 0, true, 'the terminal was re-fitted');
    assert.equal(entry.terminal.hasSelection(), false, 'and the stale selection went with it');
    assert.equal(h.calls.selectionClears, 1);
  } finally { h.destroy(); }
});

test('#459: a drag that leaves the column count alone keeps the selection', async () => {
  const h = setupFilePanelDom();
  try {
    h.init();
    const entry = h.mount('s1', { cols: 95 }); // the fit proposes the same width
    h.switchPanel('s1');
    entry.terminal.selected = true;

    h.inCtx('refitActiveTerminal()');
    await h.frame();

    assert.equal(h.calls.fits > 0, true, 'the terminal was re-fitted');
    assert.equal(entry.terminal.hasSelection(), true, 'nothing re-wrapped, so nothing is dropped');
    assert.equal(h.calls.selectionClears, 0);
  } finally { h.destroy(); }
});
