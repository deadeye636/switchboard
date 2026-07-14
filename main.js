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
const { shouldNoticeMissingRecord, missingRecordMessage } = require('./live-record-notice');
const { startMcpServer, shutdownMcpServer, shutdownAll: shutdownAllMcp, resolvePendingDiff, rekeyMcpServer, cleanStaleLockFiles } = require('./mcp-bridge');
const { fetchAndTransformUsage } = require('./claude-auth');
const { withMainProcessUsageCache } = require('./usage-cache');
const { shouldUseSingleInstanceLock } = require('./main-lifecycle');
const quitGuard = require('./quit-guard');
// Multi-LLM backend seam (Phase 1): the spawn/env/id-map paths ask a backend instead of
// assuming Claude. `claude` is the default backend and behaves byte-identically through it.
const backends = require('./backends');
const sessionBackends = require('./session-backends');
const profiles = require('./profiles');
const settingsTransfer = require('./settings-transfer');
// Every spawn path goes through resolveSpawnEnv() below — an unresolved $VAR is dropped AND said (#169).
const { resolveEnvRefs, missingRefsMessage } = require('./env-refs');
// Tier-3 custom launchers (T-3.10): the entry shape + cascade live in one module shared with the
// renderer; main only re-validates what the renderer hands it before spawning.
const { normalizeLauncher } = require('./public/custom-launchers');
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
  setProjectState, getProjectStates, getProjectTombstones,
  renameProjectRefs, deleteProjectRefs,
  toggleBookmark, removeBookmark, listBookmarks,
  createTask, listTasks, getTask, updateTask, removeTask, openTaskCountsBySession, openTaskCountsByProject,
  saveProjectHandoff, listProjectHandoffs, deleteProjectHandoff,
  getSessionTags, setSessionTags, listAllTags, getAllSessionTags,
  getProjectTags, setProjectTags, listAllProjectTags, getAllProjectTags,
  listTagDefs, createTagDef, renameTagDef, setTagDefColor, setTagDefFlags, deleteTagDef,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedByParent, getCachedByProjectPath, getBackendsByProjectPath, getCachedFolder, getCachedSession, upsertCachedSessions,
  deleteCachedSession, deleteCachedFolder, replaceSessionMetrics,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting, listSettings,
  listSavedVariables, listAllSavedVariables, getSavedVariable, saveSavedVariable, deleteSavedVariable, touchSavedVariable,
  getDailyMetrics, getDailyModelTokens, getModelUsage, getTotalCounts,
  getDailyBackendTokens, getDailyCost, getHourlyActivity,
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
  settingsWindow = new BrowserWindow({
    width: 900, height: 820, minWidth: 640, minHeight: 480,
    title: 'Switchboard — Settings',
    parent: mainWindow || undefined,
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    backgroundColor: '#0d1117', // settings.html's body background — no white first frame
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true },
  });
  settingsWindow.setMenu(null);
  settingsWindow.loadFile(path.join(__dirname, 'public', 'settings.html'));
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
    if (appQuitting || !mainWindow || mainWindow.isDestroyed()) return;
    event.preventDefault();
    settingsWindow.hide();
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}
ipcMain.on('open-settings-window', () => openSettingsWindow());

// Cancel/Save in the standalone settings window (#175). The renderer used to call
// window.close(), which destroys the window without ever emitting 'close' — there is
// nothing to intercept and turn into a hide. So it asks for the hide directly, and the
// warm renderer survives to serve the next open.
ipcMain.on('hide-settings-window', (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (w && w === settingsWindow && !w.isDestroyed()) w.hide();
});

/**
 * Tell the windows to re-apply the global settings. `except` skips the window that already
 * applied the change itself (that is the renderer-initiated save path, issue #76). A change
 * made in MAIN — the settings import — passes nothing and reaches every window, including
 * the one that triggered it: nobody has applied it yet.
 */
function broadcastSettingsChanged(except) {
  for (const w of [mainWindow, settingsWindow]) {
    if (w && !w.isDestroyed() && w.webContents !== except) {
      w.webContents.send('settings-changed');
    }
  }
}
ipcMain.on('settings-changed', (event) => broadcastSettingsChanged(event.sender));

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
let closeConfirmed = false;

