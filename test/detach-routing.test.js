// #2 — where a session's bytes go, and the detach/reattach state machine behind it.
//
// The module takes BrowserWindow and the ipc object through ctx, so both halves run here without
// Electron. What is deliberately NOT covered: the window itself (bounds, show, preload) — that is
// Electron's, and asserting it would only restate the constructor call.

const test = require('node:test');
const assert = require('node:assert/strict');

const detach = require('../src/app/detach');

// A stand-in for BrowserWindow: records what it was asked, and can be destroyed like the real one.
function makeWindowClass(created) {
  return class FakeWindow {
    constructor(opts) {
      this.opts = opts;
      this.destroyed = false;
      this.shown = false;
      this.focused = 0;
      this.minimized = false;
      this.listeners = new Map();
      this.loaded = null;
      this.sent = [];
      this.webContents = { send: (...args) => this.sent.push(args) };
      created.push(this);
    }
    setMenu() {}
    loadFile(file, opts) { this.loaded = { file, opts }; }
    once(event, fn) { this.on(event, fn); }
    on(event, fn) { this.listeners.set(event, fn); }
    emit(event, ...args) { const fn = this.listeners.get(event); if (fn) fn(...args); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    show() { this.shown = true; }
    focus() { this.focused++; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    getBounds() { return { x: 10, y: 20, width: 1200, height: 800 }; }
  };
}

// A minimal ipcMain: registerIpc hands it handlers, the test calls them.
function makeIpc() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    call: (channel, ...args) => handlers.get(channel)(null, ...args),
    has: (channel) => handlers.has(channel),
  };
}

// One wired-up module per test: `detachedWindows` is module state, so every case starts from empty.
function setup({ sessions = ['s1'], quitting = false } = {}) {
  const created = [];
  const main = {
    destroyed: false,
    sent: [],
    isDestroyed() { return this.destroyed; },
    getBounds() { return { x: 100, y: 50, width: 1400, height: 900 }; },
    webContents: { send: (...a) => main.sent.push(a) },
  };
  const activeSessions = new Map(sessions.map((id) => [id, { pty: {} }]));
  detach.init({
    getMainWindow: () => (main.destroyed ? null : main),
    getAppQuitting: () => quitting,
    activeSessions,
    log: { info() {}, warn() {} },
    BrowserWindow: makeWindowClass(created),
  });
  const ipc = makeIpc();
  detach.registerIpc(ipc);
  detach.closeAll(); // clear whatever a previous test left behind
  main.sent.length = 0;
  return { ipc, main, created, activeSessions };
}

test('a session with no window of its own renders in the main window', () => {
  const { main } = setup();
  assert.equal(detach.windowForSession('s1'), main);
  assert.equal(detach.isDetached('s1'), false);
});

test('detaching routes that session — and only that session — to its own window', () => {
  const { ipc, main, created } = setup({ sessions: ['s1', 's2'] });
  const res = ipc.call('detach-session', 's1', 'Session one');
  assert.deepEqual(res, { ok: true });
  assert.equal(created.length, 1);
  assert.equal(detach.windowForSession('s1'), created[0]);
  assert.equal(detach.windowForSession('s2'), main, 'a second session keeps rendering in the main window');
});

test('the detach window loads index.html for its session, and is not a child of the main window', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'Session one');
  const win = created[0];
  assert.match(win.loaded.file, /index\.html$/);
  assert.deepEqual(win.loaded.opts, { query: { detached: 's1' } });
  assert.equal(win.opts.parent, undefined, 'a child window is always on top — that defeats a second monitor');
  assert.equal(win.opts.webPreferences.backgroundThrottling, false, 'a background monitor must keep painting');
  assert.equal(win.opts.title, 'Session one');
});

test('the main window is told to release the session it just handed over', () => {
  const { ipc, main } = setup();
  ipc.call('detach-session', 's1');
  assert.deepEqual(main.sent, [['session-detached', 's1']]);
});

test('a session with no live process cannot be detached', () => {
  const { ipc, created } = setup({ sessions: [] });
  const res = ipc.call('detach-session', 's1');
  assert.equal(res.ok, false);
  assert.match(res.error, /not running/);
  assert.equal(created.length, 0);
});

test('detaching twice focuses the window instead of opening a second one', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1');
  const res = ipc.call('detach-session', 's1');
  assert.deepEqual(res, { ok: true, already: true });
  assert.equal(created.length, 1);
  assert.equal(created[0].focused, 1);
});

