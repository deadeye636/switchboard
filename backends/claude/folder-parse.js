// Claude's PURE parse-loops — the Electron-free LEAF (#199 step 5.2a / F1 + F2).
//
// This holds the two pure Claude read-loops (`parseClaudeFolder`, `parseClaudeFile`) + the per-file
// retained-parse-state memo (`_fileReadState` / `rememberFileReadState`) they share, lifted out of
// store-indexer.js so the step-5 index worker can require THIS module without dragging in electron.
//
// ELECTRON-FREE PRECONDITION (locked by test/worker-leaf-electron-free.test.js): this file requires ONLY
// fs/path + fs-only helpers — folder-index-state, Claude's session-reader (the format layer), and
// (transitively, through the reader) derive-project-path / metrics-bucket. It must NEVER require
// index-writes (→ backends registry + a Worker spawn) or the backends registry, or electron. store-indexer
// re-imports these functions so there is ONE implementation and no drift; the DB-touching orchestration
// (snapshot gather, the sink, noteStoreProject / cancelReindex / setFolderMeta / the delete-diff) stays on
// main in store-indexer.js.
//
// The Claude format readers are reached DIRECTLY off session-reader here (not through the backends
// descriptor as store-indexer does) precisely so this leaf need not require the registry.

const fs = require('fs');
const { getFolderIndexMtimeMs } = require('../../folder-index-state');
// Reached via the NAMESPACE (not destructured) so the reader functions stay patchable at the
// session-reader module for the reconcile characterization tests — store-indexer used to route these
// through the `claude` descriptor, which was the mock seam; the leaf goes direct-to-reader (F1), so the
// seam is the reader module itself. PARSER_SCHEMA_VERSION is a constant, captured once.
const sessionReader = require('./session-reader');
const CLAUDE_PARSER_VERSION = sessionReader.PARSER_SCHEMA_VERSION;

// Per-file incremental read state (perf #74): filePath -> { offset, state, metrics } as returned by
// readSessionFileIncremental. Lets a watcher flush on a large live transcript read only the
// newly-appended bytes. In-memory only; bounded so weeks of touched files can't grow unchecked. Shared by
// BOTH readers of Claude's store — the debounced refreshFile hot path (via parseClaudeFile) and the
// reconcile sweep's refreshFolder (via parseClaudeFolder). Worker-owned once step 5.2b lands.
const _fileReadState = new Map();
const FILE_READ_STATE_MAX = 512;

// Store the retained parse state for a file, evicting the oldest entry when the memo is full (an evicted
// entry just costs one full re-read).
function rememberFileReadState(filePath, next) {
  _fileReadState.set(filePath, next);
  if (_fileReadState.size > FILE_READ_STATE_MAX) {
    _fileReadState.delete(_fileReadState.keys().next().value);
  }
}

