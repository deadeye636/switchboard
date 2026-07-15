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
const { startTimer } = require('./perf');
const { applyIndexResults, markPersisted, noteStoreProject, isRemovedProject } = require('./index-writes');
// #199 step 5.2a (F1): the PURE Axis-B parse-loop + its incremental memo live in the Electron-free leaf
// backend-parse.js. backend-scan re-imports the loop so there is ONE implementation the step-5 worker and
// main both run — no drift. The DB-touching orchestration (snapshot gather, storeExists, the sink,
// noteStoreProject / markPersisted / isRemovedProject / the delete-diff) stays HERE, on main.
const { parseBackendSessions } = require('./backend-parse');

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

// The retained-parse-state memo `_axisBReadState` and the `parseBackendSessions` parse-loop moved to the
// Electron-free leaf ./backend-parse.js (#199 step 5.2a / F1) — see its doc comment for the reply shape.
// backend-scan imports the loop above; the DB-touching orchestration (snapshot gather + reply replay)
// stays HERE, on main.

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
 * #199 step 5.1b: the parse-loop is the PURE `parseBackendSessions` (snapshot-in, reply-out — what moves
 * to the worker in 5.2). This function is now main: GATHER the snapshot (the DB-reading gates the loop must
 * not do — the cached-rows snapshot + the store-not-found guard), CALL the pure loop, then REPLAY every
 * side-effect from the reply — noteStoreProject / markPersisted-on-skip / the snapshot-scoped delete-diff /
 * the apply-time removed gate / the one neutral sink. Behaviour-identical.
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

  // --- snapshot (main gathers what the pure loop must not read) ---
  let handles;
  try { handles = b.discoverSessions() || []; } catch (err) {
    log.info(`[scan] ${backendId}: discovery failed: ${err.message}`);
    return stats;
  }

  // Cached rows of THIS backend only — the reconcile below must never look at (or delete) another
  // backend's rows, even when they sit in the same folder. This IS the snapshot the delete-diff is
  // confined to (never a fresh liveCache read at apply time — fable finding 2).
  const cached = cachedRowsOfBackend(backendId);

  // The store-not-found guard (storeExists stays on MAIN). An empty store means two very different things:
  // "the user deleted their sessions" (reconcile them away) or "we are looking in the wrong place" (do
  // NOT). Deleting the whole history because a directory is missing is not a reconcile, it is data loss —
  // so when there are no handles AND the store is not there, leave the cached rows alone. This early return
  // IS the storeMissing delete-gate: with no handles there is nothing to note, mark or index anyway.
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

  // --- pure parse-loop (this is what moves to the worker in step 5.2) ---
  const reply = parseBackendSessions(b, { handles, cachedByFile, cachedById, force });

  // --- replay every side-effect from the reply (shared by the inline path and, in 5.2b, the worker) ---
  applyBackendReply(backendId, reply, { cached, stats });

  stats.elapsedMs = Math.round(elapsed());
  if (stats.upserted || stats.deleted) {
    log.info(`[scan] ${backendId}: ${stats.scanned} sessions (${stats.upserted} indexed, ${stats.skipped} unchanged, ${stats.deleted} removed) in ${stats.elapsedMs} ms`);
  }
  return stats;
}

