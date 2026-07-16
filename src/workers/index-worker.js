// The PERSISTENT index worker (#199 step 5.2b) — the off-thread parse for every backend.
//
// This is the lift the whole #199 structural pass was building toward: the fs-walk + stat + parse + the
// RISK-4b recursive `getFolderIndexMtimeMs` gate walk (measured at ~214 ms/tick on the main loop) all run
// HERE, on a worker thread, so the UI thread never blocks on them. Main keeps the DB: it posts a request,
// the worker parses incrementally against its OWN memos, and posts back the per-backend reply main then
// applies through the one neutral sink. One parser (this worker), one writer (main).
//
// ELECTRON-FREE (locked by test/worker-leaf-electron-free.test.js): it requires ONLY the two Electron-free
// parse LEAVES (folder-parse / backend-parse — their `_fileReadState` / `_axisBReadState` memos become
// worker-owned automatically, this module has its own instance of them), the fs-only gate/derive helpers,
// and the backends registry (verified to pull no electron at load, #199 precondition). NO electron, NO DB,
// NO index-writes.
//
// This is the ONE runtime path (#199): the env flag that used to gate it, and the inline parse loops main
// ran when it was off, were removed once the worker was validated in a live install. Main always spawns it.
//
// Protocol (see index-worker-client.js on the main side for the mirror image):
//   IN  reconcile{reqId, roster, roots, folderMeta, removedSet, snapshot}  — the periodic sweep
//       file{reqId, folder, path, projectPath, parentSessionId}            — the Claude watcher hot path
//       immediate{...file payload...}                                      — same, PRIORITY (jumps the queue)
//       rebuild{reqId, roster, roots, folderMeta, removedSet, snapshot}    — force re-parse (B-4, async)
//       rootCacheReset{}                                                   — clear the worker's _rootCache (F4)
//   OUT reply{reqId, kind:'reconcile'|'rebuild', claude:[{folder, reply}], backends:[{backendId, reply, storeMissing}]}
//       reply{reqId, kind:'file', session, sessionId}
//
// Each per-folder / per-backend `reply` is byte-for-byte what parseClaudeFolder / parseBackendSessions
// returns on-thread — main's replay (applyClaudeFolderReply / applyBackendReply) is the SAME code path.

'use strict';

const fs = require('fs');
const path = require('path');
const { parentPort } = require('worker_threads');

const { getFolderIndexMtimeMs } = require('../index/folder-index-state');
const { deriveProjectPath, _resetRootCache } = require('../session/derive-project-path');
const { parseClaudeFolder, parseClaudeFile } = require('../backends/claude/folder-parse');
const { parseBackendSessions } = require('../backends/parse');
// The registry — Electron-free at load (the #199 precondition). Used ONLY to resolve an Axis-B descriptor
// by id from the roster main posts; the worker NEVER calls backends.list() (B-1: a worker has no injected
// settings, so list() would fall back to Claude-only).
const backends = require('../backends');

// --- Claude reconcile (folder-shaped) --------------------------------------------------------------

// Resolve a folder's projectPath cheaply, mirroring store-indexer.folderProjectPath but fs-only: reuse the
// last-derived path (posted in folderMeta) while its directory still exists, else derive from the JSONL
// heads. The DB read folderProjectPath does (getFolderMeta) is replaced by the posted `folderMeta`.
function workerFolderProjectPath(folder, folderPath, folderMeta) {
  const known = folderMeta && folderMeta[folder];
  if (known && known.projectPath && fs.existsSync(known.projectPath)) return known.projectPath;
  return deriveProjectPath(folderPath);
}

