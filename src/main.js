const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, session, shell } = require('electron');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const log = require('electron-log');
// getFolderIndexMtimeMs moved to session-cache.js
const { shouldNoticeMissingRecord, missingRecordMessage } = require('./app/terminal/live-record-notice');
const { startMcpServer, shutdownMcpServer, shutdownAll: shutdownAllMcp, resolvePendingDiff, rekeyMcpServer, cleanStaleLockFiles } = require('./servers/mcp-bridge');
const { withMainProcessUsageCache } = require('./backends/usage-cache');
// Multi-LLM backend seam (Phase 1): the spawn/env/id-map paths ask a backend instead of
// assuming Claude. `claude` is the default backend and behaves byte-identically through it.
const backends = require('./backends');
const sessionBackends = require('./session/session-backends');
const profiles = require('./backends/profiles');
// Every spawn path goes through resolveSpawnEnv() below — an unresolved $VAR is dropped AND said (#169).
const { resolveEnvRefs, missingRefsMessage } = require('./backends/env-refs');
// The PATH/PATHEXT walk lives with the file store, which is where every backend's availability probe
// already asks for it (#240). Not backend-specific — it names no backend and knows no store.
const { findOnPath } = require('./backends/file-store');
// Tier-3 custom launchers (T-3.10): the entry shape + cascade live in one module shared with the
// renderer; main only re-validates what the renderer hands it before spawning.
const { normalizeLauncher } = require('./shared/custom-launchers');
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

// …and its own userData, for the same reason (#216). Separating only the DB left the two sharing
// %APPDATA%/switchboard, which meant Chromium fought itself over one cache directory (a steady stream of
// "Unable to move the cache: Access is denied" in the log you read while diagnosing) — and, less cosmetically,
// a dev insert wrote its secret-ref temp files into the INSTALLED app's directory, since getSecretRefDir()
// hangs off userData. Everything under userData moves with this: the caches, secret-refs, window state, and
// electron-log's main.log (see docs/logging paths — a dev build's log lives under the dev userData).
// Must run before anything reads the path.
if (!app.isPackaged && !process.env.SWITCHBOARD_USER_DATA) {
  app.setPath('userData', path.join(os.homedir(), '.switchboard-dev', 'userData'));
} else if (process.env.SWITCHBOARD_USER_DATA) {
  app.setPath('userData', process.env.SWITCHBOARD_USER_DATA);
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
const { discoverShellProfiles, getShellProfiles, invalidateShellProfiles, resolveShell, isWindows, isWslShell, shellArgs, ptyShellArgs, quoteArgvForShell } = require('./app/terminal/shell-profiles');
const { startScheduler } = require('./servers/schedule-runner');
const { encodeProjectPath } = require('./session/encode-project-path');



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
  deleteCachedSession, deleteCachedFolder, setSessionLineage, replaceSessionMetrics,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting, listSettings,
  listSavedVariables, listAllSavedVariables, getSavedVariable, saveSavedVariable, deleteSavedVariable, touchSavedVariable,
  getDailyMetrics, getDailyModelTokens, getModelUsage, getTotalCounts,
  getDailyBackendTokens, getDailyCost, getHourlyActivity,
  closeDb,
  DB_PATH,
} = require('./db/db');

// Re-apply the saved log level now that settings are readable (#121).
try { applyLogLevel(getSetting('global')?.logLevel); } catch { /* first run: defaults stand */ }


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
const { createSearchWorkerClient } = require('./index/search-worker-client');

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

// SWITCHBOARD_STORE_CLAUDE isolates the Claude session scan at an alternate projects dir (demo/sandbox
// — scripts/demo-start.js), so a dev/demo run never scans the real ~/.claude/projects. Flows to the
// claude descriptor via setRoots([PROJECTS_DIR]) below and to the index worker (msg.roots).
const PROJECTS_DIR = process.env.SWITCHBOARD_STORE_CLAUDE || path.join(os.homedir(), '.claude', 'projects');
// The Plans/Memory/Work-Files tabs (and their ~/.claude paths) moved to src/app/plans-memory.js (#227),
// where WHERE a backend keeps plans + instruction files is a declared descriptor capability, not a
// hardcoded Claude path in the core. The dead get-stats handler + its stats-cache.json path went too.
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

// (getIndexedProjectRoots + isAllowedMemoryPath moved to src/app/plans-memory.js with the memory
// handlers — #227. The allowlist is now sourced from the register + each backend's declared home dirs.)

// Active PTY sessions
const activeSessions = new Map();
let mainWindow = null;

