// The MAIN-side client for the persistent index worker (#199 step 5.2b).
//
// This is the other half of workers/index-worker.js: it owns the worker's LIFECYCLE (spawn once, respawn
// on crash, terminate on quit) and does everything the worker must not — the DB reads that build the
// request snapshot, and the DB writes that replay each reply through the one neutral sink. Main is the sole
// writer; the worker is the sole parser.
//
// This is the ONE runtime path (#199): the env flag that used to gate it (and the inline parse loops it
// duplicated) were removed once the worker was validated in a live install. The reconcile / file / rebuild
// paths post a request here instead of parsing on the UI thread.
//
// The reply-apply is the SAME code a synchronous refresh runs: store-indexer.applyClaudeFolderReply /
// applyClaudeFileReply and backend-scan.applyBackendReply — the reply the worker posts is byte-identical to
// what the pure parse-loop returns on-thread, so there is one replay, no drift.

'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const storeIndexer = require('./backends/claude/store-indexer');
const backendScan = require('./backend-scan');
const indexWrites = require('./index-writes');

let PROJECTS_DIR, log;
let getAllCached, getAllFolderMeta, setFolderMeta, getFolderIndexMtimeMs;
let isAppQuitting = () => false;
let afterReconcile = () => {};   // main hook: syncRegistry + applyAutoHide + notify, run after an apply
let onFileApplied = () => {};    // main hook: the rename/notify already runs in applyClaudeFileReply

function init(ctx) {
  PROJECTS_DIR = ctx.PROJECTS_DIR;
  log = ctx.log || console;
  getAllCached = ctx.db.getAllCached;
  getAllFolderMeta = ctx.db.getAllFolderMeta;
  setFolderMeta = ctx.db.setFolderMeta;
  getFolderIndexMtimeMs = require('./folder-index-state').getFolderIndexMtimeMs;
  if (typeof ctx.isAppQuitting === 'function') isAppQuitting = ctx.isAppQuitting;
  if (typeof ctx.afterReconcile === 'function') afterReconcile = ctx.afterReconcile;
  if (typeof ctx.onFileApplied === 'function') onFileApplied = ctx.onFileApplied;
}

// --- worker lifecycle ------------------------------------------------------------------------------

let worker = null;
let reqSeq = 0;
const pending = new Map();   // reqId -> { resolve, ctx } — awaits a reply, carrying the retained snapshot

// The delete-epoch guard (both lanes). A row deleted on main AFTER a request was posted must not be
// reverse-resurrected by that request's (older) reply. Each delete is stamped with the current sequence;
// a reply for a request posted at seq S drops any session whose delete-seq >= S.
const deletedAt = new Map();   // sessionId -> seq at delete time
function noteDeleted(sessionId) {
  if (sessionId) deletedAt.set(sessionId, reqSeq);
}
function dropIdsSince(postedSeq) {
  const out = new Set();
  for (const [id, seq] of deletedAt) if (seq >= postedSeq) out.add(id);
  return out;
}
// Bound the delete ledger: once no request older than a delete is still outstanding, that delete can never
// resurrect anything, so forget it.
function pruneDeleted() {
  if (!pending.size) { deletedAt.clear(); return; }
  let minSeq = Infinity;
  for (const p of pending.values()) if (p.postedSeq < minSeq) minSeq = p.postedSeq;
  for (const [id, seq] of deletedAt) if (seq < minSeq) deletedAt.delete(id);
}

// --- postReconcile COALESCING (#199 step 5.3, fix 1) -----------------------------------------------
// A burst of get-projects fired 6+ back-to-back reconcile posts. Mirror the inline queueIndexSweep's
// `indexSweepQueued` guard: while a (non-force) reconcile is OUTSTANDING (posted, reply not yet applied) a
// new postReconcile only ARMS a trailing flag instead of posting again, so a burst yields at most ONE
// in-flight reconcile + ONE trailing. When the in-flight reply settles the trailing sweep re-holds the gate,
// so the last genuinely-needed sweep still runs. `force` (rebuild — awaited, rare) bypasses the gate.
let reconcileInFlight = false;   // a gate-holding non-force reconcile is posted, its reply not yet applied
let reconcileTrailing = false;   // a further sweep was requested while the gate was held — run one after

