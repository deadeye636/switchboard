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
    assert.equal(h.q('.fp-actions').style.display, 'none', 'the row goes — the question is answered');

    // A second press must not answer twice: the CLI's tools/call is already resolved, and the bridge
    // would drop it — but the panel is what has to know that.
    h.q('.file-panel-accept-btn')?.click();
    assert.equal(h.calls.diffResponses.length, 1);
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

test('in panes mode the panel asks for a pane tab instead of a side panel', async () => {
  const h = setupFilePanelDom({ panes: true });
  try {
    h.init();
    h.switchPanel('s1');
    h.ipc.openDiff('s1', 'diff-1', diffData());
    await h.settle();

    // A diff is a kind of its own now (#311) - it used to render through the preview host, because
    // both were the one #file-panel.
    assert.deepEqual(h.calls.openViewTab.map((c) => [c[0], c[1].ref]), [['diff', 'diff-1']]);
    assert.equal(h.panel().style.width, '', 'no side-panel width');
    assert.equal(h.document.getElementById('file-panel-resize-handle').style.display, 'none');

    h.window.closeFilePanel();
    assert.deepEqual(h.calls.closeViewTab.map((c) => [c[0], c[1] && c[1].ref]), [['diff', 'diff-1']]);
    assert.deepEqual(h.calls.diffResponses, [['s1', 'diff-1', 'reject', null]], 'closing answers it');
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
