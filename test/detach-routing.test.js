// #2 — where a session's bytes go, and the detach/reattach state machine behind it.
//
// The module takes BrowserWindow and the ipc object through ctx, so both halves run here without
// Electron. What is deliberately NOT covered: the window itself (bounds, show, preload) — that is
// Electron's, and asserting it would only restate the constructor call.

const test = require('node:test');
const assert = require('node:assert/strict');

const detach = require('../src/app/detach');

// A stand-in for BrowserWindow: records what it was asked, and can be destroyed like the real one.
let nextWindowId = 1;
function makeWindowClass(created, main, { loadingOnCreate = false } = {}) {
  return class FakeWindow {
    // Electron's own static. `sessions-in-my-window` addresses a window by its ASKER, so the test has
    // to be able to answer "which window is this webContents?" the way the real class does — and that
    // includes the MAIN window, which is not one of ours but is very much a window Electron knows.
    static fromWebContents(sender) {
      if (main && sender === main.webContents) return main;
      return created.find((w) => w.webContents === sender) || null;
    }

    constructor(opts) {
      this.opts = opts;
      this.id = nextWindowId++;
      this.destroyed = false;
      this.shown = false;
      this.focused = 0;
      this.minimized = false;
      this.listeners = new Map();
      this.loaded = null;
      this.sent = [];
      // `isLoading` / `once` are what `open-view-in-window` reads (#364): a message sent to a renderer
      // that has not loaded yet is dropped silently by Electron, so delivery waits for it.
      // A window made a moment ago is ALWAYS loading, which is the case `open-view-in-new-window`
      // (#370) has to survive — but most tests here act on windows that have long since loaded, so
      // this is opt-in rather than the default.
      this.loading = loadingOnCreate;
      this.loadListeners = [];
      this.webContents = {
        send: (...args) => this.sent.push(args),
        isLoading: () => this.loading,
        once: (event, fn) => { if (event === 'did-finish-load') this.loadListeners.push(fn); },
      };
      // Where this window sits on screen. A field rather than a constant, because `window-at-screen-point`
      // (#360) is decided by geometry and every window answering the same rectangle would test nothing.
      this.bounds = { x: 10, y: 20, width: 1200, height: 800 };
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
    getBounds() { return this.bounds; }
    getTitle() { return this.opts.title; }
    finishLoad() { this.loading = false; const fns = this.loadListeners; this.loadListeners = []; fns.forEach((fn) => fn()); }
  };
}

// A minimal ipcMain: registerIpc hands it handlers, the test calls them.
function makeIpc() {
  const handlers = new Map();
  // `on` is the fire-and-forget half. It carries the ANSWER to a question main asked a renderer
  // (#375), which `handle` cannot express — that direction has no reply channel of its own.
  const listeners = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
    call: (channel, ...args) => handlers.get(channel)(null, ...args),
    // For the handlers that answer the ASKER rather than an argument (`sessions-in-my-window`).
    callFrom: (channel, sender, ...args) => handlers.get(channel)({ sender }, ...args),
    emit: (channel, sender, ...args) => listeners.get(channel)({ sender }, ...args),
    has: (channel) => handlers.has(channel) || listeners.has(channel),
  };
}

// One wired-up module per test: `detachedWindows` is module state, so every case starts from empty.
// `screen` is optional (#362): without it placement falls back to the offset from the main window,
// which is what a single-display machine and every pre-#362 test expect.
function setup({ sessions = ['s1'], quitting = false, screen = undefined, loadingOnCreate = false, settings = null } = {}) {
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
    BrowserWindow: makeWindowClass(created, main, { loadingOnCreate }),
    screen,
    // Where the windows are remembered (#371). Absent in every test that predates it, which is also
    // the shape of a build where the settings store is not wired: nothing is saved and nothing breaks.
    getSetting: settings ? settings.getSetting : undefined,
    setSetting: settings ? settings.setSetting : undefined,
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
  assert.deepEqual(res, { ok: true, windowId: String(created[0].id) });
  assert.equal(created.length, 1);
  assert.equal(detach.windowForSession('s1'), created[0]);
  assert.equal(detach.windowForSession('s2'), main, 'a second session keeps rendering in the main window');
});

test('the detach window loads index.html for its session, and is not a child of the main window', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'Session one');
  const win = created[0];
  assert.match(win.loaded.file, /index\.html$/);
  // `win=detached` is the identity marker (#370): the renderer's "am I one of ours" cannot be the
  // session id any more, because a window holding only a view has no session and must still say yes.
  assert.deepEqual(win.loaded.opts, { query: { win: 'detached', detached: 's1' } });
  assert.equal(win.opts.parent, undefined, 'a child window is always on top — that defeats a second monitor');
  assert.equal(win.opts.webPreferences.backgroundThrottling, false, 'a background monitor must keep painting');
  assert.equal(win.opts.title, 'Session one');
});

test('the main window is told to release the session it just handed over', () => {
  const { ipc, main } = setup();
  ipc.call('detach-session', 's1');
  assert.deepEqual(main.sent, [['session-detached', 's1']]);
});

// #319 reversed this. The refusal existed because the new window mounted by calling openTerminal,
// which SPAWNS when it finds no live PTY — so a detach used to start a CLI on its own. The renderer
// stopped doing that (#318/#319: a session without a process is shown with a Launch button), so the
// window may open; what must not happen is a process appearing because of it.
test('a session with no live process gets its window too, and nothing is started', () => {
  const { ipc, created, activeSessions } = setup({ sessions: [] });
  assert.equal(ipc.call('detach-session', 's1', 'Dormant one').ok, true);
  assert.equal(created.length, 1);
  assert.equal(detach.windowForSession('s1'), created[0]);
  assert.equal(activeSessions.size, 0, 'detaching is a view operation — it never spawns');
});

test('a move no longer needs a process, and moving one starts nothing', () => {
  // #332: the refusal that stood here predated #319. The rule it protected ("a window change never
  // resumes a CLI") lives in the renderer now, which is where the mount happens — so main lets the
  // move through and says, in the adopt, that there is nothing running to attach to.
  const { ipc, main, created, activeSessions } = setup({ sessions: [] });
  ipc.call('detach-session', 's1');
  main.sent.length = 0;

  assert.deepEqual(ipc.call('move-session-to-window', 's1', 'main'), { ok: true });
  assert.deepEqual(main.sent, [['session-reattached', 's1', false, null]]);
  assert.equal(activeSessions.size, 0, 'a move is a view operation — it never spawns');
  assert.equal(created[0].destroyed, true, 'the window gave away its last session');
});

test('a session with no id is still refused', () => {
  const { ipc, created } = setup({ sessions: [] });
  assert.equal(ipc.call('detach-session', '').ok, false);
  assert.equal(created.length, 0);
});

test('detaching twice focuses the window instead of opening a second one', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1');
  const res = ipc.call('detach-session', 's1');
  assert.deepEqual(res, { ok: true, already: true, windowId: String(created[0].id) });
  assert.equal(created.length, 1);
  assert.equal(created[0].focused, 1);
});

