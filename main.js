const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, screen, session, shell, Tray } = require('electron');
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
const { startMcpServer, shutdownMcpServer, shutdownAll: shutdownAllMcp, resolvePendingDiff, rekeyMcpServer, cleanStaleLockFiles } = require('./mcp-bridge');
const { fetchAndTransformUsage } = require('./claude-auth');
const { withMainProcessUsageCache } = require('./usage-cache');
const { shouldUseSingleInstanceLock } = require('./main-lifecycle');
log.transports.file.level = app.isPackaged ? 'info' : 'debug';
log.transports.console.level = app.isPackaged ? 'info' : 'debug';

try { require('electron-reloader')(module, { watchRenderer: true }); } catch {};

// Clean env for child processes — strip Electron internals that cause nested
// Electron apps (or node-pty inside them) to malfunction.
const cleanPtyEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    !k.startsWith('ELECTRON_') &&
    !k.startsWith('GOOGLE_API_KEY') &&
    k !== 'NODE_OPTIONS' &&
    k !== 'ORIGINAL_XDG_CURRENT_DESKTOP' &&
    k !== 'WT_SESSION'
  )
);

// Shell profiles → shell-profiles.js
const { discoverShellProfiles, getShellProfiles, resolveShell, isWindows, isWslShell, windowsToWslPath, shellArgs, quoteArgvForShell } = require('./shell-profiles');
const { startScheduler } = require('./schedule-runner');
const { encodeProjectPath } = require('./encode-project-path');



// --- Auto-updater (only in packaged builds) ---
let autoUpdater = null;
// Path to the downloaded update archive, captured from the `update-downloaded`
// event. On macOS we install it manually (see installUpdateMac) because the
// fork ships unsigned builds and Squirrel.Mac refuses to apply unsigned updates.
let pendingUpdateFilePath = null;
if (app.isPackaged || process.env.FORCE_UPDATER) {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  // On macOS, never let electron-updater hand the download off to Squirrel.Mac:
  // it requires a Developer ID signature we don't have, which makes the install
  // fail. We do a manual bundle swap instead (see the updater-install handler).
  autoUpdater.autoInstallOnAppQuit = process.platform !== 'darwin';
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;

  function sendUpdaterEvent(type, data) {
    log.info(`[updater] ${type}`, data || '');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater-event', type, data);
    }
  }
  autoUpdater.on('checking-for-update', () => sendUpdaterEvent('checking'));
  autoUpdater.on('update-available', (info) => sendUpdaterEvent('update-available', info));
  autoUpdater.on('update-not-available', (info) => sendUpdaterEvent('update-not-available', info));
  autoUpdater.on('download-progress', (progress) => sendUpdaterEvent('download-progress', progress));
  autoUpdater.on('update-downloaded', (info) => {
    pendingUpdateFilePath = info?.downloadedFile || null;
    sendUpdaterEvent('update-downloaded', info);
  });
  autoUpdater.on('error', (err) => {
    log.error('[updater] Error:', err?.message || String(err));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater-event', 'error', { message: err?.message || String(err) });
    }
  });
}
const {
  getMeta, getAllMeta, toggleStar, setName, setArchived,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedFolder, getCachedSession, upsertCachedSessions,
  deleteCachedSession, deleteCachedFolder,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting,
  closeDb,
} = require('./db');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STATS_CACHE_PATH = path.join(CLAUDE_DIR, 'stats-cache.json');
const MAX_BUFFER_SIZE = 256 * 1024;

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
];

function isSensitivePath(filePath) {
  const resolved = path.resolve(filePath);
  return SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(resolved));
}

// Stricter allowlist for memory/plan files that should only be under ~/.claude/
// or active project directories.
function isAllowedMemoryPath(filePath) {
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(CLAUDE_DIR + path.sep) || resolved === CLAUDE_DIR) return true;
  for (const [, session] of activeSessions) {
    if (session.projectPath && resolved.startsWith(session.projectPath + path.sep)) return true;
  }
  return false;
}

