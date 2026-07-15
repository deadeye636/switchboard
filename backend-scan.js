// The generic Axis-B store scanner, split out of session-cache.js (#199 step 4).
//
// Claude's folder-driven scan (store-indexer.js) is untouched. This is the generic counterpart for a
// backend that keeps its sessions somewhere else entirely (Codex: (CODEX_HOME||~/.codex)/sessions/…) —
// handle-based, not root-glob-based, so a db-mode backend (Hermes) plugs in by yielding {kind:'db'}
// handles with no change here. The project bucket stays CENTRAL and backend-agnostic (§5.9): the backend
// supplies only a `cwd`, run through the same resolveWorktreePath + encodeProjectPath pipeline Claude's
// folders use.
//
// Every write funnels through the neutral sink in index-writes.js. The Axis-B "prepare" is a no-op — the
// parser already set `backendId` — so the row-shaping that is NOT the reader's (the folder key, the
// sessionBucketPath cwd fallback, the Hermes lineageParentId remap, the changeMarker for db rows) stays
// in THIS parse loop, not in a prepare and not in the sink.

const fs = require('fs');
const backends = require('./backends');
const { resolveWorktreePath } = require('./derive-project-path');
const { encodeProjectPath } = require('./encode-project-path');
const { startTimer } = require('./perf');
const { applyIndexResults, markPersisted, noteStoreProject, isRemovedProject } = require('./index-writes');

let log;
let getAllCached;

function init(ctx) {
  log = ctx.log;
  getAllCached = ctx.db.getAllCached;
}

// Cached rows of one backend, across all folders — the per-backend reconcile input. Filtered off
// getAllCached() (already the sidebar's per-paint read) rather than a dedicated indexed query, so this
// needs no new ctx.db wiring.
function cachedRowsOfBackend(backendId) {
  return (getAllCached() || []).filter(r => (r.backendId || 'claude') === backendId);
}

// The same retained-parse-state memo, for the Axis-B file backends (#194). Their generic scan/watcher
// flush used to full-parse every CHANGED file. Keyed by file path → the backend's opaque `parseState`;
// disjoint from Claude's `_fileReadState` (Claude's store never shares a path with a Codex/Pi store).
const _axisBReadState = new Map();
const FILE_READ_STATE_MAX = 512;

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

/**
 * Rescan one backend's own session store and reconcile the cache with it.
 *
 * Only `ready && enabled` backends are scanned (§5.8). Claude (and every Axis-A profile, which shares
 * Claude's store) is a no-op here — refreshFolder / populateCacheViaWorker own that store.
 *
 * Returns { scanned, upserted, skipped, deleted } (all 0 when the backend is skipped).
 */
function refreshBackendSessions(backendId, { force = false } = {}) {
  const stats = { scanned: 0, upserted: 0, skipped: 0, deleted: 0 };
  const elapsed = startTimer();   // how long a store takes to walk (#153)

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
  // away) or "we are looking in the wrong place" (do NOT). Deleting the whole history because a directory
  // is missing is not a reconcile, it is data loss — so when there are no handles AND the store is not
  // there, leave the cached rows alone.
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

  for (const h of handles) {
    if (!h) continue;
    const isFile = h.kind === 'file' && !!h.path;
    const isDb = h.kind === 'db' && !!h.sessionId;
    if (!isFile && !isDb) continue;
    stats.scanned++;

    // The change gate. For a FILE store the mtime is the marker; for a DB store there is no file per
    // session, so the backend supplies its own marker on the handle. Either way it lands in the row's
    // `modified`-equivalent, so an unchanged session is never re-read.
    //
    // A marker match is not enough on its own: bumping a parser does not touch a file's mtime or a
    // Hermes session's ended_at, so a row written by an older parser must be re-read (#152).
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
        // backendId. Only the upsert path used to say so (#155), so the overlay entry lived forever. The
        // mark is cheap and idempotent; only the first one writes. Stays in the parse loop, NOT the sink
        // (a skipped session is never handed to the sink).
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

    // Incremental read when the backend offers it AND this is a file handle (#194). A db-store backend
    // (Hermes) has no per-file state and no incremental parser, so it keeps the full parseSession path.
    // Capability-gated — no backend id here.
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

    // §5.9: the backend supplies a cwd, the grouping layer owns the rest. A backend may yield a session
    // with NO cwd (Hermes gateway/cron chats): those group into a BACKEND-SCOPED bucket (the backend's
    // own store root) rather than being force-fitted under some project they were never in.
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
  }

  // Reconcile: a cached row whose file is gone from the store is dropped. Keyed on the file (not on "did
  // we parse it this pass"), so a row skipped by the mtime gate or by a hidden project survives.
  //
  // NOT when discovery only PARTIALLY read the store (#197): a readdir that threw on a subtree drops that
  // subtree's sessions from `handles` — they are unseen, not deleted. Purging their rows would erase real
  // history for a store we merely failed to read. Keep them; the next clean pass reconciles genuine losses.
  const deleteIds = [];
  if (handles.incomplete) {
    if (cached.length) log.info(`[scan] ${backendId}: store only partially readable — keeping ${cached.length} cached row(s), skipping reconcile`);
  } else {
    for (const row of cached) {
      const stillThere = row.filePath ? seenFiles.has(row.filePath) : seenIds.has(row.sessionId);
      if (stillThere) continue;
      deleteIds.push(row.sessionId);
    }
  }

  // The one neutral sink: upserts (with markPersisted + setName + per-day metrics 'if-nonempty', #154)
  // and the per-id reconcile deletes, all scoped through each row's own backendId.
  applyIndexResults({ sessions: rows, deleteIds, metricsMode: 'if-nonempty' });
  stats.upserted = rows.length;
  stats.deleted = deleteIds.length;

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
 * marker matches happily.
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

module.exports = {
  init,
  refreshBackendSessions,
  refreshAllBackendSessions,
  cachedRowsOfBackend,
  storeExists,
};