// #340: moving a whole PANE is "detach the first tab, then move the rest to where it went", so the
// caller needs the window it just made by name. Both answers carry it — a second detach of the same
// session is the "it is already over there" case, and the pane's remaining tabs still have to follow
// it rather than the call reading as a no-op.
test('a detach answers with the id of the window it made, so more sessions can follow it (#340)', () => {
  const { ipc, created } = setup({ sessions: ['s1', 's2'] });
  const windowId = ipc.call('detach-session', 's1', 'Session one').windowId;
  assert.equal(windowId, String(created[0].id));
  // The id it answers with is the one `move-session-to-window` takes — that is the whole point of it.
  assert.deepEqual(ipc.call('move-session-to-window', 's2', windowId), { ok: true });
  assert.equal(detach.windowForSession('s2'), created[0], 'the second session went to the same window');
});

test('reattaching closes the window and routes the session home again', () => {
  const { ipc, main, created } = setup();
  ipc.call('detach-session', 's1');
  main.sent.length = 0;
  const res = ipc.call('move-session-to-window', 's1', 'main');
  assert.deepEqual(res, { ok: true });
  assert.equal(created[0].isDestroyed(), true);
  assert.equal(detach.windowForSession('s1'), main);
  assert.deepEqual(main.sent, [['session-reattached', 's1', true, null]], 'exactly one notification, not one per path');
});

test('reattaching a session that was never detached is a no-op', () => {
  const { ipc, main } = setup();
  const res = ipc.call('move-session-to-window', 's1', 'main');
  assert.deepEqual(res, { ok: true, already: true }, 'it is already where it would be moved to');
  assert.deepEqual(main.sent, []);
});