// The gate-holding request settled (applied or errored). Re-hold the gate with the trailing sweep if one was
// armed (reconcileInFlight stays true across the re-post — the gate is continuously held), else release it.
// Called from every NORMAL settle path so the gate can never wedge shut.
function afterGateSettled() {
  if (reconcileTrailing && !isAppQuitting()) {
    reconcileTrailing = false;
    doPostReconcile({ force: false, gate: true });
  } else {
    reconcileInFlight = false;
  }
}
// Worker gone (crash/quit): clear the gate WITHOUT firing a trailing — a late reply must not spawn a fresh
// worker mid-teardown, and the reconcile safety-net + the next get-projects re-trigger a sweep anyway.
function clearReconcileGate() { reconcileInFlight = false; reconcileTrailing = false; }

// --- per-file liveness push COALESCING (#199 step 5.3, fix 4) --------------------------------------
// The flag-OFF path fires ONE `projects-changed` per watcher flush; the worker file lane used to push per
// apply (`onFileApplied`), a storm on a busy multi-agent session. Collapse a burst of file replies into one
// trailing push — a trailing debounce capped by a max-wait, the same shape as the watcher's flush — without
// dropping the eventual convergence (the last file always leaves a pending push).
let _filePushTimer = null;
let _filePushFirstAt = 0;
const FILE_PUSH_DEBOUNCE_MS = 300;
const FILE_PUSH_MAX_WAIT_MS = 1000;
function coalesceFilePush() {
  const now = Date.now();
  if (!_filePushTimer) _filePushFirstAt = now;
  const delay = Math.min(FILE_PUSH_DEBOUNCE_MS, Math.max(0, FILE_PUSH_MAX_WAIT_MS - (now - _filePushFirstAt)));
  if (_filePushTimer) clearTimeout(_filePushTimer);
  _filePushTimer = setTimeout(flushFilePush, delay);
  if (typeof _filePushTimer.unref === 'function') _filePushTimer.unref();
}
function flushFilePush() {
  if (_filePushTimer) { clearTimeout(_filePushTimer); _filePushTimer = null; }
  if (isAppQuitting()) return;
  try { onFileApplied(); } catch {}
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'workers', 'index-worker.js'));
  worker.on('message', onReply);
  worker.on('error', (err) => {
    log.warn(`[index-worker] crashed: ${err?.message || err} — respawning (empty memo, self-healing)`);
    respawn();
  });
  worker.on('exit', (code) => {
    if (code !== 0 && !isAppQuitting()) {
      log.warn(`[index-worker] exited ${code} — respawning`);
      respawn();
    }
  });
  return worker;
}

// Crash → drop the handle and let the next request spawn a fresh one. The in-flight requests are settled so
// no caller hangs; a lost reconcile is caught by the next sweep, a lost file event by the reconcile safety
// net. The new worker starts with an EMPTY memo — one round of full re-reads, then incremental again (#194/
// #200: full == incremental in result, only slower once).
function respawn() {
  const dead = worker;
  worker = null;
  if (dead) { try { dead.removeAllListeners(); dead.terminate(); } catch {} }
  for (const [, p] of pending) { try { p.resolve(); } catch {} }
  pending.clear();
  clearReconcileGate();   // the gate-holding request is lost with the worker — don't wedge future sweeps
}

function terminate() {
  const dead = worker;
  worker = null;
  if (dead) { try { dead.removeAllListeners(); dead.terminate(); } catch {} }
  pending.clear();
  clearReconcileGate();
  if (_filePushTimer) { clearTimeout(_filePushTimer); _filePushTimer = null; }
}

// --- request snapshot (the DB reads the worker must not do) ----------------------------------------

