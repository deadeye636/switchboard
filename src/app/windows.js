// The app's windows: the main BrowserWindow, the popped-out settings window, the menu (there isn't one),
// the close guard's wiring and the Electron UI zoom (#34).
//
// This module OWNS `settingsWindow` and `closeConfirmed` — nothing outside reads either. It does not own
// `mainWindow`: 46 handlers still in main.js read it, so it stays declared there and is reached through
// ctx's getter/setter pair. That is the ctx rule: a `let` is never passed by value. A module that captured
// `mainWindow` would address a window that no longer exists after a reopen, and the symptom is a UI that
// quietly stops updating, with no error anywhere.
//
// `getSetting`/`setSetting` come in through ctx on purpose: they live in db.js, which resolves DATA_DIR at
// module load. A top-level `require('../db/db')` here would run before main.js sets DATA_DIR and hand the
// dev build the installed app's database. `test/main-modules-no-db.test.js` guards it.
'use strict';

const { BrowserWindow, dialog, ipcMain, Menu, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const quitGuard = require('./quit-guard');

let ctx = null;
let settingsWindow = null;
let closeConfirmed = false;

/**
 * @param {object} context
 * @param {() => Electron.BrowserWindow|null} context.getMainWindow  a GETTER — see the header.
 * @param {(win: Electron.BrowserWindow|null) => void} context.setMainWindow
 * @param {() => boolean} context.getAppQuitting  also a getter: it flips during quit.
 * @param {(key: string) => any} context.getSetting
 * @param {(key: string, value: any) => void} context.setSetting
 * @param {Map} context.activeSessions  the live PTY sessions — killed with the window
 * @param {Map} context.subagentWatchers  subagent live-tail watchers — released with the window
 * @param {() => void} context.stopSubagentSweep
 */
function init(context) {
  ctx = context;
}

// Pop the settings panel out into its own window (Phase 2 — multi-window POC).
// Loads a minimal settings.html that reuses settings-panel.js. Changes saved
// there broadcast back to the main window via the 'settings-changed' IPC.
//
// Two things it must not do (#175):
//  - show an unpainted window. Without a backgroundColor and a deferred show, the
//    first frame is Chromium's default white, and it sits there for as long as the
//    renderer takes to come up.
//  - be rebuilt on every open. Closing used to destroy it, so each open paid a full
//    renderer cold start: a new process, the stylesheet and every panel script from
//    scratch — seconds, spent staring at that white frame. It is now hidden on close
//    and kept warm.
//
// A hidden window is re-seeded by reloading it, and it has to be: it is a live
// renderer holding the values it was seeded with, so without that it would reopen
// showing settings as they were when it was last closed — and a Save from there
// would write them back over anything changed in the meantime. The reload is also
// what discards the unsaved edits the destroy used to take with it. It keeps the
// process, the compiled scripts and the paint, so it costs a fraction of the cold
// start — and it happens BEFORE the window is shown, never in front of the user.
function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isVisible()) { settingsWindow.focus(); return; }
    const win = settingsWindow;
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
    });
    win.webContents.reload();
    return;
  }
  const mainWindow = ctx.getMainWindow();
  settingsWindow = new BrowserWindow({
    width: 900, height: 820, minWidth: 640, minHeight: 480,
    title: 'Switchboard — Settings',
    parent: mainWindow || undefined,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    show: false,
    backgroundColor: '#0d1117', // settings.html's body background — no white first frame
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), nodeIntegration: false, contextIsolation: true },
  });
  settingsWindow.setMenu(null);
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWindow.once('ready-to-show', () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    settingsWindow.show();
    settingsWindow.focus();
  });
  // The title-bar X. (Cancel/Save go through the hide-settings-window IPC instead — a
  // renderer-initiated window.close() destroys the window without emitting this event.)
  settingsWindow.on('close', (event) => {
    // Quitting, or the main window is on its way out: let it die for real, or the
    // hidden window keeps the app alive and `window-all-closed` never fires.
    const main = ctx.getMainWindow();
    if (ctx.getAppQuitting() || !main || main.isDestroyed()) return;
    event.preventDefault();
    settingsWindow.hide();
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

/**
 * Tell the windows to re-apply the global settings. `except` skips the window that already
 * applied the change itself (that is the renderer-initiated save path, issue #76). A change
 * made in MAIN — the settings import — passes nothing and reaches every window, including
 * the one that triggered it: nobody has applied it yet.
 */
function broadcastSettingsChanged(except) {
  for (const w of [ctx.getMainWindow(), settingsWindow]) {
    if (w && !w.isDestroyed() && w.webContents !== except) {
      w.webContents.send('settings-changed');
    }
  }
}

/**
 * Closing the main window kills every PTY it owns — a Claude mid-turn, a build running in a terminal, all
 * of it, and an accidental Alt+F4 was enough. Ask first.
 *
 * The question goes to the RENDERER, so it looks like the rest of the app rather than like a Windows system
 * box. That makes it asynchronous, and a 'close' event cannot wait: so the close is cancelled, the dialog is
 * put up, and if the answer is yes the window is closed again with `closeConfirmed` set, which walks past
 * this guard. The decision and the wording live in quit-guard.js, where they can be tested.
 *
 * The native box is the fallback for the one case where the renderer cannot answer — it is gone or it has
 * crashed. Without it, a broken renderer would leave a window that cannot be closed.
 *
 * @returns {boolean} true = go ahead and close now.
 */
function confirmCloseWithRunningSessions() {
  const mainWindow = ctx.getMainWindow();
  const running = quitGuard.runningSessions(ctx.activeSessions);
  if (!quitGuard.shouldAskBeforeClose(running, ctx.getSetting('global') || {})) return true;

  const warning = quitGuard.closeWarning(running);
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;

  if (!wc || wc.isDestroyed() || wc.isCrashed()) {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      noLink: true,
      buttons: ['Cancel', 'Close and stop them'],
      defaultId: 0,   // Enter cancels: the safe answer is the one you get by reflex
      cancelId: 0,    // Escape too
      title: warning.title,
      message: warning.message,
      detail: warning.detail,
    });
    return choice === 1;
  }

  wc.send('confirm-close', warning);
  return false;   // the renderer answers on 'confirm-close-result'
}