test('closing the window by hand hands the session back', () => {
  const { ipc, main, created } = setup();
  ipc.call('detach-session', 's1');
  main.sent.length = 0;
  created[0].destroy(); // the user clicked the title-bar X
  assert.equal(detach.isDetached('s1'), false);
  assert.deepEqual(main.sent, [['session-reattached', 's1', true, null]]);
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

// --- Moving a session between windows (#314, #315, #316) ---------------------
//
// The same handover as detach, with either end able to be a detached window. What these pin is the
// ORDER — release, re-register, adopt — because that order is what keeps one PTY on one renderer.

test('the window list names every window and marks the one holding the session', () => {
  const { ipc } = setup({ sessions: ['s1', 's2'] });
  let windows = ipc.call('list-session-windows', 's1');
  assert.deepEqual(windows.map((w) => w.id), ['main']);
  assert.equal(windows[0].current, true, 'an undetached session is in the main window');

  ipc.call('detach-session', 's1', 'Session one');
  windows = ipc.call('list-session-windows', 's1');
  assert.equal(windows.length, 2);
  assert.equal(windows[0].current, false, 'no longer in main');
  assert.equal(windows[1].title, 'Session one');
  assert.equal(windows[1].current, true);
  assert.deepEqual(windows[1].sessionIds, ['s1']);
  // Main's set is not knowable from here — it renders everything this map does not claim. `null`
  // says that; an empty array would read as "holds nothing" (#327).
  assert.equal(windows[0].sessionIds, null);
  // Asked about a session that is NOT in that window, the same window is not current.
  assert.equal(ipc.call('list-session-windows', 's2')[1].current, false);
});

test('moving a session home releases the detached window and tells main to take it', () => {
  const { ipc, main, created } = setup();
  ipc.call('detach-session', 's1');
  main.sent.length = 0;
  const win = created[0];
  win.sent.length = 0;

  assert.deepEqual(ipc.call('move-session-to-window', 's1', 'main'), { ok: true });
  assert.deepEqual(win.sent[0], ['session-detached', 's1'], 'the window that had it lets go first');
  assert.deepEqual(main.sent, [['session-reattached', 's1', true, null]]);
  assert.equal(detach.isDetached('s1'), false);
  assert.equal(detach.windowForSession('s1'), main);
  assert.equal(win.destroyed, true, 'a window with nothing left to show closes');
});

test('a window that gave away its last session hands nothing back when it closes', () => {
  const { ipc, main, created } = setup();
  ipc.call('detach-session', 's1');
  ipc.call('move-session-to-window', 's1', 'main');
  const reattaches = main.sent.filter(([channel]) => channel === 'session-reattached');
  assert.equal(reattaches.length, 1, 'the close must not repeat the handover');
  assert.equal(created[0].destroyed, true);
});

test('a session moves from the main window into an existing detached window', () => {
  const { ipc, main, created } = setup({ sessions: ['s1', 's2'] });
  ipc.call('detach-session', 's1', 'Session one');
  const win = created[0];
  main.sent.length = 0;
  win.sent.length = 0;

  assert.deepEqual(ipc.call('move-session-to-window', 's2', String(win.id)), { ok: true });
  assert.deepEqual(main.sent, [['session-detached', 's2']], 'main releases it');
  assert.deepEqual(win.sent, [['session-reattached', 's2', true, null]], 'the window takes it');
  assert.equal(detach.windowForSession('s2'), win);
  assert.deepEqual(detach.sessionsInWindow(win).sort(), ['s1', 's2']);
  assert.equal(created.length, 1, 'no new window is opened for a move');
});

test('a session moves from one detached window to another, and the empty one closes', () => {
  const { ipc, created } = setup({ sessions: ['s1', 's2'] });
  ipc.call('detach-session', 's1', 'Session one');
  ipc.call('detach-session', 's2', 'Session two');
  const [winA, winB] = created;
  winA.sent.length = 0;
  winB.sent.length = 0;

  assert.deepEqual(ipc.call('move-session-to-window', 's2', String(winA.id)), { ok: true });
  assert.deepEqual(winB.sent, [['session-detached', 's2']]);
  assert.deepEqual(winA.sent, [['session-reattached', 's2', true, null]]);
  assert.deepEqual(detach.sessionsInWindow(winA).sort(), ['s1', 's2']);
  assert.equal(winB.destroyed, true, 'its last session left');
  assert.equal(detach.windowForSession('s2'), winA);
});

test('closing a window with several sessions hands every one of them back', () => {
  const { ipc, main, created } = setup({ sessions: ['s1', 's2'] });
  ipc.call('detach-session', 's1', 'Session one');
  const win = created[0];
  ipc.call('move-session-to-window', 's2', String(win.id));
  main.sent.length = 0;

  win.destroy();
  assert.deepEqual([...main.sent].sort((a, b) => a[1].localeCompare(b[1])),
    [['session-reattached', 's1', true, null], ['session-reattached', 's2', true, null]]);
  assert.equal(detach.isDetached('s1'), false);
  assert.equal(detach.isDetached('s2'), false);
});

test('moving a session to the window it is already in changes nothing', () => {
  const { ipc, main, created } = setup();
  ipc.call('detach-session', 's1');
  const win = created[0];
  main.sent.length = 0;
  win.sent.length = 0;

  assert.deepEqual(ipc.call('move-session-to-window', 's1', String(win.id)), { ok: true, already: true });
  assert.deepEqual(win.sent, []);
  assert.deepEqual(main.sent, []);
  assert.equal(win.destroyed, false);
});

test('a move still refuses a window that is gone, and leaves the source alone', () => {
  const { ipc, created } = setup({ sessions: ['s1'] });
  ipc.call('detach-session', 's1');
  assert.equal(ipc.call('move-session-to-window', '').ok, false);
  assert.match(ipc.call('move-session-to-window', 's1', '9999').error, /window is gone/);
  assert.equal(created[0].destroyed, false, 'a refused move leaves the window alone');
});

// --- A dormant session is not stranded in a window it shares (#332) ---------------------------
//
// Reachable only since #319, which let a session without a process be detached at all. The window
// holds one dormant and one live session; before this, the dormant one could not be moved and the
// only exit was closing the window — which handed the live one back too and took its window with it.

test('a dormant session leaves the window it shares, and the live one stays where it is', () => {
  const { ipc, main, created, activeSessions } = setup({ sessions: ['s1', 's2'] });
  ipc.call('detach-session', 's1');
  const win = created[0];
  ipc.call('move-session-to-window', 's2', String(win.id));
  activeSessions.delete('s1'); // its CLI exits while the window shows both
  main.sent.length = 0;
  win.sent.length = 0;

  assert.deepEqual(ipc.call('move-session-to-window', 's1', 'main'), { ok: true });
  assert.deepEqual(win.sent, [['session-detached', 's1']], 'the window it leaves lets go of it');
  assert.deepEqual(main.sent, [['session-reattached', 's1', false, null]], 'and main is told nothing runs');
  assert.equal(detach.windowForSession('s1'), main);
  assert.equal(win.destroyed, false, 'the window stays — it still holds the live session');
  assert.deepEqual(detach.sessionsInWindow(win), ['s2']);
});

test('a dormant session moves into an existing detached window', () => {
  // The renderer decides whether the TARGET can show one — a pane draws a dormant tab, the tabs-mode
  // strip has no entry for an unmounted session. Main's part is that the map follows and the adopt is
  // honest about the process, so the taking window mounts nothing.
  const { ipc, main, created, activeSessions } = setup({ sessions: ['s1', 's2'] });
  ipc.call('detach-session', 's1');
  const win = created[0];
  activeSessions.delete('s2'); // s2 sits dormant in the main window
  win.sent.length = 0;
  main.sent.length = 0;

  assert.deepEqual(ipc.call('move-session-to-window', 's2', String(win.id)), { ok: true });
  assert.deepEqual(main.sent, [['session-detached', 's2']]);
  assert.deepEqual(win.sent, [['session-reattached', 's2', false, null]]);
  assert.equal(detach.windowForSession('s2'), win);
  assert.equal(activeSessions.has('s2'), false, 'still nothing spawned');
});

test('the adopt notification carries whether the process is still alive', () => {
  // The taking window must not resume a CLI that has ended, and its own `activePtyIds` is a polled
  // snapshot — up to half a minute stale in an idle window. Main answers from the live map instead.
  const { ipc, main, created, activeSessions } = setup();
  ipc.call('detach-session', 's1');
  const win = created[0];
  activeSessions.delete('s1'); // the PTY exited while the session was detached
  main.sent.length = 0;

  win.destroy(); // the user closes the window of a session that is no longer running
  assert.deepEqual(main.sent, [['session-reattached', 's1', false, null]]);
});

// --- What a window holds, asked by the window itself (#326, #331) ------------------------------
//
// A detached window's URL names ONE session. Everything moved in later lives only in main's map, so
// after a reload — or after a move that landed while the window was still booting — the window and
// main disagree about what it holds, and main is the one that decides where the bytes go.

test('a detached window can ask main which sessions it holds', () => {
  const { ipc, created } = setup({ sessions: ['s1', 's2'] });
  ipc.call('detach-session', 's1');
  const win = created[0];
  ipc.call('move-session-to-window', 's2', String(win.id));

  assert.deepEqual(ipc.callFrom('sessions-in-my-window', win.webContents).sort(), ['s1', 's2'],
    'both, not just the one in the URL');
});

test('the main window holds nothing in that map, and says so', () => {
  // Not "no sessions" — everything NOT in the map is main's already. The question only means
  // something for a window that has a set of its own.
  const { ipc, main } = setup({ sessions: ['s1'] });
  ipc.call('detach-session', 's1');
  assert.deepEqual(ipc.callFrom('sessions-in-my-window', main.webContents), []);
});

test('an unknown or missing sender answers empty rather than throwing', () => {
  const { ipc, created } = setup({ sessions: ['s1'] });
  ipc.call('detach-session', 's1');
  assert.deepEqual(ipc.call('sessions-in-my-window'), [], 'no event at all');
  assert.deepEqual(ipc.callFrom('sessions-in-my-window', { stranger: true }), []);
  created[0].destroy();
  assert.deepEqual(ipc.callFrom('sessions-in-my-window', created[0].webContents), [],
    'a destroyed window owns nothing');
});

// --- Giving a claim back (#331) ---------------------------------------------------------------
//
// An adopt can fail on the renderer's side — the session record never arrives, or the process ended
// while the window waited for it. Main must not keep routing that session to a window that draws it
// nowhere, so the taking window hands the claim back.

test('a window that cannot render a session hands the claim back to main', () => {
  const { ipc, main, created } = setup({ sessions: ['s1'] });
  ipc.call('detach-session', 's1');
  const win = created[0];
  main.sent.length = 0;

  win.sent.length = 0;

  assert.deepEqual(ipc.callFrom('release-session-claim', win.webContents, 's1'), { ok: true });
  assert.equal(detach.isDetached('s1'), false, 'main stops routing it there');
  assert.deepEqual(main.sent, [['session-reattached', 's1', true, null]], 'and the main window is offered it');
  assert.deepEqual(win.sent, [['session-detached', 's1']],
    'the giving window is told to let go first — anything it did mount must not survive the handover');
  assert.equal(win.isDestroyed(), false, 'the window stays — it may still hold others');
});

test('only the window that holds the session may give it up', () => {
  // A stale hand-back from a window that has since passed the session on would un-register the NEW
  // owner, and main would route the bytes to a window that let go.
  const { ipc, main, created } = setup({ sessions: ['s1', 's2'] });
  ipc.call('detach-session', 's1');
  ipc.call('detach-session', 's2');
  const [winA, winB] = created;
  ipc.call('move-session-to-window', 's1', String(winB.id)); // s1 now belongs to winB
  main.sent.length = 0;

  assert.deepEqual(ipc.callFrom('release-session-claim', winA.webContents, 's1'), { ok: false });
  assert.equal(detach.windowForSession('s1'), winB, 'the new owner keeps it');
  assert.deepEqual(main.sent, []);
});

test('a hand-back for something nobody holds is refused rather than announced', () => {
  const { ipc, main, created } = setup({ sessions: ['s1'] });
  ipc.call('detach-session', 's1');
  main.sent.length = 0;
  assert.deepEqual(ipc.callFrom('release-session-claim', created[0].webContents, 'ghost'), { ok: false });
  assert.deepEqual(ipc.call('release-session-claim', 's1'), { ok: false }, 'no sender, no claim');
  assert.deepEqual(main.sent, []);
});

// --- #360: which window is at a screen point --------------------------------
//
// A tab dragged out of a window has to know whether it landed ON another one. The far window is a
// second renderer process and never sees the drag, so only this side can answer.

test('#360: a point inside the main window answers "main"', () => {
  const { ipc } = setup();
  // main sits at 100,50 and is 1400×900.
  assert.equal(ipc.call('window-at-screen-point', { x: 400, y: 300 }), 'main');
});

test('#360: a point inside a detached window answers that window', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  created[0].bounds = { x: 2000, y: 100, width: 800, height: 600 };
  assert.equal(ipc.call('window-at-screen-point', { x: 2400, y: 400 }), String(created[0].id));
});

test('#360: a point over nothing of ours answers null', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  created[0].bounds = { x: 2000, y: 100, width: 800, height: 600 };
  // Right of the detached window, below main. The desktop, or another application — either way the
  // tear-off proceeds as before.
  assert.equal(ipc.call('window-at-screen-point', { x: 3500, y: 3000 }), null);
});

