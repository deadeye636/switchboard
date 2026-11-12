'use strict';
// session-flow.js — main's half of the Flow tab (spec 46, #826, plan T6).
//
// The renderer sends a SESSION ID. Main finds the cached row, asks the backend's `sessionFlow(row)` for the
// sources (absolute paths, which never leave main), and starts one short-lived worker (`src/workers/flow-worker.js`)
// that streams the transcript and answers one `FlowSnapshot`. Terminating the worker is the cancel.
//
// PERFORMANCE (binding, plan "Performance bounds"): nothing here blocks the main thread. The request path and
// the status path use `fs.promises` only (a source test pins that there is no `*Sync` call in this file); the
// worker has `resourceLimits` and a wall-clock timeout (`unref`); a generation counter per window and session drops a
// stale reply; quitting terminates every active worker (`terminateAll`, called in the teardown BEFORE `closeDb`,
// the #76 pattern) and a reply that arrives after `appQuitting` is dropped unread. The database is read only in the
// same tick as a `quitting()` check: the cached row, and the settings blobs behind the window hint.
//
// NO PATH LEAVES THIS MODULE. The answers carry a snapshot (which holds `sourceId`, never a file), a state word
// or a fixed sentence. A raw error message is never sent: a failure becomes a snapshot with `complete: false` and
// a limitation of this module's own (`test/session-flow.test.js` scans the answers deeply for a path).
//
// WHY NO CONTAINMENT CHECK ON THE SOURCE: the path is not input. It comes from the backend's `sessionFlow(row)`
// applied to a row main itself cached (the same row `read-session-jsonl` opens by `row.filePath`), and the
// renderer chooses only which session. A guard here would have no root to compare against.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { performance } = require('perf_hooks');
const backends = require('../backends');
const { createContextWindowResolver } = require('../index/context-window');
const { emptyFlowSnapshot } = require('../shared/flow-snapshot');

const LEGACY_SESSION_BACKEND = 'claude';
const WORKER_FILE = path.join(__dirname, '..', 'workers', 'flow-worker.js');
const RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 });
const TIMEOUT_MS = 30000;
const HEAD_BYTES = 4096;
const MAX_FINGERPRINTS = 100;
// The subagent files watched by `status`: the same bound as the reader's lane cap (spec 46), so the poll never stats more than a read can show.
const MAX_SUB_FILES = 200;

let ctx = null;
// A request belongs to ONE window and one session: a detached window loads the same shell, so keying by the session
// alone would let window A's cancel (its viewer closing) stop window B's read. `senderId` is the asking
// webContents' id (0 for a caller that names none, which is how the tests ask).
const keyOf = (senderId, sessionId) => (senderId || 0) + '|' + sessionId;
// key -> generation of the newest request; a reply of an older one is dropped.
const generations = new Map();
// key -> { finish } of the worker that is running now.
const active = new Map();
// key -> the fingerprint of the last snapshot handed to that window (what ITS `status` compares against). Bounded.
const fingerprints = new Map();

function init(context) {
  ctx = context;
  generations.clear();
  active.clear();
  fingerprints.clear();
}

function debug(msg) {
  if (ctx && ctx.log && typeof ctx.log.debug === 'function') ctx.log.debug(`[session-flow] ${msg}`);
}

function quitting() {
  return !!(ctx && typeof ctx.getAppQuitting === 'function' && ctx.getAppQuitting());
}

// --- the descriptor and the row ---

function descriptorFor(row) {
  return backends.get(row.backendId || LEGACY_SESSION_BACKEND);
}

/**
 * The context window main would show for this session, as the health badge resolves it: the shared resolver
 * (`src/index/context-window.js`) asks the descriptor's `contextWindow` with the user's per-backend variables and the
 * stored launch options. `{ windowTokens }` or null. Once per request, so nothing is memoised across requests.
 */
async function windowHintFor(row, backend) {
  if (typeof ctx.getSetting !== 'function') return null;
  const answer = await createContextWindowResolver(ctx.getSetting, { liveWindowOf: ctx.liveWindowOf }).windowOfAsync(row, backend);
  const windowTokens = answer ? Number(answer.windowTokens) : 0;
  const model = answer && typeof answer.model === 'string' && answer.model ? answer.model : null;
  return windowTokens > 0 ? (model ? { windowTokens, model } : { windowTokens }) : null;
}

// --- fingerprints (size, mtime, a hash of the first 4 KB) ---