// Replay a `parseBackendSessions` reply — the DB / overlay / scan-state side-effects main owns. Extracted
// (#199 step 5.2b) so there is ONE replay: the inline `refreshBackendSessions` (index-worker flag OFF) and
// the persistent index worker's reconcile reply handler (flag ON) both call it, the reply being byte-
// identical whether the pure loop ran on-thread or in the worker.
//
//   cached   — THIS request's cached snapshot for this backend; the delete-diff is confined to it (never a
//              fresh liveCache read — fable finding 2).
//   stats    — filled in place ({scanned, skipped, upserted, deleted}).
//   dropIds  — the delete-epoch guard (worker path only): sessionIds DELETED since the request. Their rows
//              are filtered out of the sink so a late reply can't reverse-resurrect a just-deleted row.
function applyBackendReply(backendId, reply, { cached = [], stats = {}, dropIds } = {}) {
  stats.scanned = reply.scanned;
  stats.skipped = reply.skipped;

  // UNCONDITIONAL store sighting per parsed session (#167 tombstone/bring-back) — Axis-B notes EVERY
  // session, not just removed ones (unlike Claude's loop).
  for (const sp of reply.storeProjects) noteStoreProject(sp.projectPath, sp.newestAt);

  // #155 markPersisted on the SKIP path (both the file-mtime and db-marker skip branches). A skipped
  // session never reaches the sink, so this is the only place its overlay entry becomes evictable.
  for (const id of reply.skippedIds) markPersisted(id);

  // Snapshot-scoped, per-id reconcile delete-diff — a cached row whose source is gone from the store.
  // Confined to THIS request's cached snapshot (never a fresh liveCache read), and NOT run when discovery
  // only PARTIALLY read the store (#197): unseen is not deleted. Keyed per cached row: file rows on the
  // seen FILE set (so a row skipped by the mtime gate survives), db rows on the seen ID set (no file).
  const seenIds = new Set(reply.seenIds);
  const seenFiles = new Set(reply.seenFiles);
  const deleteIds = [];
  if (reply.incomplete) {
    if (cached.length) log.info(`[scan] ${backendId}: store only partially readable — keeping ${cached.length} cached row(s), skipping reconcile`);
  } else {
    for (const row of cached) {
      const stillThere = row.filePath ? seenFiles.has(row.filePath) : seenIds.has(row.sessionId);
      if (stillThere) continue;
      deleteIds.push(row.sessionId);
    }
  }

  // Apply-time REMOVED gate (isRemovedProject is a DB read — runs on MAIN, not in the pure loop): a removed
  // project is not indexed back in, but its already-cached row is left alone. The row is still in
  // `reply.seenIds` above, so the reconcile above did not delete it — exactly the old `if (hit)
  // seenIds.add(...)` semantics, now expressed as "shaped + seen, but filtered out of the sink." Mirrors
  // refreshFolder. A hidden project is indexed as normal — hiding is a view decision, not a delete.
  let sessions = reply.sessions;
  if (dropIds && dropIds.size) sessions = sessions.filter(row => !dropIds.has(row.sessionId));
  const toIndex = sessions.filter(row => !isRemovedProject(row.projectPath));

  // The one neutral sink: upserts (with markPersisted + setName + per-day metrics 'if-nonempty', #154)
  // and the per-id reconcile deletes, all scoped through each row's own backendId.
  applyIndexResults({ sessions: toIndex, deleteIds, metricsMode: 'if-nonempty' });
  stats.upserted = toIndex.length;
  stats.deleted = deleteIds.length;
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

// The Axis-B backends the index worker should scan: every ready+enabled backend that owns its OWN store
// (i.e. not Claude, not an Axis-A profile, and shaped like a scannable store). This is what main posts as
// the `roster` so the worker never calls `backends.list()` (B-1: in a worker `backendEnabled` is empty, so
// list() would fall back to Claude-only). Same filter refreshAllBackendSessions applies inline.
function axisBRoster() {
  let list;
  try { list = backends.list(); } catch { return []; }
  return list
    .filter(b => b.status === 'ready' && b.enabled && b.id !== 'claude' && !b.isProfile
      && typeof b.discoverSessions === 'function' && typeof b.parseSession === 'function')
    .map(b => b.id);
}

module.exports = {
  init,
  refreshBackendSessions,
  refreshAllBackendSessions,
  cachedRowsOfBackend,
  storeExists,
  // #199 step 5.2b: shared reply-replay + the roster main posts to the worker.
  applyBackendReply,
  axisBRoster,
};
