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

// The SECOND tray: the optional usage icon (#113). Deliberately its own instance rather than a mode of
// the one above — the first tray is the app's identity and its menu, and a user who turns the usage icon
// off must not lose the way back into the window. Everything about what it SHOWS is decided in the
// renderer (`shell/usage-tray.js` picks the backend, `shell/usage-tray-icon.js` draws it); this end owns
// only the OS object and its lifetime.
let usageTray = null;
let usageTrayTooltip = 'Switchboard usage';

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

  // The usage tray, pushed from the renderer whenever the status bar's own usage changes (#113). A
  // payload with no image means "off, or nothing to show" and takes the icon down — the renderer is the
  // only party that knows both the setting and the reading, so it is the one that decides.
  //
  // `send`, not `invoke`: nothing here answers, and a usage repaint must never make the renderer wait.
  ipc.on('usage-tray-update', (_event, payload) => {
    try { applyUsageTray(payload); } catch (err) {
      ctx.log.warn('[usage-tray] update failed:', err?.message || String(err));
    }
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
  destroyUsageTray();
}

// --- The usage tray (#113) --------------------------------------------------------------------------

/** Its menu is short on purpose: this icon exists to be READ, and everything actionable already has a
 *  home in the first tray's menu. Refresh is the one thing that is about this icon's own subject. */
function usageTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open Switchboard', click: () => focusMainWindow() },
    {
      // Hide, not close: closing the main window takes its sessions down with it (`src/app/windows.js`),
      // and a menu item one click from a running agent must not be the one that ends it.
      label: 'Hide window',
      click: () => {
        const win = ctx.getMainWindow();
        if (win && !win.isDestroyed()) win.hide();
      },
    },
    {
      label: 'Show usage',
      click: () => {
        focusMainWindow();
        const win = ctx.getMainWindow();
        if (win && !win.isDestroyed()) win.webContents.send('open-stats');
      },
    },
    {
      label: 'Refresh now',
      click: () => {
        const win = ctx.getMainWindow();
        if (win && !win.isDestroyed()) win.webContents.send('refresh-usage');
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

/**
 * Apply one rendered face. Creates the tray on the first call and destroys it when the renderer says the
 * feature is off, so a switched-off icon costs no OS object at all.
 *
 * `payload.dataURL` / `.dataURL2x` are PNGs the renderer drew; `.title` is macOS-only text that sits
 * beside the icon (`setTitle` exists nowhere else), which is why the percentage is not baked into the
 * image there — the menu bar's own font follows its light/dark theme and a bitmap number cannot.
 */
function applyUsageTray(payload) {
  const data = payload || {};
  if (!data.dataURL) {
    destroyUsageTray();
    return;
  }
  let image;
  try {
    image = nativeImage.createFromDataURL(data.dataURL);
    // The second representation is what keeps it sharp on a scaled display — a menu bar draws at the
    // display's scale factor, and a 16 px bitmap stretched to 32 is visibly soft.
    if (data.dataURL2x) {
      const hiDpi = nativeImage.createFromDataURL(data.dataURL2x);
      if (!hiDpi.isEmpty()) image.addRepresentation({ scaleFactor: 2, buffer: hiDpi.toPNG() });
    }
  } catch (err) {
    ctx.log.warn('[usage-tray] could not build the icon:', err?.message || String(err));
    return;
  }
  if (image.isEmpty()) return;

  try {
    if (!usageTray || usageTray.isDestroyed()) {
      usageTray = new Tray(image);
      usageTray.setContextMenu(usageTrayMenu());
      usageTray.on('click', () => focusMainWindow());
    } else {
      usageTray.setImage(image);
    }
    // NOT a template image, deliberately: `setTemplateImage(true)` makes macOS repaint the icon in one
    // system colour, and the colour IS the reading here — a monochrome ring would say how full the
    // bucket is and not whether that is fine or nearly fatal.
    if (typeof data.tooltip === 'string' && data.tooltip) usageTrayTooltip = data.tooltip;
    usageTray.setToolTip(usageTrayTooltip);
    if (process.platform === 'darwin' && typeof usageTray.setTitle === 'function') {
      usageTray.setTitle(typeof data.title === 'string' ? data.title : '');
    }
  } catch (err) {
    ctx.log.warn('[usage-tray] could not update the icon:', err?.message || String(err));
  }
}

function destroyUsageTray() {
  if (usageTray && !usageTray.isDestroyed()) {
    try { usageTray.destroy(); } catch { /* already gone */ }
  }
  usageTray = null;
}

module.exports = { init, registerIpc, createTray, destroyTray, focusMainWindow };
