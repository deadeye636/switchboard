const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { getFolderIndexMtimeMs } = require('./folder-index-state');
const { deriveProjectPath } = require('./derive-project-path');
const { readSessionFile, readSessionFileIncremental, enumerateSessionFiles, resolveJsonlPath, subagentSessionId } = require('./read-session-file');
const { encodeProjectPath } = require('./encode-project-path');

/**
 * Session cache module.
 * Call init(ctx) once with the shared context object.
 */
let PROJECTS_DIR, activeSessions, getMainWindow, log;
let deleteCachedFolder, getCachedByFolder, upsertCachedSessions, deleteCachedSession, replaceSessionMetrics;
let deleteSearchFolder, deleteSearchSession, upsertSearchEntries;
let setFolderMeta, getFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, getMeta, setName;
let getFavoritedProjects, getProjectDisplayNames, getAutoHiddenProjects;

function init(ctx) {
  PROJECTS_DIR = ctx.PROJECTS_DIR;
  activeSessions = ctx.activeSessions;
  getMainWindow = ctx.getMainWindow;
  log = ctx.log;
  // DB functions
  deleteCachedFolder = ctx.db.deleteCachedFolder;
  getCachedByFolder = ctx.db.getCachedByFolder;
  upsertCachedSessions = ctx.db.upsertCachedSessions;
  deleteCachedSession = ctx.db.deleteCachedSession;
  replaceSessionMetrics = ctx.db.replaceSessionMetrics;
  deleteSearchFolder = ctx.db.deleteSearchFolder;
  deleteSearchSession = ctx.db.deleteSearchSession;
  upsertSearchEntries = ctx.db.upsertSearchEntries;
  setFolderMeta = ctx.db.setFolderMeta;
  getFolderMeta = ctx.db.getFolderMeta;
  getAllFolderMeta = ctx.db.getAllFolderMeta;
  getAllMeta = ctx.db.getAllMeta;
  getAllCached = ctx.db.getAllCached;
  getSetting = ctx.db.getSetting;
  getMeta = ctx.db.getMeta;
  setName = ctx.db.setName;
  getFavoritedProjects = ctx.db.getFavoritedProjects;
  getProjectDisplayNames = ctx.db.getProjectDisplayNames;
  getAutoHiddenProjects = ctx.db.getAutoHiddenProjects;
}

// readSessionFile is imported from read-session-file.js (shared with worker)

/** Read one folder from filesystem by scanning .jsonl files directly */
function readFolderFromFilesystem(folder) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  const projectPath = deriveProjectPath(folderPath, folder);
  if (!projectPath) return { projectPath: null, sessions: [] };
  const sessions = [];

  for (const { filePath, parentSessionId } of enumerateSessionFiles(folderPath)) {
    const s = readSessionFile(filePath, folder, projectPath, { parentSessionId });
    if (s) sessions.push(s);
  }

  return { projectPath, sessions };
}

/** Refresh a single folder incrementally: only re-read changed/new .jsonl files */
// Resolve a folder's projectPath cheaply: reuse the last-derived path while its
// directory still exists, else derive from the JSONL heads (I/O). Shared by the
// folder- and file-level refresh paths.
function folderProjectPath(folder, folderPath) {
  const knownMeta = getFolderMeta ? getFolderMeta(folder) : null;
  if (knownMeta && knownMeta.projectPath && fs.existsSync(knownMeta.projectPath)) return knownMeta.projectPath;
  return deriveProjectPath(folderPath, folder);
}

function isHiddenProject(projectPath) {
  return ((getSetting('global') || {}).hiddenProjects || []).includes(projectPath);
}

// Title precedence: user rename (session_meta.name) > JSONL custom-title (Claude
// /title) > JSONL ai-title. AI titles must NEVER promote to session_meta.name or
// they'd overwrite the user's UI rename on the next index pass.
function sessionName(s) {
  return getMeta(s.sessionId)?.name || s.customTitle || s.aiTitle || '';
}