test('#360: the asking window is skipped by identity, not geometry', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  const win = created[0];
  win.bounds = { x: 200, y: 100, width: 400, height: 300 };
  // A point inside the ASKER's own box. It is the one window whose box the caller has already ruled
  // out, so re-deciding it here from different numbers could only disagree with the caller.
  assert.equal(ipc.callFrom('window-at-screen-point', win.webContents, { x: 300, y: 200 }), 'main');
});

test('#360: the point is converted from the asking renderer\'s frame', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  const win = created[0];
  win.bounds = { x: 1000, y: 0, width: 800, height: 600 };
  // The asker reports its own box as half the size — what a zoomed renderer does, since its CSS pixels
  // are not the OS's DIPs. A point at its own right edge must land at the window's real right edge.
  const box = { x: 500, y: 0, width: 400, height: 300 };
  assert.equal(ipc.callFrom('window-at-screen-point', win.webContents, { x: 300, y: 100 }, box), 'main');
  // Without the conversion this would read as x=300 — inside main (100..1500) either way, so the
  // sharper check is a point that only lands correctly once converted: 900 in the asker's frame is
  // 1800 on screen, past main's right edge at 1500 and outside the detached window too.
  assert.equal(ipc.callFrom('window-at-screen-point', win.webContents, { x: 900, y: 100 }, box), null);
});

test('#360: a point that is not a point answers null rather than guessing', () => {
  const { ipc } = setup();
  assert.equal(ipc.call('window-at-screen-point', null), null);
  assert.equal(ipc.call('window-at-screen-point', { x: 'over there', y: 3 }), null);
});

// --- #362: which display a detached window opens on ---
//
// Pure bounds math, so the multi-monitor cases a single-screen machine can never show are covered
// here. The `screen` module itself is Electron's and is not restated.

const LAPTOP = { x: 0, y: 0, width: 1920, height: 1040 };      // primary, taskbar subtracted
const SECOND = { x: 1920, y: -180, width: 2560, height: 1400 }; // to the right, taller, offset up

test('#362: detaching onto the source display keeps the offset from the source window', () => {
  const source = { x: 100, y: 80, width: 1600, height: 900 };
  const b = detach.detachWindowBounds(LAPTOP, source);
  assert.deepEqual(b, { x: 160, y: 140, width: 960, height: 720 });
});

test('#362: detaching onto another display anchors on that display, not the old coordinates', () => {
  const source = { x: 100, y: 80, width: 1600, height: 900 };
  const b = detach.detachWindowBounds(SECOND, source);
  // x=100+60 would sit on the LAPTOP; the target's own origin is what the offset applies to.
  assert.equal(b.x, SECOND.x + 60);
  assert.equal(b.y, SECOND.y + 60);
});

test('#362: a window never opens larger than the display it is going to', () => {
  // Torn off a 4K screen onto a small panel: 60% of 3840 is wider than the panel is.
  const source = { x: 0, y: 0, width: 3840, height: 2160 };
  const small = { x: 0, y: 0, width: 1280, height: 720 };
  const b = detach.detachWindowBounds(small, source);
  assert.equal(b.width, 1280);
  assert.equal(b.height, 720);
});

test('#362: the window is clamped fully onto the display it lands on', () => {
  // A source near the bottom-right corner would push the offset window off the edge.
  const source = { x: 1500, y: 900, width: 1600, height: 900 };
  const b = detach.detachWindowBounds(LAPTOP, source);
  assert.ok(b.x >= LAPTOP.x, `x ${b.x} is left of the display`);
  assert.ok(b.y >= LAPTOP.y, `y ${b.y} is above the display`);
  assert.ok(b.x + b.width <= LAPTOP.x + LAPTOP.width, 'right edge is off the display');
  assert.ok(b.y + b.height <= LAPTOP.y + LAPTOP.height, 'bottom edge is off the display');
});

test('#362: a display with a negative origin still places the window inside it', () => {
  const source = { x: 2000, y: 0, width: 1600, height: 900 };
  const b = detach.detachWindowBounds(SECOND, source);
  assert.ok(b.y >= SECOND.y, `y ${b.y} is above the display top ${SECOND.y}`);
  assert.ok(b.y + b.height <= SECOND.y + SECOND.height, 'bottom edge is off the display');
});

test('#362: the minimum window size wins over a tiny source window', () => {
  const source = { x: 0, y: 0, width: 400, height: 300 };
  const b = detach.detachWindowBounds(LAPTOP, source);
  assert.equal(b.width, 640);
  assert.equal(b.height, 400);
});

test('#362: with no screen module an aimed-at point changes nothing', () => {
  const { ipc, created } = setup(); // setup() passes no `screen` — see the header
  ipc.call('detach-session', 's1', 'One', { point: { x: 3000, y: 500 } });
  ipc.call('detach-session', 's2', 'Two');
  // Asserted as a relation, not as coordinates: the harness's main window is shared module state and
  // earlier tests move it, so absolute numbers here would pass or fail on test ORDER. The claim is
  // that without a display to consult, a point cannot invent one — both windows land the same way.
  assert.equal(created[0].opts.x, created[1].opts.x);
  assert.equal(created[0].opts.y, created[1].opts.y);
});

