const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, screen, session, shell, Tray } = require('electron');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const pty = require('node-pty');
const log = require('electron-log');
const attentionSource = require('./public/attention-source');
// getFolderIndexMtimeMs moved to session-cache.js
const { appendToOutputBuffer, MAX_BUFFER_SIZE } = require('./output-buffer');
const { decideOsc94 } = require('./osc-busy');
const { startMcpServer, shutdownMcpServer, shutdownAll: shutdownAllMcp, resolvePendingDiff, rekeyMcpServer, cleanStaleLockFiles } = require('./mcp-bridge');
const { fetchAndTransformUsage } = require('./claude-auth');
const { withMainProcessUsageCache } = require('./usage-cache');
const { shouldUseSingleInstanceLock } = require('./main-lifecycle');
// Multi-LLM backend seam (Phase 1): the spawn/env/id-map paths ask a backend instead of
// assuming Claude. `claude` is the default backend and behaves byte-identically through it.
const backends = require('./backends');
const sessionBackends = require('./session-backends');
const { resolveEnv } = require('./env-refs');
// Log levels (#121). Raising this from the settings avoids needing a dev build to
// diagnose a live session. Three tiers, matching electron-log's own ladder:
//   info  — default. Transitions and lifecycle: busy edges, subagent spawn/complete.
//   debug — diagnostics: per-decision detail, still readable.
//   silly — firehose: one line per OSC event (the CLI retitles on every spinner
//           frame, so this is ~10 lines/s per busy session). Short sessions only.
const LOG_LEVELS = ['info', 'debug', 'silly'];
const DEFAULT_LOG_LEVEL = app.isPackaged ? 'info' : 'debug';
function applyLogLevel(level) {
  const resolved = LOG_LEVELS.includes(level) ? level : DEFAULT_LOG_LEVEL;
  log.transports.file.level = resolved;
  log.transports.console.level = resolved;
  return resolved;
}
applyLogLevel(DEFAULT_LOG_LEVEL);

// Keep a stray async error in the main process from killing the whole app with
// Electron's fatal dialog (#139). The trigger seen in the wild is a PTY write
// completing with EAGAIN on a saturated Windows conpty pipe — it throws later, in
// libuv's write-completion callback (WriteWrap.onWriteComplete), so no try/catch
// at the .write() call can catch it. It shows up in grid mode, where many
// terminals stream at once and stress the pipes; the write path itself is the
// same in tabs mode, so this guard changes no tab behaviour. Transient IO errors
// are logged and swallowed; anything else is logged at error level so real bugs
// stay visible instead of silently vanishing.
const TRANSIENT_IO_CODES = new Set(['EAGAIN', 'EPIPE', 'ECONNRESET', 'ERR_STREAM_WRITE_AFTER_END']);
process.on('uncaughtException', (err) => {
  if (err && TRANSIENT_IO_CODES.has(err.code)) {
    log.warn(`[main] swallowed transient IO error: ${err.code} — ${err.message}`);
    return;
  }
  log.error('[main] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('[main] unhandledRejection:', reason);
});

// Raise Chromium's per-renderer WebGL context budget (default 16). Every open
// terminal holds a GL context for as long as it lives — since #81 removed the
// per-tab suspend/restore, the renderer's LRU cap (12) was the only thing keeping
// us under the default. Overflow is not fatal (Chromium kills the oldest context
// and xterm falls back to its DOM renderer), but the swap shifts cell metrics, so
// it must not happen during normal use. Chromium's own guidance is to stay under
// the limit rather than raise it — a driver that runs out of GPU memory tends to
// crash instead of reporting the error — so keep this modest and well above the
// LRU cap, not unbounded. Must run before app ready.
const MAX_ACTIVE_WEBGL_CONTEXTS = 32;
app.commandLine.appendSwitch('max-active-webgl-contexts', String(MAX_ACTIVE_WEBGL_CONTEXTS));

// Dev builds default to a separate SQLite DB so they don't race on
// session_cache with a running installed app. Honors an explicit
// SWITCHBOARD_DATA_DIR env var if set (test sandboxes, agent runs). This MUST
// happen before db.js is required — db.js resolves DATA_DIR at module load.
if (!app.isPackaged && !process.env.SWITCHBOARD_DATA_DIR) {
  process.env.SWITCHBOARD_DATA_DIR = path.join(os.homedir(), '.switchboard-dev');
}

try { require('electron-reloader')(module, { watchRenderer: true }); } catch {};

// Clean env for child processes — strip Electron internals that cause nested
// Electron apps (or node-pty inside them) to malfunction.
const cleanPtyEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    !k.startsWith('ELECTRON_') &&
    !k.startsWith('GOOGLE_API_KEY') &&
    k !== 'NODE_OPTIONS' &&
    k !== 'ORIGINAL_XDG_CURRENT_DESKTOP' &&
    k !== 'WT_SESSION' &&
    // Strip any inherited AFK vars so Switchboard's per-session setting is
    // authoritative — "empty" must really mean Claude's default, not a leaked
    // shell value (#51).
    k !== 'CLAUDE_AFK_TIMEOUT_MS' &&
    k !== 'CLAUDE_AFK_COUNTDOWN_MS'
  )
);

// Shell profiles → shell-profiles.js
const { discoverShellProfiles, getShellProfiles, invalidateShellProfiles, resolveShell, isWindows, isWslShell, windowsToWslPath, shellArgs, ptyShellArgs, quoteArgvForShell } = require('./shell-profiles');
const { startScheduler } = require('./schedule-runner');
const { encodeProjectPath } = require('./encode-project-path');
const { afkTimeoutToEnvMs, resolveAfkTimeoutSec } = require('./afk-timeout');



const {
  getMeta, getAllMeta, toggleStar, setName, setArchived,
  toggleProjectFavorite, getFavoritedProjects, getProjectDisplayNames,
  getProjectMeta, setProjectAutoHidden, resetProjectAutoHide, getAutoHiddenProjects,
  renameProjectRefs, deleteProjectRefs,
  toggleBookmark, removeBookmark, listBookmarks,
  createTask, listTasks, getTask, updateTask, removeTask, openTaskCountsBySession, openTaskCountsByProject,
  saveProjectHandoff, listProjectHandoffs, deleteProjectHandoff,
  getSessionTags, setSessionTags, listAllTags, getAllSessionTags,
  getProjectTags, setProjectTags, listAllProjectTags, getAllProjectTags,
  listTagDefs, createTagDef, renameTagDef, setTagDefColor, setTagDefFlags, deleteTagDef,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedByParent, getCachedFolder, getCachedSession, upsertCachedSessions,
  deleteCachedSession, deleteCachedFolder, replaceSessionMetrics,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting,
  listSavedVariables, listAllSavedVariables, getSavedVariable, saveSavedVariable, deleteSavedVariable, touchSavedVariable,
  getDailyMetrics, getDailyModelTokens, getModelUsage, getTotalCounts,
  closeDb,
  DB_PATH,
} = require('./db');

// Re-apply the saved log level now that settings are readable (#121).
try { applyLogLevel(getSetting('global')?.logLevel); } catch { /* first run: defaults stand */ }

// Pure insert-template helpers (no Electron deps — unit-tested separately).
const { defaultInsertTemplate, shellRefFor, substituteInsertTemplate } = require('./variable-insert');

// --- Search query worker ---
// Routes 'search' IPC off the main thread so that a slow FTS5 phrase query
// (e.g. a 60-char pasted URL) never blocks the Electron event loop.
// better-sqlite3 is synchronous; on the main thread a slow query stalls ALL
// IPC (terminal data, OSC, sidebar) → visible UI freeze. The worker opens a
// read-only WAL connection which coexists safely with the main thread's writer.
//
// A dedicated worker is used instead of the existing scan-projects worker because
// that worker is used for cold-start indexing and may be occupied with a long
// sequential scan when the user types a query.
//
// Protocol logic (correlation IDs, pending map, drain, backoff, circuit-breaker)
// lives in search-worker-client.js so it can be unit-tested without Electron.
const { createSearchWorkerClient } = require('./search-worker-client');

const searchClient = createSearchWorkerClient({
  workerFactory: (dbPath) => new Worker(
    path.join(__dirname, 'workers', 'search-query.js'),
    { workerData: { dbPath } }
  ),
  searchByType,
  log,
  dbPath: DB_PATH,
});

searchClient.startWorker();

/**
 * Send a search query to the worker and return a Promise<results[]>.
 * Falls back to the synchronous searchByType on the main thread if the
 * worker is not yet ready (first-launch race or circuit-breaker open).
 */
const searchViaWorker = searchClient.searchViaWorker;

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STATS_CACHE_PATH = path.join(CLAUDE_DIR, 'stats-cache.json');
// MAX_BUFFER_SIZE imported from output-buffer.js (single source of truth)

// --- Path validation for IPC file operations ---
// Sensitive paths that should never be read/written via the file panel IPC.
// The file panel intentionally opens arbitrary files (OSC8 hyperlinks from
// terminal output), so we block known-sensitive locations rather than
// allowlisting. The primary XSS→file-access chain is mitigated by CSP +
// DOMPurify; this is defense-in-depth.
const SENSITIVE_PATH_PATTERNS = [
  /[/\\]\.ssh[/\\]/i,
  /[/\\]\.gnupg[/\\]/i,
  /[/\\]\.aws[/\\]credentials/i,
  /[/\\]\.env$/i,
  /[/\\]\.env\.local$/i,
  /[/\\]\.netrc$/i,
  /[/\\]\.docker[/\\]config\.json$/i,
  /[/\\]\.kube[/\\]config$/i,
  // Claude's own OAuth token — the app's most sensitive local asset.
  /[/\\]\.credentials\.json$/i,
  /[/\\]\.claude[/\\]\.credentials/i,
  // Private keys / package + shell secrets that can live outside ~/.ssh.
  /[/\\]id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?$/i,
  /[/\\]\.npmrc$/i,
  /[/\\]\.pypirc$/i,
  /[/\\]\.(?:bash|zsh)_history$/i,
];

function isSensitivePath(filePath) {
  const resolved = path.resolve(filePath);
  return SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(resolved));
}

// All indexed project roots (same enumeration as the get-memories handler).
// Cached: enumerating PROJECTS_DIR + deriveProjectPath on every read-call is
// wasteful; refreshed lazily every PROJECT_ROOTS_TTL_MS.
const PROJECT_ROOTS_TTL_MS = 5000;
let _projectRootsCache = null;
let _projectRootsCachedAt = 0;
function getIndexedProjectRoots() {
  const now = Date.now();
  if (_projectRootsCache && now - _projectRootsCachedAt < PROJECT_ROOTS_TTL_MS) {
    return _projectRootsCache;
  }
  const roots = new Set();
  try {
    if (fs.existsSync(PROJECTS_DIR)) {
      for (const d of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name === '.git') continue;
        const p = deriveProjectPath(path.join(PROJECTS_DIR, d.name));
        if (p) roots.add(p);
      }
    }
  } catch {}
  _projectRootsCache = roots;
  _projectRootsCachedAt = now;
  return roots;
}

// Allowlist for memory/plan files: ~/.claude, active-session project dirs, or
// any indexed project root. The Plans/Memory panel (get-memories) surfaces
// memory files from EVERY indexed project — not just ones with a live session —
// so the allowlist must cover every known project root, else reading a memory
// file for a project without an open session would be rejected.
function isAllowedMemoryPath(filePath) {
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(CLAUDE_DIR + path.sep) || resolved === CLAUDE_DIR) return true;
  for (const [, session] of activeSessions) {
    if (session.projectPath && resolved.startsWith(session.projectPath + path.sep)) return true;
  }
  for (const root of getIndexedProjectRoots()) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return true;
  }
  return false;
}

// Active PTY sessions
const activeSessions = new Map();
let mainWindow = null;
let settingsWindow = null;

// Pop the settings panel out into its own window (Phase 2 — multi-window POC).
// Loads a minimal settings.html that reuses settings-panel.js. Changes saved
// there broadcast back to the main window via the 'settings-changed' IPC.
function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 900, height: 820, minWidth: 640, minHeight: 480,
    title: 'Switchboard — Settings',
    parent: mainWindow || undefined,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true },
  });
  settingsWindow.setMenu(null);
  settingsWindow.loadFile(path.join(__dirname, 'public', 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}
ipcMain.on('open-settings-window', () => openSettingsWindow());
ipcMain.on('settings-changed', (event) => {
  // Broadcast to every window except the sender, so a change made in the main
  // window also reaches the settings popout (and vice-versa) (issue #76).
  for (const w of [mainWindow, settingsWindow]) {
    if (w && !w.isDestroyed() && w.webContents !== event.sender) {
      w.webContents.send('settings-changed');
    }
  }
});

// Subagent live-tail watchers (watchId → { filePath, parentSessionId, agentId })
const subagentWatchers = new Map();
let subagentWatcherSeq = 0;

function createWindow() {
  // Restore saved window bounds
  const savedBounds = getSetting('global')?.windowBounds;
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

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 500,
    title: 'Switchboard',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Set position after creation to prevent macOS from clamping size
  if (restorePosition) {
    mainWindow.setBounds({ ...restorePosition, width: bounds.width, height: bounds.height });
  }

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

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
      const g = getSetting('global') || {};
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
      wc.toggleDevTools();
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
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      const b = mainWindow.getBounds();
      const global = getSetting('global') || {};
      global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      setSetting('global', global);
    }, 500);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Also save immediately before close (debounce may not have flushed)
  mainWindow.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    if (!mainWindow.isMinimized()) {
      const b = mainWindow.getBounds();
      const global = getSetting('global') || {};
      global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      setSetting('global', global);
    }
  });

  mainWindow.on('closed', () => {
    // On macOS the app stays alive in the dock after the last window closes.
    // Kill all running PTY processes so orphaned `claude` processes don't
    // accumulate in the background with no way for the user to interact.
    for (const [id, session] of activeSessions) {
      if (!session.exited) {
        try { session.pty.kill(); } catch {}
      }
      activeSessions.delete(id);
    }
    // Release all subagent file watchers
    for (const [, entry] of subagentWatchers) {
      try { fs.unwatchFile(entry.filePath, entry.listener); } catch {}
    }
    subagentWatchers.clear();
    try { sessionTransitions.stopSubagentSweep(); } catch {}
    mainWindow = null;
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
  if (!mainWindow || mainWindow.isDestroyed()) return 0;
  const l = clampZoomLevel(level);
  mainWindow.webContents.setZoomLevel(l);
  try {
    const g = getSetting('global') || {};
    g.electronZoomLevel = l;
    setSetting('global', g);
  } catch { /* best-effort */ }
  mainWindow.webContents.send('zoom-changed', l);
  return l;
}

// --- Native notifications, dock/taskbar badge, and tray (Spec 01) ---
// All emission is driven by the renderer, which funnels attention/ready
// transitions through the pure notification-policy.js decision module.
let tray = null;
let traySummary = 'Switchboard';

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function updateTrayTooltip() {
  if (tray && !tray.isDestroyed()) tray.setToolTip(traySummary);
}

ipcMain.on('notify', (_event, payload) => {
  if (!Notification.isSupported()) return;
  const { title, body, sessionId } = payload || {};
  try {
    const notification = new Notification({ title: title || 'Switchboard', body: body || '' });
    notification.on('click', () => {
      focusMainWindow();
      if (sessionId && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('focus-session', sessionId);
      }
    });
    notification.show();
  } catch (err) {
    log.error('[notify] failed to show notification:', err?.message || String(err));
  }
});

ipcMain.on('set-badge', (_event, count) => {
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
    log.error('[set-badge] failed:', err?.message || String(err));
  }
});

ipcMain.on('set-tray-summary', (_event, text) => {
  traySummary = typeof text === 'string' && text ? text : 'Switchboard';
  updateTrayTooltip();
});

function createTray() {
  if (tray) return;
  let trayImage;
  try {
    // Icon liegt jetzt mit im Paket (build.files), sonst ist __dirname/build im ASAR leer.
    const iconPath = path.join(__dirname, 'build', 'icon.png');
    trayImage = nativeImage.createFromPath(iconPath);
    if (trayImage.isEmpty()) {
      log.error('[tray] icon image empty (asset im Paket?):', iconPath);
    } else {
      // Windows-Tray erwartet 16px; macOS/Linux 18px wie bisher.
      const size = process.platform === 'win32' ? 16 : 18;
      trayImage = trayImage.resize({ width: size, height: size });
    }
  } catch (err) {
    log.error('[tray] failed to load icon:', err?.message || String(err));
    trayImage = nativeImage.createEmpty();
  }
  try {
    tray = new Tray(trayImage);
  } catch (err) {
    log.error('[tray] failed to create tray:', err?.message || String(err));
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
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('focus-next-attention');
        }
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setToolTip(traySummary);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => focusMainWindow());
}

// --- Session cache helpers ---

const { deriveProjectPath } = require('./derive-project-path');