// The search-index row for a session (external-content FTS body = its text).
function buildSearchEntry(s) {
  const name = sessionName(s);
  return {
    id: s.sessionId, type: 'session', folder: s.folder,
    title: (name ? name + ' ' : '') + s.summary, body: s.textContent,
  };
}

// opts.indexMtimeMs — pre-computed getFolderIndexMtimeMs result. The reconcile
// sweep already scans every folder once for its change gate; passing that value
// in avoids a second readdir+stat pass per refreshed folder. Stamping the
// pre-refresh value is the safe direction: a file that changes mid-refresh just
// triggers one extra sweep next pass.
function refreshFolder(folder, opts = {}) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  if (!fs.existsSync(folderPath)) {
    deleteCachedFolder(folder);
    return;
  }
  const stampMtimeMs = () =>
    (opts.indexMtimeMs != null ? opts.indexMtimeMs : getFolderIndexMtimeMs(folderPath));

  // Reuse the previously-derived projectPath when its directory still exists.
  // deriveProjectPath reads session JSONL heads, and refreshFolder runs on
  // every watcher flush — deriving each time is wasted I/O on hot folders.
  // A vanished directory falls through to a fresh derive so the missing-
  // project remap detection keeps working.
  const projectPath = folderProjectPath(folder, folderPath);
  if (!projectPath) {
    setFolderMeta(folder, null, stampMtimeMs());
    return;
  }

  // Hidden/removed project: don't re-index its folder back into the cache. The
  // folder stays on disk after a "Remove", so the reconcile sweep would otherwise
  // re-add the very sessions the user just cleared (and churn the DB). Record the
  // current mtime so the sweep treats the folder as up-to-date and skips it until
  // it is un-hidden (unhideProject forces a fresh refresh).
  if (isHiddenProject(projectPath)) {
    setFolderMeta(folder, projectPath, stampMtimeMs());
    return;
  }

  // Get what's currently cached for this folder.
  // cachedMap: DB sessionId → { modified, filePath } so we can do mtime comparison
  // even for subagents whose DB sessionId differs from the on-disk filename.
  const cachedSessions = getCachedByFolder(folder);
  const cachedMap = new Map(); // DB sessionId → { modified, filePath }
  const cachedByFilePath = new Map(); // filePath → { dbId, entry } (reverse map for the per-file loop)
  for (const row of cachedSessions) {
    const entry = {
      modified: row.modified,
      filePath: resolveJsonlPath(PROJECTS_DIR, row),
    };
    cachedMap.set(row.sessionId, entry);
    cachedByFilePath.set(entry.filePath, { dbId: row.sessionId, entry });
  }

  const currentIds = new Set();
  let changed = false;

  // Collect all changes first, then batch DB writes to minimize lock duration
  const sessionsToUpsert = [];
  const searchEntriesToUpsert = [];
  const namesToSet = [];
  const sessionsToDelete = [];

  for (const { filePath, parentSessionId } of enumerateSessionFiles(folderPath)) {
    // Check if file mtime changed.
    // We need the DB sessionId to look up the cache, but we don't know it until after
    // readSessionFile — for subagents it's sub:<parent>:<agentId>. Use the file path
    // to find a matching cached entry instead.
    let fileMtime;
    try { fileMtime = fs.statSync(filePath).mtime.toISOString(); } catch { continue; }

    // Find cached entry by file path (handles both top-level and subagent IDs)
    const cachedHit = cachedByFilePath.get(filePath) || null;
    const cachedEntry = cachedHit ? cachedHit.entry : null;
    const cachedDbId = cachedHit ? cachedHit.dbId : null;

    if (cachedDbId !== null) currentIds.add(cachedDbId);

    if (cachedEntry && cachedEntry.modified === fileMtime) {
      continue; // unchanged, skip
    }

    // File is new or modified — re-read it. Drop any incremental per-file
    // state so the next watcher-driven refreshFile starts from this full read
    // (guards against rewritten files whose retained offset is now wrong).
    _fileReadState.delete(filePath);
    const s = readSessionFile(filePath, folder, projectPath, { parentSessionId });
    if (s) {
      currentIds.add(s.sessionId); // ensure we don't delete a newly-read subagent row
      sessionsToUpsert.push(s);
      // Per-(date,model) metrics only exist on the full-read path. The header-only
      // refresh branch above doesn't produce dailyMetrics, so this is the sole
      // write point for an incremental refresh — short transaction, fine to run
      // outside the upsert batch.
      replaceSessionMetrics(s.sessionId, s.dailyMetrics);
      searchEntriesToUpsert.push(buildSearchEntry(s));
      if (s.customTitle) namesToSet.push({ id: s.sessionId, name: s.customTitle });
    }
    changed = true;
  }

  // Remove sessions whose .jsonl files were deleted
  for (const sessionId of cachedMap.keys()) {
    if (!currentIds.has(sessionId)) {
      sessionsToDelete.push(sessionId);
      changed = true;
    }
  }

  // Batch all DB writes to reduce lock contention
  if (sessionsToUpsert.length > 0) {
    upsertCachedSessions(sessionsToUpsert);
  }
  for (const entry of searchEntriesToUpsert) {
    deleteSearchSession(entry.id);
  }
  if (searchEntriesToUpsert.length > 0) {
    upsertSearchEntries(searchEntriesToUpsert);
  }
  for (const { id, name } of namesToSet) {
    setName(id, name);
  }
  for (const sessionId of sessionsToDelete) {
    deleteCachedSession(sessionId);
    deleteSearchSession(sessionId);
  }

  // Update folder mtime
  setFolderMeta(folder, projectPath, stampMtimeMs());
}