// The Axis-B backend ids — everything the Claude scope EXCLUDES. Rows whose backendId is one of these are
// an Axis-B store's own; every other row (incl. NULL→'claude' and Axis-A profiles) is in the Claude scope.
function axisBIdSet() {
  const scope = indexWrites.claudeStoreScope();   // { except: [axis-B ids] }
  return new Set((scope && scope.except) || []);
}

// Build the compact snapshot main posts + RETAINS. The retained copy (cachedMap per folder, cached rows per
// backend) is what the reply-apply diffs against — never a fresh liveCache read at apply time (fable
// finding 2). Returns { post, retained }.
function buildSnapshot(roster) {
  const rows = (typeof getAllCached === 'function' && getAllCached()) || [];
  const axisB = axisBIdSet();

  // Claude scope: grouped by folder, filePath RESOLVED exactly as refreshFolder's snapshot does.
  const claudeByFolder = {};              // folder -> [{sessionId, modified, filePath, parserVersion}]
  const retainedClaude = new Map();       // folder -> Map(sessionId -> {modified, filePath, parserVersion})
  // Axis-B: the per-backend cached rows, kept whole (applyBackendReply needs row.filePath/sessionId).
  const backendRows = {};                 // backendId -> [row]
  const retainedBackends = new Map();     // backendId -> [row]

  for (const row of rows) {
    const backendId = row.backendId || 'claude';
    if (axisB.has(backendId)) {
      (backendRows[backendId] = backendRows[backendId] || []).push(row);
      continue;
    }
    // Claude-scope row.
    const filePath = storeIndexer.resolveRowFilePath(row);
    const entry = { sessionId: row.sessionId, modified: row.modified, filePath, parserVersion: row.parserVersion };
    (claudeByFolder[row.folder] = claudeByFolder[row.folder] || []).push(entry);
    let m = retainedClaude.get(row.folder);
    if (!m) { m = new Map(); retainedClaude.set(row.folder, m); }
    m.set(row.sessionId, { modified: row.modified, filePath, parserVersion: row.parserVersion });
  }
  for (const id of roster.axisB) retainedBackends.set(id, backendRows[id] || []);

  const backendsSnap = {};
  for (const id of roster.axisB) backendsSnap[id] = backendRows[id] || [];

  return {
    post: { claudeByFolder, backends: backendsSnap },
    retained: { claude: retainedClaude, backends: retainedBackends },
  };
}

// folderMeta (indexMtimeMs + projectPath per folder) + the removed-projectPath set the worker short-
// circuits Claude removed folders on. Both DB reads → done here, posted to the worker.
function buildFolderContext() {
  const metaMap = (typeof getAllFolderMeta === 'function' && getAllFolderMeta()) || new Map();
  const folderMeta = {};
  const removedSet = [];
  for (const [folder, meta] of metaMap) {
    folderMeta[folder] = { indexMtimeMs: meta.indexMtimeMs, projectPath: meta.projectPath };
    if (meta.projectPath && storeIndexer.isRemovedProject(meta.projectPath)) removedSet.push(meta.projectPath);
  }
  return { folderMeta, removedSet };
}

function roster() {
  return { claudeEnabled: storeIndexer.claudeEnabled(), axisB: backendScan.axisBRoster() };
}

// --- posting ---------------------------------------------------------------------------------------

// Instrument the postMessage so 5.3 can A/B the clone+IPC cost against the removed 214 ms gate walk. Cheap
// counts always (folder/row totals), and the wall time of the synchronous structured-clone that
// postMessage does before it returns. NOT the flip — 5.3 measures and decides.
let _testTransport = null;   // test seam: when set, requests go here instead of a spawned Worker
function instrumentedPost(msg, sizeHint) {
  const t = Date.now();
  if (_testTransport) _testTransport(msg);
  else ensureWorker().postMessage(msg);
  const ms = Date.now() - t;
  log.debug(`[index-worker] post ${msg.type} reqId=${msg.reqId} clone~${sizeHint.folders}f/${sizeHint.rows}rows postMs=${ms}`);
}