// The Claude parse-loop as a PURE function (#199 step 5.1a). Snapshot-in, reply-out: it COMPUTES and
// RETURNS everything main must PERSIST, and persists NONE of it — no DB read, no sink call, no
// noteStoreProject / cancelReindex / setFolderMeta. Its return IS the reply shape the step-5 worker will
// post; if a side-effect is not in the reply, main drops it even on-thread, so every one is represented.
// The ONE deliberate, non-persisted exception it mutates in place: the module-level `_fileReadState` memo
// (the incremental offsets — worker-owned in 5.2), which is process-local, single-threaded, and carries no
// cross-request state a reply would need. (#199 step 5.2a/F3: the perf counters are RETURNED in reply.stats
// now, not mutated on a caller-supplied object — a by-reference accumulator can't cross a thread.)
//
// Worker-safe: it only touches the filesystem (statSync, enumerateSessionFiles, readSessionFileIncremental,
// getFolderIndexMtimeMs) and the module-level `_fileReadState` memo. The DB-reading gates it must not do —
// `folderProjectPath` (needs getFolderMeta) and `isRemovedProject` — are resolved by main and fed in as
// `projectPath` / `removed`; the cached-rows snapshot arrives as `cachedMap` + `cachedByFilePath` (built by
// main from getCachedByFolder). stampClaudeProvenance is NOT applied here (it reads the launch overlay,
// main-only) — the loop returns RAW sessions and main prepares them.
//
// Reply fields (all load-bearing — see the step-5 "Corrections" in the plan):
//   sessions        — RAW parsed rows (main maps stampClaudeProvenance, then the sink writes them)
//   seenIds         — every cached id STILL present (unchanged-skipped + re-read); main's snapshot-scoped
//                     delete-diff = cachedMap.keys() − seenIds (NOT liveCache − seenIds — fable finding 2)
//   seenFiles       — every .jsonl visited (forward-compat with the worker's file-based diff)
//   reReadFiles     — files this pass actually re-read; main cancelReindex()es each (the debounce timers
//                     live on main — dropping this reintroduces the #199 double-read)
//   skippedIds      — the #155 skip-path markPersisted ids (empty for Claude's loop; carried for shape)
//   folderStamps    — [{folder, projectPath, indexMtimeMs}] for EVERY visited folder incl. removed /
//                     no-projectPath / vanished-with-projectPath, or the sweep gate re-trips every tick
//   vanishedFolders — folder gone at walk time; main does the scoped cached-folder delete WITHOUT the
//                     matching search-folder delete (the A-4 asymmetry)
//   storeProjects   — [{projectPath, newestAt}] for a REMOVED folder; main replays noteStoreProject
//                     (drop it and storeProjectPaths empties → syncRegistry breaks the #167 bring-back)
//   stats           — {filesFull, filesIncremental, bytes} the perf counters, RETURNED (F3) so main folds
//                     them into the sweep accumulator; a by-reference mutation can't cross a thread
//   changed         — whether any file was (re-)read (main ORs in the delete count it computes)
function parseClaudeFolder({ folder, folderPath, exists, projectPath, removed, cachedMap, cachedByFilePath, indexMtimeMs }) {
  const reply = {
    sessions: [], seenIds: [], seenFiles: [], reReadFiles: [], skippedIds: [],
    folderStamps: [], vanishedFolders: [], storeProjects: [],
    stats: { filesFull: 0, filesIncremental: 0, bytes: 0 }, changed: false,
  };
  const stampMtimeMs = () => (indexMtimeMs != null ? indexMtimeMs : getFolderIndexMtimeMs(folderPath));

  // VANISHED-FOLDER branch (#199 step-4 footnote A-4): report it so main does the EXACT asymmetric delete —
  // deleteCachedFolder WITHOUT deleteSearchFolder. A pre-existing FTS-orphan asymmetry: the cache-first
  // order makes a scoped search wipe impossible here anyway (the scoped FTS delete resolves backendId
  // through the very rows this deletes). Routing it through the sink's search-first wipeFolders would
  // CHANGE behaviour (arguably fix the orphan) — kept as-is to stay behaviour-identical.
  if (!exists) {
    reply.vanishedFolders.push(folder);
    reply.changed = true;
    return reply;
  }

  // No projectPath (undeterminable cwd): stamp the folder so the gate does not re-trip, nothing else.
  if (!projectPath) {
    reply.folderStamps.push({ folder, projectPath: null, indexMtimeMs: stampMtimeMs() });
    return reply;
  }

  // REMOVED project: don't index its folder back into the cache (a hidden one still is — #167). What the
  // folder holds, and how recent it is, still has to be REPORTED so the sweep does not forget a removal
  // while its transcripts are there, and a session NEWER than the removal brings the project back. The
  // `newestAt` is the folder index mtime (matching the pre-extraction `newestMs = getFolderIndexMtimeMs`),
  // NOT a session parse — so this branch reads no session file, exactly as before.
  if (removed) {
    const newestMs = getFolderIndexMtimeMs(folderPath);
    reply.storeProjects.push({ projectPath, newestAt: newestMs ? new Date(newestMs).toISOString() : null });
    reply.folderStamps.push({ folder, projectPath, indexMtimeMs: stampMtimeMs() });
    return reply;
  }

  // --- the parse-loop proper ---
  const seen = new Set();   // cached ids + re-read session ids still present this pass
  for (const { filePath, parentSessionId } of sessionReader.enumerateSessionFiles(folderPath)) {
    // We need the DB sessionId to look up the cache, but we don't know it until after the read — for
    // subagents it's sub:<parent>:<agentId>. Use the file path to find a matching cached entry instead.
    let fileMtime;
    try { fileMtime = fs.statSync(filePath).mtime.toISOString(); } catch { continue; }
    reply.seenFiles.push(filePath);

    const cachedHit = cachedByFilePath.get(filePath) || null;
    const cachedEntry = cachedHit ? cachedHit.entry : null;
    const cachedDbId = cachedHit ? cachedHit.dbId : null;

    if (cachedDbId !== null) seen.add(cachedDbId);

    // The staleness gate. An unchanged file is skipped — UNLESS the parser that wrote the cached row is
    // not the parser that would read it now (#152). A parser change does not touch the file's mtime.
    if (cachedEntry && cachedEntry.modified === fileMtime && cachedEntry.parserVersion === CLAUDE_PARSER_VERSION) {
      continue; // unchanged, and read by the parser we still have
    }

    // File is new or modified — re-read it INCREMENTALLY, sharing the watcher's memo (#199 step 2). We
    // hand the memo over, we do NOT delete it. This is the #194 parity fix applied to Claude.
    const prev = _fileReadState.get(filePath) || null;
    const res = sessionReader.readSessionFileIncremental(filePath, folder, projectPath, { parentSessionId }, prev);
    if (res) {
      rememberFileReadState(filePath, res.next);
      // full-vs-incremental is classified by whether a memo existed (the dominant signal); a rare
      // fingerprint-mismatch full re-read with a memo is counted as incremental, but the reader does
      // not expose which branch it took and the counter is diagnostic, not load-bearing.
      if (prev) { reply.stats.filesIncremental++; reply.stats.bytes += Math.max(0, res.next.offset - prev.offset); }
      else { reply.stats.filesFull++; reply.stats.bytes += res.next.offset; }
      // This sweep just read the file — main must cancel any pending debounced refreshFile for it so the
      // watcher flush doesn't redo the same read+FTS work a moment later (#199 step 2).
      reply.reReadFiles.push(filePath);
      const s = res.session;
      seen.add(s.sessionId); // ensure main doesn't delete a newly-read subagent row
      reply.sessions.push(s); // RAW — main applies stampClaudeProvenance before the sink
    } else {
      // Not (yet) a valid session, or it became invalid — drop any stale memo so the next touch starts
      // from a clean full read (mirrors refreshFile).
      _fileReadState.delete(filePath);
    }
    reply.changed = true;
  }

  reply.seenIds = [...seen];
  reply.folderStamps.push({ folder, projectPath, indexMtimeMs: stampMtimeMs() });
  return reply;
}

