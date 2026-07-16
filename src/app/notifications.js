// Native notifications, the dock/taskbar badge, and the tray (spec 01).
//
// All emission is driven by the RENDERER, which funnels attention/ready transitions through the pure
// `notification-policy.js` decision module. Nothing here decides whether to notify — it only performs.
//
// The tray owns two pieces of state that nothing outside this file reads: the `Tray` instance and the
// tooltip text the renderer last pushed. `focusMainWindow` is used by every entry point here (a clicked
// notification, both tray menu items, a tray click) and by nothing else.
'use strict';

const { app, ipcMain, Menu, Notification, Tray, nativeImage } = require('electron');
const path = require('path');

let ctx = null;
let tray = null;
let traySummary = 'Switchboard';

/**
 * @param {object} context
 * @param {() => Electron.BrowserWindow|null} context.getMainWindow  a GETTER: the window is reassigned on
 *   reopen, so a captured value would address a window that no longer exists — and the symptom is a UI
 *   that quietly stops updating.
 * @param {object} context.log
 */
function init(context) {
  ctx = context;
}

/** Bring the main window forward — restoring it first if the user minimised it. */
function focusMainWindow() {
  const win = ctx.getMainWindow();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function updateTrayTooltip() {
  if (tray && !tray.isDestroyed()) tray.setToolTip(traySummary);
}

function registerIpc(ipc = ipcMain) {
  ipc.on('notify', (_event, payload) => {
    if (!Notification.isSupported()) return;
    const { title, body, sessionId } = payload || {};
    try {
      const notification = new Notification({ title: title || 'Switchboard', body: body || '' });
      notification.on('click', () => {
        focusMainWindow();
        const win = ctx.getMainWindow();
        if (sessionId && win && !win.isDestroyed()) {
          win.webContents.send('focus-session', sessionId);
        }
      });
      notification.show();
    } catch (err) {
      ctx.log.error('[notify] failed to show notification:', err?.message || String(err));
    }
  });

  ipc.on('set-badge', (_event, count) => {
    const n = Number(count) || 0;
    try {
      if (process.platform === 'darwin') {
        // macOS dock badge is the primary target.
        if (app.dock) app.dock.setBadge(n ? String(n) : '');
      } else if (typeof app.setBadgeCount === 'function') {
        // Linux (Unity launchers) honour this; it is a no-op on platforms that
        // don't support a numeric badge (e.g. Windows).
        app.setBadgeCount(n);
      }
    } catch (err) {
      ctx.log.error('[set-badge] failed:', err?.message || String(err));
    }
  });

  ipc.on('set-tray-summary', (_event, text) => {
    traySummary = typeof text === 'string' && text ? text : 'Switchboard';
    updateTrayTooltip();
  });
}

function createTray() {
  if (tray) return;
  let trayImage;
  try {
    // The icon ships inside the package (build.files) — otherwise __dirname/../build is empty in the ASAR.
    const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
    trayImage = nativeImage.createFromPath(iconPath);
    if (trayImage.isEmpty()) {
      ctx.log.error('[tray] icon image empty (asset im Paket?):', iconPath);
    } else {
      // The Windows tray wants 16px; macOS/Linux 18px as before.
      const size = process.platform === 'win32' ? 16 : 18;
      trayImage = trayImage.resize({ width: size, height: size });
    }
  } catch (err) {
    ctx.log.error('[tray] failed to load icon:', err?.message || String(err));
    trayImage = nativeImage.createEmpty();
  }
  try {
    tray = new Tray(trayImage);
  } catch (err) {
    ctx.log.error('[tray] failed to create tray:', err?.message || String(err));
    return;
  }
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Switchboard', click: () => focusMainWindow() },
    {
      // Spec 02 owns the real "next attention" handler; until then this just
      // brings the window forward.
      label: 'Focus next attention',
      click: () => {
        focusMainWindow();
        const win = ctx.getMainWindow();
        if (win && !win.isDestroyed()) win.webContents.send('focus-next-attention');
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setToolTip(traySummary);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => focusMainWindow());
}

/** Drop the tray icon. Called on quit — the OS keeps a dead icon around otherwise. */
function destroyTray() {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

module.exports = { init, registerIpc, createTray, destroyTray, focusMainWindow };