// Debounced per-file re-index (perf #1 + #4 + review item B). Re-reading and
// re-indexing a transcript on *every* append is the dominant cost in the hot
// path — catastrophic for a 200 MB+ host session (full readFileSync per line),
// and the FTS re-tokenize is the single most expensive write. So a storm of
// appends is coalesced into ONE read+index per quiet window, capped by a
// max-wait so a continuously-appending session still refreshes at least every
// REINDEX_MAX_WAIT_MS. Session-cache metadata therefore lags by at most ~max-wait
// during a burst — invisible for a session that is by definition actively
// changing — and the throttled reconcile sweep stays as the safety net.
const _reindexTimers = new Map(); // key(filePath) -> { timer, firstAt, fn }
const REINDEX_DEBOUNCE_MS = 800;
const REINDEX_MAX_WAIT_MS = 3000;
function scheduleReindex(key, fn) {
  const now = Date.now();
  let e = _reindexTimers.get(key);
  if (!e) { e = { firstAt: now, timer: null, fn }; _reindexTimers.set(key, e); }
  else e.fn = fn;
  const waited = now - e.firstAt;
  const delay = Math.min(REINDEX_DEBOUNCE_MS, Math.max(0, REINDEX_MAX_WAIT_MS - waited));
  if (e.timer) clearTimeout(e.timer);
  e.timer = setTimeout(() => { _reindexTimers.delete(key); try { e.fn(); } catch {} }, delay);
  if (typeof e.timer.unref === 'function') e.timer.unref();
}
function cancelReindex(key) {
  const e = _reindexTimers.get(key);
  if (e && e.timer) clearTimeout(e.timer);
  _reindexTimers.delete(key);
}
// Run every pending re-index now — call before the process exits so the last
// edits inside a debounce window aren't lost (perf review item H).
function flushPendingReindex() {
  for (const [key, e] of [..._reindexTimers]) {
    if (e.timer) clearTimeout(e.timer);
    _reindexTimers.delete(key);
    try { e.fn(); } catch {}
  }
}

// Per-file incremental read state (perf #74): filePath → { offset, state,
// metrics } as returned by readSessionFileIncremental. Lets a watcher flush on
// a large live transcript read only the newly-appended bytes instead of the
// whole file. In-memory only — the first refresh after startup does one full
// read to seed it. Bounded so weeks of touched files can't grow unchecked;
// an evicted entry just costs one full re-read.
const _fileReadState = new Map();
const FILE_READ_STATE_MAX = 512;

