'use strict';

// #567 — the cold scan's DB writes must not take the main thread in one bite.
//
// The scan worker streams one folder as it finishes it and the main-side handler applies exactly one per
// event-loop turn. What that buys is the property this file asserts: while the scan is being written, OTHER
// main-thread work still runs between folders. In the app that other work is a PTY chunk on its way to the
// renderer and an `open-terminal` waiting to be served — a session restore spawning its CLIs into a cold
// scan used to wait out every folder's writes back-to-back (measured at 717 ms on a 1008-session store).
//
// A `setImmediate` ticker stands in for that work here: it cannot advance at all while a synchronous loop
// is running, so the number of ticks observed between the first and the last folder's writes is exactly the
// number of times the main thread was free.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../src/index/session-cache');
const storeIndexer = require('../src/backends/claude/store-indexer');
const backends = require('../src/backends');
const sessionBackends = require('../src/session/session-backends');
const { encodeProjectPath } = require('../src/session/encode-project-path');

function makeFakeDb(onUpsert) {
  const cache = new Map();
  const search = new Map();
  const meta = new Map();
  const folderMeta = new Map();
  return {
    _cache: cache, _folderMeta: folderMeta,
    deleteCachedFolder(folder) { for (const [id, r] of [...cache]) if (r.folder === folder) cache.delete(id); },
    deleteSearchFolder(folder) { for (const [id, e] of [...search]) if (e.folder === folder) search.delete(id); },
    getFolderLineage() { return []; },
    getCachedByFolder() { return []; },
    upsertCachedSessions(sessions) {
      for (const s of sessions) cache.set(s.sessionId, { ...s });
      if (onUpsert) onUpsert(sessions);
    },
    deleteCachedSession(id) { cache.delete(id); },
    deleteSearchSession(id) { search.delete(id); },
    upsertSearchEntries(entries) { for (const e of entries) search.set(e.id, e); },
    replaceSessionMetrics() {},
    setFolderMeta(folder, projectPath, indexMtimeMs) { folderMeta.set(folder, { folder, projectPath, indexMtimeMs }); },
    getFolderMeta(folder) { return folderMeta.get(folder) || null; },
    getAllFolderMeta() { return folderMeta; },
    getAllMeta() { return meta; },
    getAllCached() { return [...cache.values()]; },
    getSetting() { return {}; },
    getMeta(id) { return meta.get(id) || null; },
    setName(id, name) { meta.set(id, { ...(meta.get(id) || {}), name }); },
    getProjectMeta() { return null; },
    getProjectStates() { return new Map(); },
    getProjectTombstones() { return new Map(); },
  };
}

function setup(folders, onUpsert, infoLines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-coldscan-'));
  const projectsDir = path.join(root, 'claude-projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  const made = [];
  for (let i = 0; i < folders; i++) {
    const cwd = path.join(root, `proj-${i}`);
    fs.mkdirSync(cwd, { recursive: true });
    const folder = encodeProjectPath(cwd);
    const dir = path.join(projectsDir, folder);
    fs.mkdirSync(dir, { recursive: true });
    const sessionId = `aaaaaaaa-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`;
    fs.writeFileSync(
      path.join(dir, sessionId + '.jsonl'),
      JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } }) + '\n',
      'utf8',
    );
    made.push({ folder, sessionId });
  }

  backends.init({ getGlobalSettings: () => ({ backendEnabled: {} }) });
  const db = makeFakeDb(onUpsert);
  sessionCache.init({
    PROJECTS_DIR: projectsDir,
    activeSessions: new Map(),
    getMainWindow: () => null,
    log: { info(msg) { if (infoLines) infoLines.push(String(msg)); }, warn() {}, debug() {}, silly() {} },
    db,
  });
  sessionBackends._configureForTests({ filePath: path.join(root, 'session-backends.json') });
  return { root, db, made };
}

test('the cold scan applies one folder per event-loop turn, so main is free in between', async () => {
  const FOLDERS = 6;
  let ticks = 0;
  const ticksAtUpsert = [];
  const w = setup(FOLDERS, () => ticksAtUpsert.push(ticks));
  let ticking = true;
  const tick = () => { if (ticking) { ticks++; setImmediate(tick); } };
  setImmediate(tick);
  try {
    await sessionCache.populateCacheViaWorker();
    ticking = false;

    assert.equal(ticksAtUpsert.length, FOLDERS, 'every folder was written');
    assert.equal(w.db._cache.size, FOLDERS, 'and every session landed in the cache');
    // The property. A single synchronous loop would show ONE tick value for every folder; a drain that
    // yields shows a strictly increasing one, i.e. the main thread ran something else in between.
    const distinct = new Set(ticksAtUpsert).size;
    assert.equal(distinct, FOLDERS,
      `each folder's writes ran on their own turn (tick counts seen: ${ticksAtUpsert.join(',')})`);
  } finally {
    ticking = false;
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('terminateScanWorker stops a drain that is still queued (no write after the DB closes)', async () => {
  const FOLDERS = 8;
  const applied = [];
  let stop = null;
  const w = setup(FOLDERS, (sessions) => {
    applied.push(sessions[0].sessionId);
    // Quit arrives after the first folder has been written and while the rest are still queued —
    // exactly the #76 hazard at the streamed seam.
    if (applied.length === 1 && stop) stop();
  });
  stop = () => storeIndexer.terminateScanWorker();
  try {
    await sessionCache.populateCacheViaWorker();
    assert.equal(applied.length, 1, 'nothing queued behind the terminate was written');
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('a scan that was cancelled does not report itself complete afterwards (#567)', async () => {
  // `terminateScanWorker` settles the scan, and the worker's terminal message can already be in flight:
  // a MessagePort delivers what was posted before `.terminate()`. Without the `settled` guard in
  // `finish()`, that late message logs a finished cold scan and pushes `projects-changed` — carrying the
  // partial count that was actually written, which reads as a scan that indexed one project and stopped.
  //
  // The race itself has no deterministic seam, and the commit that added the guard said so. Measured
  // against the code as it was: this test passes there too, because in a harness this small the worker
  // is terminated before it ever posts its terminal message, so `finish` is not reached with or without
  // the guard. It is kept as a CONTRACT pin, not as a regression catch — it fails the day a cancelled
  // scan starts announcing itself, whichever way that comes about — and it says so here rather than
  // being counted as coverage it does not provide.
  const FOLDERS = 8;
  const applied = [];
  const infoLines = [];
  let stop = null;
  const w = setup(FOLDERS, (sessions) => {
    applied.push(sessions[0].sessionId);
    if (applied.length === 1 && stop) stop();
  }, infoLines);
  stop = () => storeIndexer.terminateScanWorker();
  try {
    await sessionCache.populateCacheViaWorker();
    const completions = infoLines.filter(l => l.includes('cold scan:'));
    assert.deepEqual(completions, [],
      `a cancelled scan reported itself complete: ${completions.join(' | ')}`);
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});