test('#362: a work area smaller than the minimum window size still holds the window', () => {
  // The minimum must not win over the display: flooring to 640x400 on a smaller panel would hang
  // the window off two edges of the screen it was just placed on.
  const tiny = { x: 0, y: 0, width: 320, height: 200 };
  const source = { x: 0, y: 0, width: 1600, height: 900 };
  const b = detach.detachWindowBounds(tiny, source);
  assert.ok(b.x + b.width <= tiny.x + tiny.width, `right edge ${b.x + b.width} is past ${tiny.width}`);
  assert.ok(b.y + b.height <= tiny.y + tiny.height, `bottom edge ${b.y + b.height} is past ${tiny.height}`);
  assert.ok(b.width > 0 && b.height > 0, 'a window with no extent is not a window');
});

// A stand-in for Electron's `screen`: two displays side by side, the second one taller and offset
// up, so a wrong display shows up as a wrong ORIGIN rather than only a wrong size.
function makeScreen(cursor = { x: 10, y: 10 }) {
  const displays = [
    { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { workArea: { x: 1920, y: -180, width: 2560, height: 1400 } },
  ];
  return {
    asked: [],
    getCursorScreenPoint() { return cursor; },
    getDisplayNearestPoint(point) {
      this.asked.push(point);
      return displays.find((d) => point.x >= d.workArea.x && point.x < d.workArea.x + d.workArea.width)
        || displays[0];
    },
  };
}

test('#362: end to end, a drop point on the second display opens the window there', () => {
  const screen = makeScreen();
  const { ipc, created } = setup({ screen });
  // The asking renderer is main: its box as the renderer measured it, and a point on its right half
  // that converts to a screen coordinate past 1920.
  const box = { x: 100, y: 50, width: 1400, height: 900 };
  ipc.call('detach-session', 's1', 'One', { point: { x: 2600, y: 300 }, box });
  assert.equal(created.length, 1);
  assert.ok(created[0].opts.x >= 1920, `x ${created[0].opts.x} is not on the second display`);
  assert.ok(created[0].opts.y >= -180, `y ${created[0].opts.y} is above the second display`);
});

test('#362: end to end, no drop point asks the display under the cursor', () => {
  const screen = makeScreen({ x: 2500, y: 200 }); // cursor parked on the second display
  const { ipc, created } = setup({ screen });
  ipc.call('detach-session', 's1', 'One'); // a menu detach carries no point
  assert.deepEqual(screen.asked, [{ x: 2500, y: 200 }]);
  assert.ok(created[0].opts.x >= 1920, `x ${created[0].opts.x} is not on the cursor's display`);
});

test('#362: end to end, a screen module that throws does not stop the detach', () => {
  const screen = { getCursorScreenPoint() { throw new Error('no display server'); }, getDisplayNearestPoint() { throw new Error('nope'); } };
  const { ipc, created } = setup({ screen });
  const res = ipc.call('detach-session', 's1', 'One');
  assert.equal(res.ok, true);
  assert.equal(created.length, 1);
});

test('#362: end to end, the drop point is converted from the asking renderer\'s frame', () => {
  // The #362 tests above all use `ipc.call`, which sends no `event.sender` — so `toScreenPoint` is
  // handed a null window and returns the point unchanged. That leaves the CSS-pixel → DIP conversion
  // unexercised through THIS handler, and a swap of `point` and `box` in the wiring would pass them
  // all. Here the asker is a real window reporting itself at half size, the way a zoomed renderer
  // does, so only the converted point lands on the second display.
  const screen = makeScreen();
  const { ipc, created } = setup({ sessions: ['s1', 's2'], screen });
  ipc.call('detach-session', 's1', 'One');
  const asker = created[0];
  asker.bounds = { x: 0, y: 0, width: 1600, height: 1000 };
  const box = { x: 0, y: 0, width: 800, height: 500 };

  ipc.callFrom('detach-session', asker.webContents, 's2', 'Two', { point: { x: 1000, y: 100 }, box });
  // 1000 in the asker's frame is 2000 on screen — the second display. Unconverted it would read as
  // 1000 and land on the first, which is the regression this pins.
  assert.equal(created.length, 2);
  assert.ok(created[1].opts.x >= 1920, `x ${created[1].opts.x} is not on the second display`);
});

// --- #363: tearing a session out of a window it SHARES ---

test('#363: a session sharing a detached window gets one of its own', () => {
  const { ipc, created, main } = setup({ sessions: ['s1', 's2'] });
  ipc.call('detach-session', 's1', 'One');
  ipc.call('move-session-to-window', 's2', String(created[0].id)); // now one window holds both
  assert.deepEqual([...detach.sessionsInWindow(created[0])].sort(), ['s1', 's2']);
  created[0].sent.length = 0;
  main.sent.length = 0;

  assert.equal(ipc.call('detach-session', 's2', 'Two').ok, true);
  assert.equal(created.length, 2, 'a second window was made rather than the first one focused');
  assert.equal(detach.windowForSession('s2'), created[1]);
  assert.deepEqual(detach.sessionsInWindow(created[0]), ['s1'], 'the shared window keeps the rest');
  // The release goes to the window that HELD it. Telling main to let go of a session it never had
  // releases nothing, and the old window would keep drawing one that has moved away.
  assert.deepEqual(created[0].sent, [['session-detached', 's2']]);
  assert.deepEqual(main.sent, []);
});

test('#363: a session already alone in its window is still just focused', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  const res = ipc.call('detach-session', 's1', 'One');
  assert.deepEqual(res, { ok: true, already: true, windowId: String(created[0].id) });
  assert.equal(created.length, 1, 'it already has a window of its own — nothing to do');
  assert.equal(created[0].focused, 1);
});

// --- #364: routing a sidebar pick to the window that holds the view ---
//
// Memory, Plans and Work files are steered from the sidebar, and a detached window has none. So a
// view pushed to another window is driven from the main window, and main has to know where it went.

test('#364: a file picked in the sidebar goes to the window holding the view', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  const holder = created[0];
  assert.deepEqual(ipc.callFrom('window-views-changed', holder.webContents, [{ kind: 'memory' }]), { ok: true });

  const res = ipc.call('route-view-file', 'memory', { filePath: 'notes/CLAUDE.md' });
  assert.equal(res.routed, true);
  assert.equal(res.windowTitle, 'One', 'the answer names the window, so the click can say where it went');
  assert.deepEqual(holder.sent, [['open-view-file', 'memory', { filePath: 'notes/CLAUDE.md' }]]);
});

test('#364: a view nobody claims is opened locally, not routed', () => {
  const { ipc } = setup();
  assert.deepEqual(ipc.call('route-view-file', 'memory', { filePath: 'x' }), { routed: false });
});

test('#364: a window that gave the view up stops receiving picks', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  const holder = created[0];
  ipc.callFrom('window-views-changed', holder.webContents, [{ kind: 'memory' }]);
  ipc.callFrom('window-views-changed', holder.webContents, []);
  holder.sent.length = 0;

  assert.equal(ipc.call('route-view-file', 'memory', { filePath: 'x' }).routed, false);
  assert.deepEqual(holder.sent, [], 'and nothing is sent at a view it no longer shows');
});