test('reattaching closes the window and routes the session home again', () => {
  const { ipc, main, created } = setup();
  ipc.call('detach-session', 's1');
  main.sent.length = 0;
  const res = ipc.call('reattach-session', 's1');
  assert.deepEqual(res, { ok: true });
  assert.equal(created[0].isDestroyed(), true);
  assert.equal(detach.windowForSession('s1'), main);
  assert.deepEqual(main.sent, [['session-reattached', 's1']], 'exactly one notification, not one per path');
});

test('reattaching a session that was never detached is a no-op', () => {
  const { ipc, main } = setup();
  const res = ipc.call('reattach-session', 's1');
  assert.equal(res.ok, false);
  assert.deepEqual(main.sent, []);
});

test('closing the window by hand hands the session back', () => {
  const { ipc, main, created } = setup();
  ipc.call('detach-session', 's1');
  main.sent.length = 0;
  created[0].destroy(); // the user clicked the title-bar X
  assert.equal(detach.isDetached('s1'), false);
  assert.deepEqual(main.sent, [['session-reattached', 's1']]);
});

test('closeAll stays silent even when the app is NOT quitting', () => {
  // It runs from the main window's own close, where appQuitting is still false on the plain Alt+F4
  // path — so a reattach would fire into a renderer that is being torn down.
  const { ipc, main, created } = setup({ quitting: false });
  ipc.call('detach-session', 's1');
  main.sent.length = 0;
  detach.closeAll();
  assert.equal(created[0].isDestroyed(), true);
  assert.deepEqual(main.sent, []);
});

test('a re-keyed session takes its window with it', () => {
  const { ipc, main, created } = setup();
  ipc.call('detach-session', 's1');
  main.sent.length = 0;
  detach.rekey('s1', 's1-forked');
  // Output is sent under the new id from here on; without the migration it would go to the main
  // window while the detached one sat silent.
  assert.equal(detach.windowForSession('s1-forked'), created[0]);
  assert.equal(detach.windowForSession('s1'), main);
  assert.deepEqual(detach.detachedSessionIds(), ['s1-forked']);
  assert.deepEqual(created[0].sent, [['detached-session-rekeyed', 's1', 's1-forked']]);
  assert.deepEqual(main.sent, [['session-detach-rekeyed', 's1', 's1-forked']]);
});

test('re-keying a session that is not detached does nothing', () => {
  const { main } = setup();
  detach.rekey('s1', 's2');
  assert.deepEqual(main.sent, []);
  assert.deepEqual(detach.detachedSessionIds(), []);
});

test('on quit the windows go without asking the main window to take anything back', () => {
  const { ipc, main, created } = setup({ quitting: true });
  ipc.call('detach-session', 's1');
  main.sent.length = 0;
  detach.closeAll();
  assert.equal(created[0].isDestroyed(), true);
  assert.deepEqual(main.sent, [], 'the app is going away — a reattach would be for nobody');
  assert.deepEqual(detach.detachedSessionIds(), []);
});

test('a destroyed window stops claiming its session', () => {
  const { ipc, main, created } = setup();
  ipc.call('detach-session', 's1');
  created[0].destroyed = true; // gone without its event, e.g. an OS-level teardown
  assert.equal(detach.isDetached('s1'), false);
  assert.equal(detach.windowForSession('s1'), main);
});

test('with no main window at all, routing answers null rather than throwing', () => {
  const { main } = setup();
  main.destroyed = true;
  assert.equal(detach.windowForSession('s1'), null);
});

test('the renderer can ask what is detached', () => {
  const { ipc } = setup({ sessions: ['s1', 's2'] });
  ipc.call('detach-session', 's1');
  ipc.call('detach-session', 's2');
  assert.deepEqual(ipc.call('detached-session-ids').sort(), ['s1', 's2']);
  assert.equal(ipc.call('is-session-detached', 's1'), true);
  assert.equal(ipc.call('is-session-detached', 'nope'), false);
});

test('focusing a detached window restores it when minimized', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1');
  created[0].minimized = true;
  assert.deepEqual(ipc.call('focus-detached-window', 's1'), { ok: true });
  assert.equal(created[0].minimized, false);
  assert.equal(created[0].focused, 1);
  assert.deepEqual(ipc.call('focus-detached-window', 'nope'), { ok: false });
});