// Incremental single-file refresh (perf #1). The projects watcher fires per
// changed .jsonl; re-indexing just that one file avoids re-enumerating +
// re-stating the whole folder and rebuilding its cached-row map on every append
// — the dominant per-flush cost when a busy multi-agent session has many
// subagent files. The throttled folder-level reconcileCacheFromFilesystem sweep
// stays as the safety net for anything a per-file pass misses (e.g. a delete
// event that never arrived).
//
// `relFilename` is the watcher's path relative to PROJECTS_DIR, e.g.
// "<folder>/<uuid>.jsonl" (top-level) or "<folder>/<uuid>/subagents/<f>.jsonl".
function refreshFile(folder, relFilename, opts = {}) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  const rel = relFilename.split(/[\\/]/).filter(Boolean);
  const inner = rel.slice(1); // path within the folder
  if (inner.length === 0) return;
  // Subagent transcripts live one or more levels below <folder>; their parent
  // session UUID is the first path segment inside the folder.
  const parentSessionId = inner.length >= 2 ? inner[0] : null;
  const filePath = path.join(PROJECTS_DIR, ...rel);

  const projectPath = folderProjectPath(folder, folderPath);
  if (!projectPath) return;
  // Hidden/removed project: don't re-index its folder back into the cache.
  if (isHiddenProject(projectPath)) {
    cancelReindex(filePath);
    setFolderMeta(folder, projectPath, getFolderIndexMtimeMs(folderPath));
    return;
  }

  if (!fs.existsSync(filePath)) {
    // Deleted file → drop its row immediately (deletes must not lag), stamping the
    // sessionId the same way readSessionFile does (top-level = filename; subagent
    // = sub:<parent>:<agentId>).
    cancelReindex(filePath);
    _fileReadState.delete(filePath);
    const base = path.basename(filePath, '.jsonl');
    let sessionId = base;
    if (parentSessionId) {
      const m = base.match(/^agent-(.+)$/);
      try { sessionId = subagentSessionId(parentSessionId, m ? m[1] : base); } catch { sessionId = null; }
    }
    if (sessionId) { deleteCachedSession(sessionId); deleteSearchSession(sessionId); }
    setFolderMeta(folder, projectPath, getFolderIndexMtimeMs(folderPath));
    return;
  }

  // Stamp the folder as indexed-as-of-now up front (cheap single-row write) so the
  // reconcile sweep doesn't jump in with a full-folder refresh while the heavy
  // read+FTS is still pending in the debounce window below.
  setFolderMeta(folder, projectPath, getFolderIndexMtimeMs(folderPath));

  const run = () => {
    // Incremental hot-path read (perf #74): reuse the retained parse state so
    // only the bytes appended since the last refresh are read. First touch (or
    // a rewritten/truncated file) falls back to a full read inside
    // readSessionFileIncremental.
    const prev = _fileReadState.get(filePath) || null;
    const res = readSessionFileIncremental(filePath, folder, projectPath, { parentSessionId }, prev);
    // null = file not yet a valid session (no first user turn) or became invalid.
    // Leave any existing row as-is; the reconcile sweep reconciles genuine losses.
    if (!res) {
      _fileReadState.delete(filePath);
      return;
    }
    _fileReadState.set(filePath, res.next);
    if (_fileReadState.size > FILE_READ_STATE_MAX) {
      // Evict the oldest-inserted entry; it just falls back to a full read.
      _fileReadState.delete(_fileReadState.keys().next().value);
    }
    const s = res.session;
    // Capture the effective name before writing so we can tell the renderer when a
    // rename (Claude /rename → JSONL custom-title, promoted via setName) actually
    // changed it. Without this notify, the deferred reindex writes the new name to
    // the DB but the sidebar keeps showing the old one until an unrelated refresh.
    const prevName = (getMeta(s.sessionId) || {}).name || null;
    upsertCachedSessions([s]);
    replaceSessionMetrics(s.sessionId, s.dailyMetrics);
    deleteSearchSession(s.sessionId);
    upsertSearchEntries([buildSearchEntry(s)]);
    if (s.customTitle) setName(s.sessionId, s.customTitle);
    const newName = (getMeta(s.sessionId) || {}).name || null;
    if (newName !== prevName) notifyRendererProjectsChanged();
  };

  // opts.immediate: skip the reindex debounce and run inline. Used by the Stop-hook
  // fast-path so a rename shows the instant the turn ends, not after both debounces.
  if (opts.immediate) {
    cancelReindex(filePath);
    run();
  } else {
    scheduleReindex(filePath, run);
  }
}

