// Detached session windows (#2): a session moved into an OS window of its own, so it can live on a
// second monitor while the main window carries the rest.
//
// The PTY never moves. It stays in `activeSessions` exactly as before; what changes is **which window
// receives its byte stream**. That is the whole mechanism, and it is why detach is cheap here:
//
//   terminal-data          -> the OWNING window (this module decides)
//   everything else        -> the main window (the sidebar, the attention inbox and the badges live
//                            there, and they must keep updating for a detached session too)
//
// Get that separation wrong and the symptom is subtle: attention badges stop appearing for the one
// session the user pushed to the other screen — the one they are least likely to be watching.
//
// The detached window loads the SAME `index.html` with `?detached=<sessionId>`. It therefore inherits
// every terminal fix (ConPTY quirks, paste, mouse reporting, right-click, WebGL fallback) instead of
// growing a second, quietly diverging renderer. The cost is one full renderer per detached session,
// which is accepted for a power feature.
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
    // Still the registered window? Then this is the user closing it. The explicit reattach path takes
    // the entry out of the map BEFORE destroying, precisely so this does not fire a second
    // notification — the main window would reopen the session twice.
    const wasRegistered = detachedWindows.get(sessionId) === win;
    if (wasRegistered) detachedWindows.delete(sessionId);
    if (!wasRegistered || ctx.getAppQuitting()) return;
    ctx.log.info(`[detach] window closed, session returns to the main window: ${sessionId}`);
    sendToMain('session-reattached', sessionId);
  });

  return win;
}

/** Close every detached window — the main window is going, so its sessions have nowhere to be. */
function closeAll() {
  for (const win of detachedWindows.values()) {
    if (win && !win.isDestroyed()) win.destroy(); // destroy, not close: `closed` must not re-attach
  }
  detachedWindows.clear();
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

  ipc.handle('reattach-session', (_event, sessionId) => {
    const win = detachedWindows.get(sessionId);
    if (!win || win.isDestroyed()) return { ok: false, error: 'not detached' };
    detachedWindows.delete(sessionId);
    // `closed` fires with the id already gone from the map, so the notification below is the only one.
    win.destroy();
    sendToMain('session-reattached', sessionId);
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
  windowForSession,
  isDetached,
  detachedSessionIds,
  closeAll,
  detachedWindows,
};