function createWindow() {
  // Restore saved window bounds
  const savedBounds = ctx.getSetting('global')?.windowBounds;
  let bounds = { width: 1400, height: 900 };

  let restorePosition = null;
  if (savedBounds && savedBounds.width && savedBounds.height) {
    bounds.width = savedBounds.width;
    bounds.height = savedBounds.height;

    // Only restore position if it's on a visible display
    if (savedBounds.x != null && savedBounds.y != null) {
      const displays = screen.getAllDisplays();
      const onScreen = displays.some(d => {
        const b = d.bounds;
        return savedBounds.x >= b.x - 100 && savedBounds.x < b.x + b.width &&
               savedBounds.y >= b.y - 100 && savedBounds.y < b.y + b.height;
      });
      if (onScreen) {
        restorePosition = { x: savedBounds.x, y: savedBounds.y };
      }
    }
  }

  const mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 500,
    title: 'Switchboard',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  ctx.setMainWindow(mainWindow);

  // Set position after creation to prevent macOS from clamping size
  if (restorePosition) {
    mainWindow.setBounds({ ...restorePosition, width: bounds.width, height: bounds.height });
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Open external links in the system browser instead of a child BrowserWindow
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });
  // Override window.open so xterm WebLinksAddon's default handler (which does
  // window.open() then sets location.href) routes through our IPC instead of
  // creating a child BrowserWindow.
  mainWindow.webContents.on('did-finish-load', () => {
    // Restore persisted Electron UI zoom (#34). setZoomLevel resets to 0 on each
    // load, so re-apply after the page is ready.
    try {
      const g = ctx.getSetting('global') || {};
      if (typeof g.electronZoomLevel === 'number' && g.electronZoomLevel !== 0) {
        mainWindow.webContents.setZoomLevel(clampZoomLevel(g.electronZoomLevel));
      }
    } catch { /* best-effort */ }
    mainWindow.webContents.executeJavaScript(`
      window.open = function(url) {
        if (url && /^https?:\\/\\//i.test(url)) { window.api.openExternal(url); return null; }
        const proxy = {};
        Object.defineProperty(proxy, 'location', { get() {
          const loc = {};
          Object.defineProperty(loc, 'href', {
            set(u) { if (/^https?:\\/\\//i.test(u)) window.api.openExternal(u); }
          });
          return loc;
        }});
        return proxy;
      };
      void 0;
    `);
  });

  // Prevent Cmd+R / Ctrl+Shift+R from reloading the page (Chromium built-in).
  // Ctrl+R alone on macOS is NOT a reload shortcut and must pass through to xterm
  // for reverse-i-search.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'r' && input.meta) event.preventDefault();
    if (key === 'r' && input.control && input.shift) event.preventDefault();

    // The application menu (and its View-role accelerators) was removed, so wire
    // the useful ones here. primary = Cmd on macOS, Ctrl elsewhere.
    const primary = process.platform === 'darwin' ? input.meta : input.control;
    const wc = mainWindow.webContents;

    // Zoom accelerators, matched on the produced character (`key`) so they follow
    // the keyboard layout. Modifiers beyond `primary` must be rejected explicitly:
    //   - alt: Ctrl+Alt IS AltGr on Windows, so without this every AltGr chord on
    //     one of these keys zoomed.
    //   - the cross-modifier (Meta here / Ctrl on macOS), same reasoning.
    //   - shift: it never belongs to a zoom chord... except on layouts where '+'
    //     exists only as Shift+'=' (US). Allow it there and nowhere else, keyed on
    //     the physical `code` — otherwise Ctrl+Shift+numpad-plus zooms, and on a
    //     German layout Shift+'0' produces '=', so Ctrl+Shift+0 zoomed IN instead
    //     of resetting.
    const secondary = process.platform === 'darwin' ? input.control : input.meta;
    const zoomChord = primary && !input.alt && !secondary;
    const shiftAllowedForPlus = !input.shift || input.code === 'Equal';

    if (key === 'f12' || (primary && input.shift && key === 'i')) {
      // Open DevTools in a SEPARATE (detached) window, not docked to the app.
      if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools({ mode: 'detach' });
      event.preventDefault();
    } else if (key === 'f11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    } else if (zoomChord && (key === '+' || key === '=') && shiftAllowedForPlus) {
      applyMainZoom(wc.getZoomLevel() + 0.5);
      event.preventDefault();
    } else if (zoomChord && !input.shift && key === '-') {
      applyMainZoom(wc.getZoomLevel() - 0.5);
      event.preventDefault();
    } else if (zoomChord && !input.shift && key === '0') {
      applyMainZoom(0);
      event.preventDefault();
    }
  });

  // Save window bounds on move/resize (debounced)
  let boundsTimer = null;
  const saveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      const b = mainWindow.getBounds();
      const global = ctx.getSetting('global') || {};
      global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      ctx.setSetting('global', global);
    }, 500);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Also save immediately before close (debounce may not have flushed)
  mainWindow.on('close', (event) => {
    // Closing the window kills every PTY it owns (see the 'closed' handler below), and it did that
    // without a word: a Claude mid-turn, a build running in a terminal — gone, with an accidental
    // Alt+F4 enough to do it. Ask first, and ask BEFORE anything here is torn down, or a cancelled
    // close would still have taken the settings window with it.
    if (!closeConfirmed && !ctx.getAppQuitting() && !confirmCloseWithRunningSessions()) {
      event.preventDefault();
      return;
    }

    // The settings window survives its own close (it hides, #175) — take it down
    // with the main window, or `window-all-closed` never fires and the app lingers
    // with no window. `destroy()` skips its close handler by design.
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
    // #277/#287: take down any open changes and diff windows too, or `window-all-closed` never fires.
    try { require('./vcs').destroyAllVcsWindows(); } catch { /* module not wired in a test build */ }
    if (boundsTimer) clearTimeout(boundsTimer);
    if (!mainWindow.isMinimized()) {
      const b = mainWindow.getBounds();
      const global = ctx.getSetting('global') || {};
      global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      ctx.setSetting('global', global);
    }
  });

  mainWindow.on('closed', () => {
    // On macOS the app stays alive in the dock after the last window closes.
    // Kill all running PTY processes so orphaned `claude` processes don't
    // accumulate in the background with no way for the user to interact.
    for (const [id, session] of ctx.activeSessions) {
      if (!session.exited) {
        try { session.pty.kill(); } catch {}
      }
      ctx.activeSessions.delete(id);
    }
    // Release all subagent file watchers
    for (const [, entry] of ctx.subagentWatchers) {
      try { fs.unwatchFile(entry.filePath, entry.listener); } catch {}
    }
    ctx.subagentWatchers.clear();
    try { ctx.stopSubagentSweep(); } catch {}
    ctx.setMainWindow(null);
  });
}