/**
 * Reconcile the cache with the filesystem.
 *
 * Re-indexes only folders that are new or whose newest .jsonl is newer than what
 * we last indexed — a cheap, stat-only gate when nothing changed. This is what
 * keeps sessions from silently going missing: a project folder that changed while
 * the app was closed, or that predates the build which first indexed it, is
 * otherwise never picked up, because the cold-start full scan
 * (populateCacheViaWorker) only runs when the cache is completely empty.
 *
 * Rate-limited: the live watcher (startProjectsWatcher) catches real-time
 * changes, so this safety-net sweep only needs to run occasionally. The
 * throttle skips the redundant double-call per sidebar paint (each
 * get-projects triggers loadProjects twice).
 */
const RECONCILE_THROTTLE_MS = 5000;
let lastReconcileAt = 0;

function reconcileCacheFromFilesystem() {
  const now = Date.now();
  if (now - lastReconcileAt < RECONCILE_THROTTLE_MS) return;
  lastReconcileAt = now;
  try {
    const metaMap = getAllFolderMeta();
    const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .map(d => d.name);

    for (const folder of folders) {
      const meta = metaMap.get(folder);
      const folderPath = path.join(PROJECTS_DIR, folder);
      // One readdir+stat pass per folder per sweep: the gate value is handed to
      // refreshFolder for its final stamp instead of being recomputed there.
      const indexMtimeMs = getFolderIndexMtimeMs(folderPath);
      if (!meta || indexMtimeMs > (meta.indexMtimeMs || 0)) {
        refreshFolder(folder, { indexMtimeMs });
      }
    }
  } catch (err) {
    console.error('Error reconciling cache:', err);
  }
}