function hashHead(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** `{ size, mtimeMs, headLen, head }` for a file, or null when it cannot be opened. One open, one stat, one read. */
async function fingerprintOf(file) {
  let fh = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const st = await fh.stat();
    const headLen = Math.min(HEAD_BYTES, st.size);
    const buf = Buffer.allocUnsafe(headLen);
    const { bytesRead } = headLen ? await fh.read(buf, 0, headLen, 0) : { bytesRead: 0 };
    return { size: st.size, mtimeMs: st.mtimeMs, headLen: bytesRead, head: hashHead(buf.subarray(0, bytesRead)) };
  } catch { return null; } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** The head hash of the first `len` bytes, or null. */
async function headHashOf(file, len) {
  let fh = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = len ? await fh.read(buf, 0, len, 0) : { bytesRead: 0 };
    return bytesRead === len ? hashHead(buf) : null;
  } catch { return null; } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** The directory a source list names with the role `subagents-dir`, or null. The core reads the role, never a backend id. */
function subagentsDir(sources) {
  const s = Array.isArray(sources) && sources.find(x => x && x.role === 'subagents-dir' && typeof x.file === 'string');
  return s ? s.file : null;
}

/**
 * The `.jsonl` files of a directory: `{ names, total }` with the first MAX_SUB_FILES names in sorted order and the count
 * of ALL of them, so a directory past the cap still shows that it grew. One readdir. An absent directory is
 * `{ names: [], total: 0 }`; any other failure is null.
 */
async function listSubNames(dir) {
  let names;
  try { names = await fs.promises.readdir(dir); } catch (err) { return err && err.code === 'ENOENT' ? { names: [], total: 0 } : null; }
  const all = names.filter(n => n.endsWith('.jsonl')).sort();
  return { names: all.slice(0, MAX_SUB_FILES), total: all.length };
}

/**
 * What the read saw of the subagent files, kept in main: `{ sizes: Map(name -> size | null), total }` (null = the stat failed, so
 * nothing is known about that file until a later stat succeeds), or `{ unknown: true }` when the directory could not be listed (the
 * next status lists it again). One readdir and one stat per file, off the poll path.
 */
async function subagentSizes(dir) {
  const now = await listSubNames(dir);
  if (!now) return { unknown: true };
  const sizes = new Map();
  for (const n of now.names) {
    try { sizes.set(n, (await fs.promises.stat(path.join(dir, n))).size); } catch { sizes.set(n, null); }
  }
  return { sizes, total: now.total };
}

/**
 * Whether the subagent files moved since the read: `unchanged | grew | rewritten`, or null when the directory cannot be
 * listed. One readdir, and a stat of each file the last read listed, one after the other (never in parallel: 200 at once would
 * flood the thread pool other I/O shares). A name that is new, or more files than at the read, answers `grew` without a stat; a
 * listed file that is gone or smaller is `rewritten`. A listed file is never called gone for falling out of the capped window.
 * The directory's own mtime is no signal: appending to a file inside does not move it on Windows.
 */
async function subagentStatus(dir, before) {
  const now = await listSubNames(dir);
  if (!now) return null;
  if (before.unknown) return now.total > 0 ? 'grew' : 'unchanged';
  let grew = now.total > before.total || now.names.some(n => !before.sizes.has(n));
  for (const [n, size] of before.sizes) {
    let st;
    try { st = await fs.promises.stat(path.join(dir, n)); } catch { if (size === null) continue; return 'rewritten'; }
    if (size === null) { grew = true; continue; }   // first successful stat of a file the read could not stat
    if (st.size < size) return 'rewritten';
    if (st.size > size) grew = true;
  }
  return grew ? 'grew' : 'unchanged';
}

/**
 * Whether the extra rollouts a reader reported (a Codex subagent's, `files` of the worker's reply) moved since the read:
 * `unchanged | grew | rewritten`. One stat each, in sequence, at most MAX_SUB_FILES. A new child file needs no check of its own:
 * the parent's rollout grows in the same moment it spawns one.
 */
async function readFilesStatus(before) {
  let grew = false;
  for (const [file, size] of before) {
    let st;
    try { st = await fs.promises.stat(file); } catch { return 'rewritten'; }
    if (st.size < size) return 'rewritten';
    if (st.size > size) grew = true;
  }
  return grew ? 'grew' : 'unchanged';
}

function remember(key, fp) {
  fingerprints.delete(key);
  fingerprints.set(key, fp);
  while (fingerprints.size > MAX_FINGERPRINTS) fingerprints.delete(fingerprints.keys().next().value);
}

/**
 * Whether the transcript moved since the snapshot last handed out, as one string: `unchanged | grew | rewritten`,
 * or `unknown` (no read yet, an unknown session, or a source that cannot be stat-ed). One stat of the main file, a
 * 4 KB read only when its size or mtime moved and it did not shrink, then — for a backend whose sources name a
 * `subagents-dir` — one readdir and a stat of each file the snapshot listed (at most MAX_SUB_FILES, in sequence). A new or grown
 * subagent file is `grew`, a removed or shrunk one `rewritten`. The answer holds no path.
 */
async function getStatus(sessionId, senderId) {
  const row = lookupRow(sessionId);
  const flow = row ? flowOf(row) : null;
  const before = fingerprints.get(keyOf(senderId, sessionId));
  if (!flow || !before) return 'unknown';
  const file = mainFile(flow.sources);
  if (!file) return 'unknown';
  let st;
  try { st = await fs.promises.stat(file); } catch { return 'unknown'; }
  let main = 'unchanged';
  if (st.size < before.size) return 'rewritten';
  if (!(st.size === before.size && st.mtimeMs === before.mtimeMs)) {
    const head = await headHashOf(file, before.headLen);
    if (head === null || head !== before.head) return 'rewritten';
    if (st.size > before.size) main = 'grew';
  }
  if (main === 'grew') return main;
  const dir = subagentsDir(flow.sources);
  if (before.files && before.files.size) {
    const moved = await readFilesStatus(before.files);
    if (moved === 'rewritten') return moved;
    if (moved === 'grew') return moved;
  }
  if (!dir || !before.subs) return main;
  return (await subagentStatus(dir, before.subs)) || main;
}

// --- lookups ---

function lookupRow(sessionId) {
  if (!ctx || typeof sessionId !== 'string' || !sessionId) return null;
  try { return ctx.getCachedSession(sessionId) || null; } catch { return null; }
}

function flowOf(row) {
  const backend = descriptorFor(row);
  if (!backend || typeof backend.sessionFlow !== 'function') return null;
  let answer;
  try { answer = backend.sessionFlow(row); } catch { return null; }
  return answer ? { backend, answer, sources: answer.sources || [] } : null;
}

function mainFile(sources) {
  const s = (Array.isArray(sources) && (sources.find(x => x && x.laneHint === 'main') || sources[0])) || null;
  return s && typeof s.file === 'string' ? s.file : null;
}

// --- the worker ---

const FAILURES = {
  timeout: { id: 'worker-timeout', text: 'Reading this session took too long and was stopped.' },
  memory: { id: 'worker-memory', text: 'This session is too large to read in the memory the reader may use.' },
  crash: { id: 'worker-crashed', text: 'The reader stopped unexpectedly, so no steps are shown.' },
  cancelled: { id: 'read-cancelled', text: 'This read was cancelled or replaced by a newer one.' },
  noTranscript: { id: 'no-transcript', text: 'Nothing has been written for this session yet.' },
  unknown: { id: 'session-unknown', text: 'This session is not known, so no steps are shown.' },
};

function failureSnapshot(kind, answer) {
  const failure = FAILURES[kind] || FAILURES.crash;
  const snap = emptyFlowSnapshot({
    capabilities: answer && answer.capabilities,
    limitations: [...((answer && answer.limitations) || []), failure],
  });
  snap.complete = false;
  return snap;
}

function defaultCreateWorker(workerData, resourceLimits) {
  return new Worker(WORKER_FILE, { workerData, resourceLimits });
}

/** Runs one worker; resolves `{ kind: 'result'|'timeout'|'memory'|'crash'|'cancelled', ... }`, never rejects. */
function runWorker(key, workerData) {
  return new Promise((resolve) => {
    const create = (ctx && ctx.createWorker) || defaultCreateWorker;
    const timeoutMs = (ctx && ctx.timeoutMs) || TIMEOUT_MS;
    const t0 = performance.now();
    let worker = null;
    let timer = null;
    let done = false;
    let onlineMs = null;
    const entry = { finish: null };
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (active.get(key) === entry) active.delete(key);
      try { const p = worker && worker.terminate(); if (p && p.catch) p.catch(() => {}); } catch { /* already gone */ }
      resolve({ ...outcome, onlineMs, totalMs: performance.now() - t0 });
    };
    entry.finish = finish;
    try {
      worker = create(workerData, RESOURCE_LIMITS);
    } catch {
      finish({ kind: 'crash' });
      return;
    }
    active.set(key, entry);
    timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    if (timer.unref) timer.unref();
    worker.on('online', () => { onlineMs = performance.now() - t0; });
    worker.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'result' && m.snapshot && typeof m.snapshot === 'object') finish({ kind: 'result', ...m });
      else finish({ kind: 'crash' });
    });
    worker.on('error', (err) => finish({ kind: err && err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'crash' }));
    worker.on('exit', () => finish({ kind: 'crash' }));
  });
}