// Subagent live-tail watchers (watchId → { filePath, parentSessionId, agentId })
const subagentWatchers = new Map();
let subagentWatcherSeq = 0;

// --- Windows: main + settings window, the menu, the close guard, UI zoom (#34) -> app/windows.js ---
// getSetting/setSetting go in through ctx because windows.js must not top-level-require db.js — that
// would resolve DATA_DIR before main.js has set it (see :81-85).
const windows = require('./app/windows');
windows.init({
  getMainWindow: () => mainWindow,
  setMainWindow: (win) => { mainWindow = win; },
  getAppQuitting: () => appQuitting,
  getSetting,
  setSetting,
  activeSessions,
  subagentWatchers,
  stopSubagentSweep: () => sessionTransitions.stopSubagentSweep(),
});
windows.registerIpc(ipcMain);
const { createWindow, buildMenu, broadcastSettingsChanged } = windows;


// --- Native notifications, dock/taskbar badge, and tray (Spec 01) -> app/notifications.js ---
const notifications = require('./app/notifications');
notifications.init({ getMainWindow: () => mainWindow, log });
notifications.registerIpc(ipcMain);
const focusMainWindow = notifications.focusMainWindow;

// --- Session cache helpers ---

const { deriveProjectPath } = require('./session/derive-project-path');

// Session cache → session-cache.js
const sessionCache = require('./index/session-cache');
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
const { readSessionFile, readFolderFromFilesystem, refreshFolder,
        buildProjectsFromCache, buildProjectsAdmin, shouldAutoHide, notifyRendererProjectsChanged, sendStatus,
        populateCacheViaWorker } = sessionCache;
// Only the parser version is Claude's to read here. The transcript PATH goes through the descriptor's
// transcriptPathFor (#211/#233) — a direct resolveJsonlPath import is how the subagent handlers came to
// resolve every backend's row inside Claude's store.
const { PARSER_SCHEMA_VERSION: CLAUDE_PARSER_VERSION } = require('./backends/claude/session-reader');

// #199 — the off-thread index worker is the ONE runtime path. The SWITCHBOARD_INDEX_WORKER flag and the
// inline parse orchestration it used to gate were removed once the worker was validated in a live install
// (commit 6605aef is the pre-worker fallback in git history). The worker is spawned once and every
// reconcile / file / rebuild request is posted to it instead of parsing on the UI thread; the reply is
// applied on main through the one neutral sink. One parser (the worker), one writer (main).
const indexWorker = require('./index/index-worker-client');
indexWorker.init({
  PROJECTS_DIR,
  log,
  db: { getAllCached, getAllFolderMeta, setFolderMeta },
  isAppQuitting: () => appQuitting,
  // The post-sweep upkeep main owns — the same three steps that used to run after the inline sweep.
  // syncRegistry + applyAutoHide run every sweep (cheap, idempotent); the projects-changed push is gated on
  // `changed` so a sweep that moved nothing does not notify (#208 — the Axis-B watcher fires this on every
  // store change; a busy Codex/Hermes append that the gate skips must not push at the 600 ms watcher cadence).
  afterReconcile: (changed = true) => {
    try { projects.syncRegistry(); } catch (err) { log.warn('[registry] sync failed:', err?.message || err); }
    try { projects.applyAutoHide(); } catch (err) { log.warn('[auto-hide] failed:', err?.message || err); }
    if (changed) notifyRendererProjectsChanged();
  },
  // A per-file apply (watcher hot path) pushes projects-changed so the sidebar learns of a new/updated
  // session; it rides each file reply (coalesced in the client).
  onFileApplied: () => notifyRendererProjectsChanged(),
});

// Renderer-reachable status for verifying the off-thread path is live (#199). DevTools console:
//   await window.api.indexWorkerStatus()   ->  { alive: true, pending: <n> }
// `alive` is whether the worker thread is currently spawned; `pending` the in-flight request count.
ipcMain.handle('index-worker-status', () => indexWorker.status());

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
const projects = require('./projects/projects');

// (visibleProjectPaths + the Plans/Memory/Work-Files handlers moved to src/app/plans-memory.js — #227.)

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
    // Note each explicitly-deleted id into the worker's delete-epoch guard first, so an in-flight reconcile
    // reply can't reverse-resurrect a session removeProject/deleteProjectSessions just deleted.
    deleteCachedSession: (id) => { try { indexWorker.noteDeleted(id); } catch {} return deleteCachedSession(id); },
    deleteSearchSession,
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