function buildMenu() {
  // No application menu — the top menu bar (Switchboard/Edit/View) is removed.
  // The Edit roles' clipboard accelerators are preserved by Chromium for native
  // editable fields; the terminal's Ctrl+V pastes itself (terminal-manager.js).
  // DevTools/zoom/fullscreen accelerators are wired in the before-input-event
  // handler in createWindow().
  Menu.setApplicationMenu(null);
}

// --- Electron UI zoom (#34) ---
// Zoom level (not factor); Electron factor = 1.2 ** level. Clamped so the UI stays
// usable. Applied via applyMainZoom, which also persists (survives restart) and
// broadcasts `zoom-changed` so the statusbar button stays in sync — including when
// the user zooms via the keyboard accelerators.
const ZOOM_LEVEL_MIN = -3;
const ZOOM_LEVEL_MAX = 3;
function clampZoomLevel(level) {
  const v = Number(level);
  if (!Number.isFinite(v)) return 0;
  return Math.max(ZOOM_LEVEL_MIN, Math.min(ZOOM_LEVEL_MAX, v));
}
function applyMainZoom(level) {
  const mainWindow = ctx.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return 0;
  const l = clampZoomLevel(level);
  mainWindow.webContents.setZoomLevel(l);
  try {
    const g = ctx.getSetting('global') || {};
    g.electronZoomLevel = l;
    ctx.setSetting('global', g);
  } catch { /* best-effort */ }
  mainWindow.webContents.send('zoom-changed', l);
  return l;
}

