'use strict';
// #514 — a session whose process has ended must read as ended everywhere at once.
//
// The two answers the app gives about "is this session running" are `activePtyIds` (every surface asks
// `getSessionStatus`/`sessionIsLive` about it) and the pending branch of `getSessionStatus`
// (`pendingSessions` minus `launchExitedSessions`). Both are written by `src/renderer/shell/session-ipc.js`,
// so that is what this drives — the real file, in a vm, not a replica of its logic. A replica is what
// `test/running-indicators.test.js` had to settle for, and a replica cannot fail when the shipped file
// changes.
//
// No jsdom: session-ipc.js touches no DOM outside the handler branches these tests do not enter, so a
// plain vm context with the renderer globals on it is the whole harness. `window` IS that global object,
// which is also how the renderer runs — a classic <script>'s top-level names and `window.*` share one
// scope there (`.claude/rules/renderer.md`).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src', 'renderer', 'shell', 'session-ipc.js');

// The `window.api.on*` registrations run at parse time. Each one is recorded so a test can fire the
// event the way main does; the `get*` pair is answered with a promise that resolves to nothing.
const IPC_EVENTS = [
  'onTerminalData', 'onMcpOpenDiff', 'onMcpOpenFile', 'onSessionDetected', 'onSessionForked',
  'onResumeConflict', 'onLiveOwners', 'onStoreRecordNotices', 'onProcessExited',
  'onTerminalNotification', 'onSessionNotice', 'onAttentionSignal', 'onCliBusyState',
  'onTimelineSignal',
];

function loadSessionIpc(state = {}) {
  const handlers = {};
  const calls = { refreshSidebar: 0, pollActiveSessions: 0, destroySession: [], loadProjects: 0 };
  const api = {
    getLiveOwners: () => Promise.resolve([]),
    getStoreRecordNotices: () => Promise.resolve([]),
  };
  for (const name of IPC_EVENTS) api[name] = (cb) => { handlers[name] = cb; };

  const sandbox = {
    api,
    // --- the session tables app.js owns ---
    openSessions: state.openSessions || new Map(),
    sessionMap: state.sessionMap || new Map(),
    pendingSessions: state.pendingSessions || new Map(),
    launchExitedSessions: state.launchExitedSessions || new Set(),
    userStoppedSessions: state.userStoppedSessions || new Set(),
    activePtyIds: state.activePtyIds || new Set(),
    attentionSessions: new Set(),
    attentionReason: new Map(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map(),
    finishedAt: new Map(),
    subagentActiveSessions: new Set(),
    sessionTimelineStore: { events: new Map(), loaded: new Set() },
    cachedProjects: state.cachedProjects || [],
    cachedAllProjects: state.cachedAllProjects || [],
    activeSessionId: state.activeSessionId || null,
    gridViewActive: false,
    gridCards: new Map(),
    gridViewerCount: { textContent: '' },
    terminalHeader: { style: {} },
    terminalHeaderName: { textContent: '' },
    terminalHeaderPtyTitle: { textContent: '', style: {} },
    placeholder: { style: {} },
    // --- the functions the handlers call ---
    setActiveSession: (id) => { sandbox.activeSessionId = id; },
    dropTimeline: () => {},
    refreshSidebar: () => { calls.refreshSidebar++; },
    pollActiveSessions: () => { calls.pollActiveSessions++; },
    destroySession: (id) => { calls.destroySession.push(id); },
    showGridView: () => {},
    loadProjects: () => { calls.loadProjects++; return Promise.resolve(); },
    sessionRowEls: () => [],
    canonicalSessionRow: () => null,
    trackActivity: () => {},
    recordFileTouched: () => {},
    handleSessionViewed: () => {},
    flowTrackReceived: () => {},
    scheduleFlush: () => {},
    terminalWriteBuffers: new Map(),
    applyAttention: () => {},
    classifyAttentionSignal: () => ({}),
    setActivity: () => {},
    setExactActivity: () => {},
    showControlToast: () => {},
    setLiveOwners: () => {},
    setStoreRecordNotices: () => {},
    addTimelineEvent: () => {},
    document: { querySelectorAll: () => [] },
    console,
  };
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });
  return { sandbox, handlers, calls };
}

// A session in the state `launchNewSession` leaves behind: one record object shared by the pending
// entry, the sidebar map and (when mounted) the terminal entry.
function pendingSession(sandbox, id, { mounted = true } = {}) {
  const session = { sessionId: id, projectPath: '/tmp/example', summary: 'New session' };
  sandbox.sessionMap.set(id, session);
  sandbox.pendingSessions.set(id, { session, projectPath: '/tmp/example', folder: 'example' });
  if (mounted) {
    sandbox.openSessions.set(id, { session, closed: false, terminal: { write() {} }, element: {} });
  }
  return session;
}

// ---------------------------------------------------------------------------
// The push retracts the id in the set every surface reads
// ---------------------------------------------------------------------------

test('process-exited takes the session out of activePtyIds without waiting for the poll', () => {
  const { sandbox, handlers } = loadSessionIpc();
  pendingSession(sandbox, 'sess-1');
  sandbox.activePtyIds.add('sess-1');

  handlers.onProcessExited('sess-1', 0);

  // The pane placeholder (`sessionIsLive`), the tab dot, the grid card and the sidebar row all ask this
  // one set. Before #514 it stayed populated until `getActiveSessions` answered, so anything that
  // repainted in between disagreed with the tab that had just drawn its Launch button.
  assert.equal(sandbox.activePtyIds.has('sess-1'), false);
});

