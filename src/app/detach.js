// Detached session windows (#2): a session moved into an OS window of its own, so it can live on a
// second monitor while the main window carries the rest.
//
// The PTY never moves. It stays in `activeSessions` exactly as before; what changes is **which window
// receives its byte stream**. That is the whole mechanism, and it is why detach is cheap here:
//
//   terminal-data                        -> the OWNING window (this module decides)
//   session-detached / session-reattached -> the window that must let go / take over. Main by default;
//                                           since #316 either end can be a detached window.
//   everything else                      -> the main window (the sidebar, the attention inbox and the
//                                           badges live there, and they must keep updating for a
//                                           detached session too)
//
// Get that separation wrong and the symptom is subtle: attention badges stop appearing for the one
// session the user pushed to the other screen — the one they are least likely to be watching.
//
// The detached window loads the SAME `index.html` with `?detached=<sessionId>`. It therefore inherits
// every terminal fix (ConPTY quirks, paste, mouse reporting, right-click, WebGL fallback) instead of
// growing a second, quietly diverging renderer. The cost is one full renderer per detached WINDOW —
// since #316 a window can hold several sessions — which is accepted for a power feature.
//
// Needs no DB, and `BrowserWindow` arrives through ctx rather than a top-level require — that is what
// keeps the routing and the detach/reattach state machine loadable in `node --test`
// (test/detach-routing.test.js), which is the half that decides where a session's bytes go.
'use strict';

const path = require('path');

let ctx = null;

// sessionId -> BrowserWindow. A session appears here for exactly as long as its window lives.
const detachedWindows = new Map();

/**
 * @param {object} context
 * @param {() => Electron.BrowserWindow|null} context.getMainWindow  a GETTER — see the ctx rule.
 * @param {() => boolean} context.getAppQuitting
 * @param {Map} context.activeSessions
 * @param {object} context.log
 * @param {typeof Electron.BrowserWindow} context.BrowserWindow  through ctx — see the header.
 */
function init(context) {
  ctx = context;
}

/** The window that renders this session's output: its own if it has one, else the main window. */
function windowForSession(sessionId) {
  const win = detachedWindows.get(sessionId);
  if (win && !win.isDestroyed()) return win;
  return ctx.getMainWindow();
}

// A window is addressed by id: 'main', or the BrowserWindow id as a string. A detached window may own
// SEVERAL sessions since #316 — the map is keyed by session, so one window can appear under many keys.
const MAIN_WINDOW_ID = 'main';

function windowIdOf(win) {
  return win && !win.isDestroyed() ? String(win.id) : null;
}

/** Every session currently rendered by this window. */
function sessionsInWindow(win) {
  const ids = [];
  for (const [sessionId, w] of detachedWindows) {
    if (w === win) ids.push(sessionId);
  }
  return ids;
}

function detachedWindowById(windowId) {
  for (const win of detachedWindows.values()) {
    if (!win.isDestroyed() && String(win.id) === String(windowId)) return win;
  }
  return null;
}

/**
 * The windows a session can be moved to (#316): the main window, plus every detached one. Named by
 * what they show, because "window 3" means nothing to the user.
 *
 * With a `sessionId`, the window that currently holds it is marked `current` — the renderer cannot
 * work that out on its own. A detached window's own set is not in its renderer, and "not detached"
 * meaning "in main" is only true when asked from the main window.
 */
function listSessionWindows(sessionId) {
  const holder = sessionId ? detachedWindows.get(sessionId) : null;
  const holderLive = holder && !holder.isDestroyed() ? holder : null;
  const out = [{
    id: MAIN_WINDOW_ID,
    title: 'Main window',
    isMain: true,
    sessionIds: [],
    current: !!sessionId && !holderLive,
  }];
  const seen = new Set();
  for (const win of detachedWindows.values()) {
    if (win.isDestroyed() || seen.has(win.id)) continue;
    seen.add(win.id);
    out.push({
      id: windowIdOf(win),
      title: win.getTitle() || 'Session window',
      isMain: false,
      sessionIds: sessionsInWindow(win),
      current: win === holderLive,
    });
  }
  return out;
}

/** Is this session currently rendered in a window of its own? */
function isDetached(sessionId) {
  const win = detachedWindows.get(sessionId);
  return !!(win && !win.isDestroyed());
}

/** Every detached session id — the renderer asks on boot so its tabs can show the state. */
function detachedSessionIds() {
  return [...detachedWindows.keys()].filter(isDetached);
}

function sendToMain(channel, ...args) {
  const main = ctx.getMainWindow();
  if (main && !main.isDestroyed()) main.webContents.send(channel, ...args);
}

/**
 * Does this session still have a process? Sent along with every `session-reattached`, because the
 * window taking it must not resume a CLI the user stopped — and the renderer's own answer is a
 * POLLED snapshot, up to 30 s stale in an idle window. Here it is the authoritative map.
 */
