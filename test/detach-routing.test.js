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
function makeWindowClass(created) {
  return class FakeWindow {
    // Electron's own static. `sessions-in-my-window` addresses a window by its ASKER, so the test has
    // to be able to answer "which window is this webContents?" the way the real class does.
    static fromWebContents(sender) {
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
      this.webContents = { send: (...args) => this.sent.push(args) };
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
  };
}

// A minimal ipcMain: registerIpc hands it handlers, the test calls them.
function makeIpc() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    call: (channel, ...args) => handlers.get(channel)(null, ...args),
    // For the handlers that answer the ASKER rather than an argument (`sessions-in-my-window`).
    callFrom: (channel, sender, ...args) => handlers.get(channel)({ sender }, ...args),
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
  assert.deepEqual(main.sent, [['session-reattached', 's1', false]]);
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
  assert.deepEqual(main.sent, [['session-reattached', 's1', true]], 'exactly one notification, not one per path');
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
  assert.deepEqual(main.sent, [['session-reattached', 's1', true]]);
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
  assert.deepEqual(main.sent, [['session-reattached', 's1', true]]);
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
  assert.deepEqual(win.sent, [['session-reattached', 's2', true]], 'the window takes it');
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
  assert.deepEqual(winA.sent, [['session-reattached', 's2', true]]);
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
    [['session-reattached', 's1', true], ['session-reattached', 's2', true]]);
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
  assert.deepEqual(main.sent, [['session-reattached', 's1', false]], 'and main is told nothing runs');
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
  assert.deepEqual(win.sent, [['session-reattached', 's2', false]]);
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
  assert.deepEqual(main.sent, [['session-reattached', 's1', false]]);
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
  assert.deepEqual(main.sent, [['session-reattached', 's1', true]], 'and the main window is offered it');
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
