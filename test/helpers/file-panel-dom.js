// A jsdom harness for src/renderer/views/file-panel.js.
//
// The file had ZERO coverage — nothing in the suite loaded it — while owning the preview and the diff,
// including the accept/reject that answers a CLI's `openDiff` over the MCP bridge. #311 turns its single
// tab into one instance per pane tab, which means touching the side-panel path that tabs AND grid mode
// share, so the behaviour worth pinning first is the behaviour that must not change.
//
// Same shape as `panes-dom.js`: a jsdom window, the globals stubbed onto it, then the real sources run in
// its VM context. Loaded in index.html's order, because that is what decides which name wins.
//
// Two things this harness deliberately does NOT provide:
//   - a real CodeMirror. `loadCodeMirrorBundle` injects an external <script>, which jsdom never fetches,
//     so it is replaced with a resolved promise AFTER viewer-panel.js has installed the real one. The
//     merge viewers are stubs that record what they were asked to render.
//   - a real main process. `window.api` is a proxy: every `on*` registrar keeps the callback so a test can
//     fire the IPC the bridge would, and everything else answers a promise.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');

// What file-panel.js addresses by id: the split container it builds around #terminals, and the header
// controls it hangs the IDE-emulation chip in.
const HTML = `<!DOCTYPE html><html><body>
  <div id="terminal-area">
    <div id="terminals"></div>
    <div id="terminal-header">
      <div id="terminal-header-controls"><button id="terminal-stop-btn"></button></div>
    </div>
  </div>
</body></html>`;

/**
 * @param {object} [opts]
 * @param {boolean} [opts.panes]   report panes mode as active (the pane-tab path instead of the side panel)
 * @param {string}  [opts.diffMode] seed `filePanelDiffMode` ('inline' | 'side-by-side')
 */