// --- Input sanitization for shell command arguments ---
const SHELL_META_CHARS = /[;&|`$(){}!#\n\r]/;
function validateShellArg(value, fieldName) {
  if (!value) return;
  if (SHELL_META_CHARS.test(value)) {
    throw new Error(`${fieldName} contains invalid characters`);
  }
}

// Active PTY sessions
const activeSessions = new Map();
let mainWindow = null;

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
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
    trayImage = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
    if (!trayImage.isEmpty()) trayImage = trayImage.resize({ width: 18, height: 18 });
  } catch {
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
    deleteCachedFolder, getCachedByFolder, upsertCachedSessions, deleteCachedSession,
    deleteSearchFolder, deleteSearchSession, upsertSearchEntries,
    setFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, getMeta, setName,
  },
});
const { readSessionFile, readFolderFromFilesystem, refreshFolder, reconcileCacheFromFilesystem,
        buildProjectsFromCache, notifyRendererProjectsChanged, sendStatus, populateCacheViaWorker } = sessionCache;


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

// --- IPC: remap-project ---
ipcMain.handle('remap-project', (_event, oldPath, newPath) => {
  try {
    const stat = fs.statSync(newPath);
    if (!stat.isDirectory()) return { error: 'Path is not a directory' };

    // Find the folder key for the old project path
    const folder = oldPath.replace(/[/_]/g, '-').replace(/^-/, '-');
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

    // Refresh the folder cache so the new path takes effect
    refreshFolder(folder);
    notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
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

// --- IPC: clipboard write ---
// The renderer's navigator.clipboard.writeText is gated on focus/user-activation and
// is flaky-to-dead on Linux/Wayland (Ozone). The main-process clipboard has no such
// strings attached, so all terminal copies go through here.
ipcMain.handle('clipboard-write-text', (_event, text) => {
  if (typeof text === 'string') clipboard.writeText(text);
});

// --- IPC: MCP bridge ---
ipcMain.on('mcp-diff-response', (_event, sessionId, diffId, action, editedContent) => {
  resolvePendingDiff(sessionId, diffId, action, editedContent);
});

ipcMain.handle('read-file-for-panel', async (_event, filePath) => {
  try {
    const resolved = path.resolve(filePath);
    if (isSensitivePath(resolved)) return { ok: false, error: 'access to sensitive path denied' };
    const content = fs.readFileSync(resolved, 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('save-file-for-panel', async (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (isSensitivePath(resolved)) return { ok: false, error: 'access to sensitive path denied' };
    if (!fs.existsSync(resolved)) return { ok: false, error: 'File does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── File Watching (for viewer panels) ────────────────────────────────
const fileWatchers = new Map(); // filePath → FSWatcher

ipcMain.handle('watch-file', (_event, filePath) => {
  const resolved = path.resolve(filePath);
  if (isSensitivePath(resolved)) return { ok: false, error: 'access to sensitive path denied' };
  if (fileWatchers.has(resolved)) return { ok: true };
  try {
    let debounce = null;
    const watcher = fs.watch(resolved, (eventType) => {
      if (eventType !== 'change') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('file-changed', resolved);
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
  const resolved = path.resolve(filePath);
  const watcher = fileWatchers.get(resolved);
  if (watcher) {
    watcher.close();
    fileWatchers.delete(resolved);
  }
  return { ok: true };
});

ipcMain.handle('get-projects', (_event, showArchived) => {
  try {
    const needsPopulate = !isCachePopulated() || !isSearchIndexPopulated();

    if (needsPopulate) {
      populateCacheViaWorker();
      return [];
    }

    // Pick up folders changed while the app was closed, or never indexed by an
    // older build, so sessions/worktrees don't silently go missing. Stat-gated,
    // so it's cheap when nothing has changed.
    reconcileCacheFromFilesystem();
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
      } catch {}
    }
    plans.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    // Index plans for FTS
    try {
      deleteSearchType('plan');
      upsertSearchEntries(plans.map(p => ({
        id: p.filename, type: 'plan', folder: null,
        title: p.title,
        body: fs.readFileSync(path.join(PLANS_DIR, p.filename), 'utf8'),
      })));
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
    if (!resolved.startsWith(PLANS_DIR)) {
      return { ok: false, error: 'path outside plans directory' };
    }
    fs.writeFileSync(resolved, content, 'utf8');
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

// --- IPC: refresh-stats (run /stats + /usage via PTY) ---
ipcMain.handle('refresh-stats', async () => {
  // For stats, use the configured shell profile
  const globalSettings = getSetting('global') || {};
  const statsProfileId = globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile;
  const statsShellProfile = resolveShell(statsProfileId);
  const statsShell = statsShellProfile.path;
  const statsShellExtraArgs = statsShellProfile.args || [];
  const ptyEnv = {
    ...cleanPtyEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'iTerm.app',
    TERM_PROGRAM_VERSION: '3.6.6',
    FORCE_COLOR: '3',
    ITERM_SESSION_ID: '1',
  };

  // Helper: spawn claude with args, collect output, auto-accept trust, kill when idle
  // waitFor: optional regex tested against stripped output — finish only when matched
  function runClaude(args, { timeoutMs = 15000, waitFor = null } = {}) {
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      let trustAccepted = false;
      // Track idle: ✳ in OSC title means Claude is idle and waiting for input
      let sawActivity = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        try { p.kill(); } catch {}
        resolve(output);
      };

      const claudeCmd = `claude ${args}`;
      const p = pty.spawn(statsShell, shellArgs(statsShell, claudeCmd, statsShellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: os.homedir(),
        env: ptyEnv,
      });

      const strip = (s) => s
        .replace(/\x1b\[[^@-~]*[@-~]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b[^[\]].?/g, '');

      p.onData((data) => {
        output += data;

        // Auto-accept trust directory prompt (Enter selects "1. Yes")
        if (!trustAccepted) {
          if (/trust\s*this\s*folder/i.test(strip(output))) {
            trustAccepted = true;
            try { p.write('\r'); } catch {}
            return;
          }
        }

        // If waitFor is set, finish when that pattern appears in stripped output
        if (waitFor) {
          if (waitFor.test(strip(output))) {
            finish();
          }
          return;
        }

        // Default: detect busy→idle transition via OSC title containing ✳
        if (!sawActivity) {
          const oscTitle = data.match(/\x1b\]0;([^\x07\x1b]*)/);
          if (oscTitle) {
            const first = oscTitle[1].charAt(0);
            if (first.charCodeAt(0) >= 0x2800 && first.charCodeAt(0) <= 0x28FF) {
              sawActivity = true;
            }
          }
        } else if (data.includes('\u2733')) {
          finish();
        }
      });

      p.onExit(() => finish());
      setTimeout(finish, timeoutMs);
    });
  }

  try {
    // Run /stats via PTY (for heatmap/chart data) and fetch usage via API in parallel
    const [, usage] = await Promise.all([
      runClaude('"/stats"', { waitFor: /streak/i, timeoutMs: 10000 }),
      fetchAndTransformUsage().catch(() => ({})),
    ]);

    // Read refreshed stats cache
    let stats = null;
    try {
      if (fs.existsSync(STATS_CACHE_PATH)) {
        stats = JSON.parse(fs.readFileSync(STATS_CACHE_PATH, 'utf8'));
      }
    } catch {}

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

// --- IPC: get-memories ---
function folderToShortPath(folder) {
  // Convert "-Users-home-dev-MyClaude" → "dev/MyClaude"
  const parts = folder.replace(/^-/, '').split('-');
  const meaningful = parts.filter(Boolean);
  return meaningful.slice(-2).join('/');
}

/** Scan a directory for .md files (non-recursive). Returns array of { filename, filePath, modified }. */
function scanMdFiles(dir) {
  const results = [];
  try {
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) {
        const fp = path.join(dir, e.name);
        const content = fs.readFileSync(fp, 'utf8').trim();
        if (content) {
          const stat = fs.statSync(fp);
          results.push({ filename: e.name, filePath: fp, modified: stat.mtime.toISOString() });
        }
      }
    }
  } catch {}
  return results;
}

ipcMain.handle('get-memories', () => {
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);

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
        const projectPath = deriveProjectPath(folderPath, folder);
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
                const content = fs.readFileSync(fp, 'utf8').trim();
                if (content && !seenPaths.has(fp)) {
                  const stat = fs.statSync(fp);
                  files.push({ filename: name, filePath: fp, modified: stat.mtime.toISOString(), displayPath: shortName + '/', source: 'project' });
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
          projects.push({ folder, projectPath: projectPath || '', shortName, files });
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

  // Index all files for FTS
  try {
    deleteSearchType('memory');
    const allFiles = [
      ...globalFiles.map(f => ({ ...f, label: 'Global' })),
      ...projects.flatMap(p => p.files.map(f => ({ ...f, label: p.shortName }))),
    ];
    upsertSearchEntries(allFiles.map(f => ({
      id: f.filePath, type: 'memory', folder: null,
      title: f.label + ' ' + f.filename,
      body: fs.readFileSync(f.filePath, 'utf8'),
    })));
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
    return { ok: true };
  } catch (err) {
    console.error('Error saving memory file:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: search ---
ipcMain.handle('search', (_event, type, query, titleOnly) => {
  return searchByType(type, query, 50, !!titleOnly);
});

// --- IPC: settings ---
ipcMain.handle('get-setting', (_event, key) => {
  return getSetting(key);
});

ipcMain.handle('set-setting', (_event, key, value) => {
  setSetting(key, value);
  return { ok: true };
});

ipcMain.handle('delete-setting', (_event, key) => {
  deleteSetting(key);
  return { ok: true };
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

function attentionHooksEnabled() {
  const global = getSetting('global') || {};
  return global.attentionHooks === true;
}

function startAttentionHookServer() {
  if (attentionHookServer) return;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
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
        const signal = attentionSource.classifyAttentionSignal({ source: 'hook', payload: hook });
        if (sessionId && signal && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('attention-signal', {
            sessionId,
            kind: signal.kind,
            reason: signal.reason,
            source: 'hook',
          });
          log.info(`[attention-hook] session=${sessionId} kind=${signal.kind} reason="${signal.reason}"`);
        }
      } catch (err) {
        log.warn(`[attention-hook] bad payload: ${err.message}`);
      }
      // Empty decision object = no-op; never block or alter Claude's behavior.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  server.on('error', (err) => log.error(`[attention-hook] server error: ${err.message}`));
  server.listen(0, '127.0.0.1', () => {
    attentionHookPort = server.address().port;
    attentionHookServer = server;
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
  const url = `http://127.0.0.1:${port}${ATTENTION_HOOK_MARK}`;
  const settings = stripSwitchboardHooks(readClaudeSettings());
  if (!settings.hooks) settings.hooks = {};
  const addHook = (event, matcher) => {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    settings.hooks[event].push({ matcher: matcher || '', hooks: [{ type: 'http', url, timeout: 5 }] });
  };
  addHook('Notification', ''); // permission_prompt / idle_prompt / elicitation / …
  addHook('Stop', ''); // agent finished responding (matcher ignored for Stop)
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
};