// Plans, Memory and Work-Files tabs (#227) — the 9 handlers that used to live here, now behind the
// descriptor's plansDir/memorySources so the core hardcodes no ~/.claude path. Wired before
// save-file-for-panel below, which invalidates its FTS signature after a panel write.
const plansMemory = require('./app/plans-memory');
plansMemory.init({
  backends,
  activeSessions,
  log,
  db: { getProjectStates, getProjectDisplayNames, getAllFolderMeta, deleteSearchType, upsertSearchEntries },
});
plansMemory.registerIpc(ipcMain);

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
          // Stamp the delete-epoch so an in-flight worker reply can't reverse-resurrect this id.
          indexWorker.noteDeleted(row.sessionId);
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
const { mimeForExt: previewMimeForExt } = require('./shared/preview-kind');
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
    if (resolved.includes('/.work-files/') || resolved.includes('\\.work-files\\')) plansMemory.invalidateFtsSignature('work-file');
    if (resolved.endsWith('.md')) plansMemory.invalidateFtsSignature('memory');
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
    try { require('./session/derive-project-path')._resetRootCache(); } catch { /* best effort */ }
    // The worker keeps its OWN _rootCache; a rebuild must clear it there too or it keeps stale roots (F4).
    try { indexWorker.postRootCacheReset(); } catch { /* best effort */ }
    await populateCacheViaWorker();
    markClaudeParserRead();
    // A rebuild must cover EVERY backend's roots, not just Claude's (T-2.7 + T-4.2) — otherwise
    // "Rebuild session cache" would silently drop the user's Codex/other-backend history. And it must
    // FORCE the re-read: the reason to rebuild is that a row is wrong, and a wrong row's change marker
    // matches just fine, so the normal (marker-gated) sweep would skip exactly the rows to repair. The
    // force re-read is an async worker round-trip covering Claude + every backend.
    try { await indexWorker.postReconcile({ force: true }); } catch (err) { log.warn('[rebuild] worker force reconcile failed:', err?.message || err); }
    return { ok: true };
  } catch (err) {
    console.error('Error rebuilding cache:', err);
    return { ok: false, error: err.message };
  }
});

// #199 step 3: the index-repair sweep, coalesced and OFF the get-projects response path.
//
// reconcile (Claude store) + backend sweep (Codex/etc.) + syncRegistry + applyAutoHide used to run
// inline on every get-projects, blocking the sidebar paint. They now run here, once per burst of
// sidebar refreshes: get-projects returns the cached view immediately and calls queueIndexSweep(),
// which defers the work to the next tick and drops duplicate requests while one is pending. When the
// sweep actually changes the cache it pushes 'projects-changed', so the renderer re-fetches and the
// view converges — the paint simply never waits on the repair work.
//
// This still runs on the main thread (moving the parse off-thread is #199 step 5); the win is that the
// RESPONSE no longer waits, and after step 2 the reconcile is incremental and cheap.
let indexSweepQueued = false;
function queueIndexSweep() {
  if (indexSweepQueued) return;
  indexSweepQueued = true;
  setImmediate(() => {
    indexSweepQueued = false;
    if (appQuitting) return;
    // The whole reconcile + backend sweep runs off-thread. postReconcile applies the reply on the main
    // thread and then runs syncRegistry + applyAutoHide + notify itself (the `afterReconcile` hook wired
    // at init) — nothing to fold in here: the push happens inside the apply. postReconcile also coalesces
    // a burst of these into one in-flight + one trailing sweep.
    indexWorker.postReconcile();
  });
}

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

    // #199 step 3: the response is now a PURE cache read. The repair/upkeep work that used to run on the
    // MAIN thread on every get-projects (sidebar refresh / tab switch / refresh click) — reconcile the
    // Claude store, sweep the other backends' stores, register newly-seen projects, apply auto-hide —
    // was the 2-5 s stall that froze xterm input mid-paint. It is now taken OFF the response path:
    // queueIndexSweep() runs it just after this returns (coalesced), and it announces via the existing
    // 'projects-changed' push when it actually moves the cache, so the sidebar still converges — it just
    // no longer waits on repair work to paint.
    const built = buildProjectsFromCache(showArchived);
    queueIndexSweep();
    return built;
  } catch (err) {
    console.error('Error listing projects:', err);
    return [];
  }
});

// (get-plans/read-plan/save-plan moved to src/app/plans-memory.js — #227. The dead get-stats
// handler + its stats-cache.json path were removed with them.)
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