// The single-FILE watcher lane as a PURE function (#199 step 5.2a / F2). refreshFile (store-indexer.js)
// used to interleave the DB reads with this incremental fs read; this is the READ half lifted out — an
// incremental single-file read against the SAME `_fileReadState` memo. Main keeps the DB half (removed
// check, the #60 rename straddle, setFolderMeta, the vanished-file delete) so deletes never lag.
//
// Worker-safe: only readSessionFileIncremental + the memo. Returns {session|null, sessionId, next}:
//   session   — the parsed row (RAW; main applies stampClaudeProvenance before the sink), or null when the
//               file is not yet a valid session (no first user turn) or became invalid — in which case the
//               stale memo is already dropped here, mirroring the old refreshFile behaviour.
//   sessionId — session.sessionId when there is one, else null (convenience for main).
//   next      — the retained parse state that was just remembered (null on a null read).
function parseClaudeFile(filePath, folder, projectPath, { parentSessionId } = {}) {
  const prev = _fileReadState.get(filePath) || null;
  const res = sessionReader.readSessionFileIncremental(filePath, folder, projectPath, { parentSessionId }, prev);
  if (!res) {
    // null = file not yet a valid session or became invalid. Drop any existing memo so the next touch
    // starts from a clean full read (mirrors refreshFile).
    _fileReadState.delete(filePath);
    return { session: null, sessionId: null, next: null };
  }
  rememberFileReadState(filePath, res.next);
  return { session: res.session, sessionId: res.session.sessionId, next: res.next };
}

module.exports = {
  parseClaudeFolder,
  parseClaudeFile,
  _fileReadState,
  rememberFileReadState,
  FILE_READ_STATE_MAX,
};
