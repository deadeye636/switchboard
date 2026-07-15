const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { getFolderIndexMtimeMs } = require('./folder-index-state');
const { deriveProjectPath, resolveWorktreePath } = require('./derive-project-path');
const { encodeProjectPath } = require('./encode-project-path');
const backends = require('./backends');
// Claude's format readers are reached THROUGH its descriptor (#188), not by importing the format
// modules directly — the same route codex/pi already take. The registry is fully seeded by the time
// require('./backends') returns, so `get('claude')` is safe at module load.
const claude = backends.get('claude');
const CLAUDE_PARSER_VERSION = claude.PARSER_SCHEMA_VERSION;
const sessionBackends = require('./session-backends');
const registry = require('./project-registry');
const { startTimer } = require('./perf');

/**
 * Session cache module.
 * Call init(ctx) once with the shared context object.
 */
let PROJECTS_DIR, activeSessions, getMainWindow, log;
let deleteCachedFolder, getCachedByFolder, upsertCachedSessions, deleteCachedSession, replaceSessionMetrics;
let deleteSearchFolder, deleteSearchSession, upsertSearchEntries;
let setFolderMeta, getFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, getMeta, setName;
let getFavoritedProjects, getProjectDisplayNames, getAutoHiddenProjects;
let getProjectMeta, getProjectStates;

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
  getProjectMeta = ctx.db.getProjectMeta;
  getProjectStates = ctx.db.getProjectStates;
}

// --- backend provenance + scoping (multi-LLM T-4.2) ---
//
// The cache is no longer Claude-only, but the FOLDER key is still shared: a session groups into a
// project by its cwd (§5.9), and the folder key is encodeProjectPath(cwd) whatever produced it. So a
// Codex rollout in D:\Projekte\demo lands in the SAME folder bucket as the Claude session there.
//
// Consequence: every folder-wide read/delete below must be scoped to the store being refreshed, or
// the Claude sweep would delete the Codex rows in "its" folder (they have no file under
// ~/.claude/projects, so the vanished-file reconcile would sweep them away) — and the Codex sweep
// would do the same in reverse. Two disjoint scopes:
//   CLAUDE store  = claude + every Axis-A profile (a profile shares Claude's binary AND its store)
//   Axis-B stores = codex (later gemini/hermes/pi) — each has its own root
// Expressed as { except: [axis-B ids] } so a newly-created Axis-A profile is automatically inside
// Claude's scope without the scanner needing the profile list.

let _foreignIds = null;
function foreignBackendIds() {
  if (_foreignIds) return _foreignIds;
  try {
    // Axis-B backends own their session store. `planned` ones never have rows, but listing them is
    // harmless and keeps the scope stable when a phase flips one to `ready`.
    _foreignIds = backends.list().filter(b => b.axis === 'B').map(b => b.id);
  } catch {
    _foreignIds = ['codex'];
  }
  return _foreignIds;
}

/** The scope of the Claude/Axis-A store: everything that is NOT an Axis-B backend's own row. */
function claudeStoreScope() {
  return { except: foreignBackendIds() };
}

/**
 * Is Claude switched on? (#162)
 *
 * Claude's store is walked by a path of its own (PROJECTS_DIR), not by `refreshBackendSessions`, and that
 * path never consulted the enable gate — so "disabling Claude" left it happily indexing. Every other
 * backend stops being scanned when it is switched off; Claude does now too.
 *
 * Fails OPEN. If the registry cannot answer (a unit test with no backends.init, a settings read that
 * throws), scanning is the safe direction: a missed scan is a stale sidebar, while a wrongly-skipped one
 * would look like the user's sessions had vanished.
 */
function claudeEnabled() {
  try { return backends.isLaunchable('claude') !== false; } catch { return true; }
}

// The launch-time overlay (session-backends.json) is the ONLY way to tell an Axis-A profile session
// from a plain Claude one — they share the binary, the root and the format (§5.7). Root-derivation
// only distinguishes Axis-B. So: for a session discovered under Claude's root, the overlay wins;
// with no overlay entry it is plain `claude`.
//
// backendId is left UNDEFINED (not 'claude') when there is no overlay entry: db.js COALESCEs a NULL
// against the stored value, so a row that already carries a profile id is never downgraded when the
// overlay's FIFO has since evicted its entry. The row is authoritative once written.
function overlayFor(sessionId, parentSessionId) {
  try {
    const own = sessionBackends.get(sessionId);
    if (own) return own;
    // A subagent transcript has no overlay entry of its own — it belongs to its parent's backend.
    if (parentSessionId) return sessionBackends.get(parentSessionId);
  } catch { /* no overlay available (e.g. unit test without electron userData) */ }
  return null;
}

/** Stamp a Claude-root session row with its authoritative backendId before it is written (§5.7). */
function stampClaudeProvenance(s) {
  const ov = overlayFor(s.sessionId, s.parentSessionId);
  if (ov && ov.backendId) {
    s.backendId = ov.backendId;
    if (ov.profileId) s.profileId = ov.profileId;
  }
  // Which parser produced this row (#152). The skip gate above compares it to the parser we have now.
  s.parserVersion = CLAUDE_PARSER_VERSION;
  return s;
}