test('#364: a closed window stops receiving picks', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  const holder = created[0];
  ipc.callFrom('window-views-changed', holder.webContents, [{ kind: 'memory' }]);
  holder.destroy();

  // A stale entry here is invisible until a click lands nowhere — which is the whole reason this
  // registry drops entries rather than repairing them.
  assert.equal(ipc.call('route-view-file', 'memory', { filePath: 'x' }).routed, false);
});

test('#364: the asking window is never routed to itself', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  const holder = created[0];
  ipc.callFrom('window-views-changed', holder.webContents, [{ kind: 'memory' }]);
  holder.sent.length = 0;

  // The pick came from the window that holds it — the local path already does the right thing, and
  // delivering it back would open the file twice.
  assert.equal(ipc.callFrom('route-view-file', holder.webContents, 'memory', { filePath: 'x' }).routed, false);
  assert.deepEqual(holder.sent, []);
});

test('#364: a view the main window shows is steered locally, whoever else has one', () => {
  const { ipc, main, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  ipc.callFrom('window-views-changed', created[0].webContents, [{ kind: 'memory' }]);
  ipc.callFrom('window-views-changed', main.webContents, [{ kind: 'memory' }]);

  assert.equal(ipc.call('route-view-file', 'memory', { filePath: 'x' }).routed, false,
    'the main window has the sidebar, so a view there needs no routing at all');
  assert.deepEqual(created[0].sent, [], 'and the click does not also land in the other window');
});

// --- #364: opening one of the app's own views in another window ---

test('#364: a view is opened in the window it was sent to, with its file', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  const target = created[0];
  target.sent.length = 0;

  const res = ipc.call('open-view-in-window', String(target.id), 'memory', null, { filePath: 'notes/CLAUDE.md' });
  assert.deepEqual(res, { ok: true });
  // A singleton has no ref to carry its open file in, so the file travels beside the kind — without
  // it the view arrives showing an empty editor and the move looks half done.
  assert.deepEqual(target.sent, [['open-view', 'memory', null, { filePath: 'notes/CLAUDE.md' }]]);
  assert.equal(target.focused, 1, 'and it comes forward, or the move looks like nothing happened');
});

test('#364: a window that is still loading is not sent to until it has loaded', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  const target = created[0];
  target.sent.length = 0;
  target.loading = true;

  assert.deepEqual(ipc.call('open-view-in-window', String(target.id), 'memory', null, null), { ok: true });
  // Electron DROPS a send to a renderer that does not exist yet, silently — and the sender has
  // already closed its own tab by then, so the view would simply be gone. This is the whole reason
  // delivery waits.
  assert.deepEqual(target.sent, [], 'nothing was sent while it was loading');

  target.finishLoad();
  assert.deepEqual(target.sent, [['open-view', 'memory', null, null]]);
});

test('#364: a window that died while loading is not sent to at all', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  const target = created[0];
  target.loading = true;
  ipc.call('open-view-in-window', String(target.id), 'memory', null, null);
  target.destroyed = true;
  target.sent.length = 0;

  target.finishLoad();
  assert.deepEqual(target.sent, [], 'a destroyed window is not written to');
});

test('#364: a view sent to a window that is gone is refused, not dropped', () => {
  const { ipc } = setup();
  assert.deepEqual(ipc.call('open-view-in-window', '999', 'memory', null, null),
    { ok: false, error: 'no such window' });
  // The caller closes its own tab only on ok — a refusal is what keeps the view where it is.
});

test('#364: a view can be sent to the main window too', () => {
  const { ipc, main } = setup();
  main.webContents.isLoading = () => false;
  main.focus = () => { main.focused = (main.focused || 0) + 1; };
  main.sent.length = 0;

  assert.deepEqual(ipc.call('open-view-in-window', 'main', 'projects', null, null), { ok: true });
  assert.deepEqual(main.sent, [['open-view', 'projects', null, null]]);
});

// --- #370: a window that holds only a view ---
//
// A window used to be built around a session: the URL named one, the map was keyed by one, the title
// came from one, and closing handed one back. So "give Memory a window of its own" had nowhere to go.

test('#370: a view gets a window of its own, with no session in its URL', () => {
  const { ipc, created } = setup();
  const res = ipc.call('open-view-in-new-window', 'memory', null, { filePath: 'x' }, null);
  assert.equal(res.ok, true);
  assert.equal(created.length, 1);
  const win = created[0];
  assert.equal(res.windowId, String(win.id));
  // `win=detached` is the identity and `view=<kind>` is what it opens on. No `detached` key at all —
  // a session id it does not have must not be sent as the string "null".
  assert.deepEqual(win.loaded.opts, { query: { win: 'detached', view: 'memory' } });
  assert.deepEqual(detach.sessionsInWindow(win), [], 'it holds no session, and that is the point');
});

test('#370: the view is delivered once the new window has loaded, never before', () => {
  // Every window this handler makes is loading — it was made one statement earlier. A send to a
  // renderer that does not exist yet is dropped silently by Electron, and the caller has already let
  // go of its own tab, so the view would simply be gone.
  const { ipc, created } = setup({ loadingOnCreate: true });
  ipc.call('open-view-in-new-window', 'memory', null, { filePath: 'x' }, null);
  const win = created[0];
  assert.deepEqual(win.sent, []);
  win.finishLoad();
  assert.deepEqual(win.sent, [['open-view', 'memory', null, { filePath: 'x' }]]);
});

test('#370: a view-only window is a window like any other', () => {
  const { ipc, created } = setup();
  ipc.call('open-view-in-new-window', 'memory', null, null, null);
  const win = created[0];
  win.opts.title = 'Memory';

  // In the move list, so a session can be sent to it…
  const list = ipc.call('list-session-windows', 's1');
  assert.deepEqual(list.map((w) => w.id), ['main', String(win.id)]);
  assert.deepEqual(list[1].sessionIds, []);
  // …and a drop target, so a tab dragged onto it lands there. Both used to read the session map,
  // which has no entry for this window at all.
  win.bounds = { x: 2000, y: 0, width: 800, height: 600 };
  assert.equal(ipc.call('window-at-screen-point', { x: 2100, y: 100 }, null), String(win.id));
});

test('#370: the asking window is marked, so a view is never offered its own window', () => {
  const { ipc, main, created } = setup();
  ipc.call('open-view-in-new-window', 'memory', null, null, null);
  const win = created[0];

  const fromView = ipc.callFrom('list-session-windows', win.webContents, null);
  assert.deepEqual(fromView.filter((w) => w.isSelf).map((w) => w.id), [String(win.id)]);
  // A view has no session to identify its window by, which is how this was answered before (#364).
  const fromMain = ipc.callFrom('list-session-windows', main.webContents, null);
  assert.deepEqual(fromMain.filter((w) => w.isSelf).map((w) => w.id), ['main']);
});