function setupFilePanelDom(opts = {}) {
  // `pretendToBeVisual` for `requestAnimationFrame`: the side panel refits the active terminal in one
  // after opening or closing, and without it jsdom has no such function at all.
  const dom = new JSDOM(HTML, {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;

  const calls = {
    diffResponses: [],   // [sessionId, diffId, action, editedContent]
    saves: [],           // [filePath, content]
    reads: [],           // filePath
    openedInEditor: [],
    mergeViewers: [],    // { mode, filePath, oldContent, newContent }
    viewerOpens: [],     // [label, filePath]
    viewerDestroys: 0,
    openViewTab: [],     // [kind, options]
    closeViewTab: [],
    refreshChrome: 0,
    refreshSidebar: 0,
    toasts: [],
    fits: 0,
    selectionClears: 0,
  };

  // What `readFileForPanel` answers, per path. A test that previews a file seeds it here.
  const files = new Map();

  // The IPC listeners file-panel registers. A test fires them the way main does when the bridge speaks.
  const ipc = {};
  // Which sessions might be showing a review. The real pane tree knows from its own tabs; here the
  // sessions a test has opened a diff for are exactly the ones worth asking about (#398).
  const reviewSessions = new Set();

  window.api = new Proxy({
    onMcpOpenDiff: (cb) => {
      ipc.openDiff = (sessionId, ...rest) => { reviewSessions.add(sessionId); return cb(sessionId, ...rest); };
    },
    onMcpOpenFile: (cb) => { ipc.openFile = cb; },
    onMcpCloseAllDiffs: (cb) => { ipc.closeAllDiffs = cb; },
    onMcpCloseTab: (cb) => { ipc.closeTab = cb; },
    mcpDiffResponse: (...args) => { calls.diffResponses.push(args); },
    saveFileForPanel: (filePath, content) => {
      calls.saves.push([filePath, content]);
      return Promise.resolve({ ok: true });
    },
    readFileForPanel: (filePath) => {
      calls.reads.push(filePath);
      return Promise.resolve(files.has(filePath)
        ? { ok: true, content: files.get(filePath) }
        : { ok: false });
    },
    readFileDataUrl: (filePath) => Promise.resolve({ ok: true, dataUrl: 'data:image/png;base64,AAAA' }),
    openInEditor: (filePath) => { calls.openedInEditor.push(filePath); },
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop.startsWith('on')) return () => {};
      return () => Promise.resolve(null);
    },
  });

  // A mounted session as app.js holds it. `refitActiveTerminal` reaches for `fitAddon` and, since
  // #459, for the terminal's column count and selection either side of the fit. `colsAfterFit` is
  // what the width drag does: a narrower panel leaves the terminal with fewer columns.
  const openSessions = new Map();
  function mount(sessionId, { cols = 80, colsAfterFit = null } = {}) {
    const terminal = {
      cols,
      selected: false,
      hasSelection: () => terminal.selected,
      clearSelection: () => { terminal.selected = false; calls.selectionClears++; },
    };
    const entry = {
      session: { sessionId },
      terminal,
      fitAddon: { fit: () => { calls.fits++; if (colsAfterFit !== null) terminal.cols = colsAfterFit; } },
    };
    openSessions.set(sessionId, entry);
    return entry;
  }

  // Stands in for the pane body an instanced view is hosted in.
  const paneHost = window.document.createElement('div');
  paneHost.id = 'fake-pane-body';
  window.document.body.appendChild(paneHost);

  // Panes mode as file-panel sees it: whether it is on, and the two calls it makes into the tree.
  const paneTabs = new Set();
  const panesView = {
    _active: !!opts.panes,
    active: () => panesView._active,
    // The tree's one job for an instanced kind: take the element file-panel built and put it on screen.
    // Without this the roots stay detached and every "is it there" assertion answers about nothing.
    openViewTab: (kind, options) => {
      calls.openViewTab.push([kind, options]);
      const key = kind + ':' + (options && options.ref);
      paneTabs.add(key);
      const host = window.filePanelHostFor?.(kind, options && options.ref);
      if (host) paneHost.appendChild(host);
      return true;
    },
    closeViewTab: (kind, options) => {
      calls.closeViewTab.push([kind, options]);
      paneTabs.delete(kind + ':' + (options && options.ref));
    },
    hasViewTab: (kind, ref) => paneTabs.has(kind + ':' + ref),
    refreshChrome: () => { calls.refreshChrome++; },
    // A REVIEW has no tab of its own since #398: it rides with its session's tab, and the tree puts it
    // on screen when it rebuilds. `render` is what file-panel calls instead of `openViewTab`, so this
    // stub does here what buildPane does there — otherwise the roots stay detached and every "is it on
    // screen" assertion answers about nothing.
    render: () => {
      calls.render = (calls.render || 0) + 1;
      for (const sessionId of reviewSessions) {
        const host = window.filePanelReviewHostFor?.(sessionId);
        if (host && host.parentNode !== paneHost) paneHost.appendChild(host);
      }
    },
  };

  const stubs = {
    openSessions,
    panesView,
    refreshSidebar: () => { calls.refreshSidebar++; },
    showControlToast: (o) => { calls.toasts.push(o); },
    // The merge viewers, recorded rather than rendered. `dom` has to be a real node — the panel appends
    // it — and `state.doc.toString()` / `b.state.doc.toString()` are what accept-edited reads.
    createMergeViewer: (body, oldContent, newContent, filePath) => {
      calls.mergeViewers.push({ mode: 'side-by-side', filePath, oldContent, newContent });
      const el = window.document.createElement('div');
      el.className = 'cm-merge-view';
      body.appendChild(el);
      return {
        dom: el,
        b: { state: { doc: { toString: () => newContent } } },
        state: { doc: { toString: () => newContent } },
        destroy() { el.remove(); },
      };
    },
    createUnifiedMergeViewer: (body, oldContent, newContent, filePath) => {
      calls.mergeViewers.push({ mode: 'inline', filePath, oldContent, newContent });
      const el = window.document.createElement('div');
      el.className = 'cm-editor';
      body.appendChild(el);
      return {
        dom: el,
        state: { doc: { toString: () => newContent } },
        destroy() { el.remove(); },
      };
    },
  };
  for (const [k, v] of Object.entries(stubs)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  if (opts.diffMode) window.localStorage.setItem('filePanelDiffMode', opts.diffMode);

  const ctx = dom.getInternalVMContext();
  for (const rel of [
    'shared/preview-kind.js',        // previewKindForExt + extOf, both read as bare globals
    'renderer/lib/utils.js',            // cleanDisplayName and friends, read bare all over the renderer
    'renderer/lib/a11y-utils.js',       // syncTitleToAriaLabel, which viewer-toolbar calls on every button
    'renderer/terminal/terminal-fit.js', // clearSelectionAfterReflow, which the width drag's refit calls
    'renderer/views/viewer-toolbar.js', // flashButtonText + createViewerToolbar
    'renderer/views/viewer-panel.js',   // the real ViewerPanel — it takes a container already
    'renderer/views/file-panel.js',
  ]) {
    vm.runInContext(fs.readFileSync(path.join(SRC_DIR, rel), 'utf8'), ctx, { filename: path.basename(rel) });
  }

  // AFTER viewer-panel.js, which installs the real one: it injects `<script src="codemirror-bundle.js">`,
  // and jsdom fetches nothing, so the promise would never settle and no diff would ever render.
  window.loadCodeMirrorBundle = () => Promise.resolve();

  // Record what the ViewerPanel was asked to show. Wrapping the prototype rather than replacing the class
  // keeps the real component in the picture — the panel's own behaviour is what is under test.
  const proto = window.ViewerPanel.prototype;
  const realOpen = proto.open;
  const realDestroy = proto.destroy;
  proto.open = function (label, filePath, content) {
    calls.viewerOpens.push([label, filePath]);
    return realOpen.call(this, label, filePath, content);
  };
  proto.destroy = function () {
    calls.viewerDestroys++;
    return realDestroy.call(this);
  };

  const inCtx = (code) => vm.runInContext(code, ctx);

  return {
    window,
    document: window.document,
    calls,
    files,
    ipc,
    openSessions,
    panesView,
    mount,
    inCtx,
    // file-panel.js keeps its API as top-level function declarations, which land on the VM's global — so
    // the tests drive the same entry points app.js does, rather than a re-implementation.
    init: () => inCtx('initFilePanel()'),
    switchPanel: (sessionId) => inCtx(`switchPanel(${JSON.stringify(sessionId)})`),
    openFileInPanel: (sessionId, filePath) =>
      inCtx(`openFileInPanel(${JSON.stringify(sessionId)}, ${JSON.stringify(filePath)})`),
    state: (sessionId) => inCtx(`filePanelState.get(${JSON.stringify(sessionId)})`),
    // A tick for the deferred merge-viewer creation (`loadCodeMirrorBundle().then(...)`).
    settle: () => new Promise((r) => setTimeout(r, 0)),
    // A real animation frame, for what the panel defers to one — the terminal re-fit.
    frame: () => new Promise((r) => window.requestAnimationFrame(() => r())),
    panel: () => window.document.getElementById('file-panel'),
    q: (sel) => window.document.querySelector(sel),
    qa: (sel) => [...window.document.querySelectorAll(sel)],
    destroy: () => window.close(),
  };
}

module.exports = { setupFilePanelDom };
