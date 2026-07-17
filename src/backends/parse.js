// The generic Axis-B PURE parse-loop — the Electron-free LEAF (#199 step 5.2a / F1).
//
// This holds the generic Axis-B read-loop (`parseBackendSessions`) + its retained-parse-state memo
// (`_axisBReadState`), lifted out of backend-scan.js so the step-5 index worker can require THIS module
// without dragging in electron. backend-scan re-imports `parseBackendSessions` (ONE implementation, no
// drift); the DB-touching orchestration (snapshot gather, storeExists, the sink, noteStoreProject /
// markPersisted / isRemovedProject / the delete-diff) stays on main in backend-scan.js.
//
// ELECTRON-FREE PRECONDITION (locked by test/worker-leaf-electron-free.test.js): this file requires ONLY
// fs + fs-only helpers (derive-project-path, encode-project-path). It takes the backend descriptor `b` as a
// PARAMETER (main passes it) so the leaf itself never requires the backends registry — and it must NEVER
// require index-writes (→ registry + a Worker spawn) or electron.

const fs = require('fs');
const { resolveWorktreePath } = require('../session/derive-project-path');
const { encodeProjectPath } = require('../session/encode-project-path');

// The same retained-parse-state memo, for the Axis-B file backends (#194). Their generic scan/watcher
// flush used to full-parse every CHANGED file. Keyed by file path → the backend's opaque `parseState`;
// disjoint from Claude's `_fileReadState` (Claude's store never shares a path with a Codex/Pi store).
// Worker-owned once step 5.2b lands.
const _axisBReadState = new Map();
const FILE_READ_STATE_MAX = 512;

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
// EVERY parsed row is shaped and returned here; `storeExists` (the store-not-found guard) stays on main. The
// descriptor `b` is a PARAMETER (main passes it), so this leaf need not require the registry.
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
        row.lineageKind = 'parent'; // a backend-recorded hard link (#193), not a heuristic guess
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

module.exports = {
  parseBackendSessions,
  _axisBReadState,
  FILE_READ_STATE_MAX,
};