function isRunning(sessionId) {
  return !!ctx.activeSessions.get(sessionId);
}

function sendAdopt(win, sessionId) {
  const running = isRunning(sessionId);
  if (win) win.webContents.send('session-reattached', sessionId, running);
  else sendToMain('session-reattached', sessionId, running);
}

function createDetachWindow(sessionId, title) {
  const main = ctx.getMainWindow();
  const bounds = main && !main.isDestroyed() ? main.getBounds() : { width: 1100, height: 700, x: 80, y: 80 };
  const win = new ctx.BrowserWindow({
    width: Math.max(640, Math.round(bounds.width * 0.6)),
    height: Math.max(400, Math.round(bounds.height * 0.8)),
    // Offset from the main window so a detach never lands exactly on top of it.
    x: bounds.x + 60,
    y: bounds.y + 60,
    title: title || 'Switchboard — Session',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    show: false,
    backgroundColor: '#111118', // index.html's body background — no white first frame
    // NOT `parent: main`: a child window is always on top of its parent, which defeats the point of
    // moving a session to another monitor and looking at the main window on this one.
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false, // a background monitor must keep painting its terminal
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { detached: sessionId } });
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
  });

  // Closing the window hands the session back rather than ending it: the PTY ran through the whole
  // detour and the user closed a VIEW, not a process. Skip on quit — everything is going away anyway.
  win.on('closed', () => {
    // Every session this window still owns comes back — since #316 that can be more than the one it
    // was opened for. A session whose entry was already removed (the explicit reattach and the move
    // path both delete BEFORE destroying, precisely so this does not fire a second notification) is
    // not in the list, so the main window never reopens anything twice.
    const owned = sessionsInWindow(win);
    for (const id of owned) detachedWindows.delete(id);
    if (!owned.length || ctx.getAppQuitting()) return;
    ctx.log.info(`[detach] window closed, ${owned.length} session(s) return to the main window`);
    for (const id of owned) sendAdopt(null, id);
  });

  return win;
}

/**
 * A live session moved onto a new id (a fork, an accepted plan). Its window has to follow, or the
 * output — sent under the new id from that moment on — routes to the main window while the detached
 * one, still registered under the old id, goes quiet with no sign of why.
 */
function rekey(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  const win = detachedWindows.get(fromId);
  if (!win) return;
  detachedWindows.delete(fromId);
  if (!win.isDestroyed()) {
    detachedWindows.set(toId, win);
    // The window knows itself by the id in its URL; tell it the id changed so its own tab and its
    // reattach follow along.
    win.webContents.send('detached-session-rekeyed', fromId, toId);
  }
  sendToMain('session-detach-rekeyed', fromId, toId);
}

/** Close every detached window — the main window is going, so its sessions have nowhere to be. */
function closeAll() {
  // Clear FIRST, then destroy: the `closed` handler decides by "am I still the registered window?",
  // and this path must not ask the main window to take anything back. It runs from the main window's
  // own close, where `appQuitting` is still false on the plain Alt+F4 path — so the quit check alone
  // would let a reattach fire into a renderer that is being torn down.
  const windows = [...detachedWindows.values()];
  detachedWindows.clear();
  for (const win of windows) {
    if (win && !win.isDestroyed()) win.destroy();
  }
}

/**
 * @param {Electron.IpcMain} ipc  passed in, not required — see the header.
 */