test('#370: a window holding a view survives its last session leaving', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  const win = created[0];
  ipc.callFrom('window-views-changed', win.webContents, [{ kind: 'memory' }]);

  ipc.call('move-session-to-window', 's1', 'main');
  assert.equal(win.isDestroyed(), false, 'the view is the reason it exists — it must not close');
});

test('#370: a window holding nothing keeps closing when its last session leaves', () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  const win = created[0];
  ipc.callFrom('window-views-changed', win.webContents, []);

  ipc.call('move-session-to-window', 's1', 'main');
  assert.equal(win.isDestroyed(), true, 'no sidebar, nothing to show, nothing to pick');
});

test('#370: quitting closes a view-only window too', () => {
  const { ipc, created } = setup();
  ipc.call('open-view-in-new-window', 'memory', null, null, null);
  // It is in no session map, and the session map used to be the only list of windows there was — so
  // this window outlived the app that made it.
  detach.closeAll();
  assert.equal(created[0].isDestroyed(), true);
});

test('#370: a view-only window is forgotten when it closes', () => {
  const { ipc, created } = setup();
  ipc.call('open-view-in-new-window', 'memory', null, null, null);
  const win = created[0];
  ipc.callFrom('window-views-changed', win.webContents, [{ kind: 'memory' }]);
  win.destroy();

  assert.deepEqual(ipc.call('list-session-windows', null).map((w) => w.id), ['main']);
  assert.equal(ipc.call('route-view-file', 'memory', { filePath: 'x' }).routed, false,
    'and it stops being routed to, which is invisible until a click lands nowhere');
});

// --- #371: the windows come back on the next launch ---
//
// A session in a window of its own came back nowhere: the main window saves the set IT renders, and
// a detached session was released from it. The windows themselves lived only in this process.

test('#371: a restored window keeps its place when the display is still there', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(
    detach.restoreWindowBounds({ x: 300, y: 200, width: 800, height: 600 }, [area], area),
    { x: 300, y: 200, width: 800, height: 600 });
});

test('#371: a window whose display is gone opens on the primary one', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  // Saved on a second monitor to the right that is no longer attached. Honouring those coordinates
  // puts the window where the user cannot reach it — the failure this exists to prevent.
  const out = detach.restoreWindowBounds({ x: 2600, y: 300, width: 800, height: 600 }, [primary], primary);
  assert.deepEqual(out, { x: 0, y: 0, width: 800, height: 600 });
});

test('#371: a restored window is never larger than the screen it lands on', () => {
  const small = { x: 0, y: 0, width: 1280, height: 720 };
  // Saved on a 4K panel, restored onto a laptop one.
  const out = detach.restoreWindowBounds({ x: 3000, y: 100, width: 2400, height: 1500 }, [small], small);
  assert.deepEqual(out, { x: 0, y: 0, width: 1280, height: 720 });
});

test('#371: a window hanging off the edge is pulled back onto its display', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const out = detach.restoreWindowBounds({ x: 1800, y: 1000, width: 800, height: 600 }, [area], area);
  assert.deepEqual(out, { x: 1120, y: 440, width: 800, height: 600 });
});

test('#371: the second display is chosen when it is the one covering the window', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const second = { x: 1920, y: 0, width: 1920, height: 1040 };
  const out = detach.restoreWindowBounds({ x: 2200, y: 100, width: 800, height: 600 }, [primary, second], primary);
  assert.deepEqual(out, { x: 2200, y: 100, width: 800, height: 600 });
});

// A settings store that answers and records, so the save/restore round trip runs without Electron.
function settingsStore(initial = {}) {
  const rows = { global: { ...initial } };
  return {
    getSetting: (key) => rows[key],
    setSetting: (key, value) => { rows[key] = value; },
    read: () => rows.global,
  };
}

function setupWithSettings(initial, opts = {}) {
  const store = settingsStore();
  const out = setup({ ...opts, settings: store });
  // Seeded AFTER the wiring, because `setup` clears the module by calling `closeAll` — which is the
  // quit path, and the quit path writes what is standing. A state seeded before it would be the
  // empty list by the time the test asked.
  Object.assign(store.read(), initial);
  return { ...out, store };
}

test('#371: quitting records every window, with what it held and where it was', () => {
  const { ipc, created, store } = setupWithSettings({}, { sessions: ['s1', 's2'] });
  ipc.call('detach-session', 's1', 'One');
  ipc.call('move-session-to-window', 's2', String(created[0].id));
  created[0].bounds = { x: 2000, y: 100, width: 900, height: 700 };
  ipc.callFrom('window-views-changed', created[0].webContents, [{ kind: 'memory', ref: null, file: { filePath: 'a.md' } }]);

  detach.closeAll();
  assert.deepEqual(store.read().detachedWindows, [{
    bounds: { x: 2000, y: 100, width: 900, height: 700 },
    sessions: ['s1', 's2'],
    views: [{ kind: 'memory', ref: null, file: { filePath: 'a.md' } }],
    layout: null,
  }]);
});

test('#371: a window closed by hand does not come back', () => {
  const { ipc, created, store } = setupWithSettings({});
  ipc.call('detach-session', 's1', 'One');
  created[0].destroy();
  detach.closeAll();
  assert.deepEqual(store.read().detachedWindows, []);
});

test('#371: the saved windows are reopened, with their sessions routed to them', () => {
  const { ipc, created, store } = setupWithSettings({
    detachedWindows: [{ bounds: { x: 40, y: 60, width: 900, height: 700 }, sessions: ['s1'], views: [] }],
  });
  assert.equal(detach.restoreWindows(), 1);
  const win = created[0];
  assert.equal(win.opts.x, 40);
  assert.equal(win.opts.width, 900);
  // Registered BEFORE the window loads: `windowForSession` decides where the bytes go, and the
  // window is about to ask for a terminal.
  assert.equal(detach.windowForSession('s1'), win);
  // And it is told what to put back, when it asks — a push would have to pick a moment, and the
  // renderer is the only thing that knows when it can act on the answer.
  assert.deepEqual(ipc.callFrom('my-window-restore', win.webContents), { sessions: ['s1'], views: [], layout: null });
  assert.equal(ipc.callFrom('my-window-restore', win.webContents), null, 'and only once — a reload must not restore twice');
  assert.equal(store.read().detachedWindows.length, 1);
});

test('#371: restoring runs once, however often the main window is created', () => {
  const { created } = setupWithSettings({
    detachedWindows: [{ bounds: null, sessions: ['s1'], views: [] }],
  });
  assert.equal(detach.restoreWindows(), 1);
  assert.equal(detach.restoreWindows(), 0, 'the macOS activate path must not duplicate every window');
  assert.equal(created.length, 1);
});

test('#371: with restore turned off, no window comes back either', () => {
  const { created } = setupWithSettings({
    restoreSessionsOnLaunch: false,
    detachedWindows: [{ bounds: null, sessions: ['s1'], views: [] }],
  });
  assert.equal(detach.restoreWindows(), 0);
  assert.deepEqual(created, [], 'an empty frame on a second monitor is what the setting exists to prevent');
});

