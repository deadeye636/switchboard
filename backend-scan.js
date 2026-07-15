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

const backends = require('./backends');
const { applyIndexResults, markPersisted, noteStoreProject, isRemovedProject } = require('./index-writes');
// #199 step 5.2a (F1): the PURE Axis-B parse-loop + its incremental memo live in the Electron-free leaf
// backend-parse.js, so the same code runs in the worker (which discovers + parses) and on main (which
// replays the reply below). This file holds the DB-touching orchestration only: the reply replay
// (applyBackendReply — noteStoreProject / markPersisted / isRemovedProject / the delete-diff / the neutral
// sink) and the `axisBRoster` main posts to the worker.

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

// The per-backend store scan is the pure `parseBackendSessions` loop (in the Electron-free leaf
// ./backend-parse.js) plus the DB-touching orchestration below (`applyBackendReply`). Both run in the index
// worker (`workers/index-worker.js` — discover + parse + the store-not-found guard) and on main (this file —
// the reply replay). There is no on-main scan entry point any more: the old `refreshBackendSessions`, which
// gathered the snapshot and ran the loop synchronously on the UI thread for the store watcher, was removed
// in #208 once the persistent worker became the only scan path. `parseBackendSessions` + `applyBackendReply`
// are the two halves the worker and main now share.

// Replay a `parseBackendSessions` reply — the DB / overlay / scan-state side-effects main owns. This is the
// ONE replay every Axis-B scan runs: the persistent index worker's reconcile reply handler
// (index-worker-client) and the test helper both call it, the reply being byte-identical whether the pure
// loop ran on-thread or in the worker.
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

// Every Axis-B scan runs OFF the main thread in the persistent index worker (#199/#208): postReconcile posts
// the `axisBRoster` below and the worker scans each backend, incl. the `force` re-read behind "Rebuild
// session cache" and the per-store-change flush the backend-store watcher (main.js) now posts instead of
// scanning inline.

// The Axis-B backends the index worker should scan: every ready+enabled backend that owns its OWN store
// (i.e. not Claude, not an Axis-A profile, and shaped like a scannable store). This is what main posts as
// the `roster` so the worker never calls `backends.list()` (B-1: in a worker `backendEnabled` is empty, so
// list() would fall back to Claude-only). This is the ready+enabled filter the reconcile sweep applies.
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
  cachedRowsOfBackend,
  // #199 step 5.2b: shared reply-replay + the roster main posts to the worker.
  applyBackendReply,
  axisBRoster,
};