test('a relaunch is still the poll’s to restore — the exit only retracts the id it was told about', () => {
  const { sandbox, handlers } = loadSessionIpc();
  pendingSession(sandbox, 'sess-1');
  pendingSession(sandbox, 'sess-2');
  sandbox.activePtyIds.add('sess-1');
  sandbox.activePtyIds.add('sess-2');

  handlers.onProcessExited('sess-1', 0);

  assert.deepEqual([...sandbox.activePtyIds], ['sess-2']);
});

// ---------------------------------------------------------------------------
// The re-key moves the sidebar's state whether or not a terminal is mounted here
// ---------------------------------------------------------------------------

test('an adoption re-keys the pending row even when this window has no mounted terminal', () => {
  const { sandbox } = loadSessionIpc();
  const session = pendingSession(sandbox, 'launch-id', { mounted: false });

  assert.equal(sandbox.window.rekeySessionState('launch-id', 'real-id'), true);

  assert.equal(sandbox.pendingSessions.has('launch-id'), false);
  assert.equal(sandbox.pendingSessions.has('real-id'), true);
  assert.equal(sandbox.sessionMap.has('launch-id'), false);
  assert.equal(sandbox.sessionMap.get('real-id'), session);
  assert.equal(session.sessionId, 'real-id');
});

test('the exit under the adopted id retracts the Running the pending row was asserting', () => {
  const { sandbox, handlers } = loadSessionIpc();
  pendingSession(sandbox, 'launch-id', { mounted: false });
  sandbox.window.rekeySessionState('launch-id', 'real-id');

  // `src/watch/adopt.js` drops the launch id from main's `activeSessions` when it adopts, so the exit
  // can only ever name the adopted id. That is the whole failure: the marker has to land where the
  // pending entry now is.
  handlers.onProcessExited('real-id', 0);

  // Asked of every id this window still has a pending row under, not of the id the test happens to
  // know: the defect was precisely that the row the sidebar draws sat under an id nothing would name
  // again, so an assertion about `real-id` alone passes while the stranded row keeps its green dot.
  for (const id of sandbox.pendingSessions.keys()) {
    assert.notEqual(getStatus(sandbox, id).key, 'running', `pending row ${id} still reads Running`);
  }
  assert.equal(sandbox.pendingSessions.size, 1);
});

test('a window that holds nothing under the old id still refuses the re-key', () => {
  const { sandbox } = loadSessionIpc();
  assert.equal(sandbox.window.rekeySessionState('unknown-id', 'real-id'), false);
  assert.equal(sandbox.window.rekeySessionState('same', 'same'), false);
  assert.equal(sandbox.window.rekeySessionState('old', ''), false);
});

test('a mounted session re-keys exactly as it did — the terminal entry moves with the row', () => {
  const { sandbox } = loadSessionIpc();
  const session = pendingSession(sandbox, 'launch-id', { mounted: true });
  const entry = sandbox.openSessions.get('launch-id');
  sandbox.activeSessionId = 'launch-id';

  assert.equal(sandbox.window.rekeySessionState('launch-id', 'real-id'), true);

  assert.equal(sandbox.openSessions.has('launch-id'), false);
  assert.equal(sandbox.openSessions.get('real-id'), entry);
  assert.equal(sandbox.activeSessionId, 'real-id');
  assert.equal(sandbox.pendingSessions.has('real-id'), true);
  assert.equal(sandbox.sessionMap.get('real-id'), session);
  assert.equal(session.sessionId, 'real-id');
});

// ---------------------------------------------------------------------------
// The two surfaces, asked the same question through the code they each use
// ---------------------------------------------------------------------------

const { getSessionStatus } = require('../src/renderer/session/session-status.js');

function getStatus(sandbox, sessionId) {
  return getSessionStatus({ sessionId }, {
    attentionSessions: sandbox.attentionSessions,
    responseReadySessions: sandbox.responseReadySessions,
    sessionBusyState: sandbox.sessionBusyState,
    activePtyIds: sandbox.activePtyIds,
    openSessions: sandbox.openSessions,
    pendingSessions: sandbox.pendingSessions,
    launchExitedSessions: sandbox.launchExitedSessions,
  });
}

// `sessionIsLive` in views/panes-view.js, which is what decides between the two pane placeholders.
const paneSaysRunning = (sandbox, id) => sandbox.activePtyIds.has(id);

test('sidebar and pane placeholder agree the moment the exit lands, mounted or not', () => {
  for (const mounted of [true, false]) {
    const { sandbox, handlers } = loadSessionIpc();
    pendingSession(sandbox, 'launch-id', { mounted });
    sandbox.activePtyIds.add('launch-id');
    sandbox.window.rekeySessionState('launch-id', 'real-id');
    sandbox.activePtyIds.delete('launch-id');
    sandbox.activePtyIds.add('real-id');

    assert.equal(getStatus(sandbox, 'real-id').key, 'running', `mounted=${mounted}: running before the exit`);
    assert.equal(paneSaysRunning(sandbox, 'real-id'), true);

    handlers.onProcessExited('real-id', 0);

    assert.equal(paneSaysRunning(sandbox, 'real-id'), false, `mounted=${mounted}: the pane`);
    assert.notEqual(getStatus(sandbox, 'real-id').key, 'running', `mounted=${mounted}: the sidebar row`);
  }
});