// Session cache → session-cache.js
const sessionCache = require('./session-cache');
sessionCache.init({
  PROJECTS_DIR,
  activeSessions,
  getMainWindow: () => mainWindow,
  log,
  db: {
    deleteCachedFolder, getCachedByFolder, upsertCachedSessions, deleteCachedSession, replaceSessionMetrics,
    deleteSearchFolder, deleteSearchSession, upsertSearchEntries,
    setFolderMeta, getFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, getMeta, setName,
    getFavoritedProjects, getProjectDisplayNames, getAutoHiddenProjects,
  },
});
const { readSessionFile, readFolderFromFilesystem, refreshFolder, refreshFile, reconcileCacheFromFilesystem,
        buildProjectsFromCache, buildProjectsAdmin, shouldAutoHide, notifyRendererProjectsChanged, sendStatus, populateCacheViaWorker } = sessionCache;
const { resolveJsonlPath } = require('./read-session-file');
const claudeConfig = require('./claude-config');


// --- IPC: browse-folder ---
ipcMain.handle('browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Project Folder',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// --- IPC: add-project ---
ipcMain.handle('add-project', (_event, projectPath) => {
  try {
    // Validate the path exists and is a directory
    const stat = fs.statSync(projectPath);
    if (!stat.isDirectory()) return { error: 'Path is not a directory' };

    // Unhide if previously hidden
    const global = getSetting('global') || {};
    if (global.hiddenProjects && global.hiddenProjects.includes(projectPath)) {
      global.hiddenProjects = global.hiddenProjects.filter(p => p !== projectPath);
      setSetting('global', global);
    }

    // Create the corresponding folder in ~/.claude/projects/ so it persists
    const folder = encodeProjectPath(projectPath);
    const folderPath = path.join(PROJECTS_DIR, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Seed a minimal .jsonl so deriveProjectPath can read the cwd
    if (!fs.readdirSync(folderPath).some(f => f.endsWith('.jsonl'))) {
      const seedId = require('crypto').randomUUID();
      const seedFile = path.join(folderPath, seedId + '.jsonl');
      const now = new Date().toISOString();
      const line = JSON.stringify({ type: 'user', cwd: projectPath, sessionId: seedId, uuid: require('crypto').randomUUID(), timestamp: now, message: { role: 'user', content: 'New project' } });
      fs.writeFileSync(seedFile, line + '\n');
    }

    // Explicit add → allowlist, so it shows in manual project mode too.
    ensureProjectAdded(projectPath);

    // Immediately index the new folder so it's in cache before frontend renders
    refreshFolder(folder);
    notifyRendererProjectsChanged();

    return { ok: true, folder, projectPath };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: remove-project ---
ipcMain.handle('remove-project', (_event, projectPath) => {
  try {
    // Add to hidden projects list
    const global = getSetting('global') || {};
    const hidden = global.hiddenProjects || [];
    if (!hidden.includes(projectPath)) hidden.push(projectPath);
    global.hiddenProjects = hidden;
    // Also drop from the manual-mode allowlist so it stays gone in manual mode.
    if (Array.isArray(global.addedProjects)) {
      global.addedProjects = global.addedProjects.filter(p => p !== projectPath);
    }
    setSetting('global', global);

    // Clean up DB cache and search index for this folder
    const folder = encodeProjectPath(projectPath);
    deleteCachedFolder(folder);
    deleteSearchFolder(folder);
    deleteSetting('project:' + projectPath);

    notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: get-hidden-projects ---
// List of projectPaths the user has hidden (for the restore UI).
ipcMain.handle('get-hidden-projects', () => {
  const global = getSetting('global') || {};
  const auto = getAutoHiddenProjects();
  // Return objects so the restore UI can flag auto-hidden projects with a badge.
  return (global.hiddenProjects || []).map(p => ({ path: p, autoHidden: auto.has(p) }));
});

// --- IPC: unhide-project ---
// Remove a project from the hidden list and re-index its folder so it
// reappears in the sidebar. The on-disk ~/.claude/projects folder still exists
// (remove-project only cleared the DB cache), so a refresh repopulates it.
ipcMain.handle('unhide-project', (_event, projectPath) => {
  try {
    const global = getSetting('global') || {};
    global.hiddenProjects = (global.hiddenProjects || []).filter(p => p !== projectPath);
    setSetting('global', global);
    // #57: restart the grace timer + clear the auto flag so an unhidden stale
    // project isn't re-hidden on the next auto-hide pass.
    try { resetProjectAutoHide(projectPath); } catch {}

    const folder = encodeProjectPath(projectPath);
    try { refreshFolder(folder); } catch {}
    notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- Manual-project-mode allowlist helper ---
// Add a projectPath to the `addedProjects` allowlist (used only when
// projectAutoAdd === false). Idempotent; persists to the global settings blob.
function ensureProjectAdded(projectPath) {
  if (!projectPath) return;
  // #57: adding / re-adding a project restarts its auto-hide grace timer so a just-
  // added stale project isn't immediately auto-hidden again on the next pass.
  try { resetProjectAutoHide(projectPath); } catch {}
  const global = getSetting('global') || {};
  const added = Array.isArray(global.addedProjects) ? global.addedProjects : [];
  if (!added.includes(projectPath)) {
    added.push(projectPath);
    global.addedProjects = added;
    setSetting('global', global);
  }
}

// --- #57: Auto-hide stale projects ---
// One pass over all known projects: any non-hidden project with no running session
// whose effective activity (max of newest session activity and autoHideResetAt) is
// older than `autoHideDays` gets added to hiddenProjects with the autoHidden flag set.
// Runs in the main process on app start and on the throttled project refresh.
let lastAutoHideAt = 0;
const AUTO_HIDE_THROTTLE_MS = 10000;
function applyAutoHide(force) {
  try {
    const global = getSetting('global') || {};
    const days = Number(global.autoHideDays) || 0;
    if (!(days > 0)) return;

    const now = Date.now();
    if (!force && now - lastAutoHideAt < AUTO_HIDE_THROTTLE_MS) return;
    lastAutoHideAt = now;

    // Projects with a live (non-exited) session are active — never auto-hide them.
    const runningPaths = new Set();
    for (const [, session] of activeSessions) {
      if (session.exited) continue;
      if (session.projectPath) runningPaths.add(session.projectPath);
    }

    const hidden = new Set(global.hiddenProjects || []);
    let changed = false;
    // buildProjectsAdmin returns every project (hidden included) with lastActivity.
    for (const row of buildProjectsAdmin()) {
      if (hidden.has(row.projectPath)) continue;      // already hidden (manual or auto)
      if (runningPaths.has(row.projectPath)) continue; // has a running session
      const meta = getProjectMeta(row.projectPath);
      const activityMs = row.lastActivity ? new Date(row.lastActivity).getTime() : 0;
      const resetMs = meta && meta.autoHideResetAt ? new Date(meta.autoHideResetAt).getTime() : 0;
      const eff = Math.max(activityMs, resetMs);
      if (shouldAutoHide(eff, now, days)) {
        hidden.add(row.projectPath);
        try { setProjectAutoHidden(row.projectPath, 1); } catch {}
        changed = true;
      }
    }

    if (changed) {
      global.hiddenProjects = [...hidden];
      setSetting('global', global);
      notifyRendererProjectsChanged();
    }
  } catch (err) {
    log.error('[auto-hide] applyAutoHide failed:', err && err.message);
  }
}

// --- IPC: set-project-auto-add ---
// Toggle automatic project discovery. When turning OFF (manual mode), freeze the
// currently-visible projects into the allowlist so nothing disappears; new folders
// discovered afterwards won't appear unless added explicitly. Turning ON again
// ignores the allowlist (everything is discovered as before).
ipcMain.handle('set-project-auto-add', (_event, enabled) => {
  try {
    const global = getSetting('global') || {};
    if (!enabled) {
      // Snapshot the current (auto-discovered) set before flipping the flag.
      const visible = buildProjectsFromCache(false).map(p => p.projectPath);
      global.addedProjects = [...new Set(visible)];
    }
    global.projectAutoAdd = !!enabled;
    setSetting('global', global);
    notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: remap-project ---
ipcMain.handle('remap-project', (_event, oldPath, newPath) => {
  try {
    const stat = fs.statSync(newPath);
    if (!stat.isDirectory()) return { error: 'Path is not a directory' };

    // Find the folder key for the old project path
    const folder = encodeProjectPath(oldPath);
    const folderPath = path.join(PROJECTS_DIR, folder);
    if (!fs.existsSync(folderPath)) return { error: 'No session data found for this project' };

    // Rewrite cwd in all session JSONL files so CLI --resume also works
    const jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
    for (const file of jsonlFiles) {
      const filePath = path.join(folderPath, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const updated = content.split('\n').map(line => {
        if (!line) return line;
        try {
          const parsed = JSON.parse(line);
          if (parsed.cwd === oldPath) {
            parsed.cwd = newPath;
            return JSON.stringify(parsed);
          }
        } catch {}
        return line;
      }).join('\n');
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, updated);
      fs.renameSync(tmp, filePath);
    }

    // Re-point the folder→projectPath cache before refreshing. folderProjectPath()
    // short-circuits derivation while the previously-derived directory still exists
    // — and after a remap the OLD directory usually does. Without this the folder
    // keeps resolving to oldPath, the rewritten cwd is ignored, and the project
    // vanishes from the sidebar once the rest of its state has moved to newPath.
    // A zero mtime marks the folder stale so the refresh below fully re-indexes it.
    setFolderMeta(folder, newPath, 0);

    // Refresh the folder cache so the new path takes effect
    refreshFolder(folder);

    // Carry Switchboard's own per-project state across (#55): favorite + auto-hide
    // (project_meta), tags, handoffs, and the `project:<path>` blob that holds the
    // display name, permission mode, worktree prefs and AFK timeout. Without this a
    // remap silently dropped all of it and left the old path behind as a phantom.
    try { renameProjectRefs(oldPath, newPath); } catch (err) {
      log.warn('[remap] project refs move failed: ' + err.message);
    }
    try {
      const global = getSetting('global') || {};
      let touched = false;
      for (const key of ['hiddenProjects', 'addedProjects']) {
        if (!Array.isArray(global[key]) || !global[key].includes(oldPath)) continue;
        // Rewrite in place, and never end up with the path listed twice.
        global[key] = [...new Set(global[key].map(p => (p === oldPath ? newPath : p)))];
        touched = true;
      }
      if (touched) setSetting('global', global);
    } catch (err) {
      log.warn('[remap] global project lists move failed: ' + err.message);
    }

    // Move the project's ~/.claude.json entry (trust/MCP/cost) to the new path so it
    // survives the remap. Non-fatal: the session cwd rewrite above already succeeded.
    try {
      const moved = claudeConfig.renameProjectEntry(oldPath, newPath);
      if (moved && moved.error) log.warn('[remap] ~/.claude.json move failed: ' + moved.error);
    } catch (err) {
      log.warn('[remap] ~/.claude.json move threw: ' + err.message);
    }

    notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: get-projects-admin (#32) ---
// Aggregated per-project admin view: cache-derived rows (all projects incl. hidden)
// layered with trust state + read-only ~/.claude.json meta (MCP/allowedTools/cost/tokens),
// plus any project that only exists in ~/.claude.json (so trust can still be managed).
// Returns ONLY aggregated fields — never the raw secret-bearing config.
ipcMain.handle('get-projects-admin', () => {
  try {
    const global = getSetting('global') || {};
    const autoAdd = global.projectAutoAdd !== false;
    const allowed = Array.isArray(global.addedProjects) ? new Set(global.addedProjects) : null;

    // Parse ~/.claude.json once (~160 KB) and derive all three views from it,
    // instead of each helper re-reading + re-parsing the file.
    const cfg = claudeConfig.readClaudeConfig();
    const trustMap = claudeConfig.getProjectTrustMap(undefined, cfg);   // normalized -> bool
    const metaMap = claudeConfig.getProjectClaudeMeta(undefined, cfg);  // normalized -> {counts...}

    const rows = buildProjectsAdmin();
    const byNorm = new Map();
    for (const r of rows) byNorm.set(claudeConfig.normalizeClaudePath(r.projectPath), r);

    // Fold in ~/.claude.json-only projects (have trust/meta but no Switchboard cache).
    const cfgKeys = cfg && cfg.projects ? Object.keys(cfg.projects) : [];
    for (const norm of trustMap.keys()) {
      if (byNorm.has(norm)) continue;
      const key = cfgKeys.find(k => claudeConfig.normalizeClaudePath(k) === norm) || null;
      const projectPath = key || norm;
      const r = {
        projectPath,
        folder: encodeProjectPath(projectPath),
        displayName: '',
        sessionCount: 0,
        lastActivity: null,
        missing: !fs.existsSync(projectPath),
        hidden: (global.hiddenProjects || []).includes(projectPath),
        favorite: false,
        configOnly: true,
      };
      rows.push(r);
      byNorm.set(norm, r);
    }

    for (const r of rows) {
      const norm = claudeConfig.normalizeClaudePath(r.projectPath);
      r.trusted = trustMap.has(norm) ? trustMap.get(norm) : null;
      const m = metaMap.get(norm) || {};
      r.mcpServersCount = m.mcpServersCount || 0;
      r.allowedToolsCount = m.allowedToolsCount || 0;
      r.lastCost = m.lastCost != null ? m.lastCost : null;
      r.inputTokens = m.inputTokens != null ? m.inputTokens : null;
      r.outputTokens = m.outputTokens != null ? m.outputTokens : null;
      // In manual mode, whether the project is on the explicit allowlist.
      r.inAllowlist = allowed ? allowed.has(r.projectPath) : true;
    }

    return { ok: true, autoAdd, projects: rows };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: set-project-trust (#32) ---
// Atomic RMW on ~/.claude.json, only the `hasTrustDialogAccepted` field. Setting to
// true is a security decision (the renderer gates it behind a warning confirm).
ipcMain.handle('set-project-trust', (_event, projectPath, trusted) => {
  const result = claudeConfig.setProjectTrust(projectPath, trusted);
  if (result.ok) notifyRendererProjectsChanged();
  return result;
});

// --- IPC: delete-project-sessions (#32) ---
// Does any ~/.claude/projects/<folder> still resolve to this project? Legacy folder
// encodings mean there can be several, so scan rather than test the encoded name.
function projectHasSessionsOnDisk(projectPath) {
  const encoded = encodeProjectPath(projectPath);
  try {
    return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .some(d => d.name === encoded || deriveProjectPath(path.join(PROJECTS_DIR, d.name)) === projectPath);
  } catch {
    return false;
  }
}

function projectIsInClaudeConfig(projectPath) {
  try {
    const cfg = claudeConfig.readClaudeConfig();
    if (!cfg || !cfg.projects) return false;
    const norm = claudeConfig.normalizeClaudePath(projectPath);
    return Object.keys(cfg.projects).some(k => claudeConfig.normalizeClaudePath(k) === norm);
  } catch {
    return false;
  }
}

// After a hard delete, forget the project entirely (#55). Only when nothing is left
// to restore — no sessions on disk and no ~/.claude.json entry. A plain "hide" keeps
// all of this, because unhiding has to bring the project back intact.
//
// Called at the end of the two hard-delete handlers rather than from the renderer:
// the "Remove" dialog runs them in sequence, so whichever finishes last finds the
// project truly gone and does the pruning.
function pruneProjectIfGone(projectPath) {
  if (!projectPath) return false;
  if (projectHasSessionsOnDisk(projectPath) || projectIsInClaudeConfig(projectPath)) return false;

  try { deleteProjectRefs(projectPath); } catch (err) {
    log.warn('[prune] project refs delete failed: ' + err.message);
  }
  try {
    const global = getSetting('global') || {};
    let touched = false;
    for (const key of ['hiddenProjects', 'addedProjects']) {
      if (!Array.isArray(global[key]) || !global[key].includes(projectPath)) continue;
      global[key] = global[key].filter(p => p !== projectPath);
      touched = true;
    }
    if (touched) setSetting('global', global);
  } catch (err) {
    log.warn('[prune] global project lists cleanup failed: ' + err.message);
  }
  log.info('[prune] forgot project (no sessions, no config entry): ' + projectPath);
  return true;
}

// Hard-delete a project's on-disk session history: every ~/.claude/projects/<folder>
// that resolves to this projectPath (legacy encodings can leave several), plus its DB
// cache + search index. Session .jsonl files are gone afterwards. Guards each target to
// stay strictly inside PROJECTS_DIR before removing.
ipcMain.handle('delete-project-sessions', (_event, projectPath) => {
  try {
    if (!projectPath) return { error: 'No project path' };
    const encoded = encodeProjectPath(projectPath);
    let removed = 0;
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git');
    for (const d of dirs) {
      const folderPath = path.join(PROJECTS_DIR, d.name);
      const pp = deriveProjectPath(folderPath);
      if (pp !== projectPath && d.name !== encoded) continue;
      // Safety: never remove anything outside PROJECTS_DIR.
      const resolved = path.resolve(folderPath);
      if (!resolved.startsWith(path.resolve(PROJECTS_DIR) + path.sep)) continue;
      fs.rmSync(resolved, { recursive: true, force: true });
      try { deleteCachedFolder(d.name); } catch {}
      try { deleteSearchFolder(d.name); } catch {}
      removed++;
    }
    pruneProjectIfGone(projectPath);
    notifyRendererProjectsChanged();
    return { ok: true, removed };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: remove-project-config (#32) ---
// Hard-delete the project's entry from ~/.claude.json (trust, MCP, allowedTools, cost).
// Atomic RMW with .bak; all other keys/secrets preserved.
ipcMain.handle('remove-project-config', (_event, projectPath) => {
  const result = claudeConfig.removeProjectEntry(projectPath);
  if (result.ok) {
    pruneProjectIfGone(projectPath);
    notifyRendererProjectsChanged();
  }
  return result;
});

// --- IPC: delete-worktree ---
// Validated path pattern: <project>/.<segment>/[worktrees/]<name>
// Matches .claude/worktrees/<n>, .claude-worktrees/<n>, .worktrees/<n>
const WORKTREE_PATH_RE = /^(.+?)\/\.(?:claude\/worktrees|claude-worktrees|worktrees)\/([^/]+)\/?$/;

ipcMain.handle('delete-worktree', (_event, worktreePath) => {
  return new Promise((resolve) => {
    // Normalize trailing slash
    const normalizedPath = worktreePath.replace(/\/$/, '');

    // Validate path matches a known worktree layout
    const match = normalizedPath.match(WORKTREE_PATH_RE);
    if (!match) {
      return resolve({ ok: false, error: 'Path does not match a recognized worktree layout' });
    }
    const parentRepo = match[1];

    // Helper: run git worktree remove, optionally double-force
    function runRemove(doubleForce, callback) {
      const args = ['-C', parentRepo, 'worktree', 'remove', '-f'];
      if (doubleForce) args.push('-f');
      args.push('--', normalizedPath);
      execFile('git', args, (err, _stdout, stderr) => callback(err, stderr));
    }

    runRemove(false, (err, stderr) => {
      if (err && /locked/i.test(stderr || err.message || '')) {
        // Retry with double force for locked worktrees
        runRemove(true, (err2, stderr2) => {
          if (err2) return resolve({ ok: false, error: (stderr2 || err2.message || String(err2)).trim() });
          afterRemove();
        });
      } else if (err) {
        return resolve({ ok: false, error: (stderr || err.message || String(err)).trim() });
      } else {
        afterRemove();
      }
    });

    function afterRemove() {
      // Clean up DB cache: delete all sessions whose projectPath matches worktreePath
      let removed = 0;
      try {
        const allRows = getAllCached();
        for (const row of allRows) {
          if (row.projectPath === normalizedPath) {
            deleteCachedSession(row.sessionId);
            deleteSearchSession(row.sessionId);
            removed++;
          }
        }
      } catch (dbErr) {
        log.warn('[delete-worktree] DB cleanup error:', dbErr.message);
      }

      // Remove from hiddenProjects if present
      try {
        const global = getSetting('global') || {};
        if (Array.isArray(global.hiddenProjects) && global.hiddenProjects.includes(normalizedPath)) {
          global.hiddenProjects = global.hiddenProjects.filter(p => p !== normalizedPath);
          setSetting('global', global);
        }
      } catch {}

      // Also clean up folder meta
      try {
        const folder = encodeProjectPath(normalizedPath);
        deleteCachedFolder(folder);
        deleteSearchFolder(folder);
      } catch {}

      log.info(`[delete-worktree] removed=${normalizedPath} sessions=${removed}`);
      notifyRendererProjectsChanged();
      resolve({ ok: true, removed });
    }
  });
});

// --- IPC: worktree-status ---
ipcMain.handle('worktree-status', (_event, worktreePath) => {
  return new Promise((resolve) => {
    const normalizedPath = worktreePath.replace(/\/$/, '');
    const match = normalizedPath.match(WORKTREE_PATH_RE);
    if (!match) {
      return resolve({ ok: false, error: 'Path does not match a recognized worktree layout' });
    }
    const parentRepo = match[1];

    execFile('git', ['-C', parentRepo, '-C', normalizedPath, 'status', '--porcelain'], (err, stdout, stderr) => {
      if (err) {
        return resolve({ ok: false, error: (stderr || err.message || String(err)).trim() });
      }
      const dirty = stdout.split('\n').map(l => l.trimEnd()).filter(Boolean);
      resolve({ ok: true, dirty, total: dirty.length });
    });
  });
});

// --- IPC: get-projects ---
ipcMain.handle('open-external', (_event, url) => {
  log.info('[open-external IPC]', url);
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
});

// --- IPC: open a local file in the OS default app (terminal right-click menu) ---
ipcMain.handle('open-path', (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return;
  const resolved = path.resolve(filePath);
  // Mirror the read/save-file-for-panel guard: never hand a sensitive path
  // (~/.ssh, credentials, etc.) to the OS default opener.
  if (isSensitivePath(resolved)) return;
  return shell.openPath(resolved);
});

// --- IPC: open a local file in the user's configured external editor (#69) ---
// execFile (no shell string interpolation — security convention). Falls back to
// the OS default app when no editor is configured, or if the launch fails.
ipcMain.handle('open-in-editor', (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'no path' };
  const resolved = path.resolve(filePath);
  if (isSensitivePath(resolved)) return { ok: false, error: 'access to sensitive path denied' };
  const cmd = (((getSetting('global') || {}).externalEditorCommand) || '').trim();
  if (!cmd) { shell.openPath(resolved); return { ok: true, fallback: true }; }
  try {
    execFile(cmd, [resolved], { windowsHide: true }, (err) => {
      if (err) { log.warn('[open-in-editor] launch failed, using OS default:', err.message); shell.openPath(resolved); }
    });
    return { ok: true };
  } catch (err) {
    shell.openPath(resolved);
    return { ok: true, fallback: true, error: err.message };
  }
});

// --- IPC: open the OS terminal in a directory (launch-and-forget, no monitoring) ---
ipcMain.handle('open-external-terminal', (_event, cwdPath) => {
  if (typeof cwdPath !== 'string' || !cwdPath) return { ok: false, error: 'no path' };
  const cwd = path.resolve(cwdPath);
  if (!fs.existsSync(cwd)) return { ok: false, error: 'path not found' };
  try {
    if (process.platform === 'win32') {
      // Prefer Windows Terminal; fall back to a cmd window in the directory. The cwd
      // is passed via execFile's option (no shell quoting of spaces).
      execFile('wt.exe', ['-d', cwd], (err) => {
        if (err) execFile('cmd.exe', ['/c', 'start', 'cmd.exe'], { cwd }, () => {});
      });
    } else if (process.platform === 'darwin') {
      execFile('open', ['-a', 'Terminal', cwd], () => {});
    } else {
      execFile('gnome-terminal', ['--working-directory=' + cwd], (err) => {
        if (err) execFile('x-terminal-emulator', ['--working-directory=' + cwd], (e2) => {
          if (e2) execFile('xterm', [], { cwd }, () => {});
        });
      });
    }
    return { ok: true };
  } catch (e) {
    log.warn('[open-external-terminal]', e?.message || String(e));
    return { ok: false, error: String(e?.message || e) };
  }
});

// --- IPC: read clipboard (terminal right-click paste; see clipboard-write-text) ---
ipcMain.handle('read-clipboard', () => clipboard.readText());

// --- IPC: clipboard write ---
// The renderer's navigator.clipboard.writeText is gated on focus/user-activation and
// is flaky-to-dead on Linux/Wayland (Ozone). The main-process clipboard has no such
// strings attached, so all terminal copies go through here.
ipcMain.handle('clipboard-write-text', (_event, text) => {
  if (typeof text === 'string') clipboard.writeText(text);
});

// --- IPC: save a clipboard bitmap to a temp PNG (terminal image paste) ---
// Claude Code ingests an image *file path* as [Image #N]. Native clipboard-image
// paste isn't available everywhere (e.g. Windows), so on Ctrl+V we snapshot the
// clipboard bitmap to a temp PNG and insert its path — giving image paste on all
// platforms. Returns the absolute path, or null when the clipboard has no bitmap
// (e.g. plain text or a copied file, which the caller handles differently).
let _clipboardImageSeq = 0;
const CLIPBOARD_TMP_DIR = path.join(os.tmpdir(), 'switchboard-clipboard');
ipcMain.handle('save-clipboard-image', () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return null;
    const png = img.toPNG();
    if (!png || !png.length) return null;
    fs.mkdirSync(CLIPBOARD_TMP_DIR, { recursive: true });
    const file = path.join(CLIPBOARD_TMP_DIR, `paste-${Date.now()}-${_clipboardImageSeq++}.png`);
    fs.writeFileSync(file, png);
    return file;
  } catch (err) {
    log.error(`[clipboard-image] save failed: ${err.message}`);
    return null;
  }
});

// --- IPC: MCP bridge ---
ipcMain.on('mcp-diff-response', (_event, sessionId, diffId, action, editedContent) => {
  resolvePendingDiff(sessionId, diffId, action, editedContent);
});

function resolvePanelFilePath(filePath) {
  if (typeof filePath === 'string' && filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return path.resolve(filePath);
}

ipcMain.handle('read-file-for-panel', async (_event, filePath) => {
  try {
    const resolved = resolvePanelFilePath(filePath);
    if (isSensitivePath(resolved)) return { ok: false, error: 'access to sensitive path denied' };
    const content = fs.readFileSync(resolved, 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Read a file as a base64 data URL for the panel image preview (#49). Guarded by
// the same sensitive-path check as the text read, with a size cap so a huge file
// can't blow up the renderer.
const { mimeForExt: previewMimeForExt } = require('./public/preview-kind.js');
const PREVIEW_DATAURL_MAX = 15 * 1024 * 1024; // 15 MB
ipcMain.handle('read-file-dataurl', async (_event, filePath) => {
  try {
    const resolved = resolvePanelFilePath(filePath);
    if (isSensitivePath(resolved)) return { ok: false, error: 'access to sensitive path denied' };
    const stat = fs.statSync(resolved);
    if (stat.size > PREVIEW_DATAURL_MAX) {
      return { ok: false, error: `File too large to preview (${Math.round(stat.size / 1048576)} MB, max 15 MB)` };
    }
    const ext = path.extname(resolved).slice(1).toLowerCase();
    const mime = previewMimeForExt(ext) || 'application/octet-stream';
    const buf = await fs.promises.readFile(resolved);
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('save-file-for-panel', async (_event, filePath, content) => {
  try {
    const resolved = resolvePanelFilePath(filePath);
    if (isSensitivePath(resolved)) return { ok: false, error: 'access to sensitive path denied' };
    if (!fs.existsSync(resolved)) return { ok: false, error: 'File does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    // Close the sub-second window between save and search: if the saved file
    // belongs to a type that the FTS index tracks, invalidate its signature so
    // the next get-work-files / get-memories call triggers a full reindex
    // (matching the explicit invalidation in save-memory / delete-work-file).
    if (resolved.includes('/.work-files/') || resolved.includes('\\.work-files\\')) invalidateFtsSignature('work-file');
    if (resolved.endsWith('.md')) invalidateFtsSignature('memory');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── File Watching (for viewer panels) ────────────────────────────────
const fileWatchers = new Map(); // filePath → FSWatcher

ipcMain.handle('watch-file', (_event, filePath) => {
  const resolved = resolvePanelFilePath(filePath);
  if (isSensitivePath(resolved)) return { ok: false, error: 'access to sensitive path denied' };
  if (fileWatchers.has(resolved)) return { ok: true };
  try {
    let debounce = null;
    const watcher = fs.watch(resolved, (eventType) => {
      if (eventType !== 'change') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('file-changed', filePath);
        }
      }, 300);
    });
    fileWatchers.set(resolved, watcher);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('unwatch-file', (_event, filePath) => {
  const resolved = resolvePanelFilePath(filePath);
  const watcher = fileWatchers.get(resolved);
  if (watcher) {
    watcher.close();
    fileWatchers.delete(resolved);
  }
  return { ok: true };
});

// Full re-scan triggered from the UI. Re-reads every jsonl file in the worker
// thread, which is the only path that rebuilds search_fts with the live tail
// of active sessions (refreshFolder uses a header-only read by design — see
// session-cache.js). Concurrent callers share the same in-flight worker via
// populateCacheViaWorker's internal Promise.
ipcMain.handle('rebuild-cache', async () => {
  try {
    await populateCacheViaWorker();
    return { ok: true };
  } catch (err) {
    console.error('Error rebuilding cache:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-projects', async (_event, showArchived) => {
  try {
    const needsPopulate = !isCachePopulated() || !isSearchIndexPopulated();

    if (needsPopulate) {
      // First call after a migration that clears session_cache (e.g. v4) finds
      // an empty cache. Returning [] immediately makes the renderer paint an
      // empty list and rely on `notifyRendererProjectsChanged` firing later —
      // which only triggers a reload if the user is on the Sessions tab. To
      // avoid that race, await the scan here so the response carries the
      // freshly-populated cache. Concurrent callers share the same Promise.
      await populateCacheViaWorker();
    }

    // Pick up folders changed while the app was closed, or never indexed by an
    // older build, so sessions/worktrees don't silently go missing. Stat-gated,
    // so it's cheap when nothing has changed.
    reconcileCacheFromFilesystem();
    // #57: apply auto-hide before building the response so freshly-hidden projects
    // drop out of this render. Internally throttled, so it's cheap on rapid calls.
    applyAutoHide();
    return buildProjectsFromCache(showArchived);
  } catch (err) {
    console.error('Error listing projects:', err);
    return [];
  }
});

// --- IPC: get-plans ---
ipcMain.handle('get-plans', () => {
  try {
    if (!fs.existsSync(PLANS_DIR)) return [];
    const files = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md'));
    const plans = [];
    const sigFiles = [];
    const bodies = new Map(); // filename → content (single read: title + FTS body)
    for (const file of files) {
      const filePath = path.join(PLANS_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        const firstLine = content.split('\n').find(l => l.trim());
        const title = firstLine && firstLine.startsWith('# ')
          ? firstLine.slice(2).trim()
          : file.replace(/\.md$/, '');
        plans.push({ filename: file, title, modified: stat.mtime.toISOString() });
        bodies.set(file, content);
        sigFiles.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {}
    }
    plans.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    // Index plans for FTS — skipped when the file set is unchanged (dirty-flag,
    // same shouldReindex gate as get-memories / get-work-files).
    try {
      const sig = computeIndexSignature(sigFiles);
      if (shouldReindex('plan', sig)) {
        deleteSearchType('plan');
        upsertSearchEntries(plans.map(p => ({
          id: p.filename, type: 'plan', folder: null,
          title: p.title,
          body: bodies.get(p.filename) || '',
        })));
      }
    } catch {}

    return plans;
  } catch (err) {
    console.error('Error reading plans:', err);
    return [];
  }
});

// --- IPC: read-plan ---
ipcMain.handle('read-plan', (_event, filename) => {
  try {
    const filePath = path.join(PLANS_DIR, path.basename(filename));
    const content = fs.readFileSync(filePath, 'utf8');
    return { content, filePath };
  } catch (err) {
    console.error('Error reading plan:', err);
    return { content: '', filePath: '' };
  }
});

// --- IPC: save-plan ---
ipcMain.handle('save-plan', (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(PLANS_DIR + path.sep)) {
      return { ok: false, error: 'path outside plans directory' };
    }
    fs.writeFileSync(resolved, content, 'utf8');
    // Invalidate the FTS signature so the next get-plans call reindexes
    // (guards against sub-second writes where the mtime might not advance).
    invalidateFtsSignature('plan');
    return { ok: true };
  } catch (err) {
    console.error('Error saving plan:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: get-stats ---
ipcMain.handle('get-stats', () => {
  try {
    if (!fs.existsSync(STATS_CACHE_PATH)) return null;
    const raw = fs.readFileSync(STATS_CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading stats cache:', err);
    return null;
  }
});

// --- IPC: get-stats-from-db ---
// Builds a stats object from session_cache so the heatmap reflects real usage
// including subagent sessions (which claude /stats silently ignores) and
// periods where Claude already rotated the parent JSONL files off disk.
ipcMain.handle('get-stats-from-db', () => {
  try {
    return buildStatsFromDb();
  } catch (err) {
    log.error('Error building stats from DB:', err);
    return null;
  }
});

// Build the full stats object the renderer consumes. Sourced from
// session_metrics (per-(session,date,model) tokens/tool-calls/messages bucketed
// by message timestamp) so tokens, tool calls, and per-model usage are all real
// data — not the hardcoded {} the heatmap-only path used to return.
function buildStatsFromDb() {
  const daily = getDailyMetrics();       // [{date, messageCount, toolCallCount, tokens, sessionCount}]
  const totals = getTotalCounts();
  const lastComputedDate = new Date().toISOString().slice(0, 10);
  return {
    dailyActivity: daily,
    dailyModelTokens: getDailyModelTokens(),
    modelUsage: getModelUsage(),
    totalMessages: totals.totalMessages,
    totalSessions: totals.totalSessions,
    totalToolCalls: totals.totalToolCalls,
    totalTokens: totals.totalTokens,
    firstSessionDate: daily[0]?.date || lastComputedDate,
    lastComputedDate,
  };
}

// --- IPC: refresh-stats (fetch /usage + build stats from DB; /stats PTY removed) ---
ipcMain.handle('refresh-stats', async () => {
  try {
    // /stats PTY call removed — heatmap is now sourced from session_cache via
    // get-stats-from-db. Only /usage is fetched here (rate-limits panel).
    const usage = await fetchAndTransformUsage().catch(() => ({}));

    // Build stats from DB (same as get-stats-from-db) so the caller gets both
    // at once and the renderer can update heatmap + usage in a single round-trip.
    let stats = null;
    try {
      stats = buildStatsFromDb();
    } catch (dbErr) {
      log.error('Error building stats from DB in refresh-stats:', dbErr);
    }

    return { stats, usage: usage || {} };
  } catch (err) {
    log.error('Error refreshing stats:', err);
    return { stats: null, usage: {} };
  }
});

// --- IPC: get-usage (lightweight, API-only, no PTY) ---
ipcMain.handle('get-usage', async () => {
  const cachedUsage = getSetting('usage:lastSuccessful');
  try {
    const usage = await fetchAndTransformUsage() || {};
    const result = withMainProcessUsageCache(usage, cachedUsage);
    if (result.cacheValue) {
      try {
        setSetting('usage:lastSuccessful', result.cacheValue);
      } catch (err) {
        log.warn('[usage] failed to persist usage cache', err?.message || String(err));
      }
      log.info('[usage] fetched fresh usage', { keys: Object.keys(usage).filter(key => !key.startsWith('_')) });
    } else if (result.fromCache) {
      log.warn('[usage] serving cached usage', {
        reason: result.response._staleMessage,
        cachedAt: result.response._cachedAt,
      });
    } else if (usage._error || usage._rateLimited) {
      log.warn('[usage] usage unavailable', usage);
    }
    return result.response;
  } catch (err) {
    log.error('Error fetching usage:', err);
    const result = withMainProcessUsageCache({ _error: true, message: err.message }, cachedUsage);
    return result.response;
  }
});

// ---------------------------------------------------------------------------
// FTS dirty-flag: skip full reindex when file set hasn't changed.
// Each tab handler (get-memories, get-work-files) computes a cheap signature
// from the collected file list (sorted filePath + mtimeMs + size) and compares
// it to the last-indexed signature stored here. If equal, the expensive
// deleteSearchType + upsertSearchEntries block is skipped entirely — including
// the full-file readFileSync calls on every file.
//
// Invariant: the result payload (file tree returned to the UI) is built and
// returned unconditionally; only the FTS side-effect is gated.
//
// Invalidation: save-memory and delete-work-file mutations clear the stored
// signature for their respective type, forcing a fresh reindex on the next
// tab open (even if mtime precision rounds to the same second on some FSes).
// ---------------------------------------------------------------------------

/** @type {Map<string, string>} type → last-indexed signature */
const _ftsIndexSignature = new Map();

/**
 * Compute a cheap stable signature for an array of indexed file descriptors.
 * @param {Array<{filePath: string, mtimeMs: number, size: number}>} files
 * @returns {string}
 */
function computeIndexSignature(files) {
  // Sort by filePath for determinism regardless of scan order.
  const sorted = [...files].sort((a, b) => a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0);
  return sorted.map(f => `${f.filePath}\x00${f.mtimeMs}\x00${f.size}`).join('\n');
}

/**
 * Returns true when the file set for the given FTS type has changed since
 * the last reindex (or was never indexed), and updates the stored signature.
 * @param {string} type - FTS type key ('memory' | 'work-file' | 'plan')
 * @param {string} sig  - result of computeIndexSignature()
 * @returns {boolean}
 */
function shouldReindex(type, sig) {
  if (_ftsIndexSignature.get(type) === sig) return false;
  _ftsIndexSignature.set(type, sig);
  return true;
}

/**
 * Invalidate the stored signature for a given FTS type, forcing a full
 * reindex on the next get-memories / get-work-files call.
 * @param {string} type
 */
function invalidateFtsSignature(type) {
  _ftsIndexSignature.delete(type);
}

// --- IPC: get-memories ---
function folderToShortPath(folder) {
  // Convert "-Users-home-dev-MyClaude" → "dev/MyClaude"
  const parts = folder.replace(/^-/, '').split('-');
  const meaningful = parts.filter(Boolean);
  return meaningful.slice(-2).join('/');
}

/** Scan a directory for .md files (non-recursive). Returns array of { filename, filePath, modified, size }.
 *  Emptiness is judged by stat.size instead of reading every file's content —
 *  get-memories runs this over dozens of directories per call, and the FTS
 *  block below reads the bodies anyway when a reindex is actually due.
 *  (Whitespace-only files now count as non-empty; harmless.) */
function scanMdFiles(dir) {
  const results = [];
  try {
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) {
        const fp = path.join(dir, e.name);
        try {
          const stat = fs.statSync(fp);
          if (stat.size > 0) {
            results.push({ filename: e.name, filePath: fp, modified: stat.mtime.toISOString(), size: stat.size });
          }
        } catch {}
      }
    }
  } catch {}
  return results;
}

ipcMain.handle('get-memories', () => {
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);
  const projectDisplayNames = getProjectDisplayNames();

  // --- Global files ---
  const globalFiles = scanMdFiles(CLAUDE_DIR).map(f => ({ ...f, displayPath: '~/.claude' }));

  // --- Per-project files ---
  const projects = [];
  try {
    if (fs.existsSync(PROJECTS_DIR)) {
      const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '.git')
        .map(d => d.name);

      for (const folder of folders) {
        const folderPath = path.join(PROJECTS_DIR, folder);
        const projectPath = deriveProjectPath(folderPath);
        if (projectPath && hiddenProjects.has(projectPath)) continue;

        // Use same 2-deep short path as Sessions tab (e.g. "dev/MyClaude")
        const shortName = projectPath
          ? projectPath.split('/').filter(Boolean).slice(-2).join('/')
          : folderToShortPath(folder);
        const files = [];
        const seenPaths = new Set();

        // 1. ~/.claude/projects/{folder}/ — claude-home .md files
        const claudeHomeFiles = scanMdFiles(folderPath);
        for (const f of claudeHomeFiles) {
          files.push({ ...f, displayPath: '~/.claude', source: 'claude-home' });
          seenPaths.add(f.filePath);
        }
        // memory/MEMORY.md
        const memoryDir = path.join(folderPath, 'memory');
        const memoryFiles = scanMdFiles(memoryDir);
        for (const f of memoryFiles) {
          files.push({ ...f, displayPath: '~/.claude', source: 'claude-home' });
          seenPaths.add(f.filePath);
        }

        // 2. {projectPath}/ — project root CLAUDE.md, agents.md
        if (projectPath) {
          for (const name of ['CLAUDE.md', 'GEMINI.md', 'agents.md']) {
            const fp = path.join(projectPath, name);
            try {
              if (fs.existsSync(fp)) {
                // Same stat-only emptiness check as scanMdFiles — no content read here.
                const stat = fs.statSync(fp);
                if (stat.size > 0 && !seenPaths.has(fp)) {
                  files.push({ filename: name, filePath: fp, modified: stat.mtime.toISOString(), size: stat.size, displayPath: shortName + '/', source: 'project' });
                  seenPaths.add(fp);
                }
              }
            } catch {}
          }

          // 3. {projectPath}/.claude/ — commands/*.md and other .md files
          const dotClaudeDir = path.join(projectPath, '.claude');
          const dotClaudeFiles = scanMdFiles(dotClaudeDir);
          for (const f of dotClaudeFiles) {
            if (!seenPaths.has(f.filePath)) {
              files.push({ ...f, displayPath: shortName + '/.claude/', source: 'project' });
              seenPaths.add(f.filePath);
            }
          }
          // commands/*.md
          const commandsDir = path.join(dotClaudeDir, 'commands');
          const commandFiles = scanMdFiles(commandsDir);
          for (const f of commandFiles) {
            if (!seenPaths.has(f.filePath)) {
              files.push({ ...f, displayPath: shortName + '/.claude/commands/', source: 'project' });
              seenPaths.add(f.filePath);
            }
          }
        }

        if (files.length > 0) {
          const displayName = (projectPath && projectDisplayNames.get(projectPath)) || '';
          projects.push({ folder, projectPath: projectPath || '', shortName, displayName, files });
        }
      }
    }
  } catch (err) {
    console.error('Error scanning memories:', err);
  }

  // Sort projects by most recent file modified date
  projects.sort((a, b) => {
    const aMax = Math.max(...a.files.map(f => new Date(f.modified).getTime()));
    const bMax = Math.max(...b.files.map(f => new Date(f.modified).getTime()));
    return bMax - aMax;
  });

  const result = { global: { files: globalFiles }, projects };

  // Index all files for FTS — skipped when the file set is unchanged (dirty-flag).
  try {
    const allFiles = [
      ...globalFiles.map(f => ({ ...f, label: 'Global' })),
      ...projects.flatMap(p => p.files.map(f => ({ ...f, label: p.displayName || p.shortName }))),
    ];
    const sig = computeIndexSignature(allFiles.map(f => ({
      filePath: f.filePath,
      mtimeMs: new Date(f.modified).getTime(),
      size: f.size || 0,
    })));
    if (shouldReindex('memory', sig)) {
      // Only a due reindex reads file contents at all — the list above is
      // built from stats alone.
      deleteSearchType('memory');
      upsertSearchEntries(allFiles.map(f => ({
        id: f.filePath, type: 'memory', folder: null,
        title: f.label + ' ' + f.filename,
        body: fs.readFileSync(f.filePath, 'utf8'),
      })));
    }
  } catch {}

  return result;
});

// --- IPC: read-memory ---
ipcMain.handle('read-memory', (_event, filePath) => {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.endsWith('.md')) return '';
    if (!isAllowedMemoryPath(resolved)) return '';
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    console.error('Error reading memory file:', err);
    return '';
  }
});

// --- IPC: save-memory ---
ipcMain.handle('save-memory', (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.endsWith('.md')) return { ok: false, error: 'not a .md file' };
    if (!isAllowedMemoryPath(resolved)) return { ok: false, error: 'path not allowed' };
    if (!fs.existsSync(resolved)) return { ok: false, error: 'file does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    // Invalidate the FTS signature so the next get-memories call reindexes
    // (mtime change is caught by the signature, but an explicit invalidation
    // guards against sub-second writes where the mtime might not advance).
    invalidateFtsSignature('memory');
    return { ok: true };
  } catch (err) {
    console.error('Error saving memory file:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: get-work-files ---
// Walks <projectPath>/.work-files/ recursively for all known projects.
// Returns { projects: WorkFilesProject[] } — empty projects are skipped.
// Caps at WORK_FILES_CAP files per project (most recent by mtime) to guard
// against huge .work-files trees (e.g. tagpay has ~39k files).
const WORK_FILES_CAP = 200;

function walkWorkFiles(dir, baseDir, results) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const fullPath = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkWorkFiles(fullPath, baseDir, results);
    } else if (e.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        const relativePath = path.relative(baseDir, fullPath);
        results.push({
          filename: e.name,
          filePath: fullPath,
          relativePath,
          modified: stat.mtime.toISOString(),
          size: stat.size,
        });
      } catch {}
    }
  }
}

ipcMain.handle('get-work-files', () => {
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);
  const projectDisplayNames = getProjectDisplayNames();
  const projects = [];

  try {
    if (fs.existsSync(PROJECTS_DIR)) {
      const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '.git')
        .map(d => d.name);

      for (const folder of folders) {
        const folderPath = path.join(PROJECTS_DIR, folder);
        const projectPath = deriveProjectPath(folderPath);
        if (!projectPath) continue;
        if (hiddenProjects.has(projectPath)) continue;

        const workFilesDir = path.join(projectPath, '.work-files');
        if (!fs.existsSync(workFilesDir)) continue;

        const shortName = projectPath.split('/').filter(Boolean).slice(-2).join('/');

        const allFiles = [];
        walkWorkFiles(workFilesDir, workFilesDir, allFiles);

        // Sort by modified desc
        allFiles.sort((a, b) => new Date(b.modified) - new Date(a.modified));

        const totalCount = allFiles.length;
        const files = allFiles.slice(0, WORK_FILES_CAP);

        if (files.length > 0) {
          const displayName = projectDisplayNames.get(projectPath) || '';
          projects.push({ projectPath, shortName, displayName, files, totalCount });
        }
      }
    }
  } catch (err) {
    console.error('Error scanning work-files:', err);
  }

  // Sort projects by most recent file modified date
  projects.sort((a, b) => {
    const aMax = a.files.length > 0 ? new Date(a.files[0].modified).getTime() : 0;
    const bMax = b.files.length > 0 ? new Date(b.files[0].modified).getTime() : 0;
    return bMax - aMax;
  });

  // Index for FTS — text files ≤ 64KB, skip .jsonl — skipped when file set is unchanged.
  try {
    const allFiles = projects.flatMap(proj => proj.files.map(f => ({ ...f, proj })));
    const sig = computeIndexSignature(allFiles.map(f => ({
      filePath: f.filePath,
      mtimeMs: new Date(f.modified).getTime(),
      size: f.size,
    })));
    if (shouldReindex('work-file', sig)) {
      deleteSearchType('work-file');
      const TEXT_MAX = 64 * 1024;
      const entries = allFiles.map(f => {
        let body = '';
        if (!f.relativePath.endsWith('.jsonl') && f.size <= TEXT_MAX) {
          try { body = fs.readFileSync(f.filePath, 'utf8'); } catch {}
        }
        return {
          id: f.filePath, type: 'work-file', folder: null,
          title: (f.proj.displayName || f.proj.shortName) + ' ' + f.relativePath,
          body,
        };
      });
      upsertSearchEntries(entries);
    }
  } catch {}

  return { projects };
});

// A work-file path is only allowed if it sits inside the `.work-files` dir of a
// project Claude actually knows about — otherwise a compromised renderer could
// read/delete arbitrary `.work-files` dirs anywhere on disk (issue #77).
function isAllowedWorkFilePath(resolved) {
  const m = resolved.match(/[\\/]\.work-files[\\/]/);
  if (!m) return false;
  const projectRoot = resolved.slice(0, m.index);
  try {
    return fs.existsSync(path.join(PROJECTS_DIR, encodeProjectPath(projectRoot)));
  } catch { return false; }
}

// --- IPC: read-work-file ---
ipcMain.handle('read-work-file', (_event, filePath) => {
  try {
    const resolved = path.resolve(filePath);
    if (!isAllowedWorkFilePath(resolved)) return '[access denied]';
    if (!fs.existsSync(resolved)) return '';
    const stat = fs.statSync(resolved);
    if (stat.size > 2 * 1024 * 1024) return '[file too large to display]';
    // Detect binary: try reading as utf8; if it fails or contains null bytes, treat as binary
    const buf = fs.readFileSync(resolved);
    if (buf.includes(0)) return '[binary file]';
    return buf.toString('utf8');
  } catch (err) {
    console.error('Error reading work file:', err);
    return '';
  }
});

// --- IPC: delete-work-file ---
ipcMain.handle('delete-work-file', (_event, filePath) => {
  try {
    const resolved = path.resolve(filePath);
    if (!isAllowedWorkFilePath(resolved)) return { ok: false, error: 'access denied' };
    if (!fs.existsSync(resolved)) return { ok: false, error: 'not found' };
    fs.unlinkSync(resolved);
    // Invalidate the FTS signature so the next get-work-files call reindexes.
    // Deletion changes the path set, which the signature would catch; the explicit
    // invalidation is a belt-and-braces guard for path-set mutations.
    invalidateFtsSignature('work-file');
    return { ok: true };
  } catch (err) {
    console.error('Error deleting work file:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: search ---
// Routed through the search-query worker so that slow FTS5 phrase queries
// (e.g. a 60-char pasted URL) do not block the Electron main event loop.
// The renderer already awaits window.api.search(...) — this change is transparent.
ipcMain.handle('search', (_event, type, query, titleOnly) => {
  return searchViaWorker(type, query, titleOnly);
});

// --- IPC: settings ---
ipcMain.handle('get-setting', (_event, key) => {
  return getSetting(key);
});

ipcMain.handle('set-setting', (_event, key, value) => {
  setSetting(key, value);
  return { ok: true };
});

// Atomic partial update of an object-valued setting: read-merge-write happens
// synchronously inside this single handler, so concurrent callers (tab drag,
// sidebar resize, a second window) can't clobber each other's unrelated keys
// the way a renderer-side read-modify-write of the whole blob does (issue #75).
ipcMain.handle('merge-setting', (_event, key, partial) => {
  const cur = getSetting(key);
  const base = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? cur : {};
  setSetting(key, { ...base, ...(partial || {}) });
  return { ok: true };
});

ipcMain.handle('delete-setting', (_event, key) => {
  deleteSetting(key);
  return { ok: true };
});

// --- IPC: saved variables ---
// Named, reusable values shown in the terminal Saved Variables panel. Secret
// values are encrypted at-rest via Electron safeStorage; if the OS keychain is
// unavailable we fall back to plain storage (with a logged warning) rather than
// crash so the feature still works in headless/dev environments.
function normalizeSavedVariableTags(tags) {
  const raw = Array.isArray(tags) ? tags : String(tags || '').split(',');
  const seen = new Set();
  const normalized = [];
  for (const item of raw) {
    const tag = String(item || '').trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag.slice(0, 40));
    if (normalized.length >= 20) break;
  }
  return normalized;
}

function encryptSavedVariableValue(value, secret) {
  const stringValue = String(value ?? '');
  if (!secret) {
    return { value: stringValue, valueEncoding: 'plain' };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('[saved-variables] safeStorage unavailable — storing secret value as plain text');
    return { value: stringValue, valueEncoding: 'plain' };
  }
  return {
    value: safeStorage.encryptString(stringValue).toString('base64'),
    valueEncoding: 'safe-storage',
  };
}

function decryptSavedVariableValue(row) {
  if (!row) return '';
  if (row.valueEncoding === 'safe-storage') {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('System secret storage is unavailable');
    }
    return safeStorage.decryptString(Buffer.from(row.value || '', 'base64'));
  }
  return String(row.value ?? '');
}

function serializeSavedVariable(row, includeValue = false) {
  if (!row) return null;
  const serialized = {
    id: row.id,
    name: row.name,
    secret: !!row.secret,
    scope: row.scope || 'global',
    projectPath: row.projectPath || null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    insertTemplate: row.insertTemplate || '',
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    lastUsedAt: row.lastUsedAt || null,
  };
  if (includeValue) serialized.value = decryptSavedVariableValue(row);
  return serialized;
}

function savedVariablePromptValue(value) {
  const stringValue = String(value ?? '');
  return /[\s;]/.test(stringValue) ? JSON.stringify(stringValue) : stringValue;
}

function savedVariablePromptLine(variable) {
  return `${variable.name}=${savedVariablePromptValue(variable.value)}`;
}

function formatSavedVariablesForPrompt(variables) {
  if (!variables.length) return '';
  if (variables.length === 1) return savedVariablePromptLine(variables[0]);
  return `Saved variables: ${variables.map(savedVariablePromptLine).join('; ')}`;
}

ipcMain.handle('list-saved-variables', (_event, projectPath) => {
  try {
    return listSavedVariables(typeof projectPath === 'string' ? projectPath : null)
      .map(row => serializeSavedVariable(row));
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-saved-variable', (_event, id) => {
  try {
    const row = getSavedVariable(id);
    if (!row) return { ok: false, error: 'Variable not found' };
    return { ok: true, variable: serializeSavedVariable(row, true) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('save-saved-variable', (_event, input = {}) => {
  try {
    const name = String(input.name || '').trim().slice(0, 120);
    if (!name) return { ok: false, error: 'Name is required' };

    const scope = input.scope === 'project' ? 'project' : 'global';
    const projectPath = scope === 'project' ? String(input.projectPath || '').trim() : null;
    if (scope === 'project' && !projectPath) {
      return { ok: false, error: 'Project scope requires an active project' };
    }

    const secret = !!input.secret;
    const encoded = encryptSavedVariableValue(input.value, secret);
    const row = saveSavedVariable({
      id: input.id || require('crypto').randomUUID(),
      name,
      value: encoded.value,
      valueEncoding: encoded.valueEncoding,
      secret,
      scope,
      projectPath,
      tags: normalizeSavedVariableTags(input.tags),
      insertTemplate: String(input.insertTemplate || '').slice(0, 2000),
    });

    return { ok: true, variable: serializeSavedVariable(row) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('delete-saved-variable', (_event, id) => {
  try {
    deleteSavedVariable(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('use-saved-variables', (_event, ids = []) => {
  try {
    const variables = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const row = getSavedVariable(id);
      if (!row) continue;
      const variable = serializeSavedVariable(row, true);
      variables.push(variable);
      touchSavedVariable(id);
    }
    return {
      ok: true,
      text: formatSavedVariablesForPrompt(variables),
      variables: variables.map(({ value, ...variable }) => variable),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Full CRUD list for the Variables admin tab: every variable regardless of scope.
ipcMain.handle('list-all-saved-variables', () => {
  try {
    return listAllSavedVariables().map(row => serializeSavedVariable(row));
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Secret variable materialization (temp file + shell reference) -------------
// A secret's plaintext must NEVER be typed into the terminal input/prompt (it
// would land in shell history, scrollback, the Claude transcript, …). Instead we
// write the decrypted value to a 0600 temp file under userData/secret-refs and
// hand back a shell substitution that reads it at exec time. Files are swept by
// TTL on each create and wiped on quit.
const secretRefFiles = new Set();
const secretRefBySession = new Map(); // sessionId -> Set<path>

// Track a materialized secret-ref temp file, optionally scoped to the session
// that inserted it (so it can be wiped when that session stops).
function trackSecretRef(filePath, sessionId) {
  secretRefFiles.add(filePath);
  if (!sessionId) return;
  let s = secretRefBySession.get(sessionId);
  if (!s) { s = new Set(); secretRefBySession.set(sessionId, s); }
  s.add(filePath);
}

// Delete a session's secret-ref temp files (called on its PTY exit when the
// cleanup-on-session-stop setting is on). Best-effort.
function cleanupSecretRefsForSession(sessionId) {
  const s = secretRefBySession.get(sessionId);
  if (!s) return;
  for (const p of s) { try { fs.unlinkSync(p); } catch {} secretRefFiles.delete(p); }
  secretRefBySession.delete(sessionId);
}

function getSecretRefDir() {
  return path.join(app.getPath('userData'), 'secret-refs');
}

// Map a resolved shell path to the coarse family we build references for.
function classifyShellType(shellPath) {
  if (isWslShell(shellPath)) return 'unknown'; // temp file is a Windows path WSL can't cat directly
  const base = path.basename(shellPath || '').toLowerCase();
  if (base.includes('powershell') || base.includes('pwsh')) return 'pwsh';
  if (base === 'cmd.exe' || base === 'cmd') return 'cmd';
  if (base.includes('bash') || base.includes('zsh') || base === 'sh' || base === 'dash' || base === 'ksh') return 'bash';
  return 'unknown';
}

// Resolve the effective shell family for a project (mirrors createTerminalSession's
// profile precedence: project override → global → default → auto detection).
function resolveShellTypeForProject(projectPath) {
  return classifyShellType(resolveShell(effectiveSettings(projectPath).shellProfile).path);
}

// Delete secret-ref temp files older than maxAgeMs (best-effort, tolerant).
// Opt-in: a missing/<=0 maxAgeMs is a no-op (age-sweep off).
function sweepSecretRefs(maxAgeMs) {
  if (!maxAgeMs || maxAgeMs <= 0) return;
  const dir = getSecretRefDir();
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
        fs.unlinkSync(p);
        secretRefFiles.delete(p);
      }
    } catch {}
  }
}

// Wipe every secret-ref temp file (tracked + any strays) — called on quit.
function cleanupSecretRefs() {
  for (const p of secretRefFiles) { try { fs.unlinkSync(p); } catch {} }
  secretRefFiles.clear();
  try {
    const dir = getSecretRefDir();
    for (const name of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, name)); } catch {}
    }
  } catch {}
}

// Resolve the shell family for a project so the renderer can pick the right
// reference syntax (or fall back to clipboard copy for cmd/unknown).
ipcMain.handle('get-shell-type', (_event, projectPath) => {
  try {
    return { ok: true, shellType: resolveShellTypeForProject(typeof projectPath === 'string' ? projectPath : null) };
  } catch (err) {
    return { ok: false, error: err.message, shellType: 'unknown' };
  }
});

// Resolve a variable's insert-template into the exact text to place in the
// terminal. Supersedes the raw-value / materialize-secret-ref paths: it applies
// the variable's insertTemplate (or the secret/non-secret default), materializing
// a 0600 temp file only when the template references it via {path}/{ref}.
//   - {value}  → raw plaintext (leaves main only for non-secret defaults or an
//                explicit {value} template — a deliberate, documented choice).
//   - {path}   → path of a 0600 temp file holding the decrypted value.
//   - {ref}    → shell-native inline read of that file; if the shell can't do it
//                (cmd/unknown/WSL) we return { fallback:'copy', value } instead.
ipcMain.handle('resolve-variable-insert', (_event, id, shellType, sessionId) => {
  try {
    const row = getSavedVariable(id);
    if (!row) return { ok: false, error: 'Variable not found' };
    const value = decryptSavedVariableValue(row);
    const tmpl = (row.insertTemplate && row.insertTemplate.trim()) || defaultInsertTemplate(!!row.secret);
    const needsRef = tmpl.includes('{ref}');
    const needsPath = tmpl.includes('{path}');
    // A {ref} template on a shell without inline-read support can't be inserted
    // safely → copy fallback. Checked before writing any temp file so we don't
    // leave a stray secret file behind for the copy path.
    if (needsRef && shellRefFor(shellType, '') === null) {
      return { ok: false, fallback: 'copy', value };
    }
    let filePath = null;
    if (needsRef || needsPath) {
      const dir = getSecretRefDir();
      fs.mkdirSync(dir, { recursive: true });
      // Age-sweep is opt-in via the secretRefSweepMinutes setting (0 = off) so a
      // long-running prompt's ref isn't purged mid-use; quit/startup/session-stop
      // handle the rest.
      sweepSecretRefs((Number(getSetting('global')?.secretRefSweepMinutes) || 0) * 60000);
      filePath = path.join(dir, require('crypto').randomUUID());
      fs.writeFileSync(filePath, value, { mode: 0o600 });
      trackSecretRef(filePath, sessionId);
    }
    const ref = needsRef ? shellRefFor(shellType, filePath) : null;
    const text = substituteInsertTemplate(tmpl, { path: filePath, ref, value });
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Claude Code hook → attention ingest (spec 05) -----------------------------
// A tiny loopback HTTP server receives structured hook events from Claude Code
// (registered as `type: "http"` hooks in ~/.claude/settings.json) and forwards a
// normalized `attention-signal` to the renderer. The hook payload's `session_id`
// is the Claude session UUID — exactly Switchboard's realSessionId — so no extra
// correlation is needed. OSC-9 remains the default heuristic + fallback.
const CLAUDE_SETTINGS_JSON = path.join(os.homedir(), '.claude', 'settings.json');
// Sentinel in the hook URL path so we can find & remove only our own handlers.
const ATTENTION_HOOK_MARK = '/switchboard-attention-hook';

let attentionHookServer = null;
let attentionHookPort = null;
let attentionHookToken = null; // random token embedded in the hook URL, verified on POST (issue #77)

function attentionHooksEnabled() {
  const global = getSetting('global') || {};
  return global.attentionHooks === true;
}

function startAttentionHookServer() {
  if (attentionHookServer) return;
  attentionHookToken = require('crypto').randomUUID();
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    // Verify the per-run token from the hook URL so an unrelated local process
    // can't forge attention signals or force undebounced reads (issue #77).
    let reqToken = null;
    try { reqToken = new URL(req.url, 'http://127.0.0.1').searchParams.get('t'); } catch {}
    if (!attentionHookToken || reqToken !== attentionHookToken) {
      res.writeHead(403);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy(); // guard against runaway payloads
    });
    req.on('end', () => {
      try {
        const hook = JSON.parse(body || '{}');
        const sessionId = hook.session_id || hook.sessionId;
        // Fast-path: a hook POST (Stop/Notification) is an instant push at a turn
        // boundary. Refresh that session's transcript now — bypassing the watcher +
        // reindex debounces — so a rename (Claude /rename → custom-title) shows the
        // moment the turn ends instead of lagging up to several seconds (#60).
        if (sessionId) {
          try {
            const sess = activeSessions.get(sessionId)
              || [...activeSessions.values()].find(x => x.realSessionId === sessionId);
            if (sess && sess.projectFolder) {
              // relFilename is folder-prefixed (refreshFile strips the first segment).
              refreshFile(sess.projectFolder, sess.projectFolder + '/' + sessionId + '.jsonl', { immediate: true });
            }
          } catch (err) {
            log.warn(`[attention-hook] fast refresh failed: ${err.message}`);
          }
        }
        const signal = attentionSource.classifyAttentionSignal({ source: 'hook', payload: hook });
        if (sessionId && signal && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('attention-signal', {
            sessionId,
            kind: signal.kind,
            reason: signal.reason,
            source: 'hook',
            // Subagent lifecycle events carry the subagent's identity (#119).
            agentId: signal.agentId || null,
            agentType: signal.agentType || null,
          });
          const agentSuffix = signal.agentId ? ` agentId=${signal.agentId}` : '';
          log.info(`[attention-hook] session=${sessionId} kind=${signal.kind}${agentSuffix} reason="${signal.reason}"`);
        }
      } catch (err) {
        log.warn(`[attention-hook] bad payload: ${err.message}`);
      }
      // Empty decision object = no-op; never block or alter Claude's behavior.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  // Set the guard immediately (not inside the listen callback) so a second call
  // while the socket is still binding cannot create a second server (issue #76).
  attentionHookServer = server;
  server.on('error', (err) => log.error(`[attention-hook] server error: ${err.message}`));
  server.listen(0, '127.0.0.1', () => {
    attentionHookPort = server.address().port;
    log.info(`[attention-hook] listening on 127.0.0.1:${attentionHookPort}`);
    // Re-stamp the live port into settings.json if the feature is already on.
    try {
      if (attentionHooksEnabled()) writeClaudeAttentionHook(attentionHookPort);
    } catch (err) {
      log.error(`[attention-hook] failed to refresh hook on startup: ${err.message}`);
    }
  });
}

function readClaudeSettings() {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_JSON, 'utf8'));
  } catch {
    return {};
  }
}

// Remove only Switchboard-owned HTTP handlers (identified by the sentinel URL),
// pruning now-empty matcher groups and hook events. Leaves all other user hooks
// untouched — this is what makes the change reversible.
function stripSwitchboardHooks(settings) {
  if (!settings || !settings.hooks || typeof settings.hooks !== 'object') return settings;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const keptGroups = [];
    for (const group of groups) {
      if (group && Array.isArray(group.hooks)) {
        group.hooks = group.hooks.filter(
          (h) => !(h && typeof h.url === 'string' && h.url.includes(ATTENTION_HOOK_MARK)),
        );
        if (group.hooks.length > 0) keptGroups.push(group);
      } else {
        keptGroups.push(group);
      }
    }
    if (keptGroups.length > 0) settings.hooks[event] = keptGroups;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}

function writeClaudeAttentionHook(port) {
  if (!port) return;
  const url = `http://127.0.0.1:${port}${ATTENTION_HOOK_MARK}?t=${attentionHookToken}`;
  const settings = stripSwitchboardHooks(readClaudeSettings());
  if (!settings.hooks) settings.hooks = {};
  // Claude Code blocks on the hook response. The server is on 127.0.0.1 and answers
  // in milliseconds, so a long timeout only ever buys latency once nothing is
  // listening — which is exactly the case a crash leaves behind (#125).
  const HOOK_TIMEOUT_SEC = 1;
  const addHook = (event, matcher) => {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    settings.hooks[event].push({ matcher: matcher || '', hooks: [{ type: 'http', url, timeout: HOOK_TIMEOUT_SEC }] });
  };
  addHook('Notification', ''); // permission_prompt / idle_prompt / elicitation / …
  addHook('Stop', ''); // agent finished responding (matcher ignored for Stop)
  addHook('UserPromptSubmit', ''); // turn start → "Working" (TUI sessions emit no OSC-0 spinner)
  // Subagent lifecycle → the two-color overlay + the nested running indicator (#119).
  // Both events carry the parent session_id and the subagent's agent_id, and
  // SubagentStop fires at the subagent's real end. An empty matcher (which these
  // events match against the agent *type*) catches every agent type.
  addHook('SubagentStart', '');
  addHook('SubagentStop', '');
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_JSON), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS_JSON, JSON.stringify(settings, null, 2) + '\n');
  log.info(`[attention-hook] wrote hooks to ${CLAUDE_SETTINGS_JSON} (${url})`);
}

function removeClaudeAttentionHook() {
  if (!fs.existsSync(CLAUDE_SETTINGS_JSON)) return;
  const settings = stripSwitchboardHooks(readClaudeSettings());
  fs.writeFileSync(CLAUDE_SETTINGS_JSON, JSON.stringify(settings, null, 2) + '\n');
  log.info(`[attention-hook] removed Switchboard hooks from ${CLAUDE_SETTINGS_JSON}`);
}

// Renderer saved a new log level — apply it live, no restart (#121).
ipcMain.handle('set-log-level', (_event, level) => {
  const resolved = applyLogLevel(level);
  log.info(`[log] level set to ${resolved}`);
  return { ok: true, level: resolved };
});

// Renderer toggles the setting then calls this to write/remove the ~/.claude hook.
ipcMain.handle('configure-attention-hook', (_event, enabled) => {
  try {
    if (enabled) {
      if (!attentionHookServer) startAttentionHookServer();
      // If the server is still binding, the listen callback will stamp the port.
      if (attentionHookPort) writeClaudeAttentionHook(attentionHookPort);
    } else {
      removeClaudeAttentionHook();
    }
    return { ok: true };
  } catch (err) {
    log.error(`[attention-hook] configure failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

// --- Scheduled tasks ---
const scheduleIpc = require('./schedule-ipc');

const SETTING_DEFAULTS = {
  permissionMode: null,
  dangerouslySkipPermissions: false,
  worktree: false,
  worktreeName: '',
  chrome: false,
  preLaunchCmd: '',
  addDirs: '',
  visibleSessionCount: 5,
  sidebarWidth: 340,
  terminalTheme: 'switchboard',
  mcpEmulation: false,
  shellProfile: 'auto',
  conptyBackend: 'bundled',
};

// Cascade all settings: default → global → project; null/undefined mean
// "inherit". Single implementation for the get-effective-settings IPC, the
// shell-profile resolution and createTerminalSession (#79).
function effectiveSettings(projectPath) {
  const global = getSetting('global') || {};
  const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
  const effective = { ...SETTING_DEFAULTS };
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    if (global[key] !== undefined && global[key] !== null) effective[key] = global[key];
    if (project[key] !== undefined && project[key] !== null) effective[key] = project[key];
  }
  return effective;
}

ipcMain.handle('get-shell-profiles', () => {
  invalidateShellProfiles(); // drop the module-private cache so newly installed shells appear without a restart
  return getShellProfiles();
});

ipcMain.handle('get-effective-settings', (_event, projectPath) => {
  return effectiveSettings(projectPath);
});

// --- IPC: get-active-sessions ---
ipcMain.handle('get-active-sessions', () => {
  const active = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited) active.push(sessionId);
  }
  return active;
});

// --- IPC: get-active-terminals --- (plain terminal sessions for renderer restore)
ipcMain.handle('get-active-terminals', () => {
  const terminals = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited && session.isPlainTerminal) {
      terminals.push({ sessionId, projectPath: session.projectPath });
    }
  }
  return terminals;
});

// --- IPC: stop-session ---
ipcMain.handle('stop-session', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (!session || session.exited) return { ok: false, error: 'not running' };
  // Mark it dead here, not only in ptyProcess.onExit: kill() is asynchronous (very
  // visibly so under ConPTY), and until onExit lands, get-active-sessions would keep
  // reporting the session as running. The renderer's 3s poll would then re-add it to
  // activePtyIds and the grid's auto-mount would "reattach" it — resuming a fresh
  // process for a session the user just stopped (#130). onExit still fires and does
  // the real cleanup; setting this twice is harmless.
  session.exited = true;
  try { session.pty.kill(); } catch { /* already gone — the flag is what matters */ }
  return { ok: true };
});

// --- IPC: toggle-star ---
ipcMain.handle('toggle-star', (_event, sessionId) => {
  const starred = toggleStar(sessionId);
  return { starred };
});

// --- IPC: toggle-project-favorite ---
ipcMain.handle('toggle-project-favorite', (_event, projectPath) => {
  const favorited = toggleProjectFavorite(projectPath);
  return { favorited };
});

// --- IPC: Windows build number (synchronous) ---
// xterm's windowsPty option needs the build to track ConPTY wrapping: it enables
// its legacy wrapping heuristics only when backend === 'conpty' && buildNumber
// < 21376. The sandboxed preload can't read the OS build (its os.release() is a
// polyfill), so it asks here. sendSync keeps the value available before the
// first terminal opens.
//
// #115: report the capability level of the ConPTY the PTYs actually run on, not
// necessarily the OS. With the bundled conpty.dll (#114, Windows Terminal
// codebase — proper wrapped-line handling) an old-Win10 OS build would wrongly
// keep xterm's legacy heuristics on, so floor the reported build at xterm's
// threshold. 'system' keeps the raw OS build. Preload caches this at window
// load — toggling the Windows ConPTY setting needs an app restart to re-hint.
const XTERM_CONPTY_MODERN_BUILD = 21376;
function effectiveConptyBuildNumber(conptyBackend, osBuild) {
  return conptyBackend === 'system' ? osBuild : Math.max(osBuild, XTERM_CONPTY_MODERN_BUILD);
}
ipcMain.on('get-windows-build', (event) => {
  let build = 0;
  if (process.platform === 'win32') {
    try { build = parseInt(os.release().split('.')[2], 10) || 0; } catch { build = 0; }
    const backend = (getSetting('global') || {}).conptyBackend === 'system' ? 'system' : 'bundled';
    build = effectiveConptyBuildNumber(backend, build);
  }
  event.returnValue = build;
});

// --- IPC: Electron UI zoom (#34) ---
ipcMain.handle('get-zoom-level', () => {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow.webContents.getZoomLevel();
  const g = getSetting('global') || {};
  return typeof g.electronZoomLevel === 'number' ? g.electronZoomLevel : 0;
});
// delta 0 = reset to 100 %; otherwise nudge current level by delta (±0.5 like the keys).
ipcMain.handle('nudge-zoom', (_event, delta) => {
  const cur = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow.webContents.getZoomLevel() : 0;
  return applyMainZoom(delta === 0 ? 0 : cur + Number(delta || 0));
});

// --- IPC: bookmarks ---
ipcMain.handle('bookmark-toggle', (_event, payload) => {
  const { sessionId, entryIndex, timestamp, label } = payload || {};
  return toggleBookmark(sessionId, entryIndex, timestamp, label);
});
ipcMain.handle('bookmark-remove', (_event, id) => {
  removeBookmark(id);
  return { ok: true };
});
ipcMain.handle('bookmark-list', (_event, sessionId) => {
  return listBookmarks(sessionId || null);
});

// Enrich raw bookmark rows with display names (project + session), resolved from
// the session cache. Bookmarks store no projectPath (unlike tasks), so it's
// derived here at query time — kept out of the DB layer, mirroring enrichTasks.
function enrichBookmarks(rows) {
  const displayNames = getProjectDisplayNames() || {};
  return (rows || []).map((b) => {
    const cached = b.sessionId ? getCachedSession(b.sessionId) : null;
    const projectPath = (cached && cached.projectPath) || null;
    const sessionName = cached
      ? (cached.name || cached.aiTitle || cached.summary || b.sessionId)
      : (b.sessionId || null);
    const projectDisplayName = projectPath ? (displayNames[projectPath] || projectPath) : null;
    return { ...b, projectPath, sessionName, projectDisplayName };
  });
}

// Scope-filtered bookmark list for the scope switcher + large project view (#68).
// filter: { sessionId } | { projectPath } | {}. Session uses the indexed DB query;
// project filters the enriched set in JS (no projectPath column to query on).
ipcMain.handle('bookmark-list-admin', (_event, filter) => {
  const f = filter || {};
  if (f.sessionId) return enrichBookmarks(listBookmarks(f.sessionId));
  const all = enrichBookmarks(listBookmarks(null));
  if (f.projectPath) return all.filter((b) => b.projectPath === f.projectPath);
  return all;
});

// { projectPath: bookmarkCount } — drives the project-header bookmark-icon highlight.
ipcMain.handle('bookmark-counts-by-project', () => {
  const out = {};
  for (const b of enrichBookmarks(listBookmarks(null))) {
    if (b.projectPath) out[b.projectPath] = (out[b.projectPath] || 0) + 1;
  }
  return out;
});

// --- IPC: tasks (scoped task/note system) ---

// Enrich raw task rows with display names (project + session), resolved from the
// session cache. Kept out of the DB layer so the stored rows stay minimal.
function enrichTasks(rows) {
  const displayNames = getProjectDisplayNames() || {};
  return (rows || []).map((t) => {
    const cached = t.sessionId ? getCachedSession(t.sessionId) : null;
    const sessionName = cached
      ? (cached.name || cached.aiTitle || cached.summary || t.sessionId)
      : (t.sessionId || null);
    const projectDisplayName = t.projectPath
      ? (displayNames[t.projectPath] || t.projectPath)
      : null;
    return { ...t, sessionName, projectDisplayName };
  });
}

ipcMain.handle('task-create', (_event, payload) => {
  const task = createTask(payload || {});
  if (!task) return { error: 'Invalid task (title required)' };
  return { task: enrichTasks([task])[0] };
});
ipcMain.handle('task-list', (_event, filter) => {
  return { tasks: enrichTasks(listTasks(filter || {})) };
});
ipcMain.handle('task-update', (_event, payload) => {
  const { id, ...fields } = payload || {};
  if (id == null) return { error: 'Missing task id' };
  const task = updateTask(id, fields);
  if (!task) return { error: 'Task not found' };
  return { task: enrichTasks([task])[0] };
});
ipcMain.handle('task-remove', (_event, id) => {
  removeTask(id);
  return { ok: true };
});
ipcMain.handle('task-open-counts', () => {
  return { sessions: openTaskCountsBySession(), projects: openTaskCountsByProject() };
});

// --- IPC: project handoffs (Handoff library) ---
ipcMain.handle('save-handoff', (_event, payload) => {
  const { projectPath, label, content } = payload || {};
  if (!projectPath || !content) return null;
  return saveProjectHandoff(projectPath, label || null, content);
});
ipcMain.handle('list-handoffs', (_event, projectPath) => {
  return listProjectHandoffs(projectPath || null);
});
ipcMain.handle('delete-handoff', (_event, id) => {
  deleteProjectHandoff(id);
  return { ok: true };
});

// --- IPC: session tags ---
ipcMain.handle('session-tags-get', (_event, sessionId) => {
  return getSessionTags(sessionId);
});
ipcMain.handle('session-tags-set', (_event, payload) => {
  const { sessionId, tags } = payload || {};
  return setSessionTags(sessionId, tags);
});
ipcMain.handle('tags-list-all', () => {
  return listAllTags();
});
ipcMain.handle('session-tags-all', () => {
  return getAllSessionTags();
});

// --- IPC: multi-LLM backends (Phase 1, T-1.5). Kebab-case, matching the convention above.
// Renderer reads the registry + the launch-time overlay; it doesn't act on them yet (Phase 2/3).
ipcMain.handle('backends-list', () => {
  // Only JSON-safe descriptor data crosses IPC (hook functions are stripped).
  return backends.list().map(b => ({
    id: b.id, label: b.label, tier: b.tier, axis: b.axis, status: b.status,
    enabled: b.enabled !== undefined ? b.enabled : (b.id === 'claude'),
    monogram: b.monogram, colour: b.colour, configFields: b.configFields || [],
  }));
});
ipcMain.handle('session-backends-get-all', () => {
  return sessionBackends.getAll();
});

// --- IPC: project tags (#98) ---
ipcMain.handle('project-tags-get', (_event, projectPath) => {
  return getProjectTags(projectPath);
});
ipcMain.handle('project-tags-set', (_event, payload) => {
  const { projectPath, tags } = payload || {};
  // Colour now lives on the tag def (#138), and setProjectTags upserts it — so a
  // recolour here reaches every project at once, without touching session tags of
  // the same name, which are a separate vocabulary.
  return setProjectTags(projectPath, tags);
});
ipcMain.handle('project-tags-list-all', () => {
  return listAllProjectTags();
});
ipcMain.handle('project-tags-all', () => {
  return getAllProjectTags();
});

// --- IPC: tag definitions (#138) ---
// A tag is an entity: it can exist unassigned, be renamed, recoloured, hidden,
// disabled and deleted. `kind` keeps project and session vocabularies apart.
// Every handler returns { ok, error? } so the renderer can surface the reason —
// notably "a tag with that name already exists" on rename.
ipcMain.handle('tag-defs-list', (_event, kind) => {
  try { return { ok: true, tags: listTagDefs(kind) }; } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('tag-def-create', (_event, kind, name, color) => {
  try { return createTagDef(kind, name, color); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('tag-def-rename', (_event, kind, oldName, newName) => {
  try { return renameTagDef(kind, oldName, newName); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('tag-def-color', (_event, kind, name, color) => {
  try { return setTagDefColor(kind, name, color); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('tag-def-flags', (_event, kind, name, flags) => {
  try { return setTagDefFlags(kind, name, flags || {}); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('tag-def-delete', (_event, kind, name) => {
  try { return deleteTagDef(kind, name); } catch (err) { return { ok: false, error: err.message }; }
});

// --- IPC: rename-session ---
ipcMain.handle('rename-session', (_event, sessionId, name) => {
  setName(sessionId, name || null);
  // Update search index title to include the new name
  const cached = getCachedSession(sessionId);
  const summary = cached?.summary || '';
  updateSearchTitle(sessionId, 'session', (name ? name + ' ' : '') + summary);
  return { name: name || null };
});

// --- IPC: archive-session ---
// Read a transcript jsonl into { entries } for the viewer IPCs below (#79).
// Async read — a large transcript must not block the main process. Unparsable
// lines are skipped.
async function readJsonlEntries(jsonlPath) {
  try {
    const content = await fs.promises.readFile(jsonlPath, 'utf-8');
    const entries = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    return { entries };
  } catch (err) {
    return { error: err.message };
  }
}

ipcMain.handle('read-session-jsonl', async (_event, sessionId) => {
  const folder = getCachedFolder(sessionId);
  if (!folder) return { error: 'Session not found in cache' };
  return readJsonlEntries(path.join(PROJECTS_DIR, folder, sessionId + '.jsonl'));
});

ipcMain.handle('read-subagent-jsonl', async (_event, parentSessionId, agentId) => {
  const row = getCachedSession('sub:' + parentSessionId + ':' + agentId);
  if (!row) return { error: 'Subagent session not found in cache' };
  return readJsonlEntries(resolveJsonlPath(PROJECTS_DIR, row));
});

ipcMain.handle('list-subagents', (_event, parentSessionId) => {
  return getCachedByParent(parentSessionId).map(r => ({
    sessionId: r.sessionId,
    agentId: r.agentId,
    subagentType: r.subagentType,
    description: r.description,
    modified: r.modified,
    messageCount: r.messageCount,
  }));
});

// ── Subagent live-tail watchers ──────────────────────────────────────────────

ipcMain.handle('start-subagent-watch', (_event, parentSessionId, agentId) => {
  const row = getCachedSession('sub:' + parentSessionId + ':' + agentId);
  if (!row) return { error: 'Subagent not found in cache' };
  const filePath = resolveJsonlPath(PROJECTS_DIR, row);

  const watchId = ++subagentWatcherSeq;
  let offset = 0;
  // Seek to EOF so we only deliver *new* lines
  try { offset = fs.statSync(filePath).size; } catch {}

  function readNewEntries() {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= offset) return;
      const buf = Buffer.alloc(stat.size - offset);
      const fd = fs.openSync(filePath, 'r');
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      if (bytesRead <= 0) return;
      offset += bytesRead;
      const text = buf.toString('utf8', 0, bytesRead);
      const entries = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch {}
      }
      if (entries.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('subagent-watch-event', { parentSessionId, agentId, entries });
      }
    } catch {}
  }

  // fs.watchFile gives reliable polling on Linux where inotify can be unreliable for JSONL appends
  fs.watchFile(filePath, { interval: 1000, persistent: false }, readNewEntries);

  // Store the listener fn so stop-subagent-watch / window-close can pass it to
  // fs.unwatchFile — without the reference Node removes ALL watchers for the
  // path, so two watches on the same file would kill each other (issue #76).
  subagentWatchers.set(watchId, { filePath, parentSessionId, agentId, listener: readNewEntries });
  log.info(`[subagent-watch] start watchId=${watchId} parent=${parentSessionId} agentId=${agentId}`);
  return { watchId };
});

ipcMain.handle('stop-subagent-watch', (_event, watchId) => {
  const entry = subagentWatchers.get(watchId);
  if (!entry) return { ok: false };
  fs.unwatchFile(entry.filePath, entry.listener);
  subagentWatchers.delete(watchId);
  log.info(`[subagent-watch] stop watchId=${watchId}`);
  return { ok: true };
});

ipcMain.handle('archive-session', (_event, sessionId, archived) => {
  const val = archived ? 1 : 0;
  setArchived(sessionId, val);
  return { archived: val };
});

// --- IPC: open-terminal ---
ipcMain.handle('open-terminal', async (_event, sessionId, projectPath, isNew, sessionOptions) => {
  if (!mainWindow) return { ok: false, error: 'no window' };

  // Manual project mode: a session launched from Switchboard means the user is
  // actively using this project → add it to the allowlist so it shows.
  if (projectPath && getSetting('global')?.projectAutoAdd === false) ensureProjectAdded(projectPath);

  // Reattach to existing session. `exited` is set the moment stop-session issues
  // the kill (#130), so between that and ptyProcess.onExit the entry still exists
  // while its PTY is already dead — reattaching there would wire the renderer to a
  // corpse. Fall through to the resume/spawn path instead.
  const existingSession = activeSessions.get(sessionId);
  if (existingSession && !existingSession.exited) {
    const session = existingSession;
    session.rendererAttached = true;
    session.firstResize = !session.isPlainTerminal;

    // If TUI is in alternate screen mode, send escape to switch into it
    if (session.altScreen && !session.isPlainTerminal) {
      mainWindow.webContents.send('terminal-data', sessionId, '\x1b[?1049h');
    }

    // Send buffered output for reattach
    for (const chunk of session.outputBuffer) {
      mainWindow.webContents.send('terminal-data', sessionId, chunk);
    }

    if (!session.isPlainTerminal) {
      // Hide cursor after buffer replay — the live PTY stream or resize nudge
      // will re-show it at the correct position, avoiding a stale cursor artifact
      mainWindow.webContents.send('terminal-data', sessionId, '\x1b[?25l');
    }

    return { ok: true, reattached: true, mcpActive: !!session.mcpServer };
  }

  // Spawn new PTY
  if (!fs.existsSync(projectPath)) {
    return { ok: false, error: `project directory no longer exists: ${projectPath}` };
  }

  const isPlainTerminal = sessionOptions?.type === 'terminal';

  // Resolve shell profile from effective settings
  const effectiveProfileId = effectiveSettings(projectPath).shellProfile;
  // WSL profiles only work for plain terminals — Claude CLI sessions need the
  // Windows shell because session data lives on the Windows filesystem.
  const requestedProfile = resolveShell(effectiveProfileId);
  const useWslProfile = isWslShell(requestedProfile.path) && isPlainTerminal;
  const shellProfile = (isWslShell(requestedProfile.path) && !isPlainTerminal)
    ? resolveShell('auto')
    : requestedProfile;
  const shell = shellProfile.path;
  const shellExtraArgs = [...(shellProfile.args || [])];
  const isWsl = isWslShell(shell);
  // For WSL, convert Windows path to /mnt/ path and pass via --cd;
  // the spawn cwd must remain a valid Windows path for wsl.exe itself.
  if (isWsl) {
    const wslCwd = windowsToWslPath(projectPath);
    shellExtraArgs.unshift('--cd', wslCwd);
  }
  log.info(`[shell] profile=${shellProfile.id} shell=${shell} args=${JSON.stringify(shellExtraArgs)}`);

  let knownJsonlFiles = new Set();
  let sessionSlug = null;
  let projectFolder = null;

  if (!isPlainTerminal) {
    // Snapshot existing .jsonl files before spawning (for new session + fork/plan detection)
    projectFolder = encodeProjectPath(projectPath);
    const claudeProjectDir = path.join(PROJECTS_DIR, projectFolder);
    if (fs.existsSync(claudeProjectDir)) {
      try {
        knownJsonlFiles = new Set(
          fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl'))
        );
      } catch {}
    }

    // Read slug from the session's jsonl file (for plan-accept detection)
    if (!isNew) {
      try {
        const jsonlPath = path.join(claudeProjectDir, sessionId + '.jsonl');
        const head = fs.readFileSync(jsonlPath, 'utf8').slice(0, 8000);
        const firstLines = head.split('\n').filter(Boolean);
        for (const line of firstLines) {
          const entry = JSON.parse(line);
          if (entry.slug) { sessionSlug = entry.slug; break; }
        }
      } catch {}
    }
  }

  // #114: prefer node-pty's bundled conpty.dll (Windows Terminal codebase) over the
  // in-box conhost ConPTY. The OS one mis-handles rapid cursor-up + erase-line redraw
  // cycles (Claude CLI's spinner), leaving stale/duplicated rows that only a resize
  // repaint clears. 'system' falls back to the OS ConPTY (the node-pty flag is
  // experimental). No effect on non-Windows platforms.
  const useConptyDll = isWindows && (getSetting('global') || {}).conptyBackend !== 'system';

  let ptyProcess;
  let mcpServer = null;
  try {
    if (isPlainTerminal) {
      // Plain terminal: interactive login shell, no claude command. Override `claude`
      // with a helpful hint so users don't try to launch it here. The override MUST
      // match the shell's syntax — a bash function def written into PowerShell/cmd
      // shows up as a garbage line (#23) — so branch per shell type.
      const shellBase = path.basename(shell).toLowerCase();
      const isPowerShell = shellBase.includes('pwsh') || shellBase.includes('powershell');
      const isCmd = shellBase === 'cmd.exe' || shellBase === 'cmd';
      const isBashLike = !isPowerShell && !isCmd; // bash/zsh/sh/fish/wsl
      const hint = 'To start a Claude session, use the + button in the sidebar.';
      const bashShim = `claude() { printf '\\033[33m%s\\033[0m\\n' '${hint}'; return 1; }; export -f claude 2>/dev/null;`;

      const env = {
        ...cleanPtyEnv,
        TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
        CLAUDECODE: '1',
      };
      // ENV (sh/dash) + BASH_ENV inject the function for bash-like shells; useless
      // for PowerShell/cmd, so don't set them there.
      if (isBashLike) { env.ENV = bashShim; env.BASH_ENV = bashShim; }

      ptyProcess = pty.spawn(shell, ptyShellArgs(shell, undefined, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        env,
        useConptyDll,
      });

      // ENV/BASH_ENV don't apply to zsh/pwsh/cmd — write the shell-appropriate
      // override after the shell starts, then clear the pasted line.
      let initCmd;
      if (isPowerShell) {
        initCmd = `function claude { Write-Host "${hint}" -ForegroundColor Yellow }; Clear-Host\r`;
      } else if (isCmd) {
        initCmd = `doskey claude=echo ${hint} & cls\r`;
      } else {
        initCmd = bashShim + ' clear\n';
      }
      setTimeout(() => {
        if (!ptyProcess._isDisposed) {
          try {
            ptyProcess.write(initCmd);
          } catch {}
        }
      }, 300);
    } else {
      // Route the launch through the backend registry (Phase 1, T-1.2). `claude` is the default
      // backend and reproduces today's exact argv/command; an Axis-A profile additionally supplies
      // an env bundle (merged into ptyEnv further down). Claude behaviour is byte-identical — the
      // arg logic now lives in backends/claude.js buildLaunch.
      // Resume is backend-bound (§5.11): when resuming/forking WITHOUT an explicit backend choice,
      // keep the session's recorded backend/profile from the overlay instead of clobbering it with
      // the `claude` default. In Phase 1 the overlay is empty for pre-existing sessions, so this is
      // byte-identical (recorded == null -> claude); it forecloses the resume-clobber landmine once
      // profiles ship (Phase 2/3). A fork inherits the source session's recorded backend too.
      let recorded = null;
      if (!sessionOptions?.backendId) {
        const lookupId = sessionOptions?.forkFrom || (!isNew ? sessionId : null);
        if (lookupId) recorded = sessionBackends.get(lookupId);
      }
      const backend = backends.get(sessionOptions?.backendId || recorded?.backendId || 'claude') || backends.get('claude');
      const launch = backend.buildLaunch({
        cwd: projectPath,
        resume: !isNew,
        sessionId,
        forkFrom: sessionOptions?.forkFrom,
        options: sessionOptions || {},
      });
      let claudeCmd = launch.command + ' ' + quoteArgvForShell(shell, launch.args);

      // preLaunchCmd is raw shell by design (e.g. "aws-vault exec profile --") — block newlines only
      if (sessionOptions?.preLaunchCmd) {
        const pre = String(sessionOptions.preLaunchCmd);
        if (/[\r\n]/.test(pre)) {
          return { ok: false, error: 'preLaunchCmd must not contain newlines' };
        }
        claudeCmd = pre + ' ' + claudeCmd;
      }

      // Start MCP server for this session so Claude CLI sends diffs/file opens to Switchboard
      // (skip if user disabled IDE emulation in global settings)
      if (sessionOptions?.mcpEmulation !== false) {
        try {
          mcpServer = await startMcpServer(sessionId, [projectPath], mainWindow, log);
          claudeCmd += ' --ide';
        } catch (err) {
          log.error(`[mcp] Failed to start MCP server for ${sessionId}: ${err.message}`);
        }
      }

      // Core terminal env comes from the backend layer (single source of truth): iTerm identity so
      // Claude emits OSC 9, plus the MCP IDE-bridge port when one was started. Byte-identical to the
      // former inline block; shared with every backend spawn (T-1.2).
      const ptyEnv = {
        ...cleanPtyEnv,
        ...backends.backendCoreEnv({ mcpPort: mcpServer ? mcpServer.port : undefined }),
      };

      // Per-session AskUserQuestion timeout (#51): cascade session > project >
      // global, empty = inherit. Only inject when a value is actually set so an
      // unset field leaves Claude's built-in default (60s) in place.
      {
        const g = getSetting('global') || {};
        const p = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
        const sec = resolveAfkTimeoutSec(sessionOptions?.afkTimeoutSec, p.afkTimeoutSec, g.afkTimeoutSec);
        const afkMs = afkTimeoutToEnvMs(sec);
        if (afkMs != null) {
          ptyEnv.CLAUDE_AFK_TIMEOUT_MS = afkMs;
          log.info(`[afk] session=${sessionId} CLAUDE_AFK_TIMEOUT_MS=${afkMs} (from sec=${sec})`);
        }
      }

      // Axis-A profile env bundle: resolve `$VAR` refs at spawn (never on disk, §5.2) and merge
      // over the base env — the profile OVERRIDES base. Empty for the Claude default, so this is a
      // no-op there (byte-identical). Then record the launch-time backend/profile OVERLAY (§5.7):
      // the scanner later merges it into the authoritative session_cache.backendId.
      Object.assign(ptyEnv, resolveEnv(launch.env));
      const effectiveProfileId = sessionOptions?.profileId != null ? sessionOptions.profileId : (recorded?.profileId || null);
      sessionBackends.record(sessionId, backend.id, effectiveProfileId);

      ptyProcess = pty.spawn(shell, ptyShellArgs(shell, claudeCmd, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        // TERM_PROGRAM=iTerm.app: Claude Code checks this to decide whether to emit
        // OSC 9 notifications (e.g. "needs your attention"). Without it, the packaged
        // app's minimal Electron environment won't trigger those sequences.
        env: ptyEnv,
        useConptyDll,
      });

    }
  } catch (err) {
    return { ok: false, error: `Error spawning PTY: ${err.message}` };
  }

  const session = {
    pty: ptyProcess, rendererAttached: true, exited: false,
    outputBuffer: [], outputBufferSize: 0, altScreen: false,
    projectPath, firstResize: true,
    projectFolder, knownJsonlFiles, sessionSlug,
    isPlainTerminal, forkFrom: sessionOptions?.forkFrom || null,
    mcpServer, _openedAt: Date.now(),
  };
  activeSessions.set(sessionId, session);

  ptyProcess.onData(data => {
    // ConPTY flushes buffered output asynchronously after pty.kill(), so a last
    // chunk can arrive after will-quit closed the DB — the OSC 9;4 path below
    // calls getSetting() and would throw "The database connection is not open"
    // in an uncaught-exception dialog (#90 class, PTY edition).
    if (appQuitting) return;
    const currentId = session.realSessionId || sessionId;

    // Parse OSC sequences (title changes, progress, notifications, etc.)
    if (data.includes('\x1b]')) {
      const oscMatches = data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const m of oscMatches) {
        const code = m[1];
        const payload = m[2].slice(0, 120);
        // Detect Claude CLI busy state from OSC 0 title (spinner chars = busy, ✳ = idle)
        if (code === '0') {
          const firstChar = payload.charAt(0);
          const isBusy = firstChar.charCodeAt(0) >= 0x2800 && firstChar.charCodeAt(0) <= 0x28FF;
          const isIdle = firstChar === '\u2733'; // ✳
          // One line per title change — the CLI retitles on every spinner frame.
          log.silly(`[OSC 0] session=${currentId} char=U+${firstChar.charCodeAt(0).toString(16).toUpperCase()} busy=${isBusy} idle=${isIdle} wasBusy=${!!session._cliBusy}`);
          if (isBusy && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            // Marks the flag as OSC-0-owned so a stray `9;4;0` can't clear it (#120).
            session._busySource = 'osc0';
            log.info(`[OSC 0] session=${currentId} → BUSY`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, true);
            }
          } else if (isIdle && session._cliBusy) {
            session._cliBusy = false;
            session._oscIdle = true;
            session._busySource = null;
            log.info(`[OSC 0] session=${currentId} → IDLE`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, false);
            }
          }
        }
      }
      // Parse iTerm2 OSC 9 sequences (terminated by BEL \x07 or ST \x1b\\)
      const osc9Matches = data.matchAll(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const osc9 of osc9Matches) {
        const payload = osc9[1];
        // OSC 9;4 progress: 4;0; = clear/done, 4;1;N = running at N%, 4;2;N = error, 4;3; = indeterminate
        if (payload.startsWith('4;')) {
          const level = payload.split(';')[1];
          const decision = decideOsc94(level, {
            cliBusy: !!session._cliBusy,
            busySource: session._busySource || null,
            hooksEnabled: attentionHooksEnabled(),
          });
          // Progress sequences repeat while a task runs — raw line stays at silly.
          log.silly(`[OSC 9;4] session=${currentId} level=${level} payload="${payload}" wasBusy=${!!session._cliBusy} → ${decision}`);
          if (decision === 'set') {
            session._cliBusy = true;
            session._oscIdle = false;
            session._busySource = 'osc94';
            log.info(`[OSC 9;4] session=${currentId} → BUSY`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, true);
            }
          } else if (decision === 'clear') {
            // Release the latch this path set — otherwise a TUI dialog leaves the
            // session on "Working" forever (#120).
            session._cliBusy = false;
            session._oscIdle = true;
            session._busySource = null;
            log.info(`[OSC 9;4] session=${currentId} → IDLE (latch released)`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, false);
            }
          }
        } else {
          // Regular notification (attention, permission, etc.)
          log.info(`[OSC 9] session=${currentId} message="${payload}"`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('terminal-notification', currentId, payload);
          }
        }
      }
    }

    // Standalone BEL (not part of an OSC sequence)
    if (data.includes('\x07') && !data.includes('\x1b]')) {
      log.info(`[BEL] session=${currentId}`);
    }

    // Track alternate screen mode (only if data contains the marker)
    if (data.includes('\x1b[?')) {
      if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
        session.altScreen = true;
        log.info(`[altscreen] session=${currentId} ON`);
      }
      if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) {
        session.altScreen = false;
        log.info(`[altscreen] session=${currentId} OFF`);
      }
    }

    // Buffer output (skip resize-triggered redraws for plain terminals)
    if (!session._suppressBuffer) {
      appendToOutputBuffer(session, data, MAX_BUFFER_SIZE);
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', currentId, data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.exited = true;
    // During quit the DB is already closed (getSetting below would throw) and
    // before-quit has shut down MCP + killed the PTYs — skip the cleanup.
    if (appQuitting) return;
    // Clean up MCP server
    const mcpId = session.realSessionId || sessionId;
    shutdownMcpServer(mcpId);
    session.mcpServer = null;

    const realId = session.realSessionId || sessionId;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process-exited', realId, exitCode);
      // If a fork/plan-accept transition re-keyed this session under realId
      // but the PTY exited before transition detection ran, also notify the
      // renderer for the original sessionId so it doesn't stay stuck as "Running".
      if (realId !== sessionId && activeSessions.has(sessionId)) {
        mainWindow.webContents.send('process-exited', sessionId, exitCode);
      }
    }
    activeSessions.delete(realId);
    // Clean up the original key too in case transition detection hasn't run yet
    activeSessions.delete(sessionId);
    // Wipe this session's secret-ref temp files (default on; the prompt that used
    // them is done). Quit/startup wipe still covers the setting-off case.
    if (getSetting('global')?.secretRefCleanupOnSessionStop !== false) {
      cleanupSecretRefsForSession(realId);
      if (realId !== sessionId) cleanupSecretRefsForSession(sessionId);
    }
  });

  if (sessionOptions?.forkFrom) {
    log.info(`[fork-spawn] tempId=${sessionId} forkFrom=${sessionOptions.forkFrom} folder=${projectFolder} knownFiles=${knownJsonlFiles.size}`);
  }

  return { ok: true, reattached: false, mcpActive: !!mcpServer };
});

// --- IPC: terminal-input (fire-and-forget) ---
ipcMain.on('terminal-input', (_event, sessionId, data) => {
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    // Covers the synchronous failure path (e.g. the pty was disposed between the
    // guard and the write). An async EAGAIN completes later and is caught by the
    // process-level guard above. Either way the same bytes are delivered, so tabs
    // mode is unaffected.
    try {
      session.pty.write(data);
    } catch (err) {
      log.warn(`[terminal-input] write failed for session=${sessionId}: ${err.code || err.message}`);
    }
  }
});

// --- IPC: pause/resume-session-output (PTY flow control, #74) ---
// The renderer pauses the PTY while xterm's write buffer is saturated so an
// output firehose backs up in the OS pipe instead of flooding IPC; resume is
// called once xterm has drained. Guarded: pause/resume are optional in the
// node-pty API surface.
ipcMain.handle('pause-session-output', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (!session || session.exited || typeof session.pty.pause !== 'function') return { ok: false };
  try { session.pty.pause(); } catch { return { ok: false }; }
  return { ok: true };
});

ipcMain.handle('resume-session-output', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (!session || session.exited || typeof session.pty.resume !== 'function') return { ok: false };
  try { session.pty.resume(); } catch { return { ok: false }; }
  return { ok: true };
});

// --- IPC: terminal-resize (fire-and-forget) ---
// #27: the post-resize settle-repaint (ConPTY cols+1->cols nudge) is disabled — it
// caused a visible full-screen redraw ("text moves") after every resize, which was
// the dominant resize flicker. Trade-off: it existed to fix the cursor landing on the
// wrong row after xterm reflows a multi-line TUI input on resize (commit 87c3efc).
// That niche cursor glitch is accepted in favour of a calm resize. Flip back to true
// to restore the cursor fix; the per-session gating below then limits it to the
// focused session so background/grid cards don't flash.
const RESIZE_SETTLE_ENABLED = false;

ipcMain.on('terminal-resize', (_event, sessionId, cols, rows, settle) => {
  if (!RESIZE_SETTLE_ENABLED) settle = false;
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    // Track the newest requested size and cancel any in-flight redraw nudge.
    // The nudge timers below otherwise restore the cols/rows FROZEN at their
    // scheduling time — during startup restore the layout keeps settling for
    // ~100 ms after the first size push, so a stale nudge re-applied an
    // outdated size and the TUI prompt landed rows off (over- or under-shot)
    // until a manual window resize delivered a fresh, nudge-free resize.
    session._lastCols = cols;
    session._lastRows = rows;
    clearTimeout(session._nudgeTimer);
    clearTimeout(session._nudgeTimer2);

    // For plain terminals, suppress buffering during resize to avoid
    // accumulating prompt redraws that pollute reattach replay
    if (session.isPlainTerminal) session._suppressBuffer = true;

    // The PTY can exit between the !session.exited check above and this call
    // (the exit event hasn't been processed yet). node-pty then throws
    // "Cannot resize a pty that has already exited" — synchronously, which would
    // crash the main process. Swallow it: a dead PTY can't be resized anyway.
    try {
      session.pty.resize(cols, rows);
    } catch (e) {
      log.warn('[terminal-resize] resize on exited pty ignored:', e?.message || String(e));
      return;
    }

    if (session.isPlainTerminal) {
      setTimeout(() => { session._suppressBuffer = false; }, 200);
    }

    // First resize: nudge to force TUI redraw on reattach (skip for plain terminals — causes duplicate prompts)
    if (session.firstResize && !session.isPlainTerminal) {
      session.firstResize = false;
      session._nudgeTimer = setTimeout(() => {
        try {
          session.pty.resize(session._lastCols + 1, session._lastRows);
          session._nudgeTimer2 = setTimeout(() => {
            try { session.pty.resize(session._lastCols, session._lastRows); } catch {}
          }, 50);
        } catch {}
      }, 50);
    } else if (settle && !session.isPlainTerminal) {
      // Subsequent resizes: ConPTY repaints, but xterm's own buffer reflow of
      // wrapped lines can leave the cursor on the wrong row (e.g. navigating a
      // multi-line input after a resize). Once the resize settles, nudge the PTY
      // (cols±1) so ConPTY emits a clean full frame that overwrites the
      // mis-reflowed cells and repositions the cursor — mirroring how Windows
      // Terminal relies on ConPTY's repaint instead of its own reflow.
      // #27: only for the focused session (settle=true) — nudging background/grid
      // cards made every visible card flash on a window resize.
      clearTimeout(session._resizeSettleTimer);
      session._resizeSettleTimer = setTimeout(() => {
        try {
          session.pty.resize(session._lastCols + 1, session._lastRows);
          session._nudgeTimer2 = setTimeout(() => { try { session.pty.resize(session._lastCols, session._lastRows); } catch {} }, 50);
        } catch {}
      }, 150);
    }
  }
});

// --- IPC: terminal-redraw (fire-and-forget) ---
// Force one clean TUI frame by nudging the PTY (cols±1 and back), the same trick
// the settle-repaint above uses. Shrinking a terminal leaves xterm's reflowed,
// wrapped cells mis-drawn until the TUI repaints of its own accord — typing fixes
// it, which is no way to leave the screen.
//
// This is deliberately NOT the `settle` path: that one is disabled globally
// (RESIZE_SETTLE_ENABLED, #27) because it fired on every window resize and made
// every visible grid card flash. This channel is only ever called for a single
// card that the user just resized on purpose, so the one repaint is wanted.
ipcMain.on('terminal-redraw', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (!session || session.exited || session.isPlainTerminal) return;
  // Nothing to nudge back to until terminal-resize has recorded a size.
  if (!session._lastCols || !session._lastRows) return;
  clearTimeout(session._redrawTimer);
  clearTimeout(session._redrawTimer2);
  session._redrawTimer = setTimeout(() => {
    try {
      session.pty.resize(session._lastCols + 1, session._lastRows);
      session._redrawTimer2 = setTimeout(() => {
        try { session.pty.resize(session._lastCols, session._lastRows); } catch {}
      }, 50);
    } catch { /* PTY died between the guard and here */ }
  }, 50);
});

// --- IPC: close-terminal ---
ipcMain.on('close-terminal', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.rendererAttached = false;
    if (session.exited) {
      activeSessions.delete(sessionId);
    }
  }
});

// Session transitions → session-transitions.js
const sessionTransitions = require('./session-transitions');
sessionTransitions.init({ PROJECTS_DIR, activeSessions, getMainWindow: () => mainWindow, log, rekeyMcpServer, rekeySessionBackend: sessionBackends.rekeySession });
// Point the Claude backend's file-mode discovery at the app's actual projects dir (may differ from
// ~/.claude/projects when CLAUDE_DIR is overridden). The scanner adopts discoverSessions() in T-4.2.
try { require('./backends/claude').setRoots([PROJECTS_DIR]); } catch {}
const { detectSessionTransitions } = sessionTransitions;

// --- fs.watch on projects directory ---
let projectsWatcher = null;
// Set once quit begins so a still-pending debounced flush (or a late worker
// message) doesn't touch the DB after closeDb() — "The database connection is
// not open" on quit (#90).
let appQuitting = false;

function startProjectsWatcher() {
  if (!fs.existsSync(PROJECTS_DIR)) return;

  const pendingFolders = new Set();      // top-level folder add/remove → full refresh
  const pendingFiles = new Map();         // folder → Set<relFilename> → per-file refresh (#1)
  let debounceTimer = null;
  let burstStartedAt = 0;
  // Trailing debounce for calm periods, capped by a max-wait so a *continuous*
  // storm of JSONL appends (busy multi-agent session) can't keep resetting the
  // timer forever and starve the flush. Guarantees a flush at least every
  // MAX_WAIT_MS while events keep coming.
  const DEBOUNCE_MS = 500;
  const MAX_WAIT_MS = 2500;

  function flushChanges() {
    debounceTimer = null;
    if (appQuitting) return; // DB may already be closed (#90)
    const folders = new Set(pendingFolders);
    pendingFolders.clear();
    const files = new Map(pendingFiles);
    pendingFiles.clear();

    let changed = false;

    // Per-file refreshes (perf #1): update just the changed transcript(s) instead
    // of re-scanning the whole folder on every append.
    for (const [folder, relSet] of files) {
      if (folders.has(folder)) continue; // a full folder refresh below covers it
      const folderPath = path.join(PROJECTS_DIR, folder);
      if (!fs.existsSync(folderPath)) { deleteCachedFolder(folder); changed = true; continue; }
      detectSessionTransitions(folder);
      for (const rel of relSet) refreshFile(folder, rel);
      changed = true;
    }

    // Folder-level events (top-level add/remove) → full folder refresh.
    for (const folder of folders) {
      const folderPath = path.join(PROJECTS_DIR, folder);
      if (fs.existsSync(folderPath)) {
        detectSessionTransitions(folder);
        refreshFolder(folder);
      } else {
        deleteCachedFolder(folder);
      }
      changed = true;
    }

    if (changed) {
      notifyRendererProjectsChanged();
    }
  }

  try {
    projectsWatcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      // filename is relative, e.g. "folder-name/sessions-index.json" or "folder-name/abc.jsonl"
      const parts = filename.split(path.sep);
      const folder = parts[0];
      if (!folder || folder === '.git') return;

      // Only care about .jsonl changes or top-level folder add/remove
      const basename = parts[parts.length - 1];
      if (parts.length === 1) {
        pendingFolders.add(folder); // folder created/removed → full refresh
      } else if (basename.endsWith('.jsonl')) {
        // Per-file: record the specific changed transcript (relative path incl. folder).
        if (!pendingFiles.has(folder)) pendingFiles.set(folder, new Set());
        pendingFiles.get(folder).add(filename);
      } else {
        return;
      }

      const now = Date.now();
      if (!debounceTimer) burstStartedAt = now; // first event of a new burst
      const waited = now - burstStartedAt;
      const delay = Math.min(DEBOUNCE_MS, Math.max(0, MAX_WAIT_MS - waited));
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushChanges, delay);
    });

    projectsWatcher.on('error', (err) => {
      console.error('Projects watcher error:', err);
    });
  } catch (err) {
    console.error('Failed to start projects watcher:', err);
  }
}

// --- IPC: app version ---
ipcMain.handle('get-app-version', () => app.getVersion());

// Build provenance (branch @ short-hash), stamped at build time by
// scripts/gen-build-info.js into build-info.json (bundled). Falls back to a live
// git read in dev, then to "unknown". Cached — read once.
let _buildInfo;
function readBuildInfo() {
  if (_buildInfo) return _buildInfo;
  try {
    _buildInfo = require('./build-info.json');
  } catch {
    try {
      const { execFileSync } = require('child_process');
      const g = (a) => execFileSync('git', a, { encoding: 'utf8', cwd: __dirname }).trim();
      _buildInfo = {
        branch: g(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown',
        commit: g(['rev-parse', '--short', 'HEAD']) || 'unknown',
        dirty: g(['status', '--porcelain']).length > 0,
        builtAt: null,
      };
    } catch {
      _buildInfo = { branch: 'unknown', commit: 'unknown', dirty: false, builtAt: null };
    }
  }
  return _buildInfo;
}

// Version + runtime info for the settings "About" pane.
ipcMain.handle('get-about-info', () => ({
  version: app.getVersion(),
  build: readBuildInfo(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  v8: process.versions.v8,
  platform: process.platform,
  arch: process.arch,
}));

// --- App lifecycle ---
// Prevent a second Electron instance from killing active PTY sessions.
// This happens when the user replaces the AppImage while Switchboard is running:
// the OS spawns the new binary, which would otherwise initialise a second process
// and leave the first one's node-pty sessions orphaned or killed.
// requestSingleInstanceLock ensures only one packaged instance runs at a time.
// Development builds intentionally skip it so `npm start` can run beside the
// installed app while validating local changes.
const useSingleInstanceLock = shouldUseSingleInstanceLock({
  isPackaged: app.isPackaged,
  env: process.env,
});
const gotSingleInstanceLock = !useSingleInstanceLock || app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // Focus the existing window when a second launch is attempted.
  if (useSingleInstanceLock) {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }

  app.whenReady().then(() => {
    // Wipe any secret-ref temp files left behind by a previous run that didn't
    // quit cleanly (crash) — plaintext must not survive a restart.
    try { cleanupSecretRefs(); } catch {}
    // Set Content Security Policy
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self'"],
        },
      });
    });

    buildMenu();
    createWindow();
    createTray();
    startProjectsWatcher();
    startAttentionHookServer();
    // Remove IDE lock files left behind by a crashed instance whose PID was
    // reused (the function only unlinks locks matching our own pid).
    cleanStaleLockFiles(log);
    scheduleIpc.ensureScheduleCreatorCommand();

    // Shared runCommand for cron scheduler and "run now" — takes argv, not a shell string.
    const { spawn: cpSpawn } = require('child_process');
    function runScheduleCommand(claudeArgv, cwd, name, onDone) {
      const globalSettings = getSetting('global') || {};
      const profileId = globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile;
      const profile = resolveShell(profileId);
      const shell = profile.path;
      const cmd = 'claude ' + quoteArgvForShell(shell, claudeArgv);
      const args = shellArgs(shell, cmd, profile.args || []);

      // cmd.exe: Node's default arg joining escapes embedded `"` as `\"`, which
      // cmd does not understand — pass the pre-quoted line verbatim instead
      // (same failure class as the node-pty launch path, see ptyShellArgs).
      const isCmdShell = path.basename(shell).toLowerCase().startsWith('cmd');

      log.info(`[schedule] Running: ${shell} ${args.join(' ')}`);
      const child = cpSpawn(shell, args, {
        cwd,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...cleanPtyEnv, FORCE_COLOR: '0' },
        windowsVerbatimArguments: isCmdShell,
      });

      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('exit', (code) => {
        if (stderr.trim()) log.error(`[schedule] ${name} stderr:\n${stderr.trim()}`);
        log.info(`[schedule] ${name} finished (exit ${code})`);
        if (onDone) onDone();
      });

      child.on('error', (err) => {
        log.error(`[schedule] ${name} error:`, err.message);
        if (onDone) onDone();
      });
    }

    scheduleIpc.init(log, runScheduleCommand);
    startScheduler(log, runScheduleCommand);

    // Full cache rebuild on every startup — prunes stale rows for deleted
    // transcripts (sub-agent/workflow runs cleaned up between sessions leave
    // ghost rows in session_cache that show in the sidebar but are
    // inaccessible on open). populateCacheViaWorker runs in a Worker thread
    // and is non-blocking; concurrent callers share the same in-flight
    // Promise so the FTS-recreated path below (if also triggered) is free.
    populateCacheViaWorker().then(() => {
      // #57: run one auto-hide pass once the cache is populated on startup, so
      // stale projects are hidden before the first sidebar render settles.
      try { applyAutoHide(true); } catch {}
    });

    // File-trigger watcher — allows harness scripts to inject input into open
    // PTY sessions by dropping a JSON file in ~/.switchboard/triggers/.
    // Wrapped in try/catch so a boot failure here doesn't abort app.whenReady.
    try {
      require('./trigger-watcher').start({
        log,
        getPtyForSession(sessionId) {
          const session = activeSessions.get(sessionId);
          if (!session || session.exited) return null;
          return { ptyProcess: session.pty };
        },
        isSessionBusy(sessionId) {
          const session = activeSessions.get(sessionId);
          return session ? !!session._cliBusy : false;
        },
      });
    } catch (err) {
      log.error('[trigger-watcher] Failed to start trigger watcher:', err.message);
    }

    // Re-index search if FTS table was recreated (e.g. tokenizer config change).
    // populateCacheViaWorker is already running above; the guard inside it
    // (populatePromise !== null) means this is a no-op on the same tick and
    // returns the shared Promise — no double scan.
    if (searchFtsRecreated) populateCacheViaWorker();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }); // end app.whenReady
} // end gotSingleInstanceLock else-branch

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Stop any pending debounced cache flush from running after the DB closes (#90).
  appQuitting = true;

  // Leave no hook pointing at a port nobody listens on: Claude Code blocks on every
  // UserPromptSubmit until it times out, in every project, not just ours (#125). The
  // next boot rewrites the hook, so removing it here costs nothing.
  try { if (attentionHooksEnabled()) removeClaudeAttentionHook(); } catch { /* best effort */ }

  // Shut down all MCP servers
  shutdownAllMcp();

  // Remove the tray icon
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }

  // Close filesystem watcher
  if (projectsWatcher) {
    projectsWatcher.close();
    projectsWatcher = null;
  }

  // Kill all PTY processes on quit
  for (const [, session] of activeSessions) {
    if (!session.exited) {
      try { session.pty.kill(); } catch {}
    }
  }

  // Wipe any secret-ref temp files written for inline secret insertion.
  cleanupSecretRefs();

  // Flush the launch-time backend/profile overlay so a session started just before quit keeps
  // its provenance across the restart (§5.7).
  try { sessionBackends.flushNow(); } catch {}
});

// Close SQLite after all windows are closed to avoid "connection is not open" errors
app.on('will-quit', () => {
  // Flush any debounced per-file re-index so the last transcript edits inside a
  // debounce window are persisted before we close the DB (perf review item H).
  try { sessionCache.flushPendingReindex(); } catch {}
  // Terminate an in-flight project scan so a late worker message can't write to
  // the DB after closeDb() ("connection is not open" at shutdown) (issue #76).
  try { sessionCache.terminateScanWorker(); } catch {}
  // Terminate the search worker gracefully before closing the DB, so the
  // worker's read-only connection is released before the WAL checkpoint.
  // shutdown() suppresses the restart logic before calling terminate().
  searchClient.shutdown();
  closeDb();
});
