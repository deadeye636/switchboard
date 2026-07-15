// Claude's folder-driven store indexer, split out of session-cache.js (#199 step 4).
//
// This owns the ~/.claude/projects walk: the incremental folder/file refresh (refreshFolder,
// refreshFile), the reconcile safety-net sweep, the debounced per-file reindex, the per-file
// retained-parse-state memo, the cold-scan worker, and the Claude `prepare` (stampClaudeProvenance).
// Every write goes through the neutral sink in index-writes.js — the only backend-shaped step here is
// stampClaudeProvenance, which runs on main BEFORE the sink.
//
// CYCLE GUARD (#199 step-4 footnote): this file sits under backends/claude/ and requires the registry
// (`../index`) at load to reach Claude's format readers through its descriptor. NOTHING under backends/
// may require THIS module back, or the registry would still be mid-seeding when `backends.get('claude')`
// runs here and blow up. backends/claude/index.js (the descriptor) must never require store-indexer.

const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { getFolderIndexMtimeMs } = require('../../folder-index-state');
const { deriveProjectPath } = require('../../derive-project-path');
const backends = require('../index');
// Claude's format readers are reached THROUGH its descriptor (#188), not by importing the format
// modules directly. The registry is fully seeded by the time this module is first required (the façade
// requires index-writes — hence backends — before it requires us), so `get('claude')` is safe at load.
const claude = backends.get('claude');
const CLAUDE_PARSER_VERSION = claude.PARSER_SCHEMA_VERSION;
const sessionBackends = require('../../session-backends');
const { startTimer } = require('../../perf');
const {
  applyIndexResults,
  claudeStoreScope,
  isRemovedProject,
  noteStoreProject,
  newestSessionAt,
  notifyRendererProjectsChanged,
  sendStatus,
} = require('../../index-writes');

let PROJECTS_DIR, log;
let getFolderMeta, setFolderMeta, getAllFolderMeta, getCachedByFolder, deleteCachedFolder, getMeta;

