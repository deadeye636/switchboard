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

// The generic Axis-B parse-loop as a PURE function (#199 step 5.1b — the exact analogue of 5.1a's
// parseClaudeFolder). Snapshot-in, reply-out: it COMPUTES and RETURNS everything main must PERSIST, and
// persists NONE of it — no DB read, no sink call, no noteStoreProject / markPersisted / isRemovedProject
// inside. Its return IS the reply shape the step-5 worker will post; if a side-effect is not in the reply,
// main drops it even on-thread, so every one is represented.
//
// One deliberate, non-persisted exception it DOES mutate in place: the module-level `_axisBReadState` memo
// (the retained incremental parse-state — worker-owned in 5.2, like `_fileReadState` in 5.1a). It is
// process-local, single-threaded, and carries no cross-request state a reply would need.
//
// Worker-safe: it only touches the filesystem (statSync via the change gate; the descriptor's
// discoverSessions result is fed in as `handles`; parseSession / parseSessionIncremental; resolveWorktreePath
// / encodeProjectPath / the backend's sessionBucketPath) and that one memo. The DB-reading gates it must
// NOT do are resolved by main: `cachedRowsOfBackend` (the snapshot) arrives as `cachedByFile` + `cachedById`;
// `isRemovedProject` runs on main at APPLY time (it filters the row out of the sink but keeps it "seen"), so
// EVERY parsed row is shaped and returned here; `storeExists` (the store-not-found guard) stays on main.
//
// Reply fields (all load-bearing — see the step-5 "Corrections" in the plan):
//   sessions      — SHAPED rows (folder/projectPath/backendId/parserVersion + the db-mode changeMarker and
//                   the Hermes lineageParentId remap already applied — this is the row-shaping that is NOT
//                   the reader's, so it rides in the reply, not a prepare). Axis-B has no `prepare`.
//   seenIds       — every cached id STILL present (skipped-unchanged + re-read + shaped); with `seenFiles`
//                   it drives main's snapshot-scoped, per-cached-row delete-diff (file rows key on the file,
//                   db rows on the id — a db session has no file).
//   seenFiles     — every FILE handle visited (added before the change gate, so a skipped file counts).
//   skippedIds    — the #155 skip-path markPersisted ids (BOTH the file-mtime and db-marker skip branches);
//                   main replays markPersisted — a skipped session never reaches the sink.
//   storeProjects — [{projectPath, newestAt}] for EVERY parsed session, UNCONDITIONALLY (Axis-B's biggest
//                   #167 difference from Claude, which only notes the removed branch); main replays
//                   noteStoreProject — drop it and storeProjectPaths empties → syncRegistry breaks the
//                   tombstone/bring-back. `newestAt` is the RAW row's recency, captured before shaping
//                   overwrites row.modified.
//   incomplete    — `handles.incomplete` (#197): a partial read; main skips the reconcile delete-diff.
//   scanned/skipped — the stat counters (pure to compute; main copies them onto its return stats).
// (storeMissing is NOT computed here — storeExists is a main-side check; main handles it as an early return
//  before ever calling this loop, which IS the store-not-found gate.)
function parseBackendSessions(b, { handles, cachedByFile, cachedById, force = false }) {
  const reply = {
    sessions: [], seenIds: [], seenFiles: [], skippedIds: [], storeProjects: [],
    incomplete: !!handles.incomplete, scanned: 0, skipped: 0,
  };
  // A marker match is not enough on its own: bumping a parser does not touch a file's mtime or a Hermes
  // session's ended_at, so a row written by an older parser must be re-read (#152).
  const parserVersion = Number.isInteger(b.PARSER_SCHEMA_VERSION) ? b.PARSER_SCHEMA_VERSION : null;
  const parserCurrent = (hit) => parserVersion == null || hit.parserVersion === parserVersion;

  const seenFiles = new Set();
  const seenIds = new Set();

  for (const h of handles) {
    if (!h) continue;
    const isFile = h.kind === 'file' && !!h.path;
    const isDb = h.kind === 'db' && !!h.sessionId;
    if (!isFile && !isDb) continue;
    reply.scanned++;

    // The change gate. For a FILE store the mtime is the marker; for a DB store there is no file per
    // session, so the backend supplies its own marker on the handle.
    let changeKey;
    let hit;
    if (isFile) {
      seenFiles.add(h.path);
      try { changeKey = fs.statSync(h.path).mtime.toISOString(); } catch { continue; }
      hit = cachedByFile.get(h.path);
      if (!force && hit && hit.modified === changeKey && parserCurrent(hit)) {
        seenIds.add(hit.sessionId);
        // A SKIPPED session is a persisted one: its row is right there, carrying the authoritative
        // backendId. Only the upsert path used to say so (#155), so the overlay entry lived forever.
        // Report it — main replays markPersisted (a skipped session is never handed to the sink).
        reply.skippedIds.push(hit.sessionId);
        reply.skipped++;
        continue;
      }
    } else {
      changeKey = h.marker == null ? null : String(h.marker);
      hit = cachedById.get(h.sessionId);
      if (!force && hit && changeKey && hit.changeMarker === changeKey && parserCurrent(hit)) {
        seenIds.add(hit.sessionId);
        reply.skippedIds.push(hit.sessionId);
        reply.skipped++;
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

    // UNCONDITIONAL store sighting — the only place a removed project's sessions are ever seen, and both
    // the sweep and "a new session brings it back" hang off it (#167). Captured with the RAW row's recency
    // BEFORE the shaping below overwrites row.modified. Main replays noteStoreProject. Reported for EVERY
    // parsed session, removed or not — the removal check is main's, at apply time.
    reply.storeProjects.push({ projectPath, newestAt: row.lastEntryAt || row.modified || null });

    // Row-shaping (fs/pure, worker-safe — NOT a DB read, and NOT the reader's job, so it stays HERE and
    // rides in `sessions`). The REMOVED gate that used to `continue` here is gone: it is a DB read
    // (isRemovedProject) and runs on main at apply time instead — so a removed-project row is shaped and
    // returned like any other, and main is what declines to index it back in.
    row.folder = encodeProjectPath(projectPath);   // the SAME key Claude's folder for this cwd carries
    row.projectPath = projectPath;
    row.backendId = row.backendId || b.id;         // the parser already knows (Axis B = own root)
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
    reply.sessions.push(row);
  }

  reply.seenIds = [...seenIds];
  reply.seenFiles = [...seenFiles];
  return reply;
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
  stats.scanned = reply.scanned;
  stats.skipped = reply.skipped;

  // --- replay every side-effect from the reply (main owns the DB, the overlay and the scan-state) ---

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
  const toIndex = reply.sessions.filter(row => !isRemovedProject(row.projectPath));

  // The one neutral sink: upserts (with markPersisted + setName + per-day metrics 'if-nonempty', #154)
  // and the per-id reconcile deletes, all scoped through each row's own backendId.
  applyIndexResults({ sessions: toIndex, deleteIds, metricsMode: 'if-nonempty' });
  stats.upserted = toIndex.length;
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
