// A jsdom harness for src/renderer/views/panes-view.js.
//
// The file is a classic <script> that reaches into a dozen renderer globals and registers itself as
// `window.panesView`, so it cannot be require()d. Same shape as the terminal-manager harness: a
// jsdom window, the globals stubbed onto it, then the real source run in its VM context.
//
// It existed for nothing before #343-#346 — panes-view.js was the largest unguarded file in the
// renderer, and every defect those issues describe was found by reading or driving the app rather
// than by the suite.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');

// The elements panes-view addresses by id: the terminal host and the five view singletons it can
// adopt into a pane (#310).
const HTML = `<!DOCTYPE html><html><body>
  <div id="main">
    <div id="terminal-area">
      <div id="terminal-split">
        <div id="terminals"></div>
        <div id="file-panel"></div>
      </div>
      <div id="terminal-header"></div>
      <div id="placeholder"></div>
    </div>
    <div id="jsonl-viewer" style="display:none"></div>
    <div id="plan-viewer" style="display:none"></div>
    <div id="stats-viewer" style="display:none"></div>
    <div id="memory-viewer" style="display:none"></div>
  </div>
</body></html>`;

/**
 * Build a panes-view instance in a fresh jsdom window.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.detached]  report this window as a detached one (#2)
 * @param {string}  [opts.storedTree] raw JSON to seed localStorage's `paneTree` with
 * @returns harness — `window`, `panes` (the window.panesView facade), `calls` (a spy record),
 *          `mount`/`unmount` for fake sessions, `readStored`, `inCtx`, `destroy`
 */