/** Build projects response from cached data */
function buildProjectsFromCache(showArchived) {
  const metaMap = getAllMeta();
  const cachedRows = getAllCached();
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);

  // Group by projectPath, not on-disk folder name. Multiple ~/.claude/projects/<folder>/
  // directories can resolve to the same projectPath (Claude Code's folder-name encoding
  // scheme has changed over time, leaving legacy stragglers around), so we merge them into
  // a single sidebar group to avoid duplicate-id collisions in the morphdom render.
  // Only insert a project entry once we have a session that survives the archive filter —
  // otherwise folders whose sessions are all archived would appear in the sidebar as
  // undismissable phantom entries.
  const projectMap = new Map();
  // Track the newest session activity per projectPath across ALL cached rows
  // (archived included). Used to sort a project whose only sessions are archived
  // — it becomes an empty placeholder below, but should still rank by its last
  // real activity instead of being lumped with never-used empty folders.
  const lastActivityByPath = new Map();
  for (const row of cachedRows) {
    if (!row.projectPath) continue;
    if (hiddenProjects.has(row.projectPath)) continue;
    if (row.modified) {
      const prev = lastActivityByPath.get(row.projectPath);
      if (!prev || row.modified > prev) lastActivityByPath.set(row.projectPath, row.modified);
    }
    const meta = metaMap.get(row.sessionId);
    const s = {
      sessionId: row.sessionId,
      summary: row.summary,
      firstPrompt: row.firstPrompt,
      created: row.created,
      modified: row.modified,
      messageCount: row.messageCount,
      userMessageCount: row.userMessageCount || 0,
      inputTokens: row.inputTokens || 0,
      outputTokens: row.outputTokens || 0,
      cacheCreationTokens: row.cacheCreationTokens || 0,
      cacheReadTokens: row.cacheReadTokens || 0,
      largestUserPromptWords: row.largestUserPromptWords || 0,
      startedAt: row.startedAt || null,
      lastEntryAt: row.lastEntryAt || null,
      activeMinutes: row.activeMinutes || 0,
      projectPath: row.projectPath,
      slug: row.slug || null,
      aiTitle: row.aiTitle || null,
      parentSessionId: row.parentSessionId || null,
      agentId: row.agentId || null,
      subagentType: row.subagentType || null,
      description: row.description || null,
      name: meta?.name || null,
      starred: meta?.starred || 0,
      archived: meta?.archived || 0,
    };
    if (!showArchived && s.archived) continue;
    if (!projectMap.has(row.projectPath)) {
      projectMap.set(row.projectPath, {
        folder: encodeProjectPath(row.projectPath),
        projectPath: row.projectPath,
        missing: !fs.existsSync(row.projectPath),
        sessions: [],
      });
    }
    projectMap.get(row.projectPath).sessions.push(s);
  }

  // Include empty project directories (no sessions yet). Resolve folder→projectPath
  // through cache_meta (populated by the indexer) instead of re-reading a JSONL off
  // disk for every directory on every render. Fall back to deriveProjectPath only
  // for folders the indexer hasn't seen yet, and backfill cache_meta so subsequent
  // renders are pure DB reads.
  try {
    const folderMeta = getAllFolderMeta();
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git');
    for (const d of dirs) {
      let projectPath = folderMeta.get(d.name)?.projectPath;
      if (!projectPath) {
        projectPath = deriveProjectPath(path.join(PROJECTS_DIR, d.name), d.name);
        if (projectPath) setFolderMeta(d.name, projectPath, 0);
      }
      if (!projectPath) continue;
      if (hiddenProjects.has(projectPath)) continue;
      if (!projectMap.has(projectPath)) {
        projectMap.set(projectPath, {
          folder: encodeProjectPath(projectPath),
          projectPath,
          missing: !fs.existsSync(projectPath),
          sessions: [],
          // null for genuinely never-used folders; an ISO date when the folder's
          // sessions exist but are all archived (so it sorts by real recency).
          lastActivity: lastActivityByPath.get(projectPath) || null,
        });
      }
    }
  } catch {}

  // Inject active plain terminal sessions so they participate in sorting
  for (const [sessionId, session] of activeSessions) {
    if (session.exited || !session.isPlainTerminal) continue;
    if (!session.projectPath) continue;
    if (hiddenProjects.has(session.projectPath)) continue;
    if (!projectMap.has(session.projectPath)) {
      projectMap.set(session.projectPath, {
        folder: encodeProjectPath(session.projectPath),
        projectPath: session.projectPath,
        sessions: [],
      });
    }
    const proj = projectMap.get(session.projectPath);
    if (!proj.sessions.some(s => s.sessionId === sessionId)) {
      proj.sessions.push({
        sessionId, summary: 'Terminal', firstPrompt: '', projectPath: session.projectPath,
        name: null, starred: 0, archived: 0, messageCount: 0,
        modified: new Date(session._openedAt).toISOString(),
        created: new Date(session._openedAt).toISOString(),
        type: 'terminal',
      });
    }
  }

  const favorited = typeof getFavoritedProjects === 'function' ? getFavoritedProjects() : new Set();
  const displayNames = typeof getProjectDisplayNames === 'function' ? getProjectDisplayNames() : new Map();

  const projects = [];
  for (const proj of projectMap.values()) {
    proj.sessions.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    proj.favorited = favorited.has(proj.projectPath);
    proj.displayName = displayNames.get(proj.projectPath) || '';
    projects.push(proj);
  }

  projects.sort((a, b) => {
    // Favorited projects go to the top (before any other ordering).
    if (a.favorited && !b.favorited) return -1;
    if (!a.favorited && b.favorited) return 1;
    // Missing projects go to the bottom
    if (a.missing && !b.missing) return 1;
    if (!a.missing && b.missing) return -1;
    // Effective recency: a live session's timestamp, or (for a project whose
    // sessions are all archived) its last-known activity. Only projects with no
    // recency at all — genuinely never-used empty folders — sink to the bottom.
    const aDate = a.sessions[0]?.modified || a.lastActivity || '';
    const bDate = b.sessions[0]?.modified || b.lastActivity || '';
    if (!aDate && bDate) return 1;
    if (!bDate && aDate) return -1;
    return new Date(bDate) - new Date(aDate);
  });

  // Manual project mode (projectAutoAdd === false): only show projects on the
  // explicit allowlist (addedProjects), so newly-discovered ~/.claude/projects
  // folders (e.g. from Claude sessions started outside Switchboard) don't appear.
  // The allowlist is seeded with the current set when the user switches to manual
  // (see the set-project-auto-add IPC); a missing/invalid list falls back to
  // showing everything so we never blank the sidebar unexpectedly.
  if (global.projectAutoAdd === false && Array.isArray(global.addedProjects)) {
    const added = new Set(global.addedProjects);
    return projects.filter(p => added.has(p.projectPath));
  }

  return projects;
}