function registerIpc(ipc) {
  ipc.handle('detach-session', (_event, sessionId, title) => {
    if (!sessionId) return { ok: false, error: 'no session' };
    if (isDetached(sessionId)) {
      const win = detachedWindows.get(sessionId);
      win.focus();
      return { ok: true, already: true };
    }
    const session = ctx.activeSessions.get(sessionId);
    if (!session) return { ok: false, error: 'session is not running' };
    const win = createDetachWindow(sessionId, title);
    detachedWindows.set(sessionId, win);
    ctx.log.info(`[detach] session moved to its own window: ${sessionId}`);
    // The main renderer releases its terminal for this session; the PTY keeps running, and the new
    // window attaches to it. Two renderers on one PTY would double every keystroke's echo.
    sendToMain('session-detached', sessionId);
    return { ok: true };
  });

  // `reattach-session` used to live here. It is `move-session-to-window(id, 'main')` with a window
  // destroy hard-coded instead of "close it if it is now empty" — every caller went through the move
  // handler once #316 landed, so keeping both would have left two paths to the same handover, one of
  // them wrong for a window holding more than one session.

  /**
   * Move a session between windows (#316) — main → a detached window, detached → main, detached →
   * another detached window. Same handover the detach path uses: the giving window releases its
   * terminal (the PTY runs on), then the taking window attaches. The order matters — release first,
   * or two renderers hold one PTY for the length of an IPC round trip and echo every keystroke twice.
   */
  ipc.handle('move-session-to-window', (_event, sessionId, targetWindowId) => {
    if (!sessionId) return { ok: false, error: 'no session' };
    if (!ctx.activeSessions.get(sessionId)) return { ok: false, error: 'session is not running' };
    const target = String(targetWindowId) === MAIN_WINDOW_ID ? null : detachedWindowById(targetWindowId);
    if (String(targetWindowId) !== MAIN_WINDOW_ID && !target) return { ok: false, error: 'window is gone' };

    const source = detachedWindows.get(sessionId) || null;
    const sourceLive = source && !source.isDestroyed() ? source : null;
    if (sourceLive === target) return { ok: true, already: true };

    // Release. The main window answers `session-detached`; a detached one answers the same channel,
    // so both sides of the move run the same code path.
    if (sourceLive) sourceLive.webContents.send('session-detached', sessionId);
    else sendToMain('session-detached', sessionId);

    // Re-register before telling the target to take it: `windowForSession` decides where the PTY's
    // bytes go, and the replay the target is about to ask for must already route to it.
    if (target) detachedWindows.set(sessionId, target);
    else detachedWindows.delete(sessionId);

    if (target) {
      sendAdopt(target, sessionId);
      if (target.isMinimized()) target.restore();
      target.focus();
    } else {
      sendAdopt(null, sessionId);
    }
    // A detached window that just gave away its last session has nothing left to show, and no chrome
    // to pick a new one with — the sidebar lives in the main window. So it goes. Its entries are
    // already out of the map, so `closed` hands nothing back.
    if (sourceLive && !sessionsInWindow(sourceLive).length) sourceLive.destroy();
    ctx.log.info(`[detach] session moved to ${target ? 'window ' + target.id : 'the main window'}: ${sessionId}`);
    return { ok: true };
  });

  ipc.handle('list-session-windows', (_event, sessionId) => listSessionWindows(sessionId));

  /**
   * "What do I hold?", asked by a detached window about ITSELF (#326, #331).
   *
   * The window cannot answer this on its own. Its URL names the session it was opened for, and that
   * is all it knows: sessions moved in later live only in this map, and a session moved in while the
   * window was still booting was announced to a renderer that had no session list yet to mount it
   * from. Both end the same way — main routes a session's bytes to a window that draws it nowhere.
   *
   * So main answers, addressed by the ASKER rather than by an id the renderer would have to guess.
   * The main window is not in the map and correctly gets an empty list: what it shows is its own
   * business, and everything not in this map is already its.
   */
  ipc.handle('sessions-in-my-window', (event) => {
    const sender = event && event.sender;
    if (!sender) return [];
    const win = ctx.BrowserWindow.fromWebContents(sender);
    if (!win || win.isDestroyed()) return [];
    return sessionsInWindow(win);
  });

  /**
   * "I cannot render this one" — the taking window gives a claim back (#331).
   *
   * An adopt can fail on the renderer's side: the session record never arrives, or the process ended
   * while the window was waiting for it. Main would otherwise keep routing that session's bytes to a
   * window that draws it nowhere, and `listSessionWindows` would keep offering it as held. So the
   * claim falls here, and the main window is told to take it — its own adopt then decides whether
   * there is still a process worth mounting.
   *
   * Only the window that HOLDS the session may give it up: a stale message from a window that has
   * since handed it on must not un-register the new owner.
   */
  ipc.handle('release-session-claim', (event, sessionId) => {
    const sender = event && event.sender;
    const holder = sessionId ? detachedWindows.get(sessionId) : null;
    if (!holder || holder.isDestroyed() || !sender || holder.webContents !== sender) return { ok: false };
    // Same order as a move — release, re-register, adopt. The release leg looks redundant (the caller
    // reaches this because it mounted NOTHING) but it is what makes the handover safe rather than
    // dependent on the caller being right about itself: if anything did get mounted meanwhile, this
    // tears it down before the main window attaches, instead of leaving two renderers on one PTY.
    holder.webContents.send('session-detached', sessionId);
    detachedWindows.delete(sessionId);
    ctx.log.info(`[detach] window ${holder.id} could not render ${sessionId}; the claim returns to the main window`);
    sendAdopt(null, sessionId);
    return { ok: true };
  });

  ipc.handle('is-session-detached', (_event, sessionId) => isDetached(sessionId));
  ipc.handle('detached-session-ids', () => detachedSessionIds());

  // A detached window asks who it is. The query string already says so; this is the answer for code
  // that would rather not parse a URL.
  ipc.handle('focus-detached-window', (_event, sessionId) => {
    const win = detachedWindows.get(sessionId);
    if (!win || win.isDestroyed()) return { ok: false };
    if (win.isMinimized()) win.restore();
    win.focus();
    return { ok: true };
  });
}

module.exports = {
  init,
  registerIpc,
  rekey,
  windowForSession,
  isDetached,
  detachedSessionIds,
  listSessionWindows,
  sessionsInWindow,
  closeAll,
  detachedWindows,
};