function confirmCloseWithRunningSessions() {
  const running = quitGuard.runningSessions(activeSessions);
  if (!quitGuard.shouldAskBeforeClose(running, getSetting('global') || {})) return true;

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

// The renderer's answer. Only a yes does anything: a no has already been honoured by the cancelled close.
ipcMain.on('confirm-close-result', (_event, confirmed) => {
  if (!confirmed) return;
  closeConfirmed = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
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
  mainWindow.on('close', (event) => {
    // Closing the window kills every PTY it owns (see the 'closed' handler below), and it did that
    // without a word: a Claude mid-turn, a build running in a terminal — gone, with an accidental
    // Alt+F4 enough to do it. Ask first, and ask BEFORE anything here is torn down, or a cancelled
    // close would still have taken the settings window with it.
    if (!closeConfirmed && !appQuitting && !confirmCloseWithRunningSessions()) {
      event.preventDefault();
      return;
    }

    // The settings window survives its own close (it hides, #175) — take it down
    // with the main window, or `window-all-closed` never fires and the app lingers
    // with no window. `destroy()` skips its close handler by design.
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
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
  // NOTE: this db object is an explicit allow-list — a function session-cache.js reads via ctx.db.*
  // but that is missing here is `undefined` at runtime (see test/main-ctx-db-wiring.test.js).
  db: {
    deleteCachedFolder, getCachedByFolder, upsertCachedSessions, deleteCachedSession, replaceSessionMetrics,
    deleteSearchFolder, deleteSearchSession, upsertSearchEntries,
    setFolderMeta, getFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, getMeta, setName,
    getFavoritedProjects, getProjectDisplayNames, getAutoHiddenProjects,
    // The register (#167): what the sidebar is built FROM, and the one predicate the scan needs — is
    // this project removed, and therefore not to be indexed back in.
    getProjectMeta, getProjectStates,
  },
});
const { readSessionFile, readFolderFromFilesystem, refreshFolder, refreshFile, reconcileCacheFromFilesystem,
        buildProjectsFromCache, buildProjectsAdmin, shouldAutoHide, notifyRendererProjectsChanged, sendStatus, populateCacheViaWorker,
        refreshAllBackendSessions } = sessionCache;
const { resolveJsonlPath, PARSER_SCHEMA_VERSION: CLAUDE_PARSER_VERSION } = require('./read-session-file');

// A bumped Claude parser has to re-read the sessions it changed — and that re-read must happen on the
// WORKER thread, not here.
//
// The per-row staleness gate (#152) lives inside refreshFolder, and refreshFolder is itself gated on the
// folder's index mtime: a folder whose files have not changed is never opened, so the row gate behind it
// never runs. For a change like #157 — which re-attributes sessions that MOVED, and a session that moved
// did so in the past — that means every existing misattribution would stand forever.
//
// Wiping the folder memo would open that gate, but it would route the whole re-read through the
// SYNCHRONOUS reconcile on the main process (the cache is not empty, so the worker path is skipped) — the
// exact thing derive-project-path's header warns about: a store's worth of transcripts, read on the UI
// thread. So instead: notice the bump, and take the path the Rebuild button already takes.
function claudeParserBumped() {
  try { return Number(getSetting('claudeParserVersion')) !== CLAUDE_PARSER_VERSION; } catch { return false; }
}

function markClaudeParserRead() {
  try { setSetting('claudeParserVersion', CLAUDE_PARSER_VERSION); } catch { /* it will simply run again */ }
}


// --- Project management (#170) ---
//
// Lives in projects.js: it holds no Electron reference of its own, so a plain `node --test` process can
// require it. main.js keeps the wiring and the state it owns (the store root, the live sessions, the
// window) and hands them over. Everything projects.js reads is on this list — a function that is missing
// here is `undefined` at runtime, not inherited (test/projects-wiring.test.js checks it against the real
// module).
const projects = require('./projects');
const projectRegistry = require('./project-registry');

/**
 * The projects that are SHOWN — on the list, not hidden, not auto-hidden (#167).
 *
 * One answer for every view. The Memories and Work-files tabs each used to carry their own copy of the
 * rule ("everything on disk, minus `hiddenProjects`"), which is how a project could be absent from the
 * sidebar and present in two other tabs.
 */
function visibleProjectPaths() {
  const set = new Set();
  try {
    for (const [projectPath, state] of getProjectStates()) {
      if (projectRegistry.isVisible(state)) set.add(projectPath);
    }
  } catch { /* an empty set would blank every view — better to show than to vanish */ }
  return set;
}

projects.init({
  PROJECTS_DIR,
  activeSessions,
  log,
  showOpenDialog: () => dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Project Folder',
  }),
  // The backend registry — trust and remap are BACKEND business now (#171): each declares whether it has
  // a project-trust gate and how to move its own transcripts. No backend id is named in projects.js.
  backends,
  db: {
    getSetting, setSetting, deleteSetting,
    deleteCachedFolder, deleteSearchFolder,
    // Row-by-row, for the hard delete: a store folder can hold sessions of more than one project (#157),
    // so the folder is the wrong unit to clear the cache by.
    deleteCachedSession, deleteSearchSession,
    getProjectMeta, setProjectAutoHidden, resetProjectAutoHide, getAutoHiddenProjects,
    renameProjectRefs, deleteProjectRefs, setFolderMeta, toggleProjectFavorite,
    getCachedByProjectPath, getBackendsByProjectPath,
    // The register (#167): the project list is a stored list, not a derivation.
    setProjectState, getProjectStates, getProjectTombstones,
    // Discovery reads the cached rows directly (one pass, no store readdir), and a project can own more
    // than one store folder — re-registering it has to index every one of them.
    getAllCached, getAllFolderMeta,
  },
  cache: {
    refreshFolder, buildProjectsFromCache, buildProjectsAdmin, shouldAutoHide,
    claudeStoreScope: sessionCache.claudeStoreScope, notifyRendererProjectsChanged,
    // What the scan saw in the stores — including projects it deliberately did not index, which is
    // exactly what the tombstone sweep may not be blind to.
    getStoreProjectPaths: sessionCache.getStoreProjectPaths,
  },
});
projects.registerIpc(ipcMain);

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
      // Clean up the DB cache for the deleted worktree — CLAUDE's rows only.
      //
      // Deleting the worktree removed Claude's transcripts (they live under the worktree path). It did
      // NOT remove Codex's rollouts, Hermes' DB rows or Pi's transcripts: those live in each backend's
      // own store, keyed on the cwd. Wiping them here would delete rows whose data is still on disk —
      // they would simply come back on the next scan, or stay invisible until then. The scoped folder
      // cleanup below had this right; this per-row loop did not.
      let removed = 0;
      try {
        // The scope is expressed as "everything EXCEPT these backends" (Claude + its Axis-A profiles
        // share one store), so a row survives when its backend is in that exception list.
        const foreign = new Set(sessionCache.claudeStoreScope().except || []);
        for (const row of getAllCached()) {
          if (row.projectPath !== normalizedPath) continue;
          if (foreign.has(row.backendId || 'claude')) continue;
          deleteCachedSession(row.sessionId);
          deleteSearchSession(row.sessionId);
          removed++;
        }
      } catch (dbErr) {
        log.warn('[delete-worktree] DB cleanup error:', dbErr.message);
      }

      // The worktree is gone from disk, so take it off the list — but leave NO tombstone (#167). A
      // tombstone exists to stop old sessions from re-registering a project the user removed; this
      // directory is simply not there any more, and if it ever comes back it should come back.
      try {
        setProjectState(normalizedPath, { registered: 0, hidden: 0, autoHidden: 0, removedAt: null });
      } catch {}

      // Also clean up folder meta. Scoped to Claude's store — the worktree removal above only took
      // Claude's data with it; another backend's rows for that path must not be collateral.
      try {
        const folder = encodeProjectPath(normalizedPath);
        const claudeScope = sessionCache.claudeStoreScope();
        deleteCachedFolder(folder, claudeScope);
        deleteSearchFolder(folder, claudeScope);
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
      // T-3.7: the External Terminal belongs to the TERMINAL bucket, so it follows
      // `terminalShellProfile` (inherit -> the CLI shell). Only when that resolves to 'auto' (no
      // explicit choice) do we keep the historical behaviour of preferring Windows Terminal.
      // Launching the chosen shell INSIDE wt keeps the nice tabbed window; if wt is missing we fall
      // back to starting the shell directly, and finally to a plain cmd window.
      let chosenShell = null;
      try {
        const id = resolveTerminalShellProfileId(cwdPath);
        if (id && id !== 'auto') chosenShell = resolveShell(id);
      } catch { /* fall through to the default behaviour */ }

      if (chosenShell && chosenShell.path) {
        const shellArgv = [chosenShell.path, ...(chosenShell.args || [])];
        execFile('wt.exe', ['-d', cwd, ...shellArgv], (err) => {
          if (err) {
            execFile(chosenShell.path, [...(chosenShell.args || [])], { cwd }, (e2) => {
              if (e2) execFile('cmd.exe', ['/c', 'start', 'cmd.exe'], { cwd }, () => {});
            });
          }
        });
      } else {
        // Prefer Windows Terminal; fall back to a cmd window in the directory. The cwd
        // is passed via execFile's option (no shell quoting of spaces).
        execFile('wt.exe', ['-d', cwd], (err) => {
          if (err) execFile('cmd.exe', ['/c', 'start', 'cmd.exe'], { cwd }, () => {});
        });
      }
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

// --- Tier-3 custom launchers (T-3.10) + the ad-hoc custom command (T-3.5) ---
//
// A launcher is the user's OWN command line, run the way they would type it — not an execFile with
// a fixed argv. So it runs in the Terminal bucket's shell (`terminalShellProfile`, T-3.7) and a
// pipeline / redirect / `&&` works. Tier 3 = launch-only: no backend id, no session file, no badge
// (00 §2) — the scanner never learns it exists.

/** The one-line command the shell will run: the raw command plus any argv tokens, quoted for THAT shell. */
function composeLauncherCommand(shellPath, launcher) {
  const command = String((launcher && launcher.command) || '').replace(/[\r\n]+/g, ' ').trim();
  if (!command) return '';
  const args = (launcher && Array.isArray(launcher.args)) ? launcher.args.filter(a => a != null && a !== '') : [];
  return args.length ? command + ' ' + quoteArgvForShell(shellPath, args) : command;
}

/** `cwd` defaults to the launching project — a launch is always in a project, so the folder is known. */
function resolveLauncherCwd(launcher, projectPath) {
  const raw = launcher && typeof launcher.cwd === 'string' ? launcher.cwd.trim() : '';
  if (raw) {
    try {
      const resolved = path.resolve(raw);
      if (fs.existsSync(resolved)) return resolved;
      log.warn(`[launcher] cwd not found, falling back to the project: ${resolved}`);
    } catch { /* fall through to the project */ }
  }
  return projectPath;
}

/** Shell args that RUN the command and leave the external window open so its output stays readable. */
function externalCommandArgs(shellPath, cmd) {
  const base = path.basename(shellPath || '').toLowerCase();
  if (isWslShell(shellPath)) return ['--', 'bash', '-l', '-i', '-c', `${cmd}; exec bash -i`];
  if (base.includes('powershell') || base.includes('pwsh')) return ['-NoLogo', '-NoExit', '-Command', cmd];
  if (base === 'cmd.exe' || base === 'cmd') return ['/K', cmd];
  const shellName = base || 'bash';
  return ['-l', '-i', '-c', `${cmd}; exec ${shellName} -i`];
}

// --- IPC: run-custom-launcher (runMode:'external') ---
// Launch-and-forget in an OS window; the app does not monitor it. `env` values are `$VAR` refs
// resolved HERE, at spawn (resolveEnv drops an unresolved one — a secret is never on disk, §5.2).
//
// Windows note: this deliberately does NOT go through `wt.exe` like the plain External Terminal.
// Windows Terminal re-parses its command line and treats a bare `;` as a pane separator, which
// would silently split a perfectly normal PowerShell command in half. A detached spawn of the shell
// gets its own console window (node's `detached` on Windows) with no such re-parsing.
ipcMain.handle('run-custom-launcher', (_event, payload) => {
  const launcher = normalizeLauncher((payload && payload.launcher) || null);
  if (!launcher) return { ok: false, error: 'invalid launcher' };

  const projectPath = payload && typeof payload.projectPath === 'string' ? payload.projectPath : '';
  if (!projectPath || !fs.existsSync(projectPath)) return { ok: false, error: 'project directory not found' };

  const cwd = resolveLauncherCwd(launcher, projectPath);
  let shellPath;
  try {
    shellPath = resolveShell(resolveTerminalShellProfileId(projectPath)).path;
  } catch {
    shellPath = process.env.COMSPEC || '/bin/sh';
  }

  const cmd = composeLauncherCommand(shellPath, launcher);
  if (!cmd) return { ok: false, error: 'empty command' };
  const env = { ...process.env, ...resolveSpawnEnv(launcher.env, launcher.name || 'Launcher') };

  try {
    const { spawn } = require('child_process');
    const child = spawn(shellPath, externalCommandArgs(shellPath, cmd), {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.on('error', (err) => log.warn(`[launcher] external launch failed: ${err.message}`));
    child.unref();
    log.info(`[launcher] external "${launcher.name}" shell=${path.basename(shellPath)} cwd=${cwd}`);
    return { ok: true };
  } catch (err) {
    log.warn('[launcher] external launch failed:', err?.message || String(err));
    return { ok: false, error: String(err?.message || err) };
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
    // A project root is remembered for the life of the process (derive-project-path). Someone rebuilding
    // the cache is telling us the answers are wrong — so drop what we think we know first, or a directory
    // that has become a repo since startup (a fresh `git init`, a new worktree) keeps its stale "no root".
    try { require('./derive-project-path')._resetRootCache(); } catch { /* best effort */ }
    await populateCacheViaWorker();
    markClaudeParserRead();
    // A rebuild must cover EVERY backend's roots, not just Claude's (T-2.7 + T-4.2) — otherwise
    // "Rebuild session cache" would silently drop the user's Codex/other-backend history. And it must
    // FORCE the re-read: the reason to rebuild is that a row is wrong, and a wrong row's change marker
    // matches just fine, so the normal (marker-gated) sweep would skip exactly the rows to repair.
    try { refreshAllBackendSessions({ force: true }); } catch (err) { log.warn('[rebuild] backend scan failed:', err?.message || err); }
    return { ok: true };
  } catch (err) {
    console.error('Error rebuilding cache:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-projects', async (_event, showArchived) => {
  try {
    // ...and a bumped parser counts as "needs populating": the rows are there, but they were written by a
    // parser that no longer describes them (#157). This runs the worker exactly once per bump.
    const needsPopulate = !isCachePopulated() || !isSearchIndexPopulated() || claudeParserBumped();

    if (needsPopulate) {
      // First call after a migration that clears session_cache (e.g. v4) finds
      // an empty cache. Returning [] immediately makes the renderer paint an
      // empty list and rely on `notifyRendererProjectsChanged` firing later —
      // which only triggers a reload if the user is on the Sessions tab. To
      // avoid that race, await the scan here so the response carries the
      // freshly-populated cache. Concurrent callers share the same Promise.
      await populateCacheViaWorker();
      markClaudeParserRead();
    }

    // Pick up folders changed while the app was closed, or never indexed by an
    // older build, so sessions/worktrees don't silently go missing. Stat-gated,
    // so it's cheap when nothing has changed.
    reconcileCacheFromFilesystem();
    // Same, for every non-Claude backend that owns its own session store (T-4.2): Codex's
    // date-bucketed rollout tree, later Hermes' SQLite. Self-gating — a `planned` or disabled
    // backend is never enumerated, and Claude/Axis-A profiles are a no-op here (they live in the
    // Claude store the reconcile above already covered). mtime-gated, so it is cheap when idle.
    try { refreshAllBackendSessions(); } catch (err) { log.warn('[scan] backend scan failed:', err?.message || err); }
    // #167: the scans above have just told us which projects have sessions. Put the new ones ON THE LIST
    // (in auto mode) and sweep the tombstones that no longer guard anything — before the list is built,
    // so a project discovered a moment ago is in this very render.
    projects.syncRegistry();
    // #57: apply auto-hide before building the response so freshly-hidden projects
    // drop out of this render. Internally throttled, so it's cheap on rapid calls.
    projects.applyAutoHide();
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
ipcMain.handle('get-stats-from-db', (_event, backendId) => {
  try {
    return buildStatsFromDb(backendId);
  } catch (err) {
    log.error('Error building stats from DB:', err);
    return null;
  }
});

// Build the full stats object the renderer consumes. Sourced from
// session_metrics (per-(session,date,model) tokens/tool-calls/messages bucketed
// by message timestamp) so tokens, tool calls, and per-model usage are all real
// data — not the hardcoded {} the heatmap-only path used to return.
// `backendId` (optional) scopes EVERY figure below to one backend — the page's filter (#159). Falsy or
// 'all' means the whole corpus. It is resolved in SQL rather than in the renderer because the renderer
// has no per-session daily data to filter: only the aggregates ever cross the IPC boundary.
/**
 * "Codex" means everything that ran the Codex binary.
 *
 * The Stats filter offers BACKENDS. A session launched from a template records the TEMPLATE's id as its
 * provenance (§5.7) — that is what the user picked, and the sidebar badge should say so. But nobody wants
 * a stats page whose filter lists "my Codex template" as if it were a provider: the question is where the
 * work went, and the answer is the backend. So a backend filter expands to the backend plus every
 * template that runs on it.
 */
/**
 * Resolve an env bundle for a SPAWN, and say out loud what it had to drop (#169).
 *
 * An unresolved `$VAR` is dropped — that is right, and it stays: emitting the literal would leak the ref
 * text into the child and mask a missing credential behind something that looks like one. What was wrong
 * is that it happened in silence: a template pointed at another provider whose key is not set launched
 * happily, and the user got a provider auth error that named nothing.
 *
 * Warn, do not refuse. Not every dropped reference is fatal — a bundle may carry an optional variable —
 * and refusing a launch on that guess would be its own bug. But it is SAID: named, in the log at `info`
 * level so a packaged build shows it, and as a toast on the session so the user connects the failure to
 * its cause instead of hunting a provider error.
 *
 * The editor already had this check. It ran where nothing was at stake, and a save-time check can never
 * replace a launch-time one anyway: the variable can vanish BETWEEN the save and the launch.
 */
function resolveSpawnEnv(bundle, source, sessionId) {
  const { env, missing } = resolveEnvRefs(bundle);
  if (!missing.length) return env;

  const message = missingRefsMessage(missing, source);
  log.warn('[env] ' + message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('session-notice', sessionId || null, message);
  }
  return env;
}

function backendFilterIds(backendId) {
  if (!backendId || backendId === 'all') return null;
  const base = String(backendId);
  const ids = [base];
  try {
    for (const b of backends.list()) {
      if (b.isProfile && (b.baseId || 'claude') === base) ids.push(b.id);
    }
  } catch { /* registry unavailable -> the base alone is still the honest answer */ }
  return ids;
}

function buildStatsFromDb(backendId) {
  const only = backendFilterIds(backendId);
  const daily = getDailyMetrics(only);    // [{date, messageCount, toolCallCount, tokens, sessionCount}]
  const totals = getTotalCounts(only);
  const lastComputedDate = new Date().toISOString().slice(0, 10);
  return {
    backendId: backendId || 'all',       // what these numbers are ABOUT — the renderer labels with it
    dailyActivity: daily,
    dailyModelTokens: getDailyModelTokens(only),
    dailyBackendTokens: getDailyBackendTokens(only),
    dailyCost: getDailyCost(only),
    hourlyActivity: getHourlyActivity(only),
    modelUsage: getModelUsage(only),
    totalMessages: totals.totalMessages,
    totalSessions: totals.totalSessions,
    totalToolCalls: totals.totalToolCalls,
    totalTokens: totals.totalTokens,
    firstSessionDate: daily[0]?.date || lastComputedDate,
    lastComputedDate,
  };
}

// --- IPC: refresh-stats (fetch /usage + build stats from DB; /stats PTY removed) ---
ipcMain.handle('refresh-stats', async (_event, backendId) => {
  try {
    // /stats PTY call removed — heatmap is now sourced from session_cache via
    // get-stats-from-db. Only /usage is fetched here (rate-limits panel).
    const usage = await fetchAndTransformUsage().catch(() => ({}));

    // Build stats from DB (same as get-stats-from-db) so the caller gets both
    // at once and the renderer can update heatmap + usage in a single round-trip.
    let stats = null;
    try {
      stats = buildStatsFromDb(backendId);
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
  const visible = visibleProjectPaths();
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
        if (projectPath && !visible.has(projectPath)) continue;

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
  const visible = visibleProjectPaths();
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
        if (!visible.has(projectPath)) continue;

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

/**
 * The one way a settings blob reaches the disk. Every writer goes through here — the settings
 * form, and the settings IMPORT (#145). An importer that called setSetting() directly would be a
 * back door around both halves of this: the secret scrub below, and the backend re-arm.
 */
function persistSettingsBlob(key, value) {
  // Custom launchers (Tier-3) carry an env block, and the settings blob goes to DISK. A profile's env is
  // guarded at exactly this boundary (profiles.save rejects a literal key); the launchers promised "the
  // same hygiene" in their own comment and never had it — a pasted key was written out verbatim. Strip
  // it here, at the trust boundary, rather than in the renderer that can be bypassed.
  try {
    const stripped = stripLauncherSecrets(value);
    if (stripped.removed.length) {
      log.warn(`[launchers] refused to persist literal secret(s): ${stripped.removed.join(', ')} — use a $VAR reference`);
      value = stripped.value;
    }
    const env = stripBackendEnvSecrets(value);
    if (env.removed.length) {
      log.warn(`[backends] refused to persist literal secret(s) in backendEnv: ${env.removed.join(', ')} — use a $VAR reference`);
      value = env.value;
    }
  } catch { /* never block a settings save on this */ }

  setSetting(key, value);
  // Enabling/disabling a backend changes which stores must be watched and scanned. Re-arm here so
  // the change takes effect immediately instead of only after a restart (§5.8: a newly-enabled
  // `ready` backend must "appear with no code change" — and with no restart either).
  if (key === 'global') {
    try {
      startBackendWatchers();
      refreshAllBackendSessions();
      notifyRendererProjectsChanged();
    } catch (err) {
      log.warn('[backends] re-arm after settings change failed:', err?.message || err);
    }
  }
}

ipcMain.handle('set-setting', (_event, key, value) => {
  persistSettingsBlob(key, value);
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

// --- IPC: settings export / import (#145) ---
// Global blob only. What goes in the file and what may come out of it is decided in
// settings-transfer.js; this pair owns the two things that need Electron — the native file
// dialogs — and nothing else. The dialog parents to the window that ASKED, because these
// buttons also render in the standalone settings pop-out.
ipcMain.handle('export-settings', async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const stamp = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(parent, {
    title: 'Export Settings',
    defaultPath: `switchboard-settings-${stamp}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    // The project list rides along explicitly now — it is a table, not a settings key (#167).
    const payload = settingsTransfer.buildExportPayload(getSetting('global'), new Date().toISOString(), getProjectStates());
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    log.info(`[settings] exported ${Object.keys(payload.global).length} global key(s)`);
    return { ok: true, filePath: result.filePath, keys: Object.keys(payload.global).length };
  } catch (err) {
    log.error('[settings] export failed:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('import-settings', async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const result = await dialog.showOpenDialog(parent, {
    title: 'Import Settings',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  try {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    } catch {
      return { ok: false, error: 'The file is not valid JSON.' };
    }
    const check = settingsTransfer.validateImportPayload(parsed);
    if (!check.ok) return { ok: false, error: check.error };

    // Through the same door a normal save uses: secrets scrubbed, backends re-armed.
    persistSettingsBlob('global', settingsTransfer.mergeImport(getSetting('global'), check.global));

    // The project list (#167). A file that carries none — an older export, or a machine that never had a
    // project — leaves the list here ALONE: importing "nothing" must not mean "wipe it".
    const incoming = settingsTransfer.importProjects(parsed);
    for (const row of incoming) {
      setProjectState(row.projectPath, { registered: 1, hidden: row.hidden, removedAt: null });
    }

    broadcastSettingsChanged();   // main-initiated: every window re-applies, incl. the sender
    const keys = Object.keys(check.global).length;
    log.info(`[settings] imported ${keys} global key(s), ${incoming.length} project(s)`);
    return { ok: true, keys, projects: incoming.length };
  } catch (err) {
    log.error('[settings] import failed:', err);
    return { ok: false, error: err.message };
  }
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

// Resolve a bare command name to a directly-executable binary, for backends that ask for argv-mode
// spawn (00 §4). Returns null when it can't be executed directly — notably a `.cmd`/`.bat` npm shim
// on Windows, which CreateProcess (and therefore node-pty's argv spawn) cannot run. The caller then
// falls back to the shell path, which resolves shims fine.
function resolveArgvExecutable(command) {
  if (!command) return null;
  const directlyExecutable = (p) => !isWindows || /\.(exe|com)$/i.test(p);

  if (path.isAbsolute(command)) {
    try { if (fs.statSync(command).isFile() && directlyExecutable(command)) return command; } catch {}
    return null;
  }
  // POSIX: let execvp resolve it via PATH.
  if (!isWindows) return command;

  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.trim()).filter(Boolean);
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.statSync(candidate).isFile()) {
          return directlyExecutable(candidate) ? candidate : null; // a shim -> use the shell instead
        }
      } catch { /* keep looking */ }
    }
  }
  return null;
}

// The TERMINAL bucket's shell (T-3.7): the in-app plain terminal + the External Terminal action.
// `terminalShellProfile` defaults to 'inherit', which falls back to the CLI shell (`shellProfile`),
// so the split is a no-op until the user picks a different terminal shell. Both keys cascade
// global → project through effectiveSettings, like every other setting.
function resolveTerminalShellProfileId(projectPath) {
  const eff = effectiveSettings(projectPath) || {};
  const t = eff.terminalShellProfile;
  return (t && t !== 'inherit') ? t : eff.shellProfile;
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

// NOTE: Claude's launch options (permissionMode, worktree, chrome, addDirs, preLaunchCmd,
// mcpEmulation, afkTimeoutSec, …) are NOT here. They are a backend's launch options like any other
// backend's and live under `backendDefaults.claude` (§4a) — see migrateClaudeLaunchDefaults below.
// What remains here is what belongs to the app, not to a CLI.
/**
 * A settings blob may carry `customLaunchers[].env` (Tier-3, T-3.10). Those values follow the same rule
 * as a profile's: a `$VAR` reference (resolved at spawn) or a plain literal — but NEVER a raw key. This
 * drops any value that looks like one, so a pasted token cannot reach the disk.
 * Returns { value, removed[] }; `value` is the original object when nothing was stripped.
 */
function stripLauncherSecrets(blob) {
  const removed = [];
  if (!blob || typeof blob !== 'object' || !Array.isArray(blob.customLaunchers)) return { value: blob, removed };

  const launchers = blob.customLaunchers.map(l => {
    if (!l || typeof l !== 'object' || !l.env || typeof l.env !== 'object') return l;
    const env = {};
    for (const [k, v] of Object.entries(l.env)) {
      if (typeof v === 'string' && profiles.looksLikeRawSecret(v, k)) {
        removed.push(`${l.name || l.id || 'launcher'}.${k}`);
        continue;   // dropped: an unresolved $VAR is dropped at spawn too, so this fails visibly, not silently
      }
      env[k] = v;
    }
    return { ...l, env };
  });

  if (!removed.length) return { value: blob, removed };
  return { value: { ...blob, customLaunchers: launchers }, removed };
}

/**
 * The same rule for a BACKEND's own env bundle (`backendEnv.<id>`). It goes to disk exactly like a
 * launcher's and a template's, so it gets exactly the same guard: a value that looks like a pasted key is
 * dropped here, at the trust boundary, and never written. A `$VAR` reference is the supported way — it is
 * resolved at spawn and lives only in the user's environment.
 */
function stripBackendEnvSecrets(blob) {
  const removed = [];
  if (!blob || typeof blob !== 'object' || !blob.backendEnv || typeof blob.backendEnv !== 'object') {
    return { value: blob, removed };
  }
  const out = {};
  for (const [backendId, env] of Object.entries(blob.backendEnv)) {
    if (!env || typeof env !== 'object') continue;
    const clean = {};
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'string' && profiles.looksLikeRawSecret(v, k)) {
        removed.push(`${backendId}.${k}`);
        continue;   // an unresolved $VAR is dropped at spawn too, so this fails visibly, not silently
      }
      clean[k] = v;
    }
    out[backendId] = clean;
  }
  if (!removed.length) return { value: blob, removed };
  return { value: { ...blob, backendEnv: out }, removed };
}

const SETTING_DEFAULTS = {
  visibleSessionCount: 5,
  sidebarWidth: 340,
  terminalTheme: 'switchboard',
  shellProfile: 'auto',
  // T-2.5/T-3.7: the Terminal bucket's shell (in-app plain terminal + External Terminal).
  // 'inherit' = use the CLI shell (`shellProfile`) — the default, so behaviour is unchanged.
  terminalShellProfile: 'inherit',
  conptyBackend: 'bundled',
};

// Claude's launch options used to live at the top of the settings blob (Sessions & CLI). They are
// launch options like any other backend's, so they now live where every backend's do:
// `backendDefaults.claude.<opt>` (§4a). Move them once, per settings scope, and delete the old keys —
// keeping both would recreate exactly the two-homes-one-setting trap this consolidates away.
//
// `dangerouslySkipPermissions` collapses into the permissionMode CHOICE 'dangerously-skip': the CLI
// treats them as one decision (the skip flag wins over --permission-mode), so the schema models one
// control, not two that can contradict each other.
const LEGACY_CLAUDE_LAUNCH_KEYS = [
  'permissionMode', 'dangerouslySkipPermissions', 'worktree', 'worktreeName',
  'chrome', 'addDirs', 'preLaunchCmd', 'mcpEmulation', 'afkTimeoutSec',
];

function migrateClaudeLaunchDefaults() {
  const scopes = [{ key: 'global', value: getSetting('global') }, ...listSettings('project:')];
  let moved = 0;
  for (const scope of scopes) {
    const blob = scope.value;
    if (!blob || typeof blob !== 'object') continue;
    if (blob.backendDefaults && blob.backendDefaults.claude) continue;            // already migrated
    if (!LEGACY_CLAUDE_LAUNCH_KEYS.some(k => blob[k] !== undefined)) continue;    // nothing to move

    const claude = {};
    for (const k of LEGACY_CLAUDE_LAUNCH_KEYS) {
      const v = blob[k];
      if (v === undefined || v === null) continue;
      if (k === 'dangerouslySkipPermissions') { if (v) claude.permissionMode = 'dangerously-skip'; continue; }
      if (k === 'permissionMode' && claude.permissionMode === 'dangerously-skip') continue;   // skip wins
      claude[k] = v;
    }
    const next = { ...blob, backendDefaults: { ...(blob.backendDefaults || {}), claude } };
    for (const k of LEGACY_CLAUDE_LAUNCH_KEYS) delete next[k];
    setSetting(scope.key, next);
    moved++;
  }
  if (moved) log.info(`[settings] moved Claude's launch options into backendDefaults.claude (${moved} scope(s))`);
}

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
  // Per-backend launch defaults (§4a) cascade **per option**, like every other setting — not as one
  // block. Taking the project's whole blob whenever it was non-empty meant a project that overrode a
  // single Codex option FROZE every backend's defaults at the moment it was saved: later changes to the
  // global defaults could never reach that project again (#149).
  //
  // A project therefore stores only the options it actually overrides.
  effective.backendDefaults = mergeBackendDefaults(global.backendDefaults, project.backendDefaults);
  return effective;
}

/** global ⊕ project, per backend, per option. The project wins where it has a value of its own. */
function mergeBackendDefaults(globalDefaults, projectDefaults) {
  const g = globalDefaults && typeof globalDefaults === 'object' ? globalDefaults : {};
  const p = projectDefaults && typeof projectDefaults === 'object' ? projectDefaults : {};
  const out = {};
  for (const id of new Set([...Object.keys(g), ...Object.keys(p)])) {
    const gOpts = (g[id] && typeof g[id] === 'object') ? g[id] : {};
    const pOpts = (p[id] && typeof p[id] === 'object') ? p[id] : {};
    const merged = { ...gOpts };
    for (const [opt, value] of Object.entries(pOpts)) {
      if (value === undefined || value === null) continue;   // absent = "inherit this option"
      merged[opt] = value;
    }
    out[id] = merged;
  }
  return out;
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
  const { projectPath, label, content, backendId } = payload || {};
  if (!projectPath || !content) return null;
  return saveProjectHandoff(projectPath, label || null, content, backendId || null);
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
  return {
    backends: backends.list().map(b => ({
      id: b.id, label: b.label, tier: b.tier, axis: b.axis, status: b.status,
      enabled: !!b.enabled, isProfile: !!b.isProfile, icon: b.icon || null,
      monogram: b.monogram || null, colour: b.colour || null, configFields: b.configFields || [],
      // Is the binary actually installed? Settings shows the reason instead of letting the user enable
      // a backend whose first launch then dies with a raw shell error.
      available: b.available !== false, unavailableReason: b.unavailableReason || null,
      // Can this backend fork a session? The sidebar hides the Fork button when it cannot — offering
      // it launches an unrelated empty session, which is worse than not offering it.
      supportsFork: b.supportsFork === true || (!!b.isProfile),
      // A standing gotcha the user cannot see from inside the app (Pi: a stored OAuth login silently
      // beats an injected key). Rendered on the backend's settings page.
      caveat: b.caveat || null,
      // How long this CLI needs before it can accept input at all (Hermes: ~12s of Python imports).
      // The handoff seeding path waits it out instead of pasting into a process that cannot hear it.
      seedGraceMs: Number(b.seedGraceMs) || 0,
    })),
    defaultLaunchTarget: backends.getDefaultLaunchTarget(),
  };
});
// Can this session be forked RIGHT NOW?
//
// Claude accepts `--session-id`, so the id we launched under IS its id — forking it always works. Codex,
// Hermes and Pi NAME THEIR OWN sessions, and we only adopt that name once they have written their store
// record, i.e. after the first turn. Before that, the only id we hold is our own, which means nothing to
// them: `pi --fork <our-uuid>` answers "No session found" and the user gets a dead tab.
//
// So: ask the backend whether it knows this session. If it does not, say why — the fix is one message.
ipcMain.handle('backend-can-fork', (_event, sessionId) => {
  if (!sessionId) return { ok: false, reason: 'Unknown session.' };

  const live = activeSessions.get(sessionId);
  const mapped = sessionBackends.get((live && live.realSessionId) || sessionId);
  let backendId = mapped && mapped.backendId;
  if (!backendId) {
    try {
      const row = getCachedSession(sessionId);
      backendId = row && row.backendId;
    } catch { /* cache unavailable */ }
  }
  const backend = backends.get(backendId || 'claude');
  if (!backend) return { ok: false, reason: 'Unknown backend.' };

  if (backend.supportsFork !== true) {
    return { ok: false, reason: `${backend.label || backend.id} cannot fork a session.` };
  }
  // A backend that names its own sessions must actually HAVE this one in its store.
  if (typeof backend.liveRefFor === 'function') {
    let known = null;
    try { known = backend.liveRefFor(sessionId); } catch { known = null; }
    if (!known) {
      return {
        ok: false,
        reason: `${backend.label || backend.id} has not written this session yet — it names its own sessions, `
          + 'and only records one once the agent has answered. Send it a message first, then fork.',
      };
    }
  }
  return { ok: true };
});

// A path a DIFFERENT agent can read, for the handoff route where a fresh session reads the old one.
//
// Backends declare how their transcript is reachable (`transcriptAccess`), because it is a property of
// the backend, not a quirk of Hermes: 'file' = it is on disk, hand over the path; 'export' = it lives in
// a store with no file, so we write it out. Any future db-backed backend declares 'export' and works.
//
// The export is a temp file (plain markdown — an agent reads that better than raw rows) and is cleaned
// up when the app quits. It contains the conversation, which is exactly what the user is asking a fresh
// agent to read, so nothing is exposed that they did not just ask for.
ipcMain.handle('handoff-transcript-path', (_event, sessionId) => {
  if (!sessionId) return { ok: false, reason: 'Unknown session.' };

  let row = null;
  try { row = getCachedSession(sessionId); } catch { /* cache unavailable */ }
  if (!row) return { ok: false, reason: 'This session is not in the cache yet.' };

  const backend = backends.get(row.backendId || 'claude');
  const access = (backend && backend.transcriptAccess) || 'file';

  if (access === 'file') {
    const filePath = row.filePath
      || (row.folder ? path.join(PROJECTS_DIR, row.folder, sessionId + '.jsonl') : null);
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, reason: 'This session has no transcript file on disk (yet).' };
    }
    return { ok: true, path: filePath };
  }

  // 'export': the backend hands us its messages and we write them out.
  if (typeof backend.readMessages !== 'function') {
    return { ok: false, reason: `${backend.label || row.backendId} cannot expose this session's transcript.` };
  }
  let entries;
  try { entries = backend.readMessages(sessionId) || []; } catch (err) { return { ok: false, reason: err.message }; }
  if (!entries.length) return { ok: false, reason: 'This session has no messages to read.' };

  try {
    const dir = path.join(app.getPath('temp'), 'switchboard-handoff');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}.md`);
    const body = entries.map(e => {
      const role = (e.message && e.message.role) || 'unknown';
      const text = (e.message && typeof e.message.content === 'string') ? e.message.content : '';
      return `## ${role}\n\n${text}\n`;
    }).join('\n');
    fs.writeFileSync(out, `# Transcript — session ${sessionId}\n\n${body}`, 'utf8');
    handoffExports.add(out);
    return { ok: true, path: out, exported: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

ipcMain.handle('session-backends-get-all', () => {
  return sessionBackends.getAll();
});

// --- IPC: user Axis-A profiles (Phase 2, T-2.1). Kebab-case.
ipcMain.handle('profiles-list', () => {
  return { profiles: profiles.list(), defaultProfileId: profiles.getDefault() };
});
ipcMain.handle('profiles-save', (_event, payload) => {
  const { profile, allowSecrets } = payload || {};
  // Secret hardening (T-2.4): a value that looks like a pasted raw key is rejected unless the user
  // explicitly acknowledged it. Auth belongs in a $VAR ref, never on disk (§5.2).
  return profiles.save(profile, { allowSecrets: !!allowSecrets });
});
// Check a template WITHOUT writing it. The editor stages its changes now and they are only committed by
// Save Settings — but the checks that matter (a raw secret, a host-key leak) must still happen while the
// user is looking at the dialog, not minutes later when they press Save somewhere else. Same validator,
// no side effects.
ipcMain.handle('profiles-validate', (_event, payload) => {
  const { profile, allowSecrets } = payload || {};
  const res = profiles.validateProfile(profile, { allowSecrets: !!allowSecrets });
  return res.ok
    ? { ok: true, profile: res.profile }
    : { ok: false, error: res.error, secretKeys: res.secretKeys, leak: res.leak };
});
ipcMain.handle('profiles-delete', (_event, id) => {
  return profiles.remove(id);
});
ipcMain.handle('profiles-set-default', (_event, id) => {
  return profiles.setDefault(id == null ? null : id);
});
// Which host env vars a profile's `$VAR` refs actually resolve to right now — drives the editor's
// live "resolves ✓ / not set ✗" badge per env row (UX#3) so a missing key surfaces in the editor
// instead of as a cryptic auth failure on first launch. Returns only presence, never the VALUES.
ipcMain.handle('env-refs-check', (_event, names) => {
  const out = {};
  if (Array.isArray(names)) {
    for (const n of names) {
      if (typeof n === 'string' && n) out[n] = typeof process.env[n] === 'string' && process.env[n] !== '';
    }
  }
  return out;
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
  const row = getCachedSession(sessionId);
  if (!row) return { error: 'Session not found in cache' };

  // Only Claude's transcripts live at PROJECTS_DIR/<folder>/<id>.jsonl. Another file backend records
  // its own absolute path (v11) — reconstructing Claude's layout for it would read the wrong file (or,
  // for a db-store backend like Hermes, no file at all: it has none, so say that instead of throwing
  // an ENOENT at the user).
  if (row.filePath) return readJsonlEntries(row.filePath);
  // An Axis-A profile runs the same binary into the same store, so it reads like Claude. Only an
  // Axis-B backend owns a store of its own.
  const backendId = row.backendId || 'claude';
  const b = backends.get(backendId);
  if (b && b.axis === 'B') {
    // A backend with no transcript file can still hand us its messages (Hermes reads them from its DB).
    // That is what makes the viewer AND the handoff pre-fill work for it — without it, a handoff on such
    // a backend silently makes the user retype the packet the agent just wrote (#148).
    if (typeof b.readMessages === 'function') {
      try {
        const entries = b.readMessages(sessionId) || [];
        return { entries };
      } catch (err) {
        return { error: err.message };
      }
    }
    return { error: `${b.label || backendId} keeps this session in its own store, not in a transcript file — there is nothing to show here.` };
  }
  const folder = row.folder || getCachedFolder(sessionId);
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

  // Starting a session here is an explicit act, so the project goes on the list — in BOTH modes (#167).
  // The mode governs DISCOVERY (may a session that merely turned up in a store register its project?),
  // not the user. This used to fire in manual mode only, which read the setting as "I cannot start
  // anything anywhere new", and in auto mode the project appeared only once the transcript existed.
  if (projectPath) projects.ensureProjectAdded(projectPath);

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

  // T-3.10 / T-3.5: a Tier-3 custom launcher (and the ad-hoc "Custom command…") rides on the plain
  // terminal path — the same MONITORED PTY tab, with the user's command typed into the shell once
  // it is up. It stays a terminal session: no backendId, no session file, nothing for the scanner.
  const launcher = isPlainTerminal ? normalizeLauncher(sessionOptions?.launcher) : null;
  const spawnCwd = resolveLauncherCwd(launcher, projectPath);

  // Resolve shell profile from effective settings.
  // T-3.7 — the shell is split by INTENT: `shellProfile` is the CLI shell (Claude and every backend
  // spawn), `terminalShellProfile` is the Terminal bucket (the in-app plain terminal + the External
  // Terminal action). Its default 'inherit' falls back to the CLI shell, so nothing changes until the
  // user actually sets it.
  const effectiveProfileId = isPlainTerminal
    ? resolveTerminalShellProfileId(projectPath)
    : effectiveSettings(projectPath).shellProfile;
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
    const wslCwd = windowsToWslPath(spawnCwd);
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
  // Set inside the backend branch below (where the descriptor is in scope) and consumed after the
  // session object exists — a backend may warn that it takes a while to become usable.
  let startupHint = null;
  // Does the OSC-0 TITLE busy heuristic apply to this session? Only for the claude binary — see the
  // session object below. Same reason `isClaudeBinary` exists, hoisted because the session is built out
  // here while the descriptor is only in scope in the branch.
  let oscTitleState = false;
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

      // A custom launcher's env: `$VAR` refs resolved at spawn (an unresolved one is dropped — never a
      // literal secret on disk, §5.2 — and SAID, #169). It must be in place BEFORE the shell starts.
      if (launcher && launcher.env) {
        Object.assign(env, resolveSpawnEnv(launcher.env, launcher.name || 'Launcher', sessionId));
      }

      ptyProcess = pty.spawn(shell, ptyShellArgs(shell, undefined, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : spawnCwd,
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

      // Type the launcher's command into the shell, after the init line above has been consumed.
      // Written into the PTY (not passed as `-c`/`/C` argv) so the interactive shell SURVIVES the
      // command: the tab keeps its output and stays usable, exactly as if the user had typed it.
      const launcherCmd = launcher ? composeLauncherCommand(shell, launcher) : '';
      if (launcherCmd) {
        log.info(`[launcher] in-app "${launcher.name}" session=${sessionId} cwd=${spawnCwd}`);
        setTimeout(() => {
          if (!ptyProcess._isDisposed) {
            try { ptyProcess.write(launcherCmd + '\r'); } catch {}
          }
        }, 600);
      }
    } else {
      // Route the launch through the backend registry (Phase 1, T-1.2). `claude` is the default
      // backend and reproduces today's exact argv/command; an Axis-A profile additionally supplies
      // an env bundle (merged into ptyEnv further down). Claude behaviour is byte-identical — the
      // arg logic now lives in backends/claude/index.js buildLaunch.
      // Resume is backend-bound (§5.11): when resuming/forking WITHOUT an explicit backend choice,
      // keep the session's recorded backend/profile from the overlay instead of clobbering it with
      // the `claude` default. In Phase 1 the overlay is empty for pre-existing sessions, so this is
      // byte-identical (recorded == null -> claude); it forecloses the resume-clobber landmine once
      // profiles ship (Phase 2/3). A fork inherits the source session's recorded backend too.
      let recorded = null;
      if (!sessionOptions?.backendId) {
        const lookupId = sessionOptions?.forkFrom || (!isNew ? sessionId : null);
        if (lookupId) {
          recorded = sessionBackends.get(lookupId);
          // The overlay is only the bridge until the first scan. `session_cache.backendId` is the
          // AUTHORITATIVE provenance (§5.7), so fall back to it — otherwise resuming a session the
          // overlay no longer knows (a scanner-discovered Codex session, or one whose entry aged out)
          // would silently default to `claude` and spawn `claude --resume <codex-uuid>`, which fails.
          if (!recorded) {
            try {
              const row = getCachedSession(lookupId);
              if (row && row.backendId) recorded = { backendId: row.backendId, profileId: null };
            } catch { /* cache unavailable -> fall through to the claude default */ }
          }
        }
      }
      // A session with no recorded provenance predates the multi-LLM era: it is Claude's, by definition.
      // That inference is still right, and with Claude disableable (#162) it is also the reason such a
      // session cannot be resumed while Claude is off — which the user is owed a sentence about, not a
      // raw failure.
      const requestedId = sessionOptions?.backendId || recorded?.backendId || 'claude';
      const inferredClaude = !sessionOptions?.backendId && !recorded?.backendId;
      const backend = backends.get(requestedId) || backends.get('claude');
      if (!backend) {
        return { ok: false, error: `Backend '${requestedId}' is not installed in this build.` };
      }
      startupHint = backend.startupHint || null;

      // §5.8 guard: only a `ready` (built) AND `enabled` (user-activated) backend may ever spawn. A
      // `planned` binary or a disabled backend is rejected here, before any PTY exists — the picker
      // never offers them, so reaching this is either a stale renderer or a crafted IPC call.
      if (!backends.isLaunchable(backend.id)) {
        const label = backend.label || backend.id;
        let error;
        if (backend.status === 'planned') {
          error = `Backend '${label}' is not built yet.`;
        } else if (backend.isProfile) {
          // A template runs its base backend's binary, so a disabled base leaves it nothing to launch.
          error = `'${label}' runs on ${backend.baseLabel || backend.baseId}, which is disabled. `
            + `Enable ${backend.baseLabel || backend.baseId} in Settings → Backends to use it again.`;
        } else if (inferredClaude) {
          error = 'This session was started before Switchboard supported other backends, so it belongs '
            + 'to Claude Code — which is currently disabled. Enable Claude Code in Settings → Backends '
            + 'to resume it. (It stays visible and searchable either way.)';
        } else {
          error = `Backend '${label}' is disabled. Enable it in Settings → Backends.`;
        }
        log.info(`[spawn] refused: backend=${backend.id} not launchable`);
        return { ok: false, error };
      }

      // Availability: a backend may declare that its binary is missing. Without this the user gets a
      // raw `'hermes' is not recognized...` from the shell inside a terminal tab, with no hint what to
      // install — the descriptor already knows the answer, so say it here instead of spawning.
      if (typeof backend.probe === 'function') {
        let avail;
        try { avail = backend.probe(); } catch (err) { avail = { ok: false, reason: err?.message || String(err) }; }
        if (avail && avail.ok === false) {
          log.info(`[spawn] backend=${backend.id} unavailable: ${avail.reason}`);
          return { ok: false, error: avail.reason || `${backend.label || backend.id} is not available.` };
        }
      }

      // Forking an id the backend never issued produces a dead tab ("No session found"). It happens with
      // every backend that names its own sessions: until it has written its store record we only hold OUR
      // id, which means nothing to it. Refuse with a sentence instead of spawning.
      if (sessionOptions?.forkFrom && typeof backend.liveRefFor === 'function') {
        let known = null;
        try { known = backend.liveRefFor(sessionOptions.forkFrom); } catch { known = null; }
        if (!known) {
          return {
            ok: false,
            error: `${backend.label || backend.id} does not know this session yet — it names its own `
              + 'sessions and records one only after the agent has answered. Send a message first, then fork.',
          };
        }
      }

      const launch = backend.buildLaunch({
        cwd: projectPath,
        resume: !isNew,
        sessionId,
        forkFrom: sessionOptions?.forkFrom,
        options: sessionOptions || {},
      });
      // How this backend wants to be spawned (00 §4). Claude runs as a shell-quoted command string
      // (today's path). An Axis-B binary may ask for ARGV mode instead: Codex is happiest with clean
      // execFile-style argv, and Windows shell quoting mangles it.
      //
      // Windows caveat: argv mode spawns through CreateProcess, which can only execute a real binary.
      // A CLI installed via npm is usually a `.cmd` shim on PATH (that is what `codex` resolves to),
      // and CreateProcess cannot run one. So argv mode is honoured only when the command resolves to
      // an actual executable; otherwise we fall back to the shell path, which resolves the shim fine.
      const argvExe = launch.spawnMode === 'argv' ? resolveArgvExecutable(launch.command) : null;

      // A pre-launch command is a raw SHELL prefix (`nvm use 20 &&`, `aws-vault exec profile --`), so
      // there has to be a shell — and a command line — for it to sit in front of. Argv mode has neither.
      //
      // That is the entire reason this option was Claude's: Claude spawns through a shell, the Axis-B
      // backends spawn argv (Windows shell quoting mangles their arguments). It was never a statement
      // about Claude. So: keep argv as the default for everyone, and drop to the shell path for the one
      // session where somebody actually set a prefix. They asked for a shell; they get one, quoted by
      // the same `quoteArgvForShell` Claude has always used.
      const preLaunchCmd = String(sessionOptions?.preLaunchCmd || '').trim();
      if (preLaunchCmd && /[\r\n]/.test(preLaunchCmd)) {
        return { ok: false, error: 'The pre-launch command must not contain newlines.' };
      }

      const useArgvSpawn = !!argvExe && !preLaunchCmd;
      if (launch.spawnMode === 'argv' && !argvExe) {
        log.info(`[spawn] backend=${backend.id} wanted argv mode but '${launch.command}' is not a directly-executable binary here — using the shell path`);
      } else if (launch.spawnMode === 'argv' && preLaunchCmd) {
        log.info(`[spawn] backend=${backend.id} has a pre-launch command — starting through the shell instead of argv`);
      }

      // The MCP IDE bridge stays CLAUDE's: `--ide` is a claude flag and the bridge speaks Claude's own
      // protocol. Handing it to Codex would be a flag it does not know. (`preLaunchCmd` used to be gated
      // here too, for a reason that turned out to be about the spawn mode — see above.)
      const isClaudeBinary = launch.command === 'claude';
      oscTitleState = isClaudeBinary;

      let claudeCmd = null;
      if (!useArgvSpawn) {
        claudeCmd = launch.command + ' ' + quoteArgvForShell(shell, launch.args);
        if (preLaunchCmd) claudeCmd = preLaunchCmd + ' ' + claudeCmd;
      }

      // Start MCP server for this session so Claude CLI sends diffs/file opens to Switchboard
      // (skip if user disabled IDE emulation in global settings)
      if (isClaudeBinary && sessionOptions?.mcpEmulation !== false) {
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
      // The project/global halves now come from backendDefaults.claude (§4a), where every backend's
      // launch options live; the session half still overrides both.
      {
        const g = ((getSetting('global') || {}).backendDefaults || {}).claude || {};
        const p = projectPath
          ? (((getSetting('project:' + projectPath) || {}).backendDefaults || {}).claude || {})
          : {};
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
      // The env a session actually gets, least specific first:
      //   1. the BACKEND's own bundle — its `$VAR` auth refs, from buildLaunch
      //   2. the USER's variables for that backend (`backendEnv.<id>`). New: a plain backend could not
      //      carry any, so the only way to hand Codex a variable was to wrap it in a whole template
      //   3. the TEMPLATE's bundle, when this launch is a template — the most specific thing there is
      //
      // `launch.env` already has (1) ⊕ (3) merged, because a template's descriptor merges its bundle over
      // its base's. So lift the template's own keys back out first, or the user's backend variables would
      // land ON TOP of the template — the wrong way round, and silently.
      //
      // `$VAR` refs are resolved here, at spawn, and never written to disk (§5.2).
      {
        const allEnv = (getSetting('global') || {}).backendEnv || {};
        const baseId = backend.isProfile ? (backend.baseId || 'claude') : backend.id;
        const templateEnv = backend.isProfile ? (backend.templateEnv || {}) : {};

        const baseEnv = { ...(launch.env || {}) };
        for (const key of Object.keys(templateEnv)) delete baseEnv[key];

        // The template's name, not the backend's: three templates can reference three different keys,
        // and "OPENAI_API_KEY is not set" without saying WHOSE is a riddle (#169).
        Object.assign(ptyEnv, resolveSpawnEnv({
          ...baseEnv,
          ...(allEnv[baseId] || {}),
          ...templateEnv,
        }, backend.label || backend.id, sessionId));
      }
      const effectiveProfileId = sessionOptions?.profileId != null ? sessionOptions.profileId : (recorded?.profileId || null);
      sessionBackends.record(sessionId, backend.id, effectiveProfileId);

      const ptyOpts = {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        // TERM_PROGRAM=iTerm.app: Claude Code checks this to decide whether to emit
        // OSC 9 notifications (e.g. "needs your attention"). Without it, the packaged
        // app's minimal Electron environment won't trigger those sequences.
        env: ptyEnv,
        useConptyDll,
      };

      if (useArgvSpawn) {
        // ARGV mode: spawn the binary directly, no shell in between, so nothing re-interprets the
        // arguments. Codex asks for this because Windows shell quoting mangles its argv.
        log.info(`[spawn] backend=${backend.id} mode=argv cmd=${argvExe} args=${JSON.stringify(launch.args)}`);
        ptyProcess = pty.spawn(argvExe, launch.args, ptyOpts);
      } else {
        ptyProcess = pty.spawn(shell, ptyShellArgs(shell, claudeCmd, shellExtraArgs), ptyOpts);
      }

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
    // Did this session already exist in the backend's store before we spawned it? Only then can our id
    // be an id the backend knows — which is the one case where `liveRefFor` has anything to find
    // (claimLiveRecord). A fork is NOT a resume: the backend names the child itself.
    _resumed: !isNew,
    // Whether the OSC-0 TITLE heuristic applies to this session. It is Claude's, and only Claude's:
    // busy = a Braille spinner glyph, idle = the ✳ character. Run it against another CLI whose TUI also
    // spins in the title — Codex does — and the busy latch closes on the first spinner frame and can
    // NEVER open again, because that CLI has no reason to ever write a ✳. The session then reads
    // "working" forever while it sits at its prompt. Every other backend reports its own state through
    // `liveState`; this heuristic exists precisely because Claude does not.
    _oscTitleState: oscTitleState,
  };
  activeSessions.set(sessionId, session);

  // A backend may warn that it takes a while to become usable (Hermes needs ~12s to load its Python
  // stack). Without a word the tab just sits black and reads as broken. Write the hint straight into
  // the session's buffer, so it also survives a detach/reattach — the binary's own output scrolls it
  // away the moment it starts talking.
  if (startupHint) {
    const hint = `\x1b[2m${String(startupHint).replace(/[\r\n]+/g, ' ')}\x1b[0m\r\n`;
    session.outputBuffer.push(hint);
    session.outputBufferSize += hint.length;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', sessionId, hint);
    }
  }

  ptyProcess.onData(data => {
    // ConPTY flushes buffered output asynchronously after pty.kill(), so a last
    // chunk can arrive after will-quit closed the DB — the OSC 9;4 path below
    // calls getSetting() and would throw "The database connection is not open"
    // in an uncaught-exception dialog (#90 class, PTY edition).
    if (appQuitting) return;
    const currentId = session.realSessionId || sessionId;

    // LIVENESS, not state. A backend whose busy/idle comes from its store (Codex/Hermes/Pi) has one
    // blind spot: a turn that runs long without writing anything looks finished. The PTY stream closes
    // it — "the process is still talking" — so state derivation can refuse to call such a turn idle.
    // It is deliberately NOT a busy signal: a spinner frame is output, and so is an echoed keystroke.
    session._lastOutputAt = Date.now();

    // Parse OSC sequences (title changes, progress, notifications, etc.)
    if (data.includes('\x1b]')) {
      const oscMatches = data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const m of oscMatches) {
        const code = m[1];
        const payload = m[2].slice(0, 120);
        // Detect Claude CLI busy state from OSC 0 title (spinner chars = busy, ✳ = idle).
        //
        // CLAUDE ONLY. The idle half of this test is the literal character ✳, which no other CLI has any
        // reason to write — so on a backend whose TUI also spins in the window title (Codex), the busy
        // latch closes on the first spinner frame and never opens again. The session reads "working"
        // forever while it sits at its prompt. Every other backend reports its own state through
        // `liveState`; this heuristic exists precisely because Claude does not.
        if (code === '0' && session._oscTitleState) {
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
    // Release the Codex rollout claim + busy latch for this session (T-4.5), so the file can be
    // re-claimed and the maps don't grow for the life of the app.
    for (const id of [realId, sessionId]) { liveStoreRef.delete(id); liveBusy.delete(id); }
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
// Give the registry access to user state (T-2.1): the `backendEnabled.<id>` flags + defaultLaunchTarget
// live in the global settings blob, user Axis-A profiles in profiles.json. backends.list() then returns
// built-ins ∪ profiles with their merged enabled flags.
backends.init({ getGlobalSettings: () => getSetting('global') || {}, profiles });
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
    // NOTE on the vanished-folder branches below: they must NOT call the raw db deleteCachedFolder.
    // A project folder key is shared across backends (same cwd -> same project), so an unscoped wipe
    // would also delete the Codex rows for that project even though nothing happened to Codex's own
    // store. refreshFolder() detects the missing folder and does a Claude-SCOPED delete instead.
    for (const [folder, relSet] of files) {
      if (folders.has(folder)) continue; // a full folder refresh below covers it
      const folderPath = path.join(PROJECTS_DIR, folder);
      if (!fs.existsSync(folderPath)) { refreshFolder(folder); changed = true; continue; }
      detectSessionTransitions(folder);
      for (const rel of relSet) refreshFile(folder, rel);
      changed = true;
    }

    // Folder-level events (top-level add/remove) → full folder refresh.
    for (const folder of folders) {
      const folderPath = path.join(PROJECTS_DIR, folder);
      if (fs.existsSync(folderPath)) detectSessionTransitions(folder);
      refreshFolder(folder); // handles both: refresh when present, scoped delete when gone
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

// --- live watch on the OTHER backends' session stores (T-4.8) ---
//
// Scan-generalization (T-4.2) is not watch-generalization. The watcher above is Claude-shaped: it
// watches PROJECTS_DIR and speaks in folders + per-file refreshes. A backend with its own store needs
// its own watch, and it operates on STORE-level targets (a dir root, or a db file), not on the
// per-session handles discovery returns — hence the separate `watchTargets()` hook.
//
// Two things bite here:
//   - Codex's tree is DATE-BUCKETED (sessions/YYYY/MM/DD/). A naive watch on today's directory goes
//     stale at MIDNIGHT (tomorrow's dir does not exist yet) and misses the dir a fresh session
//     creates. A recursive watch on the sessions ROOT covers both.
//   - The root may not exist yet (no session ever run). Watching it would throw, so we retry.
//
// A db-kind target (Hermes' state.db, Phase 5) polls the file AND its `-wal` sibling: a plain
// state.db mtime misses WAL-buffered commits.
const backendWatchers = [];
// Transcripts we exported for a "let the new session read the old one" handoff. Temp files: they exist
// so another agent can read them once, and they do not outlive the app.
const handoffExports = new Set();
let backendBusyTicker = null;   // slow re-check so a hung backend cannot stay BUSY forever
let backendWatcherRetry = null;

// --- Axis-B live sessions: identity adoption + busy/idle (T-4.5, T-5.3) ---
//
// Two problems, one root, and they apply to EVERY backend that names its own sessions:
//
//  1. IDENTITY. Claude accepts `--session-id`, so we choose the id. Codex and Hermes do not: they
//     create their own id in their own store. Until the two are reconciled the app shows two rows for
//     one session (our pending row + the scanned store row), the pending row never dies, and resuming
//     from the sidebar targets an id the tool never had.
//  2. BUSY/IDLE. Claude reports state through OSC title sequences in its PTY stream. Neither Codex nor
//     Hermes emits OSC, so a live session would sit permanently "idle". Their stores carry the signal
//     instead — and the backend watcher already fires whenever those stores change.
//
// Both are solved once, generically, via two optional descriptor hooks:
//     matchLiveSession({cwd, sinceMs, claimed}) -> {sessionId, ref} | null
//     liveState(ref)                            -> 'busy' | 'idle' | null
// A backend that names its own sessions implements them; anything else is simply skipped. Adding a
// third such backend needs no change here.
const liveStoreRef = new Map();   // our sessionId -> the backend's record ref (rollout path / db id)
const liveBusy = new Map();       // our sessionId -> last busy state pushed to the renderer

function claimLiveRecord(sessionId, session, backend) {
  const existing = liveStoreRef.get(sessionId);
  if (existing) return existing;

  // RESUME: our id already IS the backend's id, so there is nothing to correlate — just confirm the
  // record exists. This must come first: `matchLiveSession` only accepts records born after the spawn,
  // and a resumed session's record is by definition older, so correlation could never claim it — but it
  // WOULD happily claim the next new session's record in the same cwd and collapse two tabs onto one id.
  //
  // Only a RESUMED session can have a record under our id. A new one (fork included) is about to be
  // named by the backend itself, so asking is guaranteed to come back empty — and `liveRefFor` walks the
  // whole store, on every watcher flush, for every session not yet claimed. That walk bought nothing and
  // is simply not made (#155).
  //
  // For a resumed session the question IS asked on every flush until it answers, and deliberately so: a
  // null is not proof that the record is absent. Hermes' openDb() returns null while its DB is locked —
  // and the moment of heaviest write contention is right after a resume. Caching that first "no" would
  // leave the session without busy/idle for good, with nothing left to heal it, since matchLiveSession
  // can never claim a record older than the spawn. In practice this resolves on the first flush.
  if (typeof backend.liveRefFor === 'function' && session._resumed !== false) {
    let ownRef = null;
    try { ownRef = backend.liveRefFor(sessionId); } catch { ownRef = null; }
    if (ownRef) {
      liveStoreRef.set(sessionId, ownRef);
      return ownRef;
    }
  }

  const claimed = new Set(liveStoreRef.values());
  // Small grace window: the store record appears just AFTER we spawn the process.
  const sinceMs = (session._openedAt || 0) - 10000;

  let match = null;
  try {
    match = backend.matchLiveSession({ cwd: session.projectPath, sinceMs, claimed });
  } catch (err) {
    log.warn(`[${backend.id}] live match failed: ${err?.message || err}`);
    return null;
  }
  if (!match || !match.sessionId) return null;

  // Adopt the backend's id. This is exactly Claude's temp->real transition, so it reuses that
  // plumbing: re-key the live session, move the backend overlay across, and tell the renderer to fold
  // its pending row onto the real one.
  const realId = match.sessionId;
  if (realId !== sessionId && !activeSessions.has(realId)) {
    log.info(`[${backend.id}] session ${sessionId} → ${realId} (adopting the backend's own session id)`);
    session.realSessionId = realId;
    activeSessions.delete(sessionId);
    activeSessions.set(realId, session);
    sessionBackends.rekeySession(sessionId, realId);
    liveStoreRef.set(realId, match.ref);
    const wasBusy = liveBusy.get(sessionId);
    liveBusy.delete(sessionId);
    if (wasBusy !== undefined) liveBusy.set(realId, wasBusy);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session-forked', sessionId, realId);
    }
  } else {
    // No adoption needed (or the target id is somehow already live). NOTE: the claim is deliberately
    // NOT recorded before a successful adoption — doing so would make the early-return above skip the
    // adoption forever if it ever failed.
    liveStoreRef.set(sessionId, match.ref);
  }
  return match.ref;
}

function updateBackendLiveStates() {
  // Snapshot: claimLiveRecord may re-key a session, which mutates activeSessions mid-iteration.
  for (const [sessionId, session] of [...activeSessions]) {
    if (session.exited) {
      // Drop the claim so the maps don't grow for the life of the app (and so a re-launched session
      // re-claims cleanly instead of inheriting a dead ref).
      const liveId = session.realSessionId || sessionId;
      liveStoreRef.delete(sessionId); liveStoreRef.delete(liveId);
      liveBusy.delete(sessionId); liveBusy.delete(liveId);
      continue;
    }
    if (session.isPlainTerminal) continue;

    const mapped = sessionBackends.get(session.realSessionId || sessionId);
    if (!mapped) continue;
    const backend = backends.get(mapped.backendId);
    if (!backend || typeof backend.matchLiveSession !== 'function' || typeof backend.liveState !== 'function') {
      continue;   // Claude & Axis-A: they report state through OSC and own their session id already.
    }

    const liveId = session.realSessionId || sessionId;
    const ref = claimLiveRecord(sessionId, session, backend);
    if (!ref) {
      // No record, and the session is plainly running in front of the user — so the tab will show no
      // state at all, forever. Hermes' degraded mode (it writes JSON when it cannot open its own DB) puts
      // it here. Say so once, rather than leaving a blank indicator the user cannot explain (#151). We do
      // NOT fabricate a state from PTY output: output is liveness, never busy (D21).
      if (shouldNoticeMissingRecord({ openedAt: session._openedAt, alreadyNoticed: session._noRecordNoticed })) {
        session._noRecordNoticed = true;
        const message = missingRecordMessage(backend.label || backend.id);
        log.warn(`[${backend.id}] session=${liveId} has no store record — reporting no busy/idle state`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('session-notice', liveId, message);
        }
      }
      continue;
    }

    let state;
    try { state = backend.liveState(ref, { lastOutputMs: session._lastOutputAt || 0 }); } catch { state = null; }
    if (state == null) continue;

    const busy = state === 'busy';
    if (liveBusy.get(liveId) === busy) continue;   // only push edges, not every watcher event
    liveBusy.set(liveId, busy);
    log.info(`[${backend.id}] session=${liveId} → ${busy ? 'BUSY' : 'IDLE'}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cli-busy-state', liveId, busy);
    }
  }
}


function startBackendWatchers() {
  stopBackendWatchers();

  const DEBOUNCE_MS = 600;
  const pending = new Set();       // backendIds with unflushed changes
  let debounceTimer = null;
  let missingRoot = false;

  function flush() {
    debounceTimer = null;
    if (appQuitting) return;
    const ids = [...pending];
    pending.clear();
    let changed = false;
    for (const id of ids) {
      try {
        const res = sessionCache.refreshBackendSessions(id);
        if (res && (res.upserted || res.deleted)) changed = true;
      } catch (err) {
        log.warn(`[watch] backend ${id} refresh failed: ${err?.message || err}`);
      }
    }
    // The rollout that just changed is also the busy/idle signal for a live Codex session (T-4.5).
    // The store that just changed is also the busy/idle signal — and the place a freshly launched
    // session's real id first appears (T-4.5 / T-5.3). One generic pass covers every such backend.
    try { updateBackendLiveStates(); } catch (err) { log.warn(`[backends] live-state update failed: ${err?.message || err}`); }
    if (changed) notifyRendererProjectsChanged();
  }

  function schedule(backendId) {
    pending.add(backendId);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  for (const backend of backends.launchable()) {
    // Claude (and every Axis-A profile, which shares Claude's store) is already covered by
    // startProjectsWatcher above — watching it twice would double every refresh.
    if (backend.axis !== 'B' || typeof backend.watchTargets !== 'function') continue;

    let targets = [];
    try { targets = backend.watchTargets() || []; } catch { continue; }

    for (const target of targets) {
      if (!target || !target.path) continue;

      if (target.kind === 'db') {
        // Poll the DB and its write-ahead log: a commit can land in the -wal without touching the
        // main file's mtime, so watching state.db alone would miss live sessions.
        for (const file of [target.path, target.path + '-wal']) {
          try {
            fs.watchFile(file, { interval: 2000, persistent: false }, (cur, prev) => {
              if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) schedule(backend.id);
            });
            backendWatchers.push({ kind: 'poll', file });
          } catch { /* best effort */ }
        }
        continue;
      }

      // dir-kind (Codex, later Pi).
      if (!fs.existsSync(target.path)) {
        // No session has ever been run for this backend — nothing to watch yet. Re-arm later so the
        // very first session still shows up live rather than only after a restart.
        missingRoot = true;
        continue;
      }
      try {
        const w = fs.watch(target.path, { recursive: target.recursive !== false }, (_evt, filename) => {
          if (!filename) return;
          // Only session files matter; ignore the dir churn of the date buckets themselves.
          if (!String(filename).endsWith('.jsonl')) return;
          schedule(backend.id);
        });
        w.on('error', (err) => log.warn(`[watch] backend ${backend.id} watcher error: ${err?.message || err}`));
        backendWatchers.push({ kind: 'watch', watcher: w });
        log.info(`[watch] backend=${backend.id} watching ${target.path}`);
      } catch (err) {
        log.warn(`[watch] backend ${backend.id} watch failed: ${err?.message || err}`);
      }
    }
  }

  // A store root that doesn't exist yet (or a backend the user just enabled) — re-arm periodically so
  // it starts being watched without a restart.
  if (missingRoot && !backendWatcherRetry) {
    backendWatcherRetry = setTimeout(() => {
      backendWatcherRetry = null;
      if (!appQuitting) startBackendWatchers();
    }, 60000);
    if (backendWatcherRetry.unref) backendWatcherRetry.unref();
  }

  // Busy/idle for these backends is derived from their STORE, and the store only tells us something
  // when it changes. A backend that hangs mid-turn writes nothing more — so the last edge we pushed
  // (BUSY) would stand forever, and every backend's state logic has a staleness rule that never gets a
  // chance to run. This slow tick gives it one.
  //
  // It also has to run for a session we have NOT paired with a record yet, and that is not a nicety: the
  // store-changed watcher cannot fire when the store does not exist. Hermes in degraded mode (it writes
  // JSON because it could not open its own database) never touches state.db, so nothing changes, so
  // nothing ticks — and gating this on "something is busy" made it worse, because an unpaired session can
  // never BE busy. One Hermes session on a broken store would then sit there in silence, which is exactly
  // the condition #151 exists to speak up about. So: tick while anything is busy, OR while anything is
  // still unpaired. An app with no live backend session does no work either way.
  if (!backendBusyTicker) {
    backendBusyTicker = setInterval(() => {
      if (appQuitting) return;
      let anyBusy = false;
      for (const busy of liveBusy.values()) if (busy) { anyBusy = true; break; }
      if (!anyBusy && !hasUnclaimedStoreSession()) return;
      try { updateBackendLiveStates(); } catch (err) {
        log.warn(`[backends] busy re-check failed: ${err?.message || err}`);
      }
    }, 30000);
    if (backendBusyTicker.unref) backendBusyTicker.unref();
  }
}

// Is any live session still waiting to be paired with its backend's store record? Only store-derived
// backends count — Claude owns its session id and reports state through the terminal, so it is never
// "unpaired" in this sense.
//
// A session we have ALREADY spoken up about stops counting. This tick exists to get us to that notice,
// and matchLiveSession is not free: on a file backend it walks the whole store and parses every candidate.
// Left counting, a session that can never be paired (a store that moved, a cwd that will not correlate)
// would drive that walk every 30 seconds for the life of the app. The record can still turn up later —
// the store watcher fires the moment anything is written, which is exactly when it would.
function hasUnclaimedStoreSession() {
  for (const [sessionId, session] of activeSessions) {
    if (session.exited || session.isPlainTerminal || session._noRecordNoticed) continue;
    const liveId = session.realSessionId || sessionId;
    if (liveStoreRef.has(sessionId) || liveStoreRef.has(liveId)) continue;
    const mapped = sessionBackends.get(liveId);
    if (!mapped) continue;
    const backend = backends.get(mapped.backendId);
    if (!backend || typeof backend.matchLiveSession !== 'function' || typeof backend.liveState !== 'function') continue;
    return true;
  }
  return false;
}

function stopBackendWatchers() {
  for (const entry of backendWatchers) {
    try {
      if (entry.kind === 'watch') entry.watcher.close();
      else if (entry.kind === 'poll') fs.unwatchFile(entry.file);
    } catch { /* best effort */ }
  }
  backendWatchers.length = 0;
  if (backendWatcherRetry) { clearTimeout(backendWatcherRetry); backendWatcherRetry = null; }
  if (backendBusyTicker) { clearInterval(backendBusyTicker); backendBusyTicker = null; }
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
    // One-time: Claude's launch options move from the settings root into backendDefaults.claude.
    // Runs before any window reads settings, so the panel never sees the half-migrated shape.
    try { migrateClaudeLaunchDefaults(); } catch (err) {
      log.warn('[settings] Claude launch-defaults migration failed:', err?.message || err);
    }
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
    // Watch the other enabled backends' own stores (Codex's rollout tree, later Hermes' state.db)
    // so their sessions appear live, not just after a restart (T-4.8).
    startBackendWatchers();
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

      // Scheduled runs are Claude-only by design: the schedule UI composes Claude's headless argv. So
      // they answer to Claude's enable gate like everything else (#162) — a disabled backend must not
      // keep spawning its binary from a cron tick, which is exactly what this path did, silently,
      // because it never asked. Refuse loudly instead: a scheduled task that quietly stops running is
      // worse than one that says why.
      if (!backends.isLaunchable('claude')) {
        const msg = `[schedule] "${name}" skipped: Claude Code is disabled (scheduled runs are Claude-only).`;
        log.warn(msg);
        if (typeof onDone === 'function') onDone(new Error('Claude Code is disabled — scheduled runs need it.'));
        return;
      }

      // A scheduled run is a session the user asked for, so its project goes on the list (#167) — in both
      // modes, like any other launch. Without this, a schedule pointed at a project the user has not added
      // writes transcripts that never show up anywhere: real sessions, invisible, with no way to find them.
      if (cwd) { try { projects.ensureProjectAdded(cwd); } catch { /* the scan will get it in auto mode */ } }

      // The binary name comes from the backend descriptor, not a literal (T-1.7) — so no `'claude '`
      // command build survives outside backends/.
      const cmd = (backends.get('claude')?.binary || 'claude') + ' ' + quoteArgvForShell(shell, claudeArgv);
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
      try { projects.applyAutoHide(true); } catch {}
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
  for (const file of handoffExports) {
    try { fs.unlinkSync(file); } catch { /* best effort */ }
  }
  handoffExports.clear();

  // Shut down all MCP servers
  shutdownAllMcp();

  // Remove the tray icon
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }

  // Close filesystem watchers
  if (projectsWatcher) {
    projectsWatcher.close();
    projectsWatcher = null;
  }
  stopBackendWatchers();

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