// Aggregate view of ALL projects for the Projects-admin tab (#32). Unlike
// buildProjectsFromCache this does NOT drop hidden projects and does NOT apply the
// manual-mode allowlist filter — the admin UI needs to see (and act on) everything.
// Returns lightweight rows (counts only, no per-session objects). Trust + ~/.claude.json
// extra meta are layered on by the main-process IPC.
function buildProjectsAdmin() {
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);
  const favorited = typeof getFavoritedProjects === 'function' ? getFavoritedProjects() : new Set();
  const displayNames = typeof getProjectDisplayNames === 'function' ? getProjectDisplayNames() : new Map();
  const autoHiddenSet = typeof getAutoHiddenProjects === 'function' ? getAutoHiddenProjects() : new Set();

  const map = new Map(); // projectPath -> { sessionCount, lastActivity }
  const ensure = (projectPath) => {
    if (!map.has(projectPath)) map.set(projectPath, { sessionCount: 0, lastActivity: null });
    return map.get(projectPath);
  };

  for (const row of getAllCached()) {
    if (!row.projectPath) continue;
    const e = ensure(row.projectPath);
    e.sessionCount++;
    const mod = row.modified || null;
    if (mod && (!e.lastActivity || new Date(mod) > new Date(e.lastActivity))) e.lastActivity = mod;
  }

  // Include empty project directories (no sessions yet), like buildProjectsFromCache.
  try {
    const folderMeta = getAllFolderMeta();
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git');
    for (const d of dirs) {
      let projectPath = folderMeta.get(d.name)?.projectPath;
      if (!projectPath) {
        projectPath = deriveProjectPath(path.join(PROJECTS_DIR, d.name), d.name);
        if (projectPath) setFolderMeta(d.name, projectPath, 0);
      }
      if (projectPath) ensure(projectPath);
    }
  } catch {}

  const rows = [];
  for (const [projectPath, e] of map) {
    rows.push({
      projectPath,
      folder: encodeProjectPath(projectPath),
      displayName: displayNames.get(projectPath) || '',
      sessionCount: e.sessionCount,
      lastActivity: e.lastActivity,
      missing: !fs.existsSync(projectPath),
      hidden: hiddenProjects.has(projectPath),
      autoHidden: autoHiddenSet.has(projectPath),
      favorite: favorited.has(projectPath),
    });
  }
  return rows;
}


// Pure predicate for #57 auto-hide — kept dependency-free so it's unit-testable
// without Electron. `effectiveActivityMs` is max(newest session activity,
// autoHideResetAt) for the project; auto-hide fires only when the feature is on
// (days > 0) and the project has been inactive for longer than `days`.
function shouldAutoHide(effectiveActivityMs, nowMs, days) {
  if (!(days > 0)) return false;
  return (nowMs - effectiveActivityMs) > days * 86400000;
}