// The periodic reconcile sweep. Returns a Promise that resolves once the reply has been applied. Non-force
// sweeps are COALESCED through the gate (fix 1): a burst posts at most one in-flight + one trailing.
function postReconcile({ force = false } = {}) {
  if (isAppQuitting()) return Promise.resolve(false);
  if (!force) {
    if (reconcileInFlight) { reconcileTrailing = true; return Promise.resolve(false); }
    reconcileInFlight = true;
    return doPostReconcile({ force: false, gate: true });
  }
  return doPostReconcile({ force: true, gate: false });
}

// Actually build the snapshot + post the request. `gate` marks the one reconcile that holds the coalescing
// gate, so its settle re-holds/releases it (afterGateSettled). Force posts never hold the gate.
function doPostReconcile({ force = false, gate = false } = {}) {
  const r = roster();
  const { post: snapshot, retained } = buildSnapshot(r);
  const { folderMeta, removedSet } = buildFolderContext();
  const reqId = ++reqSeq;
  const postedSeq = reqSeq;

  const sizeHint = {
    folders: Object.keys(snapshot.claudeByFolder).length,
    rows: Object.values(snapshot.claudeByFolder).reduce((n, a) => n + a.length, 0)
      + Object.values(snapshot.backends).reduce((n, a) => n + a.length, 0),
  };

  return new Promise((resolve) => {
    pending.set(reqId, { resolve, postedSeq, retained, kind: force ? 'rebuild' : 'reconcile', gate });
    instrumentedPost({
      type: force ? 'rebuild' : 'reconcile',
      reqId, roster: r, roots: { claude: PROJECTS_DIR },
      folderMeta, removedSet, snapshot, force,
    }, sizeHint);
  });
}

// The Claude single-file lane (watcher hot path). The DB pre-work that must not lag or cross the thread —
// the removed short-circuit, the vanished-file delete, the up-front folder stamp — runs on main via
// storeIndexer.refreshFilePrepare; then the parse is posted. F2: parseClaudeFile runs in the worker; the
// #60 rename straddle + sink run on the reply. Returns a Promise that resolves once applied (or immediately
// when the event was fully handled by the pre-work — nothing to parse).
function postFile(folder, relFilename, { immediate = false } = {}) {
  if (isAppQuitting()) return Promise.resolve();
  const prep = storeIndexer.refreshFilePrepare(folder, relFilename);
  if (!prep) return Promise.resolve();
  if (prep.deletedId) { noteDeleted(prep.deletedId); return Promise.resolve(); }

  const reqId = ++reqSeq;
  const postedSeq = reqSeq;
  return new Promise((resolve) => {
    pending.set(reqId, { resolve, postedSeq, kind: 'file' });
    instrumentedPost({
      type: immediate ? 'immediate' : 'file',
      reqId, folder, path: prep.filePath, projectPath: prep.projectPath, parentSessionId: prep.parentSessionId,
    }, { folders: 1, rows: 1 });
  });
}

function postRootCacheReset() {
  if (!worker) return;   // nothing to reset — a fresh worker has an empty cache anyway
  ensureWorker().postMessage({ type: 'rootCacheReset' });
}

// --- reply handling --------------------------------------------------------------------------------

function onReply(msg) {
  const p = msg && msg.reqId != null ? pending.get(msg.reqId) : null;
  if (msg && msg.type === 'error') {
    if (p) { pending.delete(msg.reqId); pruneDeleted(); p.resolve(); if (p.gate) afterGateSettled(); }
    log.warn(`[index-worker] request ${msg.reqId} failed: ${msg.error}`);
    return;
  }
  if (!p) return;
  pending.delete(msg.reqId);

  // The appQuitting guard: a late reply must NOT write to a closed DB (#76/#90 at the new seam). Checked
  // BEFORE any apply. Terminate-then-close alone can't cover an already-posted reply.
  if (isAppQuitting()) { pruneDeleted(); p.resolve(); if (p.gate) clearReconcileGate(); return; }

  try {
    if (msg.kind === 'file') applyFileReply(msg, p);
    else if (msg.kind === 'reconcile' || msg.kind === 'rebuild') applyReconcileReply(msg, p);
  } catch (err) {
    log.warn(`[index-worker] apply ${msg.kind} failed: ${err?.message || err}`);
  } finally {
    pruneDeleted();
    p.resolve(msg.kind === 'file' ? undefined : true);
    if (p.gate) afterGateSettled();
  }
}