// The Claude sweep: the reconcileCacheFromFilesystem gate walk (now off-thread) + the refreshFolder
// snapshot gather (DB reads replaced by the posted snapshot) + the pure parseClaudeFolder loop, per folder.
// Returns [{folder, reply}] for every folder that TRIPPED the gate — exactly the set refreshFolder ran on.
function runClaudeReconcile({ roots, folderMeta, removedSet, snapshot, force }) {
  const out = [];
  const projectsDir = roots && roots.claude;
  if (!projectsDir || !fs.existsSync(projectsDir)) return out;

  let folders;
  try {
    folders = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .map(d => d.name);
  } catch { return out; }

  const removed = removedSet instanceof Set ? removedSet : new Set(removedSet || []);
  const byFolder = (snapshot && snapshot.claudeByFolder) || {};

  for (const folder of folders) {
    const folderPath = path.join(projectsDir, folder);
    // The gate — the RISK-4b recursive stat walk, now on THIS thread. Trip a folder that is new or whose
    // newest .jsonl is newer than what main last indexed (or every folder under `force`).
    const indexMtimeMs = getFolderIndexMtimeMs(folderPath);
    const meta = folderMeta && folderMeta[folder];
    if (!force && meta && indexMtimeMs <= (meta.indexMtimeMs || 0)) continue;

    // --- snapshot gather (fs + the posted cache, no DB) ---
    const exists = fs.existsSync(folderPath);
    let projectPath = null;
    let isRemoved = false;
    const cachedMap = new Map();
    const cachedByFilePath = new Map();
    if (exists) {
      projectPath = workerFolderProjectPath(folder, folderPath, folderMeta);
      if (projectPath) {
        isRemoved = removed.has(projectPath);
        if (!isRemoved) {
          for (const row of byFolder[folder] || []) {
            const entry = { modified: row.modified, filePath: row.filePath, parserVersion: row.parserVersion };
            cachedMap.set(row.sessionId, entry);
            cachedByFilePath.set(entry.filePath, { dbId: row.sessionId, entry });
          }
        }
      }
    }

    const reply = parseClaudeFolder({
      folder, folderPath, exists, projectPath, removed: isRemoved,
      cachedMap, cachedByFilePath, indexMtimeMs,
    });
    out.push({ folder, reply });
  }
  return out;
}

// --- Axis-B reconcile (per-row) --------------------------------------------------------------------

// Does the backend's store exist? Mirrors backend-scan.storeExists (fs-only, worker-safe). Kept here so
// the worker can honour the store-not-found guard (an empty store means "wrong place", not "user deleted
// their history") without a round-trip to main.
function storeExists(b) {
  let targets;
  try { targets = (typeof b.watchTargets === 'function' && b.watchTargets()) || []; } catch { return true; }
  if (!targets.length) return true;
  return targets.some(t => {
    if (!t || !t.path) return false;
    try { return fs.existsSync(t.path); } catch { return false; }
  });
}

// One Axis-B backend: discover + the pure parseBackendSessions loop. Returns { backendId, reply,
// storeMissing }. `storeMissing` is the store-not-found guard — with no handles and a store that isn't
// there, main leaves the cached rows alone (it must not reconcile a whole history away because a directory
// moved). A store the worker cannot READ at all (unresolvable backend / discovery threw) is a different
// case: `unreadableBackendReply` (incomplete) — see the note in the body. The cached snapshot rides in
// `snapshot.backends[id]`.
function runBackendReconcile(backendId, { snapshot, force }) {
  // A reply that says "we could NOT determine this store's contents" — the worker couldn't resolve the
  // backend, it has no discover/parse, or discovery THREW (EMFILE/EACCES mid-walk, a locked db). It is NOT
  // "the store is empty": `incomplete: true` makes main's applyBackendReply keep the cached rows and skip
  // the reconcile delete-diff (#197), exactly as the old inline refreshBackendSessions returned early. An
  // empty reply with `incomplete: false` here would let the delete-diff wipe the backend's whole history on
  // a transient error — the residual data-loss #208 closed when this became the only scan path.
  const b = backends.get(backendId);
  if (!b) return { backendId, reply: unreadableBackendReply(), storeMissing: false };
  if (typeof b.discoverSessions !== 'function' || typeof b.parseSession !== 'function') {
    return { backendId, reply: unreadableBackendReply(), storeMissing: false };
  }

  let handles;
  try { handles = b.discoverSessions() || []; } catch { return { backendId, reply: unreadableBackendReply(), storeMissing: false }; }

  const cached = (snapshot && snapshot.backends && snapshot.backends[backendId]) || [];
  if (!handles.length && cached.length && !storeExists(b)) {
    return { backendId, reply: emptyBackendReply(), storeMissing: true };
  }

  const cachedByFile = new Map();
  const cachedById = new Map();
  for (const row of cached) {
    if (row.filePath) cachedByFile.set(row.filePath, row);
    cachedById.set(row.sessionId, row);
  }

  const reply = parseBackendSessions(b, { handles, cachedByFile, cachedById, force: !!force });
  return { backendId, reply, storeMissing: false };
}