function init(ctx) {
  PROJECTS_DIR = ctx.PROJECTS_DIR;
  log = ctx.log;
  getFolderMeta = ctx.db.getFolderMeta;
  setFolderMeta = ctx.db.setFolderMeta;
  getAllFolderMeta = ctx.db.getAllFolderMeta;
  getCachedByFolder = ctx.db.getCachedByFolder;
  deleteCachedFolder = ctx.db.deleteCachedFolder;
  getMeta = ctx.db.getMeta;
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
// This is the Claude `prepare` (#199 step 4) — the one backend-shaped step, run on main BEFORE the
// neutral sink. It stamps provenance (overlay) + the parser version, and NOTHING else: customTitle ->
// setName is COMMON (Axis-B promotes it too, §5.7) so it lives in the sink, not here.
function stampClaudeProvenance(s) {
  const ov = overlayFor(s.sessionId, s.parentSessionId);
  if (ov && ov.backendId) {
    s.backendId = ov.backendId;
    if (ov.profileId) s.profileId = ov.profileId;
  }
  // Which parser produced this row (#152). The skip gate compares it to the parser we have now.
  s.parserVersion = CLAUDE_PARSER_VERSION;
  return s;
}

/** The absolute session file behind a cached row: stored path (non-Claude) or the Claude reconstruction. */
function resolveRowFilePath(row) {
  if (row && row.filePath) return row.filePath;
  return claude.resolveJsonlPath(PROJECTS_DIR, row);
}

/** Read one folder from filesystem by scanning .jsonl files directly */
function readFolderFromFilesystem(folder) {
  const { projectPath, sessions } = claude.readFolderSessions(PROJECTS_DIR, folder);
  return { projectPath, sessions };
}

// Resolve a folder's projectPath cheaply: reuse the last-derived path while its
// directory still exists, else derive from the JSONL heads (I/O). Shared by the
// folder- and file-level refresh paths.
function folderProjectPath(folder, folderPath) {
  const knownMeta = getFolderMeta ? getFolderMeta(folder) : null;
  if (knownMeta && knownMeta.projectPath && fs.existsSync(knownMeta.projectPath)) return knownMeta.projectPath;
  return deriveProjectPath(folderPath);
}

// opts.indexMtimeMs — pre-computed getFolderIndexMtimeMs result. The reconcile
// sweep already scans every folder once for its change gate; passing that value
// in avoids a second readdir+stat pass per refreshed folder. Stamping the
// pre-refresh value is the safe direction: a file that changes mid-refresh just
// triggers one extra sweep next pass.
//
// Phased (#199 step-4, fable #4) into snapshot -> parse-loop -> sink, even while on-thread: main gathers
// the cached-rows + folder-meta snapshot, the parse-loop walks/parses (this is what moves to the worker
// in step 5), and the neutral sink applies the writes.
function refreshFolder(folder, opts = {}) {
  // Claude answers to the enable gate like every other backend now (#162). "Disable is not delete"
  // (§5.8) still holds: the cached rows stay, so the sessions remain visible and searchable — they are
  // simply not re-read, and nothing new appears.
  if (!claudeEnabled()) return;   // undefined is falsy — the "changed?" contract below treats it as no-change

  // Optional perf accumulator handed in by the reconcile sweep (#199 step 2).
  const stats = opts.stats || null;

  const folderPath = path.join(PROJECTS_DIR, folder);
  // Scope EVERY folder-wide read/delete below to Claude's store: an Axis-B backend (Codex) can hold
  // rows under the same folder key, and its sessions live outside ~/.claude/projects. An unscoped sweep
  // here would delete them.
  const scope = claudeStoreScope();

  // --- snapshot (main gathers) ---
  if (!fs.existsSync(folderPath)) {
    // VANISHED-FOLDER branch (#199 step-4 footnote A-4): keep the EXACT asymmetric delete —
    // deleteCachedFolder WITHOUT deleteSearchFolder. It is a pre-existing FTS-orphan asymmetry: the
    // cache-first order makes a scoped search wipe impossible here anyway (the scoped FTS delete resolves
    // backendId through the very rows this deletes). Routing it through the sink's search-first
    // wipeFolders would CHANGE behaviour (arguably fix the orphan) — so it is kept as-is to stay
    // behaviour-identical; step 5's worker reconcile is where the orphan can be cleaned up honestly.
    deleteCachedFolder(folder, scope);
    return true;
  }
  const stampMtimeMs = () =>
    (opts.indexMtimeMs != null ? opts.indexMtimeMs : getFolderIndexMtimeMs(folderPath));

  // Reuse the previously-derived projectPath when its directory still exists. A vanished directory falls
  // through to a fresh derive so the missing-project remap detection keeps working.
  const projectPath = folderProjectPath(folder, folderPath);
  if (!projectPath) {
    setFolderMeta(folder, null, stampMtimeMs());
    return false;
  }

  // REMOVED project: don't index its folder back into the cache (a hidden one still is — #167). What the
  // folder holds, and how recent it is, still has to be REPORTED so the sweep does not forget a removal
  // while its transcripts are there, and a session NEWER than the removal brings the project back.
  if (isRemovedProject(projectPath)) {
    const newestMs = getFolderIndexMtimeMs(folderPath);
    noteStoreProject(projectPath, newestMs ? new Date(newestMs).toISOString() : null);
    setFolderMeta(folder, projectPath, stampMtimeMs());
    return false;
  }

  // Get what's currently cached for this folder. cachedMap: DB sessionId -> { modified, filePath } so we
  // can do mtime comparison even for subagents whose DB sessionId differs from the on-disk filename.
  const cachedSessions = getCachedByFolder(folder, scope);
  const cachedMap = new Map();          // DB sessionId -> { modified, filePath, parserVersion }
  const cachedByFilePath = new Map();   // filePath -> { dbId, entry } (reverse map for the per-file loop)
  for (const row of cachedSessions) {
    const entry = {
      modified: row.modified,
      filePath: resolveRowFilePath(row),
      parserVersion: row.parserVersion,   // #152 — the skip gate needs it, not just the mtime
    };
    cachedMap.set(row.sessionId, entry);
    cachedByFilePath.set(entry.filePath, { dbId: row.sessionId, entry });
  }

  // --- parse-loop (this is what moves to the worker in step 5) ---
  const currentIds = new Set();
  let changed = false;
  const preparedSessions = [];   // already-prepared rows, handed to the sink
  const deleteIds = [];          // rows whose .jsonl vanished

  for (const { filePath, parentSessionId } of claude.enumerateSessionFiles(folderPath)) {
    // We need the DB sessionId to look up the cache, but we don't know it until after the read — for
    // subagents it's sub:<parent>:<agentId>. Use the file path to find a matching cached entry instead.
    let fileMtime;
    try { fileMtime = fs.statSync(filePath).mtime.toISOString(); } catch { continue; }

    const cachedHit = cachedByFilePath.get(filePath) || null;
    const cachedEntry = cachedHit ? cachedHit.entry : null;
    const cachedDbId = cachedHit ? cachedHit.dbId : null;

    if (cachedDbId !== null) currentIds.add(cachedDbId);

    // The staleness gate. An unchanged file is skipped — UNLESS the parser that wrote the cached row is
    // not the parser that would read it now (#152). A parser change does not touch the file's mtime.
    if (cachedEntry && cachedEntry.modified === fileMtime && cachedEntry.parserVersion === CLAUDE_PARSER_VERSION) {
      continue; // unchanged, and read by the parser we still have
    }

    // File is new or modified — re-read it INCREMENTALLY, sharing the watcher's memo (#199 step 2). We
    // hand the memo over, we do NOT delete it. This is the #194 parity fix applied to Claude.
    const prev = _fileReadState.get(filePath) || null;
    const res = claude.readSessionFileIncremental(filePath, folder, projectPath, { parentSessionId }, prev);
    if (res) {
      rememberFileReadState(filePath, res.next);
      if (stats) {
        // full-vs-incremental is classified by whether a memo existed (the dominant signal); a rare
        // fingerprint-mismatch full re-read with a memo is counted as incremental, but the reader does
        // not expose which branch it took and the counter is diagnostic, not load-bearing.
        if (prev) { stats.filesIncremental++; stats.bytes += Math.max(0, res.next.offset - prev.offset); }
        else { stats.filesFull++; stats.bytes += res.next.offset; }
      }
      // This sweep just read the file — cancel any pending debounced refreshFile for it so the watcher
      // flush doesn't redo the same read+FTS work a moment later (#199 step 2).
      cancelReindex(filePath);
      const s = res.session;
      currentIds.add(s.sessionId); // ensure we don't delete a newly-read subagent row
      // Per-backend PREPARE (Claude): stamp provenance + parser version. The sink does the metrics,
      // search, name and upsert — all common.
      preparedSessions.push(stampClaudeProvenance(s));
    } else {
      // Not (yet) a valid session, or it became invalid — drop any stale memo so the next touch starts
      // from a clean full read (mirrors refreshFile).
      _fileReadState.delete(filePath);
    }
    changed = true;
  }

  // Remove sessions whose .jsonl files were deleted
  for (const sessionId of cachedMap.keys()) {
    if (!currentIds.has(sessionId)) {
      deleteIds.push(sessionId);
      changed = true;
    }
  }

  // --- sink (applies the writes) ---
  applyIndexResults({ sessions: preparedSessions, deleteIds, metricsMode: 'always' });

  // Update folder mtime
  setFolderMeta(folder, projectPath, stampMtimeMs());
  return changed;
}

// Debounced per-file re-index (perf #1 + #4 + review item B). Re-reading and re-indexing a transcript on
// *every* append is the dominant cost in the hot path. A storm of appends is coalesced into ONE
// read+index per quiet window, capped by a max-wait so a continuously-appending session still refreshes
// at least every REINDEX_MAX_WAIT_MS.
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

// Per-file incremental read state (perf #74): filePath -> { offset, state, metrics } as returned by
// readSessionFileIncremental. Lets a watcher flush on a large live transcript read only the
// newly-appended bytes. In-memory only; bounded so weeks of touched files can't grow unchecked.
const _fileReadState = new Map();
const FILE_READ_STATE_MAX = 512;

// Store the retained parse state for a file, evicting the oldest entry when the memo is full (an evicted
// entry just costs one full re-read). Shared by BOTH readers of Claude's store — the debounced
// refreshFile hot path and the reconcile sweep's refreshFolder (#199 step 2).
function rememberFileReadState(filePath, next) {
  _fileReadState.set(filePath, next);
  if (_fileReadState.size > FILE_READ_STATE_MAX) {
    _fileReadState.delete(_fileReadState.keys().next().value);
  }
}

// Incremental single-file refresh (perf #1). The projects watcher fires per changed .jsonl; re-indexing
// just that one file avoids re-enumerating + re-stating the whole folder on every append. The throttled
// folder-level reconcileCacheFromFilesystem sweep stays as the safety net.
//
// `relFilename` is the watcher's path relative to PROJECTS_DIR, e.g. "<folder>/<uuid>.jsonl" (top-level)
// or "<folder>/<uuid>/subagents/<f>.jsonl".
function refreshFile(folder, relFilename, opts = {}) {
  if (!claudeEnabled()) return;   // #162 — a disabled backend is not watched, Claude included
  const folderPath = path.join(PROJECTS_DIR, folder);
  const rel = relFilename.split(/[\\/]/).filter(Boolean);
  const inner = rel.slice(1); // path within the folder
  if (inner.length === 0) return;
  // Subagent transcripts live one or more levels below <folder>; their parent session UUID is the first
  // path segment inside the folder.
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
    // Deleted file → drop its row immediately (deletes must not lag), stamping the sessionId the same way
    // readSessionFile does (top-level = filename; subagent = sub:<parent>:<agentId>).
    cancelReindex(filePath);
    _fileReadState.delete(filePath);
    const base = path.basename(filePath, '.jsonl');
    let sessionId = base;
    if (parentSessionId) {
      const m = base.match(/^agent-(.+)$/);
      try { sessionId = claude.subagentSessionId(parentSessionId, m ? m[1] : base); } catch { sessionId = null; }
    }
    if (sessionId) applyIndexResults({ deleteIds: [sessionId] });
    setFolderMeta(folder, projectPath, getFolderIndexMtimeMs(folderPath));
    return;
  }

  // Stamp the folder as indexed-as-of-now up front (cheap single-row write) so the reconcile sweep
  // doesn't jump in with a full-folder refresh while the heavy read+FTS is still pending below.
  setFolderMeta(folder, projectPath, getFolderIndexMtimeMs(folderPath));

  const run = () => {
    // Incremental hot-path read (perf #74): reuse the retained parse state so only the bytes appended
    // since the last refresh are read. First touch (or a rewritten/truncated file) falls back to a full
    // read inside readSessionFileIncremental.
    const prev = _fileReadState.get(filePath) || null;
    const tRead = startTimer();
    const res = claude.readSessionFileIncremental(filePath, folder, projectPath, { parentSessionId }, prev);
    const readMs = tRead();
    // null = file not yet a valid session (no first user turn) or became invalid. Leave any existing row
    // as-is; the reconcile sweep reconciles genuine losses.
    if (!res) {
      _fileReadState.delete(filePath);
      return;
    }
    rememberFileReadState(filePath, res.next);
    const s = res.session;
    // Capture the effective name BEFORE the write so we can tell the renderer when a rename (Claude
    // /rename → JSONL custom-title, promoted via setName inside the sink) actually changed it. Without
    // this notify the deferred reindex writes the new name to the DB but the sidebar keeps the old one
    // until an unrelated refresh (#60). The before/after MUST straddle the sink call — the sink is what
    // runs setName now.
    const prevName = (getMeta(s.sessionId) || {}).name || null;
    const tWrite = startTimer();
    // Claude prepare + the one neutral sink (metrics 'always'; single-session upsert + FTS + setName).
    applyIndexResults({ sessions: [stampClaudeProvenance(s)], metricsMode: 'always' });
    const writeMs = tWrite();
    const newName = (getMeta(s.sessionId) || {}).name || null;
    if (newName !== prevName) notifyRendererProjectsChanged();
    // #199: one line only when this refresh actually stalled (>= 50 ms). The write blocks (upsert +
    // metrics + FTS) are one sink call now, so they are timed together as `write`.
    const totalMs = readMs + writeMs;
    if (log && totalMs >= 50) {
      log.debug(`[perf] refreshFile ${s.sessionId} ${totalMs.toFixed(0)}ms: read=${readMs.toFixed(0)} write=${writeMs.toFixed(0)}`);
    }
  };

  // opts.immediate: skip the reindex debounce and run inline. Used by the Stop-hook fast-path so a
  // rename shows the instant the turn ends, not after both debounces.
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
 * Re-indexes only folders that are new or whose newest .jsonl is newer than what we last indexed — a
 * cheap, stat-only gate when nothing changed. This is what keeps sessions from silently going missing.
 *
 * Rate-limited: the live watcher catches real-time changes, so this safety-net sweep only needs to run
 * occasionally. The throttle skips the redundant double-call per sidebar paint.
 */
const RECONCILE_THROTTLE_MS = 5000;
let lastReconcileAt = 0;

function reconcileCacheFromFilesystem() {
  const now = Date.now();
  if (now - lastReconcileAt < RECONCILE_THROTTLE_MS) return false;
  lastReconcileAt = now;
  // #199 step 2: prove the sweep no longer full-reads changed files. Same [perf]-debug style as e7450cb.
  const stats = { foldersScanned: 0, foldersTripped: 0, filesFull: 0, filesIncremental: 0, bytes: 0, gateMs: 0 };
  const elapsed = startTimer();
  let changed = false;
  try {
    const metaMap = getAllFolderMeta();
    const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .map(d => d.name);
    stats.foldersScanned = folders.length;

    for (const folder of folders) {
      const meta = metaMap.get(folder);
      const folderPath = path.join(PROJECTS_DIR, folder);
      // One readdir+stat pass per folder per sweep: the gate value is handed to refreshFolder for its
      // final stamp instead of being recomputed there. `getFolderIndexMtimeMs` recurses into subagent
      // dirs (#199 step 2), so this stat walk runs UNCONDITIONALLY for every folder every tick; `gateMs`
      // measures it. Step 5 (the off-thread index worker) is what actually removes it.
      const gt = startTimer();
      const indexMtimeMs = getFolderIndexMtimeMs(folderPath);
      stats.gateMs += gt();
      if (!meta || indexMtimeMs > (meta.indexMtimeMs || 0)) {
        stats.foldersTripped++;
        if (refreshFolder(folder, { indexMtimeMs, stats })) changed = true;
      }
    }
  } catch (err) {
    console.error('Error reconciling cache:', err);
  }
  // Log when a folder tripped (the read cost) OR when the gate walk itself was slow on an idle store.
  if (log && (stats.foldersTripped > 0 || stats.gateMs > 25)) {
    const ms = elapsed();
    log.debug(`[perf] reconcile ${ms.toFixed(0)}ms: scanned=${stats.foldersScanned} tripped=${stats.foldersTripped} gate=${stats.gateMs.toFixed(0)} full=${stats.filesFull} incr=${stats.filesIncremental} bytes=${stats.bytes}`);
  }
  return changed;
}

// --- Worker-based cache population (Claude cold scan) ---
// Returns a Promise that resolves when the in-flight scan finishes. Concurrent callers share the same
// Promise so the first get-projects after a migration can await it instead of seeing an empty list.
let populatePromise = null;
let activeScanWorker = null; // handle to the in-flight scan Worker, terminated on quit (issue #76)

function populateCacheViaWorker() {
  if (populatePromise) return populatePromise;
  sendStatus('Scanning projects…', 'active');

  // TIME IT (#153). `info`, not `debug`: packaged builds default to info, and a number nobody can see
  // cannot be compared against anything. It is one line per cold start, not per event.
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

  const worker = new Worker(path.join(__dirname, '..', '..', 'workers', 'scan-projects.js'), {
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

    sendStatus(`Indexing ${msg.results.length} projects…`, 'active');

    // Write results to DB on main thread (fast)
    let sessionCount = 0;
    // The worker only scans Claude's root, so its rebuild must stay inside Claude's store — an unscoped
    // wipe would drop the Codex rows that share this folder key (multi-LLM T-4.2).
    const scope = claudeStoreScope();
    for (const { folder, projectPath, sessions, indexMtimeMs } of msg.results) {
      // A REMOVED project is not indexed — and this is a WRITE path like any other (#167). Without this a
      // "Rebuild session cache" (or any cold start that takes the worker path) would put a removed
      // project's sessions back into the cache, the search index and the stats as an invisible zombie.
      if (projectPath && isRemovedProject(projectPath)) {
        noteStoreProject(projectPath, newestSessionAt(sessions));
        setFolderMeta(folder, projectPath, indexMtimeMs);
        continue;
      }
      // Claude prepare + the neutral sink: a folder-scoped wipe (search BEFORE cache, scoped) then the
      // prepared rows. The wipe runs even for an emptied folder.
      applyIndexResults({
        sessions: sessions.map(stampClaudeProvenance),
        wipeFolders: [{ folder, scope }],
        metricsMode: 'always',
      });
      sessionCount += sessions.length;
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

  // If the worker exits abnormally (SIGSEGV, OOM, uncaught exception) without sending a message, neither
  // the 'message' nor 'error' handler will fire. Resolve here so awaiters aren't stuck forever.
  worker.on('exit', (code) => {
    if (!settled && code !== 0) {
      sendStatus('Scan worker exited unexpectedly', 'error');
    }
    settle();
  });
  });

  // Return the in-flight promise so first callers can await/chain on scan completion.
  return populatePromise;
}

// Terminate an in-flight project-scan worker (called from will-quit before closeDb, so a late worker
// message can't write to a closed DB) (issue #76).
function terminateScanWorker() {
  if (activeScanWorker) {
    try { activeScanWorker.terminate(); } catch {}
    activeScanWorker = null;
  }
}

module.exports = {
  init,
  stampClaudeProvenance,
  resolveRowFilePath,
  readFolderFromFilesystem,
  folderProjectPath,
  refreshFolder,
  refreshFile,
  reconcileCacheFromFilesystem,
  scheduleReindex,
  cancelReindex,
  flushPendingReindex,
  populateCacheViaWorker,
  terminateScanWorker,
  // exposed for the façade's readSessionFile re-export convenience
  claude,
};