function applyReconcileReply(msg, p) {
  const dropIds = dropIdsSince(p.postedSeq);
  const scope = indexWrites.claudeStoreScope();
  const stats = { filesFull: 0, filesIncremental: 0, bytes: 0 };

  for (const { folder, reply } of msg.claude || []) {
    const cachedMap = (p.retained && p.retained.claude.get(folder)) || new Map();
    // Removed-race (fix 3): a project removed AFTER the snapshot is NOT in the worker's posted removedSet, so
    // the worker parsed + indexed it. dropIds (the delete-epoch guard) covers deletes, not removes — so
    // re-check isRemovedProject FRESH on main and drop this folder's parsed rows, mirroring refreshFolder's
    // removed short-circuit (the already-cached rows are left alone; #167 "remove ≠ delete").
    let folderDrop = dropIds;
    const pp = replyProjectPath(reply, folder);
    if (pp && storeIndexer.isRemovedProject(pp)) {
      folderDrop = new Set(dropIds);
      for (const s of reply.sessions || []) if (s && s.sessionId) folderDrop.add(s.sessionId);
    }
    storeIndexer.applyClaudeFolderReply(folder, reply, { scope, cachedMap, stats, dropIds: folderDrop });
  }

  for (const { backendId, reply, storeMissing } of msg.backends || []) {
    if (storeMissing) continue;   // mirror refreshBackendSessions' early return — keep the cached rows
    const cached = (p.retained && p.retained.backends.get(backendId)) || [];
    backendScan.applyBackendReply(backendId, reply, { cached, stats: {}, dropIds });
  }

  // syncRegistry + applyAutoHide + the projects-changed push — main's post-sweep upkeep (runs on main).
  try { afterReconcile(); } catch (err) { log.warn(`[index-worker] afterReconcile failed: ${err?.message || err}`); }
}

function applyFileReply(msg, p) {
  if (!msg.session) return;   // not yet a valid session — reconcile catches genuine losses
  const dropIds = dropIdsSince(p.postedSeq);
  if (dropIds.has(msg.sessionId)) return;   // deleted since the request — do not resurrect it
  storeIndexer.applyClaudeFileReply(msg.session);
  coalesceFilePush();   // fix 4: one trailing push per burst, matching the inline flush cadence
}

// The projectPath a folder reply resolved to — from its folderStamp (set for every visited folder) with a
// session-row fallback. Used by the removed-race re-check (fix 3).
function replyProjectPath(reply, folder) {
  if (reply && Array.isArray(reply.folderStamps)) {
    for (const st of reply.folderStamps) if (st && st.folder === folder && st.projectPath) return st.projectPath;
  }
  if (reply && reply.sessions && reply.sessions[0]) return reply.sessions[0].projectPath || null;
  return null;
}

module.exports = {
  init,
  ensureWorker,
  terminate,
  postReconcile,
  postFile,
  postRootCacheReset,
  noteDeleted,
  // Renderer-reachable status for verifying the off-thread path is live (#199 — DevTools:
  // `await window.api.indexWorkerStatus()`). `alive` = the worker thread is spawned.
  status: () => ({ alive: worker !== null, pending: pending.size }),
  // exposed for tests: a transport seam (drive without spawning a real Worker) + the reply handler, so the
  // appQuitting + delete-epoch guards can be exercised deterministically in `node --test`.
  buildSnapshot,
  _pendingSize: () => pending.size,
  _setTransport: (fn) => { _testTransport = fn; },
  _deliverReply: onReply,
  // fix 4: drive the file-lane push coalescer deterministically in `node --test`.
  _coalesceFilePush: () => coalesceFilePush(),
  _flushFilePush: () => flushFilePush(),
};