/** After the row is written the overlay entry may finally be FIFO-evicted (§5.7). */
function markPersisted(sessionId) {
  try { sessionBackends.markPersisted(sessionId); } catch {}
}

/** The absolute session file behind a cached row: stored path (non-Claude) or the Claude reconstruction. */
function resolveRowFilePath(row) {
  if (row && row.filePath) return row.filePath;
  return claude.resolveJsonlPath(PROJECTS_DIR, row);
}

// Claude's readers come off its descriptor (claude.*), shared with the scan worker via the same module.

/** Read one folder from filesystem by scanning .jsonl files directly */
function readFolderFromFilesystem(folder) {
  const { projectPath, sessions } = claude.readFolderSessions(PROJECTS_DIR, folder);
  return { projectPath, sessions };
}

/** Refresh a single folder incrementally: only re-read changed/new .jsonl files */
// Resolve a folder's projectPath cheaply: reuse the last-derived path while its
// directory still exists, else derive from the JSONL heads (I/O). Shared by the
// folder- and file-level refresh paths.
function folderProjectPath(folder, folderPath) {
  const knownMeta = getFolderMeta ? getFolderMeta(folder) : null;
  if (knownMeta && knownMeta.projectPath && fs.existsSync(knownMeta.projectPath)) return knownMeta.projectPath;
  return deriveProjectPath(folderPath);
}

/**
 * Don't index this project back in — it was REMOVED (#167).
 *
 * This used to ask "is it hidden", because hiding and removing were the same act. They are not: a hidden
 * project is still ON the list and only unseen, so its sessions go on being indexed and unhiding shows
 * them at once. A REMOVED project is off the list and its rows were purged — re-indexing them would put
 * it back into search and undo half the removal.
 *
 * A single-row lookup by primary key, called per session in the scan loop. (The predicate it replaces
 * parsed the whole global settings blob on every call.)
 */
/**
 * What the STORES hold, for projects the cache cannot speak for: projectPath -> the newest session seen.
 *
 * A REMOVED project is deliberately not indexed, so its rows are gone while its transcripts are not. Two
 * things then depend on this map, and both would be wrong without it (#167):
 *
 *   - The tombstone sweep may only forget a removal once no session for that path is left ANYWHERE. Ask
 *     the cache and it says "none" by construction — the sweep would drop the tombstone, and the next
 *     scan would resurrect the project off the very transcripts the removal was meant to forget.
 *   - A NEW session in a removed project has to bring it back. That is the entire difference between
 *     "removed" and "banned". Ask the cache and it never even hears about it.
 */
const storeProjectPaths = new Map();
function noteStoreProject(projectPath, at) {
  if (!projectPath) return;
  const prev = storeProjectPaths.get(projectPath) || null;
  storeProjectPaths.set(projectPath, at && (!prev || at > prev) ? at : prev);
}
function getStoreProjectPaths() {
  return storeProjectPaths;
}

/** The newest `modified` in a batch of parsed sessions — what a removed project is judged by. */
function newestSessionAt(sessions) {
  let newest = null;
  for (const s of sessions || []) {
    const at = s.lastEntryAt || s.modified || null;
    if (at && (!newest || at > newest)) newest = at;
  }
  return newest;
}