function cancelActive(key) {
  const entry = active.get(key);
  if (!entry) return false;
  entry.finish({ kind: 'cancelled' });
  return true;
}

/** Terminates every active worker. Called when the app quits, before the database closes. */
function terminateAll() {
  for (const entry of [...active.values()]) entry.finish({ kind: 'cancelled' });
  active.clear();
}

// --- the handlers ---

async function getSessionFlow(sessionId, senderId, { remember: keep = true } = {}) {
  const started = performance.now();
  if (quitting()) return failureSnapshot('cancelled', null);
  const row = lookupRow(sessionId);
  if (!row) return failureSnapshot('unknown', null);
  const flow = flowOf(row);
  if (!flow) return null;   // the backend has no flow: the one case that is not a snapshot
  // The backend supports a flow, but the row names no transcript file yet: a snapshot that says so, not a decline.
  if (!mainFile(flow.sources)) return failureSnapshot('noTranscript', flow.answer);

  const key = keyOf(senderId, sessionId);
  const gen = (generations.get(key) || 0) + 1;
  generations.set(key, gen);
  cancelActive(key);   // a second call terminates the first; its own promise answers `cancelled`

  const file = mainFile(flow.sources);
  const fingerprint = file ? await fingerprintOf(file) : null;
  const subDir = subagentsDir(flow.sources);
  if (fingerprint && subDir) fingerprint.subs = await subagentSizes(subDir);   // kept in main; the snapshot's copy below omits it
  if (generations.get(key) !== gen || quitting()) return failureSnapshot('cancelled', flow.answer);

  const backend = flow.backend;
  const windowHint = await windowHintFor(row, backend);   // async: the settings files are read through fs.promises
  if (generations.get(key) !== gen || quitting()) return failureSnapshot('cancelled', flow.answer);
  const workerData = {
    backendId: backend.baseId || backend.id,
    sources: flow.sources,
    windowHint,
  };
  const mainMs = performance.now() - started;
  const outcome = await runWorker(key, workerData);
  if (generations.get(key) !== gen || quitting() || outcome.kind === 'cancelled') {
    debug(`dropped a stale or cancelled reply (${outcome.kind})`);
    return failureSnapshot('cancelled', flow.answer);
  }
  if (outcome.kind !== 'result') {
    debug(`worker ended: ${outcome.kind} after ${Math.round(outcome.totalMs)} ms`);
    return failureSnapshot(outcome.kind, flow.answer);
  }
  const snapshot = outcome.snapshot;
  if (generations.get(key) === gen) generations.delete(key);   // the newest read is done: nothing left to supersede
  snapshot.fingerprint = fingerprint ? { size: fingerprint.size, mtimeMs: fingerprint.mtimeMs, head: fingerprint.head } : null;
  if (fingerprint && Array.isArray(outcome.files) && outcome.files.length) {
    fingerprint.files = new Map(outcome.files.filter(f => f && typeof f.file === 'string' && Number.isFinite(f.size)).slice(0, MAX_SUB_FILES).map(f => [f.file, f.size]));
  }
  if (fingerprint && keep) remember(key, fingerprint);   // an export (`remember: false`) leaves no fingerprint behind for `status`
  debug(`worker start ${Math.round(outcome.onlineMs || 0)} ms, load ${Math.round(outcome.loadMs || 0)} ms, read ${Math.round(outcome.readMs || 0)} ms, `
    + `reply ${outcome.replyBytes || 0} bytes, round trip ${Math.round(outcome.totalMs)} ms, main side before the worker ${mainMs.toFixed(1)} ms`);
  return snapshot;
}

function cancelSessionFlow(sessionId, senderId) {
  const key = keyOf(senderId, sessionId);
  // Only a read in flight has a generation to move on; a cancel for nothing must not leave an entry behind.
  if (generations.has(key)) generations.set(key, generations.get(key) + 1);
  cancelActive(key);
}

/** @param {Electron.IpcMain} ipc */
function registerIpc(ipc) {
  const from = (event) => (event && event.sender && event.sender.id) || 0;
  ipc.handle('get-session-flow', (event, sessionId) => getSessionFlow(sessionId, from(event)));
  ipc.handle('cancel-session-flow', (event, sessionId) => cancelSessionFlow(sessionId, from(event)));
  ipc.handle('get-session-flow-status', (event, sessionId) => getStatus(sessionId, from(event)));
}

module.exports = { init, registerIpc, getSessionFlow, cancelSessionFlow, getStatus, terminateAll, RESOURCE_LIMITS, TIMEOUT_MS };