// --- IPC: refresh-stats (fetch usage + build stats from DB; /stats PTY removed) ---
ipcMain.handle('refresh-stats', async (_event, backendId) => {
  try {
    // /stats PTY call removed — heatmap is now sourced from session_cache via
    // get-stats-from-db. Only usage is fetched here (rate-limits panel).
    const usage = await collectUsage().catch(() => ({ backends: [] }));

    // Build stats from DB (same as get-stats-from-db) so the caller gets both
    // at once and the renderer can update heatmap + usage in a single round-trip.
    let stats = null;
    try {
      stats = buildStatsFromDb(backendId);
    } catch (dbErr) {
      log.error('Error building stats from DB in refresh-stats:', dbErr);
    }

    return { stats, usage: usage || { backends: [] } };
  } catch (err) {
    log.error('Error refreshing stats:', err);
    return { stats: null, usage: { backends: [] } };
  }
});

// --- IPC: get-usage (#191) ---
//
// One segment per backend that CAN report a quota and IS switched on. The "and is switched on" half is
// the part that used to be missing: this handler called Claude's fetch unconditionally, so a user who
// disabled Claude and ran only Codex still had the app reading Claude's OAuth credentials and calling
// Anthropic's usage endpoint on a timer — for a backend they had turned off. Claude is not exempt from
// being disabled (#162), so that was not hypothetical.
//
// No backend id appears here. A backend that can report usage says so on its descriptor; everything
// below derives from that, which is what lets Antigravity arrive later as a folder and nothing else.
async function collectUsage() {
  const capable = backends.list().filter(b => b.enabled && b.usage && typeof b.usage.fetch === 'function');
  if (capable.length === 0) return { backends: [] };

  const results = await Promise.all(capable.map(async (b) => {
    const cacheKey = `usage:lastSuccessful:${b.id}`;
    const cached = getSetting(cacheKey);
    let usage;
    try {
      usage = await b.usage.fetch() || {};
    } catch (err) {
      log.error(`[usage] ${b.id} fetch threw`, err?.message || String(err));
      usage = { backendId: b.id, _error: true, message: err.message };
    }
    // Identity comes from the descriptor, not from the backend's own module — one place decides what a
    // backend is called and what badge it wears, and the usage module cannot disagree with the sidebar.
    usage.backendId = b.id;
    usage.label = b.label;
    usage.icon = b.icon || null;
    usage.monogram = b.monogram || null;
    usage.live = !!b.usage.live;

    const result = withMainProcessUsageCache(usage, cached);
    if (result.cacheValue) {
      try { setSetting(cacheKey, result.cacheValue); }
      catch (err) { log.warn(`[usage] ${b.id}: failed to persist cache`, err?.message || String(err)); }
      log.info(`[usage] ${b.id}: fresh`, { buckets: (usage.buckets || []).length });
    } else if (result.fromCache) {
      log.warn(`[usage] ${b.id}: serving cached`, { reason: result.response._staleMessage, cachedAt: result.response._cachedAt });
    } else if (usage._error || usage._rateLimited) {
      log.warn(`[usage] ${b.id}: unavailable`, { error: usage.message, rateLimited: !!usage._rateLimited });
    }
    return result.response;
  }));

  return { backends: results };
}

ipcMain.handle('get-usage', async () => {
  try {
    return await collectUsage();
  } catch (err) {
    log.error('Error fetching usage:', err);
    return { backends: [] };
  }
});

// (FTS dirty-flag block + get-memories/read-memory/save-memory + get-work-files/read-work-file/
// delete-work-file moved to src/app/plans-memory.js — #227.)
// --- IPC: search ---
// Routed through the search-query worker so that slow FTS5 phrase queries
// (e.g. a 60-char pasted URL) do not block the Electron main event loop.
// The renderer already awaits window.api.search(...) — this change is transparent.
ipcMain.handle('search', (_event, type, query, titleOnly) => {
  return searchViaWorker(type, query, titleOnly);
});

// --- Settings: the blob, the per-option cascade (#149), export/import (#145) -> app/settings.js ---
// persistSettingsBlob is the trust boundary — the ONE door to disk, so the secret scrub and the backend
// re-arm cannot be walked around. The DB and the two file dialogs go in through ctx, which is what keeps
// the module requirable: its guards used to be scraped out of THIS file's source text and run through
// `new Function`, because main.js needs Electron.
const settings = require('./app/settings');
settings.init({
  db: { getSetting, setSetting, deleteSetting, listSettings, getProjectStates, setProjectState },
  dialog,
  getParentWindow: (sender) => BrowserWindow.fromWebContents(sender) || mainWindow,
  broadcastSettingsChanged: () => broadcastSettingsChanged(),
  startBackendWatchers: () => startBackendWatchers(),
  indexWorker,
  notifyRendererProjectsChanged: () => notifyRendererProjectsChanged(),
  log,
});
settings.registerIpc(ipcMain);
const { effectiveSettings, migrateClaudeLaunchDefaults, SETTING_DEFAULTS } = settings;