function emptyBackendReply() {
  return { sessions: [], seenIds: [], seenFiles: [], skippedIds: [], storeProjects: [], incomplete: false, scanned: 0, skipped: 0 };
}

// Same as empty, but flagged `incomplete` — "we could not read this store", so main keeps every cached row
// instead of reconciling them away (see runBackendReconcile).
function unreadableBackendReply() {
  return { ...emptyBackendReply(), incomplete: true };
}

// --- request handling ------------------------------------------------------------------------------

function handleReconcile(msg, kind) {
  const roster = msg.roster || {};
  const force = kind === 'rebuild' || !!msg.force;
  const claude = roster.claudeEnabled
    ? runClaudeReconcile({ roots: msg.roots, folderMeta: msg.folderMeta, removedSet: msg.removedSet, snapshot: msg.snapshot, force })
    : [];
  const axisB = Array.isArray(roster.axisB) ? roster.axisB : [];
  const backendsOut = axisB.map(id => runBackendReconcile(id, { snapshot: msg.snapshot, force }));
  return { type: 'reply', reqId: msg.reqId, kind, claude, backends: backendsOut };
}

function handleFile(msg) {
  const parsed = parseClaudeFile(msg.path, msg.folder, msg.projectPath, { parentSessionId: msg.parentSessionId });
  return { type: 'reply', reqId: msg.reqId, kind: 'file', session: parsed.session, sessionId: parsed.sessionId };
}

// Process ONE request to completion and post its reply. Parsing is synchronous (all fs sync), so a request
// runs start-to-finish here; the priority lane is realised by the drain loop below reordering the QUEUE,
// not by interrupting an in-flight parse (no ordering hazard).
function runRequest(msg) {
  try {
    switch (msg.type) {
      case 'reconcile': return parentPort.postMessage(handleReconcile(msg, 'reconcile'));
      case 'rebuild':   return parentPort.postMessage(handleReconcile(msg, 'rebuild'));
      case 'file':
      case 'immediate': return parentPort.postMessage(handleFile(msg));
      case 'rootCacheReset':
        try { _resetRootCache(); } catch {}
        if (msg.reqId != null) parentPort.postMessage({ type: 'reply', reqId: msg.reqId, kind: 'rootCacheReset' });
        return;
      default:
        return; // unknown request type — ignore rather than crash the worker
    }
  } catch (err) {
    // Never let a single bad request take the worker down — main respawns on a crash (empty memo,
    // self-healing), but a caught error keeps the memo and reports the failure for that reqId.
    if (msg && msg.reqId != null) {
      parentPort.postMessage({ type: 'error', reqId: msg.reqId, error: (err && err.message) || String(err) });
    }
  }
}

// A priority queue drained one item per micro-turn so an `immediate` (stop-hook lane) that arrives while a
// bulk reconcile is still QUEUED jumps ahead of it. `rootCacheReset` is also fronted — a stale root must be
// cleared before the next parse reads it.
const queue = [];
let draining = false;

function enqueue(msg) {
  if (msg && (msg.type === 'immediate' || msg.type === 'rootCacheReset')) queue.unshift(msg);
  else queue.push(msg);
  if (!draining) { draining = true; setImmediate(drain); }
}

function drain() {
  if (!queue.length) { draining = false; return; }
  const msg = queue.shift();
  runRequest(msg);
  // Yield between items: a newly-arrived immediate can jump to the front before the next item runs.
  setImmediate(drain);
}

// Attach the message pump only when actually running as a worker. Requiring this module in the MAIN thread
// (the direct-drive smoke test does exactly that) has no parentPort — the exported functions are then
// driven directly, no IPC.
if (parentPort) parentPort.on('message', enqueue);

// Exposed for the direct-drive worker smoke test (test/index-worker.test.js), which imports this module in
// the same thread rather than spawning it, so it can assert the reply shape without an IPC round-trip.
module.exports = {
  runClaudeReconcile,
  runBackendReconcile,
  handleReconcile,
  handleFile,
  storeExists,
};