function notifyRendererProjectsChanged() {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('projects-changed');
  }
}

function sendStatus(text, type) {
  if (text) log.info(`[status] (${type || 'info'}) ${text}`);
  const mw = getMainWindow();
  if (mw && !mw.isDestroyed()) {
    mw.webContents.send('status-update', text, type || 'info');
  }
}

// --- Worker-based cache population ---
// Returns a Promise that resolves when the in-flight scan finishes. Concurrent
// callers share the same Promise so the first get-projects after a migration
// can await it instead of seeing an empty list.
let populatePromise = null;

function populateCacheViaWorker() {
  if (populatePromise) return populatePromise;
  sendStatus('Scanning projects\u2026', 'active');

  populatePromise = new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      populatePromise = null;
      resolve();
    };

  const worker = new Worker(path.join(__dirname, 'workers', 'scan-projects.js'), {
    workerData: { projectsDir: PROJECTS_DIR },
  });

  worker.on('message', (msg) => {
    // Progress updates from worker
    if (msg.type === 'progress') {
      sendStatus(msg.text, 'active');
      return;
    }

    if (!msg.ok) {
      console.error('Worker scan error:', msg.error);
      sendStatus('Scan failed: ' + msg.error, 'error');
      settle();
      return;
    }

    sendStatus(`Indexing ${msg.results.length} projects\u2026`, 'active');

    // Write results to DB on main thread (fast)
    let sessionCount = 0;
    for (const { folder, projectPath, sessions, indexMtimeMs } of msg.results) {
      deleteCachedFolder(folder);
      deleteSearchFolder(folder);
      if (sessions.length > 0) {
        sessionCount += sessions.length;
        upsertCachedSessions(sessions);
        for (const s of sessions) {
          // Only JSONL custom-title (genuine user title) promotes to the DB name column.
          // AI titles must not — see refreshFolder for the rationale.
          if (s.customTitle) setName(s.sessionId, s.customTitle);
          // Worker called readSessionFile, so dailyMetrics is present.
          replaceSessionMetrics(s.sessionId, s.dailyMetrics);
        }
        upsertSearchEntries(sessions.map(s => {
          // Search title precedence matches the sidebar: user rename > custom-title > ai-title.
          const name = getMeta(s.sessionId)?.name || s.customTitle || s.aiTitle || '';
          return {
            id: s.sessionId, type: 'session', folder: s.folder,
            title: (name ? name + ' ' : '') + s.summary,
            body: s.textContent,
          };
        }));
      }
      setFolderMeta(folder, projectPath, indexMtimeMs);
    }

    sendStatus(`Indexed ${sessionCount} sessions across ${msg.results.length} projects`, 'done');
    // Clear status after a few seconds
    setTimeout(() => sendStatus(''), 5000);
    notifyRendererProjectsChanged();
    settle();
  });

  worker.on('error', (err) => {
    console.error('Worker error:', err);
    sendStatus('Worker error: ' + err.message, 'error');
    settle();
  });

  // If the worker exits abnormally (SIGSEGV, OOM, uncaught exception) without
  // sending a message, neither the 'message' nor 'error' handler will fire.
  // Resolve here so awaiters aren't stuck forever and the next call can retry.
  worker.on('exit', (code) => {
    if (!settled && code !== 0) {
      sendStatus('Scan worker exited unexpectedly', 'error');
    }
    settle();
  });
  });

  // Return the in-flight promise so first callers can await/chain on scan
  // completion (the two `await populateCacheViaWorker()` sites, and the #57
  // startup auto-hide pass). Without this the first caller got `undefined`.
  return populatePromise;
}

module.exports = {
  init,
  readSessionFile,
  readFolderFromFilesystem,
  refreshFolder,
  refreshFile,
  flushPendingReindex,
  reconcileCacheFromFilesystem,
  buildProjectsFromCache,
  buildProjectsAdmin,
  shouldAutoHide,
  notifyRendererProjectsChanged,
  sendStatus,
  populateCacheViaWorker,
};