test('#371: a window that held only a view comes back too', () => {
  const { ipc, created } = setupWithSettings({
    detachedWindows: [{ bounds: null, sessions: [], views: [{ kind: 'memory', ref: null, file: null }] }],
  });
  assert.equal(detach.restoreWindows(), 1);
  assert.deepEqual(ipc.callFrom('my-window-restore', created[0].webContents),
    { sessions: [], views: [{ kind: 'memory', ref: null, file: null }], layout: null });
});

test('#371: a saved entry holding nothing is not reopened', () => {
  const { created } = setupWithSettings({
    detachedWindows: [{ bounds: null, sessions: [], views: [] }],
  });
  assert.equal(detach.restoreWindows(), 0);
  assert.deepEqual(created, []);
});

// --- #372: the arrangement comes back with the window ---
//
// A detached window keeps no layout of its own: it shares localStorage with the main window, so
// writing one there would overwrite the user's arrangement (#344). Main is the only place it can go.

test('#372: a window\'s arrangement is stored beside what it holds, and handed back', () => {
  const tree = { type: 'leaf', id: 'pane-1', tabs: [{ id: 'session:s1', kind: 'terminal' }], activeTabId: 'session:s1' };
  const { ipc, created, store } = setupWithSettings({});
  ipc.call('detach-session', 's1', 'One');
  ipc.callFrom('window-views-changed', created[0].webContents, [], { tree, activeLeafId: 'pane-1' });
  detach.closeAll();

  const saved = store.read().detachedWindows;
  assert.deepEqual(saved[0].layout, { tree, activeLeafId: 'pane-1' },
    'kept as sent — what a pane tree means belongs to the renderer that draws it');

  // …and comes back to the window that is rebuilt from it.
  Object.assign(store.read(), { detachedWindows: saved });
  assert.equal(detach.restoreWindows(), 1);
  const back = ipc.callFrom('my-window-restore', created[created.length - 1].webContents);
  assert.deepEqual(back.layout, { tree, activeLeafId: 'pane-1' });
});

test('#372: a report with no arrangement clears the one before it', () => {
  const tree = { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null };
  const { ipc, created, store } = setupWithSettings({});
  ipc.call('detach-session', 's1', 'One');
  ipc.callFrom('window-views-changed', created[0].webContents, [], { tree, activeLeafId: 'pane-1' });
  // The main window sends none, and so does a window that has left panes mode. A layout kept from
  // the last report would restore an arrangement the window no longer has.
  ipc.callFrom('window-views-changed', created[0].webContents, []);
  detach.closeAll();
  assert.equal(store.read().detachedWindows[0].layout, null);
});

// --- #375: a drop on ANOTHER window lands where it was dropped ----------------
//
// A drag never crosses a renderer process, so the far window is asked — and the answer it gives is
// both what it highlights and what the drop does.

test('#375: the window under the pointer is asked, and its answer comes back with its id', async () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  const win = created[0];
  win.bounds = { x: 2000, y: 0, width: 800, height: 600 };
  win.sent.length = 0;

  const answer = ipc.call('probe-drop-point', { x: 2100, y: 100 }, null);
  // The question went to that window, with its own bounds beside it: converting a screen point into a
  // renderer's coordinates needs the ratio between the box it measures for itself and the OS's, and
  // only that renderer knows its zoom.
  const [channel, id, at, bounds] = win.sent[0];
  assert.equal(channel, 'probe-drop-point');
  assert.deepEqual(at, { x: 2100, y: 100 });
  assert.deepEqual(bounds, win.bounds);

  ipc.emit('drop-probe-answer', win.webContents, id, { kind: 'split', leafId: 'pane-2', zone: 'right' });
  assert.deepEqual(await answer, {
    windowId: String(win.id),
    placement: { kind: 'split', leafId: 'pane-2', zone: 'right' },
  });
});

test('#375: a window that does not answer places nothing, rather than guessing', async () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  created[0].bounds = { x: 2000, y: 0, width: 800, height: 600 };

  // No `drop-probe-answer` — a renderer that is busy, or gone. The probe times out and says so; the
  // caller then moves the session without a placement, which is what it did before #375. A pane
  // nobody highlighted must not be invented (#360).
  const res = await ipc.call('probe-drop-point', { x: 2100, y: 100 }, null);
  assert.equal(res.windowId, String(created[0].id));
  assert.equal(res.placement, null);
});

test('#375: a point over no window of ours answers null and takes every hint down', async () => {
  const { ipc, main, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  created[0].bounds = { x: 2000, y: 0, width: 800, height: 600 };
  main.sent.length = 0;
  created[0].sent.length = 0;

  assert.equal(await ipc.call('probe-drop-point', { x: 9000, y: 9000 }, null), null);
  assert.deepEqual(main.sent, [['clear-drop-hint']]);
  assert.deepEqual(created[0].sent, [['clear-drop-hint']],
    'nothing may be left highlighting a drop that is not coming');
});

test('#375: the asking window is never asked about its own drag', async () => {
  const { ipc, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  const win = created[0];
  win.bounds = { x: 2000, y: 0, width: 800, height: 600 };
  win.sent.length = 0;

  // A point inside the asker: its own handlers have already drawn that answer, and asking it through
  // main would race them.
  assert.equal(await ipc.callFrom('probe-drop-point', win.webContents, { x: 2100, y: 100 }, null), null);
  assert.deepEqual(win.sent.filter((s) => s[0] === 'probe-drop-point'), []);
});

test('#375: the placement travels with the move and reaches the taking window', () => {
  const { ipc, created } = setup({ sessions: ['s1', 's2'] });
  ipc.call('detach-session', 's1', 'One');
  const win = created[0];
  win.sent.length = 0;

  const placement = { kind: 'root', zone: 'down' };
  ipc.call('move-session-to-window', 's2', String(win.id), placement);
  assert.deepEqual(win.sent.filter((s) => s[0] === 'session-reattached'),
    [['session-reattached', 's2', true, placement]],
    'the window is told where the drop landed, not only that something arrived');
});

test('#375: a move with no placement still carries null, so the taking window has one shape to read', () => {
  const { ipc, main } = setup();
  ipc.call('detach-session', 's1', 'One');
  main.sent.length = 0;
  ipc.call('move-session-to-window', 's1', 'main');
  assert.deepEqual(main.sent.filter((s) => s[0] === 'session-reattached'),
    [['session-reattached', 's1', true, null]]);
});

test('#375: ending a drag takes the highlight off every window', () => {
  const { ipc, main, created } = setup();
  ipc.call('detach-session', 's1', 'One');
  main.sent.length = 0;
  created[0].sent.length = 0;

  assert.deepEqual(ipc.call('clear-remote-drop-hints'), { ok: true });
  assert.deepEqual(main.sent, [['clear-drop-hint']]);
  assert.deepEqual(created[0].sent, [['clear-drop-hint']]);
});