function isRemovedProject(projectPath) {
  try {
    const m = getProjectMeta(projectPath);
    return !!(m && m.removedAt && !m.registered);
  } catch {
    return false;
  }
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
  // Claude answers to the enable gate like every other backend now (#162). Its store used to be walked
  // unconditionally — `refreshBackendSessions` deliberately skips Claude ("shares Claude's store"), and
  // THIS path never asked whether Claude was enabled at all. So a disabled Claude kept indexing, which
  // is not what disabling a backend means anywhere else in the app.
  //
  // "Disable is not delete" (§5.8) still holds: the cached rows stay, so the sessions remain visible and
  // searchable. They are simply not re-read, and nothing new appears.
  if (!claudeEnabled()) return;

  const folderPath = path.join(PROJECTS_DIR, folder);
  // Scope EVERY folder-wide read/delete below to Claude's store: an Axis-B backend (Codex) can hold
  // rows under the same folder key (same cwd -> same project -> same encodeProjectPath key), and its
  // sessions live outside ~/.claude/projects. An unscoped sweep here would delete them.
  const scope = claudeStoreScope();
  if (!fs.existsSync(folderPath)) {
    deleteCachedFolder(folder, scope);
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

  // REMOVED project: don't index its folder back into the cache. The store folder stays on disk after a
  // Remove, so the reconcile sweep would otherwise re-add the very sessions the user just cleared (and
  // churn the DB). Record the current mtime so the sweep treats the folder as up to date and skips it
  // until the project is registered again — which forces a fresh refresh.
  //
  // A HIDDEN project is indexed as normal: it is still on the list, only unseen (#167).
  if (isRemovedProject(projectPath)) {
    // What the folder holds, and how recent it is, still has to be REPORTED — the sweep must not forget a
    // removal while its transcripts are there, and a session NEWER than the removal has to bring the
    // project back. Skipping the folder in silence would make "removed" mean "banned for good".
    const newestMs = getFolderIndexMtimeMs(folderPath);
    noteStoreProject(projectPath, newestMs ? new Date(newestMs).toISOString() : null);
    setFolderMeta(folder, projectPath, stampMtimeMs());
    return;
  }

  // Get what's currently cached for this folder.
  // cachedMap: DB sessionId → { modified, filePath } so we can do mtime comparison
  // even for subagents whose DB sessionId differs from the on-disk filename.
  const cachedSessions = getCachedByFolder(folder, scope);
  const cachedMap = new Map(); // DB sessionId → { modified, filePath }
  const cachedByFilePath = new Map(); // filePath → { dbId, entry } (reverse map for the per-file loop)
  for (const row of cachedSessions) {
    const entry = {
      modified: row.modified,
      filePath: resolveRowFilePath(row),
      parserVersion: row.parserVersion,   // #152 — the skip gate needs it, not just the mtime
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

  for (const { filePath, parentSessionId } of claude.enumerateSessionFiles(folderPath)) {
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

    // The staleness gate. An unchanged file is skipped — UNLESS the parser that wrote the cached row is
    // not the parser that would read it now (#152). A parser change does not touch the file's mtime, so
    // without this half a schema change lands in an empty table and stays there: exactly how the Stats
    // charts came to be silently Claude-only-and-stale until someone found the Rebuild button.
    if (cachedEntry && cachedEntry.modified === fileMtime && cachedEntry.parserVersion === CLAUDE_PARSER_VERSION) {
      continue; // unchanged, and read by the parser we still have
    }

    // File is new or modified — re-read it. Drop any incremental per-file
    // state so the next watcher-driven refreshFile starts from this full read
    // (guards against rewritten files whose retained offset is now wrong).
    _fileReadState.delete(filePath);
    const s = claude.readSessionFile(filePath, folder, projectPath, { parentSessionId });
    if (s) {
      currentIds.add(s.sessionId); // ensure we don't delete a newly-read subagent row
      sessionsToUpsert.push(stampClaudeProvenance(s));
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
    // The row now carries the authoritative backendId, so the overlay entry may be evicted (§5.7).
    for (const s of sessionsToUpsert) markPersisted(s.sessionId);
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

// The same retained-parse-state memo, for the Axis-B file backends (#194). Their generic scan/watcher
// flush (refreshBackendSessions) used to full-parse every CHANGED file — a busy Codex/Pi session was
// re-read from byte 0 on every append, though its descriptor exposes `parseSessionIncremental`. Keyed by
// file path → the backend's opaque `parseState`; disjoint from `_fileReadState` (Claude's store never
// shares a path with a Codex/Pi store). Bounded the same way; an evicted entry just costs one full
// re-read, and the parser drops a state whose parser version moved or whose file shrank.
const _axisBReadState = new Map();

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
  if (!claudeEnabled()) return;   // #162 — a disabled backend is not watched, Claude included
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
  // REMOVED project: don't index its folder back into the cache (a hidden one still is — #167).
  if (isRemovedProject(projectPath)) {
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
      try { sessionId = claude.subagentSessionId(parentSessionId, m ? m[1] : base); } catch { sessionId = null; }
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
    const tRead = startTimer();
    const res = claude.readSessionFileIncremental(filePath, folder, projectPath, { parentSessionId }, prev);
    const readMs = tRead();
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
    const tUpsert = startTimer();
    upsertCachedSessions([stampClaudeProvenance(s)]);
    markPersisted(s.sessionId);
    const upsertMs = tUpsert();
    const tMetrics = startTimer();
    replaceSessionMetrics(s.sessionId, s.dailyMetrics);
    const metricsMs = tMetrics();
    // FTS is delete + full-document reinsert: buildSearchEntry(s) rebuilds the search
    // body from the WHOLE session, so this block grows with the session — the prime
    // suspect for the main-thread stall on high-output sessions (#199).
    const tFts = startTimer();
    deleteSearchSession(s.sessionId);
    upsertSearchEntries([buildSearchEntry(s)]);
    const ftsMs = tFts();
    if (s.customTitle) setName(s.sessionId, s.customTitle);
    const newName = (getMeta(s.sessionId) || {}).name || null;
    if (newName !== prevName) notifyRendererProjectsChanged();
    // #199: one line only when this refresh actually stalled (>= 50 ms), with the
    // per-block split so the culprit is visible. Silent on the common cheap refresh.
    const totalMs = readMs + upsertMs + metricsMs + ftsMs;
    if (log && totalMs >= 50) {
      log.debug(`[perf] refreshFile ${s.sessionId} ${totalMs.toFixed(0)}ms: read=${readMs.toFixed(0)} upsert=${upsertMs.toFixed(0)} metrics=${metricsMs.toFixed(0)} fts=${ftsMs.toFixed(0)}`);
    }
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

// --- multi-source scan: the backends that own their session store (Axis B) ---
//
// Claude's folder-driven scan above is untouched. This is the generic counterpart for a backend that
// keeps its sessions somewhere else entirely (Codex: (CODEX_HOME||~/.codex)/sessions/YYYY/MM/DD/
// rollout-*.jsonl). It is deliberately handle-based, not root-glob-based, so a db-mode backend
// (Hermes, Phase 5) plugs in by yielding {kind:'db'} handles with no change here.
//
// The project bucket stays CENTRAL and backend-agnostic (§5.9): the backend supplies only a `cwd`,
// which is run through the same resolveWorktreePath + encodeProjectPath pipeline Claude's folders
// use. That is what makes a Codex session in <project> and a Claude session in <project> land in the
// same sidebar project — they get the same projectPath AND the same folder key.

// Cached rows of one backend, across all folders — the per-backend reconcile input. Filtered off
// getAllCached() (already the sidebar's per-paint read) rather than a dedicated indexed query, so
// this needs no new ctx.db wiring. db.js has an idx_session_cache_backend index ready if the sweep
// ever gets hot enough to warrant a scoped getCachedByBackend().
function cachedRowsOfBackend(backendId) {
  return (getAllCached() || []).filter(r => (r.backendId || 'claude') === backendId);
}

/**
 * Rescan one backend's own session store and reconcile the cache with it.
 *
 * Only `ready && enabled` backends are scanned (§5.8). A `planned` or disabled backend's store is
 * NEVER enumerated — but its already-cached rows are left alone (disable != erase: they stay
 * visible and searchable, they just stop being refreshed).
 *
 * Claude (and every Axis-A profile, which shares Claude's store) is a no-op here — refreshFolder /
 * populateCacheViaWorker own that store.
 *
 * Returns { scanned, upserted, skipped, deleted } (all 0 when the backend is skipped).
 */
/**
 * Does the backend's store actually exist? Asked via its own `watchTargets()` — the store-level
 * addresses it already declares (a dir root, or a db file) — so no backend-specific knowledge is needed
 * here. A backend that declares nothing is assumed present (we cannot prove otherwise).
 */
function storeExists(b) {
  let targets;
  try { targets = (typeof b.watchTargets === 'function' && b.watchTargets()) || []; } catch { return true; }
  if (!targets.length) return true;
  return targets.some(t => {
    if (!t || !t.path) return false;
    try { return fs.existsSync(t.path); } catch { return false; }
  });
}

function refreshBackendSessions(backendId, { force = false } = {}) {
  const stats = { scanned: 0, upserted: 0, skipped: 0, deleted: 0 };
  const elapsed = startTimer();   // how long a store takes to walk (#153) — a number, not a hand-timed guess

  const b = backends.list().find(d => d.id === backendId);
  if (!b) return stats;
  if (b.status !== 'ready' || !b.enabled) return stats;          // §5.8 gate: never enumerate its roots
  if (b.id === 'claude' || b.isProfile) return stats;            // shares Claude's store — not ours to scan
  if (typeof b.discoverSessions !== 'function' || typeof b.parseSession !== 'function') return stats;

  let handles;
  try { handles = b.discoverSessions() || []; } catch (err) {
    log.info(`[scan] ${backendId}: discovery failed: ${err.message}`);
    return stats;
  }

  // Cached rows of THIS backend only — the reconcile below must never look at (or delete) another
  // backend's rows, even when they sit in the same folder.
  const cached = cachedRowsOfBackend(backendId);

  // An empty store means two very different things: "the user deleted their sessions" (reconcile them
  // away) or "we are looking in the wrong place" (do NOT). The second is real: a backend whose root is
  // an env var (Pi's PI_CODING_AGENT_SESSION_DIR) resolves elsewhere when the app is started from the
  // Start menu instead of a shell, and an unreadable root also reads as "no sessions". Deleting the
  // whole history because a directory is missing is not a reconcile, it is data loss — so when there
  // are no handles AND the store is not there, leave the cached rows alone.
  if (!handles.length && cached.length && !storeExists(b)) {
    log.info(`[scan] ${backendId}: store not found — keeping ${cached.length} cached session(s) instead of reconciling them away`);
    return stats;
  }
  const cachedByFile = new Map();
  const cachedById = new Map();
  for (const row of cached) {
    if (row.filePath) cachedByFile.set(row.filePath, row);
    cachedById.set(row.sessionId, row);
  }

  const seenFiles = new Set();
  const seenIds = new Set();
  const rows = [];
  const searchEntries = [];

  for (const h of handles) {
    if (!h) continue;
    const isFile = h.kind === 'file' && !!h.path;
    const isDb = h.kind === 'db' && !!h.sessionId;
    if (!isFile && !isDb) continue;
    stats.scanned++;

    // The change gate. For a FILE store the mtime is the marker; for a DB store there is no file per
    // session, so the backend supplies its own marker on the handle (Hermes builds one from ended_at +
    // last message, because its schema has no updated_at). Either way it lands in the row's `modified`
    // -equivalent, so an unchanged session is never re-read.
    //
    // A marker match is not enough on its own: it says the SOURCE is unchanged, not that the row we
    // wrote from it still reflects what our parser produces. Bumping a parser does not touch a file's
    // mtime or a Hermes session's ended_at, so a row written by an older parser must be re-read even
    // though nothing on the backend's side moved (#152).
    const parserVersion = Number.isInteger(b.PARSER_SCHEMA_VERSION) ? b.PARSER_SCHEMA_VERSION : null;
    const parserCurrent = (hit) => parserVersion == null || hit.parserVersion === parserVersion;

    let changeKey;
    let hit;
    if (isFile) {
      seenFiles.add(h.path);
      try { changeKey = fs.statSync(h.path).mtime.toISOString(); } catch { continue; }
      hit = cachedByFile.get(h.path);
      if (!force && hit && hit.modified === changeKey && parserCurrent(hit)) {
        seenIds.add(hit.sessionId);
        // A SKIPPED session is a persisted one: its row is right there, carrying the authoritative
        // backendId. Only the upsert path used to say so, so a session that never changed again was
        // never re-marked — and the overlay entry, spared from eviction as un-scanned, lived forever
        // (#155). The mark is cheap and idempotent; only the first one writes.
        markPersisted(hit.sessionId);
        stats.skipped++;
        continue;
      }
    } else {
      changeKey = h.marker == null ? null : String(h.marker);
      hit = cachedById.get(h.sessionId);
      if (!force && hit && changeKey && hit.changeMarker === changeKey && parserCurrent(hit)) {
        seenIds.add(hit.sessionId);
        markPersisted(hit.sessionId);
        stats.skipped++;
        continue;
      }
    }

    // Incremental read when the backend offers it AND this is a file handle (#194): re-parse only the
    // bytes appended since last time instead of the whole transcript. `prev` is the opaque parseState
    // from the last read (null → full read); the parser itself falls back to a full read on a version
    // bump or a shrunk/rewritten file. A db-store backend (Hermes) has no per-file state and no
    // incremental parser, so it keeps the full parseSession path. Capability-gated — no backend id here.
    let row;
    if (isFile && typeof b.parseSessionIncremental === 'function') {
      const prev = _axisBReadState.get(h.path) || null;
      let res;
      try { res = b.parseSessionIncremental(h, {}, prev); } catch { res = null; }
      row = res ? res.row : null;
      if (res && res.parseState) {
        _axisBReadState.set(h.path, res.parseState);
        if (_axisBReadState.size > FILE_READ_STATE_MAX) {
          _axisBReadState.delete(_axisBReadState.keys().next().value);   // oldest out (insertion order)
        }
      } else {
        _axisBReadState.delete(h.path);
      }
    } else {
      try { row = b.parseSession(h, {}); } catch { row = null; }
    }
    if (!row || !row.sessionId) continue;

    // §5.9: the backend supplies a cwd, the grouping layer owns the rest — grouping is central and
    // backend-agnostic. A backend may yield a session with NO cwd: Hermes is a general agent, so its
    // gateway/cron chats genuinely have no working directory. Those group into a BACKEND-SCOPED bucket
    // (the backend's own store root — a real path, so the Projects view handles it like any other)
    // rather than being force-fitted under some project they were never in.
    let cwd = row.cwd || null;
    if (!cwd && typeof b.sessionBucketPath === 'function') {
      try { cwd = b.sessionBucketPath(); } catch { cwd = null; }
    }
    if (!cwd) continue;
    const projectPath = resolveWorktreePath(cwd);
    if (!projectPath) continue;
    // Recorded BEFORE the removal check below — this is the only place a removed project's sessions are
    // ever seen, and both the sweep and "a new session brings it back" hang off it (#167).
    noteStoreProject(projectPath, row.lastEntryAt || row.modified || null);
    // REMOVED project: don't index it back in (mirrors refreshFolder). The row, if one already exists,
    // is left alone. A hidden project is indexed as normal — hiding is a view decision, not a delete.
    if (isRemovedProject(projectPath)) {
      if (hit) seenIds.add(hit.sessionId);
      continue;
    }

    row.folder = encodeProjectPath(projectPath);   // the SAME key Claude's folder for this cwd carries
    row.projectPath = projectPath;
    row.backendId = row.backendId || backendId;    // the parser already knows (Axis B = own root)
    row.parserVersion = parserVersion;             // which parser wrote it — the staleness gate above
    if (isFile) {
      row.filePath = h.path;                       // nothing to reconstruct it from — store it (v11)
      row.modified = changeKey;                    // keep the cache's change gate meaningful
    } else {
      // A db-store session has no file. `filePath` stays null (resolveRowFilePath must tolerate that)
      // and the change gate rides on the backend's own marker instead.
      row.changeMarker = changeKey;
      // Hermes lineage lives in its OWN column: `parentSessionId` is this app's Claude-subagent link,
      // and reusing it would make a Hermes child session render as a subagent of its parent.
      if (row.parentSessionId) {
        row.lineageParentId = row.parentSessionId;
        row.parentSessionId = null;
      }
    }

    seenIds.add(row.sessionId);
    rows.push(row);
    searchEntries.push(buildSearchEntry(row));
  }

  if (rows.length) {
    upsertCachedSessions(rows);
    stats.upserted = rows.length;
    for (const r of rows) {
      markPersisted(r.sessionId);
      if (r.customTitle) setName(r.sessionId, r.customTitle);
      // Per-(date, model) metrics feed the Stats charts (heatmap, daily bars, per-model tokens). Only
      // the CLAUDE read path used to write them, so those charts silently covered Claude alone while
      // the totals next to them counted every backend (#154). A parser that emits them now gets them
      // stored, exactly like Claude's.
      if (Array.isArray(r.dailyMetrics) && r.dailyMetrics.length) {
        replaceSessionMetrics(r.sessionId, r.dailyMetrics);
      }
    }
    for (const e of searchEntries) deleteSearchSession(e.id);
    upsertSearchEntries(searchEntries);
  }

  // Reconcile: a cached row whose file is gone from the store is dropped. Keyed on the file (not on
  // "did we parse it this pass"), so a row skipped by the mtime gate or by a hidden project survives.
  //
  // NOT when discovery only PARTIALLY read the store (#197): a readdir that threw on a subtree (a
  // permission error, a lock) drops that subtree's sessions from `handles` — they are unseen, not deleted.
  // Purging their rows would erase real history for a store we merely failed to read, the same data loss
  // the whole-store-absent guard above refuses. Keep them; the next clean pass reconciles genuine losses.
  if (handles.incomplete) {
    if (cached.length) log.info(`[scan] ${backendId}: store only partially readable — keeping ${cached.length} cached row(s), skipping reconcile`);
  } else {
    for (const row of cached) {
      const stillThere = row.filePath ? seenFiles.has(row.filePath) : seenIds.has(row.sessionId);
      if (stillThere) continue;
      deleteCachedSession(row.sessionId);
      deleteSearchSession(row.sessionId);
      stats.deleted++;
    }
  }

  stats.elapsedMs = Math.round(elapsed());
  if (stats.upserted || stats.deleted) {
    log.info(`[scan] ${backendId}: ${stats.scanned} sessions (${stats.upserted} indexed, ${stats.skipped} unchanged, ${stats.deleted} removed) in ${stats.elapsedMs} ms`);
  }
  return stats;
}

/**
 * Rescan every ready+enabled backend that owns its store (i.e. everything except Claude/Axis-A).
 *
 * `force` re-parses every session even if its change marker says nothing moved. That is what "Rebuild
 * session cache" means: the whole point of the action is that a cached row is WRONG, and a wrong row's
 * marker matches happily. Without it the rebuild dropped and re-read Claude's store while quietly
 * skipping every Codex and Hermes row it was asked to repair.
 */
function refreshAllBackendSessions({ force = false } = {}) {
  const out = {};
  let list;
  try { list = backends.list(); } catch { return out; }
  for (const b of list) {
    if (b.status !== 'ready' || !b.enabled) continue;
    if (b.id === 'claude' || b.isProfile) continue;
    out[b.id] = refreshBackendSessions(b.id, { force });
  }
  return out;
}

/**
 * Build the sidebar's projects from THE REGISTER (#167), with the cached sessions layered onto it.
 *
 * It used to be the other way round: the list was derived from the transcripts, so a project without one
 * could not appear however often you added it, and "remove" could only ever be faked as a permanent
 * hide. Now the register says which projects exist and which are shown; the sessions are what is IN them.
 */
function buildProjectsFromCache(showArchived) {
  const metaMap = getAllMeta();
  const cachedRows = getAllCached();
  const states = typeof getProjectStates === 'function' ? getProjectStates() : new Map();
  // A project is shown when it is on the list and neither hidden by the user nor auto-hidden by staleness.
  const visible = new Set();
  for (const [projectPath, state] of states) {
    if (registry.isVisible(state)) visible.add(projectPath);
  }

  // Group by projectPath, not on-disk folder name. Multiple ~/.claude/projects/<folder>/
  // directories can resolve to the same projectPath (Claude Code's folder-name encoding
  // scheme has changed over time, leaving legacy stragglers around), so we merge them into
  // a single sidebar group to avoid duplicate-id collisions in the morphdom render.
  // Only insert a project entry once we have a session that survives the archive filter —
  // otherwise folders whose sessions are all archived would appear in the sidebar as
  // undismissable phantom entries.
  // Which sessions the store knows, and which of them the sidebar is actually going to
  // show. A subagent is weighed against these below (#173): it is nested under its
  // parent, so a parent that is not on screen leaves it hanging.
  const knownIds = new Set();
  const shownIds = new Set();
  for (const row of cachedRows) {
    if (!row.projectPath) continue;
    knownIds.add(row.sessionId);
    if (!visible.has(row.projectPath)) continue;
    if (!showArchived && metaMap.get(row.sessionId)?.archived) continue;
    shownIds.add(row.sessionId);
  }

  const projectMap = new Map();
  // Track the newest session activity per projectPath across ALL cached rows
  // (archived included). Used to sort a project whose only sessions are archived
  // — it becomes an empty placeholder below, but should still rank by its last
  // real activity instead of being lumped with never-used empty folders.
  const lastActivityByPath = new Map();
  for (const row of cachedRows) {
    if (!row.projectPath) continue;
    // Not on the list, or on it and not shown: its sessions belong to no visible group. (A session of an
    // unregistered project is what the sync step registers — it does not paint itself into the sidebar.)
    if (!visible.has(row.projectPath)) continue;
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
      // Authoritative backend provenance (§5.7) — drives the sidebar's provider badge. A row written
      // before the multi-LLM columns existed (NULL) is Claude by definition. (The row's filePath is
      // NOT sent: it would bloat every sidebar paint. Read it per session via getCachedSession, or
      // through resolveRowFilePath below.)
      backendId: row.backendId || 'claude',
      // v12 cost + lineage (T-5.5). Null on every token-only backend (Claude/Codex/Axis-A) — the
      // Stats breakdown treats cost as just another metric and only shows it where a backend
      // reports one. `costStatus` says whether the figure is an estimate or a settled amount, so
      // an estimate is never presented as a bill. `lineageParentId` is a backend's OWN parent link
      // (Hermes' parent_session_id), deliberately separate from `parentSessionId` = Claude subagent.
      estimatedCostUsd: row.estimatedCostUsd == null ? null : Number(row.estimatedCostUsd),
      actualCostUsd: row.actualCostUsd == null ? null : Number(row.actualCostUsd),
      costStatus: row.costStatus || null,
      lineageParentId: row.lineageParentId || null,
      name: meta?.name || null,
      starred: meta?.starred || 0,
      archived: meta?.archived || 0,
    };
    if (!showArchived && s.archived) continue;
    // #129: a subagent follows its parent into the archive. `setArchived` only ever
    // stamps the row it was given, so a subagent keeps `archived = 0` and would
    // otherwise outlive its archived parent as an orphan in the sidebar. Deriving it
    // here (rather than cascading the write) also covers subagents indexed after the
    // parent was archived.
    //
    // Asked as "did the parent make it into the sidebar?" rather than "does the meta
    // row say archived?" (#173): the meta lookup answers only for a parent it can
    // resolve, so a subagent whose parent is in the store but is not being shown — its
    // meta row gone, its project hidden, its row belonging to another project — slipped
    // through and was painted as an orphan under a parent nobody could see. Whatever
    // keeps the parent out keeps the child out with it. A parent the store has never
    // heard of is a different thing: that subagent is a genuine orphan and still shows.
    if (!showArchived && s.parentSessionId
        && knownIds.has(s.parentSessionId) && !shownIds.has(s.parentSessionId)) continue;
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

  // Every REGISTERED project that has no session to show — the one the user just added and has never
  // run anything in, and the one whose sessions are all archived. This is where the list stops being a
  // derivation: it used to be a readdir of the Claude store, so a project with no transcript could not
  // be here at all, however often it was added.
  for (const projectPath of visible) {
    if (projectMap.has(projectPath)) continue;
    const state = states.get(projectPath) || {};
    projectMap.set(projectPath, {
      folder: encodeProjectPath(projectPath),
      projectPath,
      missing: !fs.existsSync(projectPath),
      sessions: [],
      // Its recency: the last real activity when its sessions are merely archived; otherwise the moment
      // it was put on the list. Without the second, a project you just added would sort below every
      // never-used folder and you would go looking for it (#167 Q2).
      lastActivity: lastActivityByPath.get(projectPath) || state.registeredAt || null,
    });
  }

  // Inject active plain terminal sessions so they participate in sorting. A terminal open in a project
  // the user has hidden stays hidden — starting one is not an unhide.
  for (const [sessionId, session] of activeSessions) {
    if (session.exited || !session.isPlainTerminal) continue;
    if (!session.projectPath) continue;
    if (!visible.has(session.projectPath)) continue;
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

  // No allowlist filter any more. Manual mode used to be a SUBTRACTIVE filter applied here — which is
  // why adding a project by hand did nothing unless discovery had already found it. The mode now decides
  // who may WRITE to the register (see project-registry.js); by the time we get here, the register is
  // the list, in both modes.
  return projects;
}


// Aggregate view of ALL projects for the Projects-admin tab (#32). Unlike
// buildProjectsFromCache this does NOT drop hidden projects and does NOT apply the
// manual-mode allowlist filter — the admin UI needs to see (and act on) everything.
// Returns lightweight rows (counts only, no per-session objects). Trust + ~/.claude.json
// extra meta are layered on by the main-process IPC.
function buildProjectsAdmin() {
  // The admin sees the register AND what is not on it: a project with sessions or a store folder but no
  // entry is exactly what the "add to sidebar" action is for, and it could not be offered if this view
  // only listed registered projects.
  const states = typeof getProjectStates === 'function' ? getProjectStates() : new Map();
  const favorited = typeof getFavoritedProjects === 'function' ? getFavoritedProjects() : new Set();
  const displayNames = typeof getProjectDisplayNames === 'function' ? getProjectDisplayNames() : new Map();

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
        projectPath = deriveProjectPath(path.join(PROJECTS_DIR, d.name));
        if (projectPath) setFolderMeta(d.name, projectPath, 0);
      }
      if (projectPath) ensure(projectPath);
    }
  } catch {}

  // ...and every registered project, including one that has neither sessions nor a store folder — the
  // whole point of the register is that such a project exists.
  for (const [projectPath, state] of states) {
    if (state.registered) ensure(projectPath);
  }

  const rows = [];
  for (const [projectPath, e] of map) {
    const state = states.get(projectPath) || {};
    rows.push({
      projectPath,
      folder: encodeProjectPath(projectPath),
      displayName: displayNames.get(projectPath) || '',
      sessionCount: e.sessionCount,
      lastActivity: e.lastActivity,
      missing: !fs.existsSync(projectPath),
      // On the list at all — what tells "hidden" (on it, unseen) apart from "not added" (not on it).
      registered: !!state.registered,
      hidden: !!state.hidden,
      autoHidden: !!state.autoHidden,
      removedAt: state.removedAt || null,
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
let activeScanWorker = null; // handle to the in-flight scan Worker, terminated on quit (issue #76)

function populateCacheViaWorker() {
  if (populatePromise) return populatePromise;
  sendStatus('Scanning projects\u2026', 'active');

  // TIME IT (#153). The cold scan's duration was measured once, by hand, and never again \u2014 so a
  // regression in it would go unnoticed, and it is the one thing standing between the user and a window
  // with nothing in it. The point has grown: #157 added a path that re-reads the WHOLE store on a parser
  // bump, and nobody would notice that doubling.
  //
  // `info`, not `debug`: packaged builds default to info, and a number nobody can see cannot be compared
  // against anything. It is one line per cold start, not per event.
  const elapsed = startTimer();

  populatePromise = new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      populatePromise = null;
      activeScanWorker = null;
      resolve();
    };

  const worker = new Worker(path.join(__dirname, 'workers', 'scan-projects.js'), {
    workerData: { projectsDir: PROJECTS_DIR },
  });
  activeScanWorker = worker;

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
    // The worker only scans Claude's root, so its rebuild must stay inside Claude's store — an
    // unscoped wipe would drop the Codex rows that share this folder key (multi-LLM T-4.2).
    const scope = claudeStoreScope();
    for (const { folder, projectPath, sessions, indexMtimeMs } of msg.results) {
      // A REMOVED project is not indexed — and this is a WRITE path like any other (#167). The worker
      // walks the whole store and knows nothing about the register, so without this a "Rebuild session
      // cache" (or any cold start that takes the worker path) would put a removed project's sessions
      // back into the cache, the search index and the stats. The sidebar would still hide it — the
      // register does that — so it would come back as an invisible, searchable zombie that nothing ever
      // purges again, because the tombstone stops it from ever being listed and swept.
      if (projectPath && isRemovedProject(projectPath)) {
        noteStoreProject(projectPath, newestSessionAt(sessions));
        setFolderMeta(folder, projectPath, indexMtimeMs);
        continue;
      }
      // Search first: the scoped FTS delete resolves the backend through session_cache, so the rows
      // it reads must still be there.
      deleteSearchFolder(folder, scope);
      deleteCachedFolder(folder, scope);
      if (sessions.length > 0) {
        sessionCount += sessions.length;
        upsertCachedSessions(sessions.map(stampClaudeProvenance));
        for (const s of sessions) {
          markPersisted(s.sessionId);
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

    const elapsedMs = Math.round(elapsed());
    const perSession = sessionCount ? Math.round(elapsedMs / sessionCount) : 0;
    log.info(
      `[scan] cold scan: ${sessionCount} sessions across ${msg.results.length} projects in ${elapsedMs} ms`
      + (sessionCount ? ` (${perSession} ms/session)` : '')
    );

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

// Terminate an in-flight project-scan worker (called from will-quit before
// closeDb, so a late worker message can't write to a closed DB) (issue #76).
function terminateScanWorker() {
  if (activeScanWorker) {
    try { activeScanWorker.terminate(); } catch {}
    activeScanWorker = null;
  }
}

module.exports = {
  init,
  terminateScanWorker,
  readSessionFile: claude.readSessionFile,
  readFolderFromFilesystem,
  refreshFolder,
  refreshFile,
  refreshBackendSessions,
  refreshAllBackendSessions,
  // Exposed so the IPC handlers that delete a folder's rows (remove-project, delete-project-sessions,
  // delete-worktree) can scope the delete exactly like the scanner does — a project folder key is
  // shared across backends, so an unscoped delete takes another backend's rows with it.
  claudeStoreScope,
  resolveRowFilePath,
  flushPendingReindex,
  reconcileCacheFromFilesystem,
  buildProjectsFromCache,
  buildProjectsAdmin,
  getStoreProjectPaths,
  shouldAutoHide,
  notifyRendererProjectsChanged,
  sendStatus,
  populateCacheViaWorker,
};