ipcMain.handle('get-shell-profiles', () => {
  _shellProfiles = null; // refresh on each request
  return getShellProfiles();
});

ipcMain.handle('get-effective-settings', (_event, projectPath) => {
  const global = getSetting('global') || {};
  const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
  const effective = { ...SETTING_DEFAULTS };
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    if (global[key] !== undefined && global[key] !== null) {
      effective[key] = global[key];
    }
    if (project[key] !== undefined && project[key] !== null) {
      effective[key] = project[key];
    }
  }
  return effective;
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
  session.pty.kill();
  return { ok: true };
});

// --- IPC: toggle-star ---
ipcMain.handle('toggle-star', (_event, sessionId) => {
  const starred = toggleStar(sessionId);
  return { starred };
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
ipcMain.handle('read-session-jsonl', (_event, sessionId) => {
  const folder = getCachedFolder(sessionId);
  if (!folder) return { error: 'Session not found in cache' };
  const jsonlPath = path.join(PROJECTS_DIR, folder, sessionId + '.jsonl');
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const entries = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    return { entries };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('archive-session', (_event, sessionId, archived) => {
  const val = archived ? 1 : 0;
  setArchived(sessionId, val);
  return { archived: val };
});

// --- IPC: open-terminal ---
ipcMain.handle('open-terminal', async (_event, sessionId, projectPath, isNew, sessionOptions) => {
  if (!mainWindow) return { ok: false, error: 'no window' };

  // Reattach to existing session
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
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
  const effectiveProfileId = (() => {
    const global = getSetting('global') || {};
    const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
    let profileId = SETTING_DEFAULTS.shellProfile;
    if (global.shellProfile !== undefined && global.shellProfile !== null) profileId = global.shellProfile;
    if (project.shellProfile !== undefined && project.shellProfile !== null) profileId = project.shellProfile;
    return profileId;
  })();
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

  let ptyProcess;
  let mcpServer = null;
  try {
    if (isPlainTerminal) {
      // Plain terminal: interactive login shell, no claude command
      // Inject a shell function to override `claude` with a helpful message
      const claudeShim = 'claude() { echo "\\033[33mTo start a Claude session, use the + button in the sidebar.\\033[0m"; return 1; }; export -f claude 2>/dev/null;';
      ptyProcess = pty.spawn(shell, shellArgs(shell, undefined, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        env: {
          ...cleanPtyEnv,
          TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
          CLAUDECODE: '1',
          // ZDOTDIR trick won't work reliably; instead inject via ENV (sh/bash) or precmd
          ENV: claudeShim,
          BASH_ENV: claudeShim,
        },
      });
      // For zsh, ENV/BASH_ENV don't apply — write the function after shell starts
      setTimeout(() => {
        if (!ptyProcess._isDisposed) {
          try {
            ptyProcess.write(claudeShim + ' clear\n');
          } catch {}
        }
      }, 300);
    } else {
      // Build claude command, using array to prevent accidental shell injection
      const claudeArgs = [];
      if (sessionOptions?.forkFrom) {
        claudeArgs.push('--resume', String(sessionOptions.forkFrom), '--fork-session');
      } else if (isNew) {
        claudeArgs.push('--session-id', String(sessionId));
      } else {
        claudeArgs.push('--resume', String(sessionId));
      }

      if (sessionOptions) {
        if (sessionOptions.dangerouslySkipPermissions) {
          claudeArgs.push('--dangerously-skip-permissions');
        } else if (sessionOptions.permissionMode) {
          claudeArgs.push('--permission-mode', String(sessionOptions.permissionMode));
        }
        if (sessionOptions.worktree) {
          claudeArgs.push('--worktree');
          if (sessionOptions.worktreeName) {
            claudeArgs.push(String(sessionOptions.worktreeName));
          }
        }
        if (sessionOptions.chrome) {
          claudeArgs.push('--chrome');
        }
        if (sessionOptions.addDirs) {
          const dirs = String(sessionOptions.addDirs).split(',').map(d => d.trim()).filter(Boolean);
          for (const dir of dirs) {
            claudeArgs.push('--add-dir', dir);
          }
        }
      }

      if (sessionOptions?.appendSystemPrompt) {
        claudeArgs.push('--append-system-prompt', String(sessionOptions.appendSystemPrompt));
      }

      let claudeCmd = 'claude ' + quoteArgvForShell(shell, claudeArgs);

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

      const ptyEnv = {
        ...cleanPtyEnv,
        TERM: 'xterm-256color', COLORTERM: 'truecolor',
        TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
      };
      if (mcpServer) {
        ptyEnv.CLAUDE_CODE_SSE_PORT = String(mcpServer.port);
      }

      ptyProcess = pty.spawn(shell, shellArgs(shell, claudeCmd, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        // TERM_PROGRAM=iTerm.app: Claude Code checks this to decide whether to emit
        // OSC 9 notifications (e.g. "needs your attention"). Without it, the packaged
        // app's minimal Electron environment won't trigger those sequences.
        env: ptyEnv,
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
          log.debug(`[OSC 0] session=${currentId} char=U+${firstChar.charCodeAt(0).toString(16).toUpperCase()} busy=${isBusy} idle=${isIdle} wasBusy=${!!session._cliBusy}`);
          if (isBusy && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            log.debug(`[OSC 0] session=${currentId} → BUSY`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, true);
            }
          } else if (isIdle && session._cliBusy) {
            session._cliBusy = false;
            session._oscIdle = true;
            log.debug(`[OSC 0] session=${currentId} → IDLE`);
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
          if (level === '0') continue; // 4;0 is also used for clearing, making it unreliable as an idle signal
          log.debug(`[OSC 9;4] session=${currentId} level=${level} payload="${payload}" wasBusy=${!!session._cliBusy}`);
          if ((level === '1' || level === '2' || level === '3') && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            log.debug(`[OSC 9;4] session=${currentId} → BUSY`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, true);
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
      session.outputBuffer.push(data);
      session.outputBufferSize += data.length;
      while (session.outputBufferSize > MAX_BUFFER_SIZE && session.outputBuffer.length > 1) {
        session.outputBufferSize -= session.outputBuffer.shift().length;
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', currentId, data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.exited = true;
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
    session.pty.write(data);
  }
});

// --- IPC: terminal-resize (fire-and-forget) ---
ipcMain.on('terminal-resize', (_event, sessionId, cols, rows) => {
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    // For plain terminals, suppress buffering during resize to avoid
    // accumulating prompt redraws that pollute reattach replay
    if (session.isPlainTerminal) session._suppressBuffer = true;

    session.pty.resize(cols, rows);

    if (session.isPlainTerminal) {
      setTimeout(() => { session._suppressBuffer = false; }, 200);
    }

    // First resize: nudge to force TUI redraw on reattach (skip for plain terminals — causes duplicate prompts)
    if (session.firstResize && !session.isPlainTerminal) {
      session.firstResize = false;
      setTimeout(() => {
        try {
          session.pty.resize(cols + 1, rows);
          setTimeout(() => {
            try { session.pty.resize(cols, rows); } catch {}
          }, 50);
        } catch {}
      }, 50);
    }
  }
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
sessionTransitions.init({ PROJECTS_DIR, activeSessions, getMainWindow: () => mainWindow, log, rekeyMcpServer });
const { detectSessionTransitions } = sessionTransitions;

// --- fs.watch on projects directory ---
let projectsWatcher = null;

function startProjectsWatcher() {
  if (!fs.existsSync(PROJECTS_DIR)) return;

  const pendingFolders = new Set();
  let debounceTimer = null;

  function flushChanges() {
    debounceTimer = null;
    const folders = new Set(pendingFolders);
    pendingFolders.clear();

    let changed = false;
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
        pendingFolders.add(folder);
      } else if (basename.endsWith('.jsonl')) {
        pendingFolders.add(folder);
      } else {
        return;
      }

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushChanges, 500);
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

// --- IPC: auto-updater ---
ipcMain.handle('updater-check', () => {
  if (!autoUpdater) return { available: false, dev: true };
  return autoUpdater.checkForUpdates();
});
ipcMain.handle('updater-download', () => {
  if (!autoUpdater) return;
  return autoUpdater.downloadUpdate();
});
// Manual install for unsigned macOS builds: Squirrel.Mac won't apply an update
// without a Developer ID signature, so we swap the .app bundle ourselves. A
// detached script waits for this process to exit, replaces the bundle from the
// already-downloaded zip, clears quarantine, ad-hoc re-signs, and relaunches.
function installUpdateMac() {
  if (!pendingUpdateFilePath || !fs.existsSync(pendingUpdateFilePath)) {
    return { ok: false, error: 'No downloaded update is available yet.' };
  }
  // process.execPath: /Applications/Switchboard.app/Contents/MacOS/Switchboard
  const appBundle = path.resolve(process.execPath, '..', '..', '..');
  if (!appBundle.endsWith('.app')) {
    return { ok: false, error: 'Could not locate the application bundle to update.' };
  }

  const script = `#!/bin/bash
set -e
APP_PID="$1"
ZIP="$2"
APP_PATH="$3"
# Wait (up to ~30s) for Switchboard to fully exit before swapping the bundle.
for _ in $(seq 1 150); do
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 0.2
done
TMP="$(mktemp -d)"
/usr/bin/ditto -x -k "$ZIP" "$TMP"
NEW_APP="$(/usr/bin/find "$TMP" -maxdepth 1 -name '*.app' -print -quit)"
if [ -z "$NEW_APP" ]; then exit 1; fi
/bin/rm -rf "$APP_PATH"
/usr/bin/ditto "$NEW_APP" "$APP_PATH"
/usr/bin/xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true
/usr/bin/codesign --force --deep --sign - "$APP_PATH" 2>/dev/null || true
/bin/rm -rf "$TMP"
/usr/bin/open "$APP_PATH"
`;

  try {
    const scriptPath = path.join(os.tmpdir(), `switchboard-update-${Date.now()}.sh`);
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
    const { spawn } = require('child_process');
    const child = spawn('/bin/bash', [scriptPath, String(process.pid), pendingUpdateFilePath, appBundle], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    log.info(`[updater] manual macOS install scheduled for ${appBundle}`);
    setImmediate(() => app.quit());
    return { ok: true };
  } catch (e) {
    log.error('[updater] manual install failed:', e?.message || String(e));
    return { ok: false, error: e?.message || String(e) };
  }
}

ipcMain.handle('updater-install', () => {
  if (!autoUpdater) return { ok: false, dev: true };
  if (process.platform === 'darwin') return installUpdateMac();
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
});

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

      log.info(`[schedule] Running: ${shell} ${args.join(' ')}`);
      const child = cpSpawn(shell, args, {
        cwd,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...cleanPtyEnv, FORCE_COLOR: '0' },
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

    // Re-index search if FTS table was recreated (e.g. tokenizer config change)
    if (searchFtsRecreated) populateCacheViaWorker();

    // Check for updates after launch
    if (autoUpdater) {
      setTimeout(() => autoUpdater.checkForUpdates().catch(e => log.error('[updater] check failed:', e?.message || String(e))), 5000);
      // Re-check every 4 hours for long-running sessions
      setInterval(() => autoUpdater.checkForUpdates().catch(e => log.error('[updater] check failed:', e?.message || String(e))), 4 * 60 * 60 * 1000);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }); // end app.whenReady
} // end gotSingleInstanceLock else-branch

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
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
});

// Close SQLite after all windows are closed to avoid "connection is not open" errors
app.on('will-quit', () => {
  closeDb();
});