function registerIpc(ipc = ipcMain) {
  ipc.on('open-settings-window', () => openSettingsWindow());

  // Cancel/Save in the standalone settings window (#175). The renderer used to call
  // window.close(), which destroys the window without ever emitting 'close' — there is
  // nothing to intercept and turn into a hide. So it asks for the hide directly, and the
  // warm renderer survives to serve the next open.
  ipc.on('hide-settings-window', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w && w === settingsWindow && !w.isDestroyed()) w.hide();
  });

  ipc.on('settings-changed', (event) => broadcastSettingsChanged(event.sender));

  // The renderer's answer. Only a yes does anything: a no has already been honoured by the cancelled close.
  ipc.on('confirm-close-result', (_event, confirmed) => {
    if (!confirmed) return;
    closeConfirmed = true;
    const mainWindow = ctx.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  // --- IPC: Electron UI zoom (#34) ---
  ipc.handle('get-zoom-level', () => {
    const mainWindow = ctx.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow.webContents.getZoomLevel();
    const g = ctx.getSetting('global') || {};
    return typeof g.electronZoomLevel === 'number' ? g.electronZoomLevel : 0;
  });
  // delta 0 = reset to 100 %; otherwise nudge current level by delta (±0.5 like the keys).
  ipc.handle('nudge-zoom', (_event, delta) => {
    const mainWindow = ctx.getMainWindow();
    const cur = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow.webContents.getZoomLevel() : 0;
    return applyMainZoom(delta === 0 ? 0 : cur + Number(delta || 0));
  });
}

module.exports = {
  init,
  registerIpc,
  createWindow,
  buildMenu,
  openSettingsWindow,
  broadcastSettingsChanged,
  applyMainZoom,
  clampZoomLevel,
};