function setupPanesDom(opts = {}) {
  const dom = new JSDOM(HTML, {
    url: 'http://localhost/' + (opts.detached ? '?detached=1' : ''),
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // jsdom does no layout, so every clientWidth/clientHeight is 0. `startSashDrag` bails on a
  // zero-extent branch and `updateToolsOverflow` would call every pane narrow, so report a
  // plausible box for the two elements the code measures.
  const box = (el, axis) => {
    if (!el.classList) return 0;
    if (el.classList.contains('pane-branch')) return axis === 'w' ? 1000 : 800;
    if (el.classList.contains('pane')) return axis === 'w' ? 500 : 800;
    return 0;
  };
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true, get() { return box(this, 'w'); },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
    configurable: true, get() { return box(this, 'h'); },
  });

  const calls = {
    showSession: [],
    destroySession: [],
    stopSession: [],
    openSession: [],
    safeFit: [],
    drain: [],
    flush: [],
    hideAllViewers: 0,
    clearActiveTerminalView: 0,
    filePanelRelayout: 0,
    closeFilePanel: 0,
    dialogs: [],
    toasts: [],
  };
  // What the next confirm dialog answers. `true` is the ordinary "the user pressed the button";
  // set it to false to exercise a cancel.
  const answers = { confirm: true };

  const openSessions = new Map();
  const sessionMap = new Map();
  const activePtyIds = new Set();

  // A mounted session as the renderer holds it: a container element plus the session record.
  function mount(sessionId, { type = 'agent', name = sessionId, running = true } = {}) {
    const element = window.document.createElement('div');
    element.className = 'terminal-container';
    element.dataset.sessionId = sessionId;
    const session = { sessionId, name, type };
    sessionMap.set(sessionId, session);
    openSessions.set(sessionId, { session, element, webglAddon: null });
    if (running) activePtyIds.add(sessionId);
    return { session, element };
  }

  function unmount(sessionId) {
    openSessions.delete(sessionId);
    activePtyIds.delete(sessionId);
  }

  if (opts.storedTree !== undefined) window.localStorage.setItem('paneTree', opts.storedTree);

  const stubs = {
    openSessions,
    sessionMap,
    activePtyIds,
    activeSessionId: null,
    launchExitedSessions: new Set(),
    subagentActiveSessions: new Set(),
    SESSION_STATUS_CLASSES: ['status-busy', 'status-idle'],
    terminalsEl: window.document.getElementById('terminals'),
    placeholder: window.document.getElementById('placeholder'),
    terminalHeader: window.document.getElementById('terminal-header'),

    showSession: (id) => { calls.showSession.push(id); window.activeSessionId = id; },
    // destroySession's real contract: it calls back into dropSession(), which is what takes the tab
    // out of the tree. A stub that only deleted the entry would make closePane look like it cleans
    // up when it does not.
    destroySession: (id) => {
      calls.destroySession.push(id);
      unmount(id);
      if (window.panesView) window.panesView.dropSession(id);
    },
    openSession: (session, _t, o) => { calls.openSession.push([session && session.sessionId, o]); },
    safeFit: (entry) => { calls.safeFit.push(entry); },
    flushTerminalBuffer: (id) => { calls.flush.push(id); },
    drainReplayBuffer: (id) => { calls.drain.push(id); },
    restoreTerminalWebgl: (id) => { const e = openSessions.get(id); if (e) e.webglAddon = {}; },
    suspendTerminalWebgl: (id) => { const e = openSessions.get(id); if (e) e.webglAddon = null; },
    forceRepaint: () => {},
    getSessionStatus: () => null,
    getSessionRuntimeState: () => ({}),
    cleanDisplayName: (s) => s || '',
    confirmAndStopSession: () => {},
    showJsonlViewer: () => {},
    openTasksView: () => {},
    hideAllViewers: () => { calls.hideAllViewers++; },
    // The two control-dialog helpers panes-view reaches for as bare globals (they are UMD exports
    // spread onto `window` by dialogs/control-dialogs.js in the real renderer).
    // `answers.whileOpen` runs before the dialog resolves — the window in which the world can move
    // under a caller that captured state before awaiting.
    showControlDialog: async (opts) => {
      calls.dialogs.push(opts);
      if (answers.whileOpen) await answers.whileOpen();
      return answers.confirm;
    },
    showControlToast: (opts) => { calls.toasts.push(opts); },
  };

  for (const [k, v] of Object.entries(stubs)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  window.api = {
    stopSession: (id) => { calls.stopSession.push(id); },
  };
  window.isDetachedWindow = () => !!opts.detached;
  window.__detachedSessionId = opts.detachedSessionId || null;
  window.clearActiveTerminalView = () => { calls.clearActiveTerminalView++; window.activeSessionId = null; };
  window.filePanelRelayout = () => { calls.filePanelRelayout++; };
  window.closeFilePanel = () => { calls.closeFilePanel++; };
  window.filePanelTabLabel = () => 'Preview';
  window.isMcpActiveForSession = () => false;
  window.relaunchSession = () => {};

  const ctx = dom.getInternalVMContext();
  for (const rel of ['renderer/views/pane-tree.js', 'renderer/views/panes-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(SRC_DIR, rel), 'utf8'), ctx, { filename: path.basename(rel) });
  }

  const readStored = () => {
    const raw = window.localStorage.getItem('paneTree');
    return raw ? JSON.parse(raw) : null;
  };

  // A pointer gesture as the sash drag sees it. jsdom has no PointerEvent, and the handlers only
  // read `button`, `clientX/Y` and `pointerId` — a MouseEvent carries the first two, and a missing
  // pointerId is exactly the "not capturable" case startSashDrag already tolerates.
  const pointer = (target, type, { x = 0, y = 0, button = 0 } = {}) => {
    const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
    target.dispatchEvent(ev);
    return ev;
  };

  return {
    window,
    document: window.document,
    pointer,
    calls,
    answers,
    openSessions,
    sessionMap,
    activePtyIds,
    mount,
    unmount,
    readStored,
    rawStored: () => window.localStorage.getItem('paneTree'),
    panes: window.panesView,
    PaneTree: window.PaneTree,
    inCtx: (code) => vm.runInContext(code, ctx),
    // Turn panes mode on with the settings the app would pass.
    enable: (extra = {}) => window.panesView.applySettings({ sessionDisplayMode: 'panes', ...extra }),
    disable: (extra = {}) => window.panesView.applySettings({ sessionDisplayMode: 'tabs', ...extra }),
    // panes-view schedules its rebuild in a microtask (scheduleRender); await this to let it land.
    settle: () => new Promise((r) => setTimeout(r, 0)),
    destroy: () => window.close(),
  };
}

module.exports = { setupPanesDom };