// --- Saved variables + secret materialization (spec 12) -> app/variables.js ---
// The secret paths are the trust boundary and they live in the module: plaintext never reaches the
// terminal input, the shell family comes from the SESSION, and every failure unlinks what it wrote.
// safeStorage, userData and the DB go in through ctx so the module needs no electron and no db.js
// require of its own (db.js resolves DATA_DIR at module load — see :81-85).
const variables = require('./app/variables');
variables.init({
  activeSessions,
  getSetting,
  getSecretRefDir,
  safeStorage,
  db: { listSavedVariables, listAllSavedVariables, getSavedVariable, saveSavedVariable, deleteSavedVariable, touchSavedVariable },
  log,
});
variables.registerIpc(ipcMain);
const { cleanupSecretRefsForSession, cleanupSecretRefs } = variables;

// The secret-ref temp files hang off userData, which a dev build keeps separate from the installed
// app's (#216) — so this is resolved per call, never captured.
function getSecretRefDir() {
  return path.join(app.getPath('userData'), 'secret-refs');
}

// --- Shell resolution helpers (the terminal + spawn paths) ---
// Map a resolved shell path to the coarse family we build references for.
function classifyShellType(shellPath) {
  if (isWslShell(shellPath)) return 'unknown'; // temp file is a Windows path WSL can't cat directly
  const base = path.basename(shellPath || '').toLowerCase();
  if (base.includes('powershell') || base.includes('pwsh')) return 'pwsh';
  if (base === 'cmd.exe' || base === 'cmd') return 'cmd';
  if (base.includes('bash') || base.includes('zsh') || base === 'sh' || base === 'dash' || base === 'ksh') return 'bash';
  return 'unknown';
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

  // One PATH walk, one PATHEXT list — findOnPath owns both (#240). It answers "where is it"; the
  // shim check below is this function's own question, and the reason it cannot just return that path.
  const found = findOnPath(command);
  if (!found) return null;
  return directlyExecutable(found) ? found : null;   // a `.cmd` shim -> use the shell instead
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


// --- Claude Code hook → attention ingest (spec 05) -> app/hooks.js ---
// The loopback server's token check (#77) is the trust boundary; it lives in the module, which stays
// Electron-free so `node --test` can drive it. getSetting comes in through ctx, not a require: db.js
// resolves DATA_DIR at module load (see :81-85).
const hooks = require('./app/hooks');
// #223: which terminal cleared which session. State only — the hook ingest fills it, the transition
// detector reads it, and neither owns it.
const clearClaims = require('./session/clear-claims');
hooks.init({
  getMainWindow: () => mainWindow,
  getSetting,
  activeSessions,
  indexWorker,
  log,
  // Dev builds do not touch the user's shared ~/.claude/settings.json unless opted in (#219).
  isPackaged: app.isPackaged,
});
hooks.registerIpc(ipcMain);
const { startAttentionHookServer, removeClaudeAttentionHook, attentionHooksEnabled } = hooks;

// Renderer saved a new log level — apply it live, no restart (#121).
ipcMain.handle('set-log-level', (_event, level) => {
  const resolved = applyLogLevel(level);
  log.info(`[log] level set to ${resolved}`);
  return { ok: true, level: resolved };
});

// --- Scheduled tasks ---
const scheduleIpc = require('./servers/schedule-ipc');


ipcMain.handle('get-shell-profiles', () => {
  invalidateShellProfiles(); // drop the module-private cache so newly installed shells appear without a restart
  return getShellProfiles();
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
    // Which CLI ran the referenced session (#202) — the backlink shows its badge. Already on the cached
    // row; only passed through here. Null for a bookmark whose session is not (or no longer) cached.
    const backendId = cached ? (cached.backendId || 'claude') : null;
    return { ...b, projectPath, sessionName, projectDisplayName, backendId };
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
    // Which CLI ran the referenced session (#202) — see enrichBookmarks.
    const backendId = cached ? (cached.backendId || 'claude') : null;
    return { ...t, sessionName, projectDisplayName, backendId };
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
      id: b.id, label: b.label, description: b.description || null, tier: b.tier, axis: b.axis, status: b.status,
      enabled: !!b.enabled, isProfile: !!b.isProfile, icon: b.icon || null,
      monogram: b.monogram || null, colour: b.colour || null, configFields: b.configFields || [],
      // Is the binary actually installed? Settings shows the reason instead of letting the user enable
      // a backend whose first launch then dies with a raw shell error.
      available: b.available !== false, unavailableReason: b.unavailableReason || null,
      // Can this backend fork a session? The sidebar hides the Fork button when it cannot — offering
      // it launches an unrelated empty session, which is worse than not offering it.
      supportsFork: b.supportsFork === true || (!!b.isProfile),
      // Does this backend have subagents (#230)? The renderer gates the subagent sidebar settings on it —
      // like usage/integrations above, the DECLARATION has to cross IPC or the gate is always false.
      supportsSubagents: b.supportsSubagents === true,
      // A standing gotcha the user cannot see from inside the app (Pi: a stored OAuth login silently
      // beats an injected key). Rendered on the backend's settings page.
      caveat: b.caveat || null,
      // How long this CLI needs before it can accept input at all (Hermes: ~12s of Python imports).
      // The handoff seeding path waits it out instead of pasting into a process that cannot hear it.
      seedGraceMs: Number(b.seedGraceMs) || 0,
      // Can this backend report a quota, and is that figure live (#191)? The DECLARATION crosses IPC;
      // the fetch stays in main. Settings offers a status-bar checkbox only for backends that say yes —
      // Hermes and Pi have no quota at all, so they never get a control that could never show a value.
      usage: b.usage ? { live: !!b.usage.live } : null,
      // Backend-owned extras that are not launch options (#212) — Claude's attention hook patches its
      // own settings.json, so it belongs to Claude and not to a generic app section. The DECLARATION
      // crosses IPC, exactly like `usage` above: the settings panel renders what is declared and names
      // no backend. A backend without integrations sends null and gets no section.
      integrations: b.integrations || null,
      // Which env-var family this CLI reads its endpoint from (#212), or null. The profile editor shows
      // its Endpoint fields only for a base that declares one — it used to ask whether the id was
      // `claude`. A TEMPLATE always sends null: `profileToDescriptor` builds an explicit field list and
      // does not carry this (nor `integrations`, nor `description`). That is fine and not an oversight —
      // the editor asks the BASE, off the built-ins, never the template's own descriptor.
      endpointEnv: b.endpointEnv || null,
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

  // An Axis-A profile runs the same binary into the same store, so it reads like Claude. Only an
  // Axis-B backend owns a store of its own.
  const backendId = row.backendId || 'claude';
  const b = backends.get(backendId);

  // A backend whose transcript is NOT a plain text file EXPORTS its messages instead of being read as
  // JSONL — Hermes (a DB with no file) and agy (a binary SQLite/protobuf `.db`). This must come BEFORE
  // the `filePath` branch: agy's `.db` IS a discovered file, so reading it as JSONL yields garbage, and
  // handing that path to a fresh agent (handoff) hands over a binary blob. Backend-neutral — keyed on
  // `transcriptAccess`, no hardcoded id. Without it the viewer and the handoff pre-fill (#148) break.
  if (((b && b.transcriptAccess) || 'file') !== 'file' && typeof b.readMessages === 'function') {
    try {
      return { entries: b.readMessages(sessionId) || [] };
    } catch (err) {
      return { error: err.message };
    }
  }

  // Claude's transcripts live at PROJECTS_DIR/<folder>/<id>.jsonl; another file backend records its own
  // absolute path (v11) — reconstructing Claude's layout for it would read the wrong file.
  if (row.filePath) return readJsonlEntries(row.filePath);

  // An Axis-B backend with its own store but no file and no exporter: say so, don't ENOENT at the user.
  if (b && b.axis === 'B') {
    return { error: `${b.label || backendId} keeps this session in its own store, not in a transcript file — there is nothing to show here.` };
  }
  const folder = row.folder || getCachedFolder(sessionId);
  if (!folder) return { error: 'Session not found in cache' };
  return readJsonlEntries(path.join(PROJECTS_DIR, folder, sessionId + '.jsonl'));
});

// A subagent row's transcript, resolved through its BACKEND (#233) — the same way read-session-jsonl
// resolves a top-level one. Both subagent handlers used to call Claude's resolveJsonlPath directly, which
// was harmless only because Claude is the sole backend declaring supportsSubagents (#230): the first
// other one would have resolved to a path under Claude's store. `transcriptPathFor` (#211) is the hook
// that answers this, and Claude's reconstructs from folder + parent id + agent id exactly as before.
const { resolveSubagentFile: resolveSubagentFileWith } = require('./session/subagent-transcript');
const resolveSubagentFile = (parentSessionId, agentId) =>
  resolveSubagentFileWith({ backends, getCachedSession }, parentSessionId, agentId);

ipcMain.handle('read-subagent-jsonl', async (_event, parentSessionId, agentId) => {
  const resolved = resolveSubagentFile(parentSessionId, agentId);
  if (resolved.error) return { error: resolved.error };
  return readJsonlEntries(resolved.filePath);
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
  const resolved = resolveSubagentFile(parentSessionId, agentId);
  if (resolved.error) return { error: resolved.error };
  const filePath = resolved.filePath;

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



// --- Terminal I/O: input, resize, redraw, flow control (#74), detach -> app/terminal/io.js ---
const terminalIo = require('./app/terminal/io');
terminalIo.init({ activeSessions, log });
terminalIo.registerIpc(ipcMain);


// Session transitions → session-transitions.js
const sessionTransitions = require('./session/session-transitions');
sessionTransitions.init({ PROJECTS_DIR, activeSessions, getMainWindow: () => mainWindow, log, rekeyMcpServer, rekeySessionBackend: sessionBackends.rekeySession,
  // #235: which backend spawned a live session — the launch overlay is what knows, so the subagent
  // dispatch asks it instead of reading a field an activeSessions entry never carries.
  getSessionBackend: (id) => sessionBackends.get(id),
  // #223: the clear claim a backend reported for one of this folder's live terminals, and the way to
  // consume it once it has been paired with a child.
  getClearClaim: (opts) => clearClaims.resolveSingleClaim(opts),
  releaseClearClaim: (tag) => clearClaims.releaseClaim(tag),
  // #193: persist a /clear child's provenance the moment the re-key resolves it (the scanner can't).
  recordLineage: (childId, folder, parentId) => setSessionLineage(childId, folder, parentId, 'clear') });
// Point the Claude backend's file-mode discovery at the app's actual projects dir (may differ from
// ~/.claude/projects when CLAUDE_DIR is overridden). The scanner adopts discoverSessions() in T-4.2.
try { require('./backends/claude').setRoots([PROJECTS_DIR]); } catch {}
// Give the registry access to user state (T-2.1): the `backendEnabled.<id>` flags + defaultLaunchTarget
// live in the global settings blob, user Axis-A profiles in profiles.json. backends.list() then returns
// built-ins ∪ profiles with their merged enabled flags.
backends.init({ getGlobalSettings: () => getSetting('global') || {}, profiles });
const { detectSessionTransitions } = sessionTransitions;

// Set once quit begins so a still-pending debounced flush (or a late worker
// message) doesn't touch the DB after closeDb() — "The database connection is
// not open" on quit (#90).
let appQuitting = false;

// Transcripts we exported for a "let the new session read the old one" handoff. Temp files: they exist
// so another agent can read them once, and they do not outlive the app.
const handoffExports = new Set();
// --- Watching: Claude's projects dir, the other backends' stores, identity adoption -> src/watch/ ---
// appQuitting stays HERE (13 readers, across windows, spawn, the cache ctx and the lifecycle) and the
// modules take a getter — never the value: a captured false lets a late flush touch the DB after
// closeDb() (#90). liveStoreRef/liveBusy are the opposite case: `const` Maps, so the reference is passed
// straight through and main's PTY exit handler deletes from the very Maps adopt.js maintains.
const watchAdopt = require('./watch/adopt');
const watchProjects = require('./watch/projects');
const watchStores = require('./watch/stores');

watchAdopt.init({
  activeSessions,
  getMainWindow: () => mainWindow,
  backends,
  sessionBackends,
  log,
});
watchProjects.init({
  projectsDir: PROJECTS_DIR,
  getAppQuitting: () => appQuitting,
  indexWorker,
  detectSessionTransitions,
  log,
});
watchStores.init({
  backends,
  getAppQuitting: () => appQuitting,
  indexWorker,
  log,
});

// The PTY exit handler drops a dead session's claim from these; nothing else in main touches them.
const { liveStoreRef, liveBusy } = watchAdopt;
const { startProjectsWatcher, stopProjectsWatcher } = watchProjects;
const { startBackendWatchers, stopBackendWatchers } = watchStores;

// This wiring sits HERE, after watch/adopt.js has been destructured, and not up at the handler it
// registers: init() PASSES liveStoreRef/liveBusy, so it reads them at call time. Placed earlier it
// throws "Cannot access 'liveStoreRef' before initialization" and the app comes up with no window.
// Registration order does not matter to Electron — a handler only runs when the renderer calls it.
// --- The spawn: open-terminal -> app/terminal/spawn.js ---
// The crossroads of the nine: it mutates watch/adopt.js's live maps on exit, calls variables.js's secret
// cleanup, asks settings.js for the cascade. Everything main.js still owns goes in as a reference or a
// getter — never a captured value.
const spawn = require('./app/terminal/spawn');
spawn.init({
  getMainWindow: () => mainWindow,
  getAppQuitting: () => appQuitting,
  activeSessions,
  liveStoreRef,
  liveBusy,
  cleanPtyEnv,
  projectsDir: PROJECTS_DIR,
  backends,
  sessionBackends,
  getSetting,
  effectiveSettings,
  attentionHooksEnabled,
  classifyShellType,
  resolveArgvExecutable,
  resolveTerminalShellProfileId,
  resolveLauncherCwd,
  composeLauncherCommand,
  resolveSpawnEnv,
  getCachedSession,
  cleanupSecretRefsForSession,
  ensureProjectAdded: (p) => projects.ensureProjectAdded(p),
  startMcpServer,
  shutdownMcpServer,
  // #223 live re-binding: where a backend may put its per-spawn binding file (userData — never the
  // user's own CLI config), the URL its hook posts to, and the way to forget a dead terminal's claim.
  bindingDir: path.join(app.getPath('userData'), 'clear-bindings'),
  clearBindUrl: hooks.clearBindUrl,
  forgetClearClaims: (tag) => clearClaims.forgetTag(tag),
  log,
});
spawn.registerIpc(ipcMain);


// --- IPC: app version ---
ipcMain.handle('get-app-version', () => app.getVersion());

// Build provenance (branch @ short-hash), stamped at build time by
// scripts/gen-build-info.js into build-info.json (bundled). Falls back to a live
// git read in dev, then to "unknown". Cached — read once.
let _buildInfo;
function readBuildInfo() {
  if (_buildInfo) return _buildInfo;
  try {
    _buildInfo = require('../build-info.json');
  } catch {
    try {
      const { execFileSync } = require('child_process');
      const g = (a) => execFileSync('git', a, { encoding: 'utf8', cwd: path.join(__dirname, '..') }).trim();
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

// --- App lifecycle -> app/lifecycle.js ---
// The composition root's last act: hand the module everything the boot and the teardown need. The
// teardown ORDER is load-bearing (appQuitting first, then flush, then terminate, then closeDb) and lives
// in the module with the reasons; main.js only supplies the pieces.
const lifecycle = require('./app/lifecycle');

const lifecycleCtx = {
  app,
  session,
  BrowserWindow,
  getMainWindow: () => mainWindow,
  setAppQuitting: (v) => { appQuitting = v; },
  activeSessions,
  cleanPtyEnv,
  log,
  // boot
  cleanupSecretRefs,
  migrateClaudeLaunchDefaults,
  buildMenu,
  createWindow,
  createTray: () => notifications.createTray(),
  startProjectsWatcher,
  startBackendWatchers,
  startAttentionHookServer,
  cleanStaleLockFiles,
  scheduleIpc,
  startScheduler,
  populateCacheViaWorker,
  applyAutoHide: (onStartup) => projects.applyAutoHide(onStartup),
  startTriggerWatcher: (opts) => require('./watch/trigger-watcher').start(opts),
  searchFtsRecreated: () => searchFtsRecreated,
  // the scheduler's runner
  getSetting,
  SETTING_DEFAULTS,
  resolveShell,
  backends,
  ensureProjectAdded: (p) => projects.ensureProjectAdded(p),
  quoteArgvForShell,
  shellArgs,
  spawnChild: (cmd, args, opts) => require('child_process').spawn(cmd, args, opts),
  // teardown
  attentionHooksEnabled,
  removeClaudeAttentionHook,
  cleanupHandoffExports: () => {
    for (const file of handoffExports) {
      try { fs.unlinkSync(file); } catch { /* best effort */ }
    }
    handoffExports.clear();
  },
  shutdownAllMcp,
  destroyTray: () => notifications.destroyTray(),
  stopProjectsWatcher,
  stopBackendWatchers,
  flushSessionBackends: () => sessionBackends.flushNow(),
  flushPendingReindex: () => sessionCache.flushPendingReindex(),
  terminateScanWorker: () => sessionCache.terminateScanWorker(),
  terminateIndexWorker: () => indexWorker.terminate(),
  shutdownSearchClient: () => searchClient.shutdown(),
  closeDb,
};

lifecycle.start(lifecycleCtx);
lifecycle.registerQuitHandlers(lifecycleCtx);
