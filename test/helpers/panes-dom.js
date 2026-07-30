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

// The elements panes-view addresses by id: the terminal host, the file panel, and every main-area
// view singleton it can adopt into a pane — five in #310, all eleven since #342.
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
    <div id="projects-viewer" style="display:none"></div>
    <div id="variables-admin-content" style="display:none"></div>
    <div id="work-files-viewer" style="display:none"></div>
    <div id="settings-viewer" style="display:none"></div>
    <div id="tasks-viewer" style="display:none"></div>
    <div id="bookmarks-viewer" style="display:none"></div>
    <div id="timeline-viewer" style="display:none"></div>
  </div>
  <div id="pane-live-region" aria-live="polite" aria-atomic="true"></div>
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
    closeAdminView: 0,
    clearActiveTerminalView: 0,
    filePanelRelayout: 0,
    closeFilePanel: 0,
    dialogs: [],
    toasts: [],
    renames: [],
    renameEnds: [],
  };
  // The inline rename as panes-view sees it: open or not, and in which element (#358).
  const renameState = { open: false, el: null };
  // What the next confirm dialog answers. `true` is the ordinary "the user pressed the button";
  // set it to false to exercise a cancel.
  const answers = { confirm: true };

  const openSessions = new Map();
  const sessionMap = new Map();
  const activePtyIds = new Set();

  // A mounted session as the renderer holds it: a container element plus the session record.
  function mount(sessionId, { type = 'agent', name = sessionId, running = true, projectPath = null } = {}) {
    const element = window.document.createElement('div');
    element.className = 'terminal-container';
    element.dataset.sessionId = sessionId;
    const session = { sessionId, name, type };
    if (projectPath) session.projectPath = projectPath;
    sessionMap.set(sessionId, session);
    // A stand-in xterm carrying only what panes-view reads of it: the scrollback budget (#352).
    // terminal-manager.js is not loaded here, so `SCROLLBACK_SINGLE` is not either — the value below
    // is that constant, and panes-view falls back to the same number when it cannot see it.
    openSessions.set(sessionId, {
      session, element, webglAddon: null,
      terminal: { options: { scrollback: 10000 } },
    });
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

    // The real `showSession` routes through the panes view first when the mode is on
    // (terminal-manager.js: `if (panesView.active() && panesView.show(sessionId))`). A stub that only
    // recorded the id would make every "clicking this shows that session" assertion pass without the
    // pane ever being asked.
    showSession: (id) => {
      calls.showSession.push(id);
      window.activeSessionId = id;
      if (window.panesView && window.panesView.active()) window.panesView.show(id);
    },
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
    hideAllViewers: () => {
      calls.hideAllViewers++;
      // The real one hides every main-area surface at once and puts the terminal area back. Stubbing
      // it as a counter alone would hide the observer cascade a real teardown produces.
      for (const id of ['jsonl-viewer', 'plan-viewer', 'stats-viewer', 'memory-viewer', 'projects-viewer',
        'work-files-viewer', 'settings-viewer', 'tasks-viewer', 'bookmarks-viewer', 'timeline-viewer']) {
        const el = window.document.getElementById(id);
        if (el) el.style.display = 'none';
      }
    },
    // The admin close route: the sidebar tab goes back, which is what hides the surface (#342).
    closeAdminView: () => {
      calls.closeAdminView++;
      for (const id of ['projects-viewer', 'variables-admin-content', 'stats-viewer']) {
        const el = window.document.getElementById(id);
        if (el) el.style.display = 'none';
      }
    },
    // What `shell/session-ipc.js` reaches into app.js for. Only the parts `rekeySessionState`
    // touches are real; the rest exist so the file can be loaded at all.
    pendingSessions: new Map(),
    userStoppedSessions: new Set(),
    terminalWriteBuffers: new Map(),
    sessionTimelineStore: { eventsBySession: new Map() },
    setActiveSession: (id) => { window.activeSessionId = id; },
    recordTimelineEvent: () => {},
    trackActivity: () => {},
    flowTrackReceived: () => {},
    scheduleFlush: () => {},
    recordFileTouched: () => {},
    handleSessionViewed: () => {},
    loadProjects: () => Promise.resolve([]),
    sessionRowEls: () => [],
    canonicalSessionRow: () => null,
    refreshSidebar: () => {},
    pollActiveSessions: () => {},
    setActivity: () => {},
    applyAttention: () => {},
    classifyAttentionSignal: () => null,
    gridViewActive: false,
    cachedProjects: [],
    cachedAllProjects: [],
    terminalHeaderName: window.document.createElement('span'),
    terminalHeaderPtyTitle: window.document.createElement('span'),
    gridViewerCount: window.document.createElement('span'),
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

  // Every `on*` registrar answers with a no-op so `shell/session-ipc.js` can be loaded for its
  // exported `rekeySessionState` without wiring the whole IPC surface.
  window.api = new Proxy({
    stopSession: (id) => { calls.stopSession.push(id); },
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop.startsWith('on')) return () => {};
      return () => Promise.resolve(null);
    },
  });
  window.isDetachedWindow = () => !!opts.detached;
  window.__detachedSessionId = opts.detachedSessionId || null;
  window.clearActiveTerminalView = () => { calls.clearActiveTerminalView++; window.activeSessionId = null; };
  window.filePanelRelayout = () => { calls.filePanelRelayout++; };
  window.closeFilePanel = () => { calls.closeFilePanel++; };
  window.filePanelTabLabel = () => 'Preview';
  // The inline rename the action bar's name calls (#358). It lives in app.js, which this harness does
  // not load — recorded rather than performed, since what the pane owes is the call with ITS element
  // and ITS session, not the editing behaviour (that is app.js's, and shared with the tabs header).
  // …and it puts the element into the same state the real one does, because that state is what panes-view
  // has to step around: a rebuild of the bar destroys the element the edit lives in. A recorder alone made
  // both of those defects invisible to the suite.
  window.startSessionRename = (el, sessionId) => {
    if (!el || renameState.open) return;
    calls.renames.push([el && el.className, sessionId, el && el.isConnected]);
    renameState.open = true;
    renameState.el = el;
    el.classList.add('editing');
    el.contentEditable = 'plaintext-only';
  };
  window.isSessionRenaming = (el) => {
    if (!renameState.open || !renameState.el || !renameState.el.isConnected) return false;
    return el ? renameState.el === el : true;
  };
  window.endSessionRename = (commit) => {
    if (!renameState.open) return;
    calls.renameEnds.push(commit !== false);
    renameState.el.classList.remove('editing');
    renameState.el.contentEditable = 'false';
    renameState.open = false;
    renameState.el = null;
  };
  window.isMcpActiveForSession = () => false;
  window.relaunchSession = () => {};

  const ctx = dom.getInternalVMContext();
  // grid-layout.js first: it spreads `pickGridNeighbor` (the spatial neighbour geometry panes mode
  // shares with the grid, #350) onto the window, and panes-view reads it as a bare global.
  // Same order as index.html. session-tabs.js loads AFTER panes-view.js there and is loaded here for
  // the same reason it is there: panes-view reaches into it at call time for the shared tab tooltip
  // and the project-path splitter (#334), and a harness without it would silently exercise the
  // fallbacks instead of the real thing.
  for (const rel of [
    'renderer/views/grid-layout.js',
    'renderer/views/pane-tree.js',
    'renderer/views/panes-view.js',
    'renderer/session/session-tabs.js',
    // Loaded for `window.rekeySessionState` (#346, #348) — the one function both the main window's
    // `session-forked` handler and a detached window's rekey call.
    'renderer/shell/session-ipc.js',
  ]) {
    vm.runInContext(fs.readFileSync(path.join(SRC_DIR, rel), 'utf8'), ctx, { filename: path.basename(rel) });
  }

  // `session-ipc.js` installs the real `clearActiveTerminalView` when it loads, replacing the stub
  // above. Wrap it rather than replacing it back: the tests want to know it was called AND want the
  // real thing to run.
  const realClear = window.clearActiveTerminalView;
  window.clearActiveTerminalView = () => {
    calls.clearActiveTerminalView++;
    if (typeof realClear === 'function') realClear();
  };

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
    renameState,
    openSessions,
    sessionMap,
    activePtyIds,
    mount,
    // Mount a session AND let the view adopt it, which is what the app's own open path does (a
    // mount is always followed by a showSession). `mount` alone changes the maps and nothing else,
    // so a test that only mounted was asserting against stale DOM.
    open: async (sessionId, opts) => {
      const m = mount(sessionId, opts);
      if (window.panesView && window.panesView.active()) window.panesView.render();
      await new Promise((r) => setTimeout(r, 0));
      return m;
    },
    unmount,
    readStored,
    rawStored: () => window.localStorage.getItem('paneTree'),
    panes: window.panesView,
    PaneTree: window.PaneTree,
    inCtx: (code) => vm.runInContext(code, ctx),
    // Turn panes mode on with the settings the app would pass.
    enable: (extra = {}) => window.panesView.applySettings({ sessionDisplayMode: 'panes', ...extra }),
    disable: (extra = {}) => window.panesView.applySettings({ sessionDisplayMode: 'grid', ...extra }),
    // panes-view schedules its rebuild in a microtask (scheduleRender); await this to let it land.
    settle: () => new Promise((r) => setTimeout(r, 0)),
    // Turn the view off before the window goes: that clears the persist debounce and ends any live
    // sash gesture. A timer left running fires into a closed jsdom window and the runner reports it
    // as an async leak from whichever test happened to be last.
    destroy: () => {
      try { window.panesView.applySettings({ sessionDisplayMode: 'grid' }); } catch { /* already off */ }
      window.close();
    },
  };
}

module.exports = { setupPanesDom };
