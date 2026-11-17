'use strict';

// #589 — the cold scan must not re-parse a folder that has not changed since the last run.
//
// Measured before this: 1.11 GiB and 9-20 s on every launch of a 1013-transcript store, ~95 % of it parse
// of rows that were already in the cache and still correct. The reconcile has gated on
// `getFolderIndexMtimeMs` since #199; the cold scan computed the same number only to STAMP it.
//
// The gate is OPT-IN, and these tests are mostly about the ways OUT of it, because that is where the
// damage lives: migration v6 drops the FTS tables and leaves `cache_meta` stamped, so a gate the
// FTS-recreated path did not bypass would skip every folder and leave search permanently empty behind a
// full sidebar — certain on the first affected upgrade, not a race.
//
// Which of these fail against the pre-#589 code, honestly:
//   - "a folder that has not changed is not re-read"                 FAILS there (it read everything)
//   - "only the folder whose transcript moved is re-read"            FAILS there
//   - "a full request while a gated scan runs still gets a full pass" FAILS there (one scan ran, not two)
//   - "lifecycle asks for the full pass when the FTS was recreated"   FAILS there (it passed no argument)
//   - "a file reply lost with the worker un-stamps its folder"        FAILS there (nothing rolled back)
//   - the parser-version, no-rows and explicit-full cases PASS there, because the old scan read every
//     folder unconditionally and so satisfies every "was it read" assertion. They are contract pins
//     against the obvious wrong implementation (an mtime-only gate), not regression catches, and they say
//     so here rather than being counted as coverage they do not provide.

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
const { getFolderIndexMtimeMs } = require('../src/index/folder-index-state');

const CLAUDE_PARSER_VERSION = backends.get('claude').PARSER_SCHEMA_VERSION;

// A fake DB that answers the three reads the gate makes — the folder stamps, the folder's cached rows,
// and (through the sink) the writes that produce both.
function makeFakeDb(onUpsert) {
  const cache = new Map();
  const search = new Map();
  const meta = new Map();
  const folderMeta = new Map();
  return {
    _cache: cache, _folderMeta: folderMeta, _search: search,
    deleteCachedFolder(folder) { for (const [id, r] of [...cache]) if (r.folder === folder) cache.delete(id); },
    deleteSearchFolder(folder) { for (const [id, e] of [...search]) if (e.folder === folder) search.delete(id); },
    getFolderLineage() { return []; },
    getCachedByFolder(folder) { return [...cache.values()].filter(r => r.folder === folder); },
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

function setup(folders, { onUpsert, infoLines } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-coldgate-'));
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
    const file = path.join(dir, sessionId + '.jsonl');
    fs.writeFileSync(
      file,
      JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } }) + '\n',
      'utf8',
    );
    made.push({ folder, sessionId, file, dir });
  }

  backends.init({ getGlobalSettings: () => ({ backendEnabled: {} }) });
  // The hand-over set is module state shared by every test in this file: start each one empty.
  storeIndexer.releaseHandedOver(storeIndexer.handedOverSnapshot());
  const db = makeFakeDb(onUpsert);
  sessionCache.init({
    PROJECTS_DIR: projectsDir,
    activeSessions: new Map(),
    getMainWindow: () => null,
    log: { info(msg) { if (infoLines) infoLines.push(String(msg)); }, warn() {}, debug() {}, silly() {} },
    db,
  });
  sessionBackends._configureForTests({ filePath: path.join(root, 'session-backends.json') });
  return { root, projectsDir, db, made };
}

// Record which folders each scan actually READ. A skipped folder produces no upsert at all, so the set of
// folders seen by the sink is exactly the set the worker opened.
function recorder() {
  const seen = [];
  return { seen, onUpsert: (sessions) => { for (const s of sessions) seen.push(s.folder); } };
}

// Move a transcript's mtime forward far enough that no filesystem timestamp granularity can hide it.
function touchLater(file) {
  const when = new Date(Date.now() + 5000);
  fs.utimesSync(file, when, when);
}

test('a folder that has not changed since the last run is not re-read', async () => {
  const rec = recorder();
  const w = setup(4, { onUpsert: rec.onUpsert });
  try {
    await sessionCache.populateCacheViaWorker();          // the first ever launch: everything is read
    assert.equal(rec.seen.length, 4, 'the first scan read every folder');

    rec.seen.length = 0;
    await sessionCache.populateCacheViaWorker({ incremental: true });
    assert.deepEqual(rec.seen, [], 'the second launch opened nothing — every folder was still stamped');
    assert.equal(w.db._cache.size, 4, 'and the rows it did not re-read are still there');
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

// What the app does right after the cold start: the reconcile request the first get-projects queues, built
// from the same two inputs index-worker-client posts (the folder stamps and the cached rows per folder).
// The reply is APPLIED the way index-worker-client does (applyClaudeFolderReply, then the hand-over
// release), so what a test asserts afterwards is on the db, not on a reply field.
function reconcileOnce(w) {
  const { sweepClaude } = require('../src/workers/index-worker');
  const { claudeStoreScope } = require('../src/index/index-writes');
  const folderMeta = {};
  for (const [folder, m] of w.db._folderMeta) folderMeta[folder] = { indexMtimeMs: m.indexMtimeMs, projectPath: m.projectPath };
  const claudeByFolder = {};
  const cachedMaps = {};
  for (const row of w.db._cache.values()) {
    const filePath = storeIndexer.resolveRowFilePath(row);
    (claudeByFolder[row.folder] = claudeByFolder[row.folder] || []).push({
      sessionId: row.sessionId, modified: row.modified, parserVersion: row.parserVersion, filePath,
    });
    (cachedMaps[row.folder] = cachedMaps[row.folder] || new Map())
      .set(row.sessionId, { modified: row.modified, filePath, parserVersion: row.parserVersion });
  }
  const handedOver = storeIndexer.handedOverSnapshot();
  const { out, examined } = sweepClaude({
    roots: { claude: w.projectsDir }, folderMeta, removedSet: [], snapshot: { claudeByFolder }, force: false,
  });
  for (const { folder, reply } of out) {
    storeIndexer.applyClaudeFolderReply(folder, reply, { scope: claudeStoreScope(), cachedMap: cachedMaps[folder] || new Map() });
  }
  storeIndexer.releaseHandedOver(handedOver.filter(f => examined.includes(f)));
  return out;
}

test('a folder whose transcript moved is left to the reconcile, which reads only the changed file (#881)', async () => {
  // A live session moves its transcript every few seconds. The old gate compared that mtime with the stamp
  // and re-parsed the whole folder on every cold start; a cleared folder is now the reconcile's.
  const rec = recorder();
  const w = setup(4, { onUpsert: rec.onUpsert });
  try {
    // A second, untouched transcript in the folder that will move, so "only the changed file" can be told
    // from "the whole folder".
    const moved = w.made[2];
    const cwd = path.join(w.root, 'proj-2');
    const otherId = 'cccccccc-0000-4000-8000-000000000002';
    const otherFile = path.join(moved.dir, otherId + '.jsonl');
    fs.writeFileSync(otherFile,
      JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'other' } }) + '\n', 'utf8');

    await sessionCache.populateCacheViaWorker();
    rec.seen.length = 0;
    const stampBefore = w.db._folderMeta.get(moved.folder).indexMtimeMs;

    touchLater(moved.file);
    await sessionCache.populateCacheViaWorker({ incremental: true });

    assert.deepEqual(rec.seen, [], 'the cold scan opened nothing, the moved folder included');
    assert.equal(w.db._folderMeta.get(moved.folder).indexMtimeMs, stampBefore,
      'and it did not stamp a folder it never read');

    const out = reconcileOnce(w);
    assert.deepEqual(out.map(o => o.folder), [moved.folder], 'the reconcile gate trips on exactly that folder');
    const reply = out[0].reply;
    assert.deepEqual(reply.sessions.map(s => s.sessionId), [moved.sessionId],
      'and it re-read only the changed file, reusing the other row');
    assert.equal(reply.stats.filesFull + reply.stats.filesIncremental, 1);
    assert.ok(w.db._folderMeta.get(moved.folder).indexMtimeMs > stampBefore,
      'the reconcile is what advances the stamp (asserted on the db)');
    assert.deepEqual(storeIndexer.handedOverSnapshot(), [], 'and it released every handed-over folder');
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('the watcher lane does not stamp a handed-over folder past a file that changed offline (#881 F1)', async () => {
  // The watcher starts BEFORE the cold scan. A live append stamps its folder with the newest mtime of every
  // file in it while the one-file parse reads only the live file: without the hand-over guard the stamp jumps
  // past the file that changed offline and the reconcile's gate skips the folder for good.
  const rec = recorder();
  const w = setup(3, { onUpsert: rec.onUpsert });
  try {
    const f = w.made[1];
    const cwd = path.join(w.root, 'proj-1');
    const offlineId = 'dddddddd-0000-4000-8000-000000000001';
    const offlineFile = path.join(f.dir, offlineId + '.jsonl');
    fs.writeFileSync(offlineFile,
      JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'offline' } }) + '\n', 'utf8');

    await sessionCache.populateCacheViaWorker();
    rec.seen.length = 0;
    const stampBefore = w.db._folderMeta.get(f.folder).indexMtimeMs;

    touchLater(offlineFile);            // changed while the app was not running
    await sessionCache.populateCacheViaWorker({ incremental: true });
    assert.deepEqual(rec.seen, [], 'the cold scan left the folder to the reconcile');

    const later = new Date(Date.now() + 9000);
    fs.utimesSync(f.file, later, later);   // the live session appends
    const prep = storeIndexer.refreshFilePrepare(f.folder, path.join(f.folder, path.basename(f.file)));
    assert.ok(prep && prep.filePath, 'the watcher lane still parses its one file');
    assert.equal(w.db._folderMeta.get(f.folder).indexMtimeMs, stampBefore,
      'but it did not advance the stamp of a handed-over folder');

    const out = reconcileOnce(w);
    const reply = out.find(o => o.folder === f.folder)?.reply;
    assert.ok(reply, 'the reconcile gate still trips on the folder');
    assert.ok(reply.sessions.some(s => s.sessionId === offlineId), 'and the offline-changed file is read');

    // Released: the watcher lane stamps normally again.
    const stampAfter = w.db._folderMeta.get(f.folder).indexMtimeMs;
    fs.utimesSync(f.file, new Date(Date.now() + 12000), new Date(Date.now() + 12000));
    storeIndexer.refreshFilePrepare(f.folder, path.join(f.folder, path.basename(f.file)));
    assert.ok(w.db._folderMeta.get(f.folder).indexMtimeMs > stampAfter, 'after the reconcile the watcher stamps again');
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('the reconcile reports only the folders it really looked at (#881 R1)', () => {
  const { sweepClaude } = require('../src/workers/index-worker');
  const w = setup(2);
  try {
    const args = { roots: { claude: w.projectsDir }, folderMeta: {}, removedSet: [], snapshot: { claudeByFolder: {} }, force: false };
    const ok = sweepClaude(args);
    assert.deepEqual(ok.examined.sort(), w.made.map(m => m.folder).sort(), 'every listed folder with a real mtime');

    // The store root cannot be listed (a file where the directory should be): nothing was looked at.
    const notADir = path.join(w.root, 'not-a-dir');
    fs.writeFileSync(notADir, 'x');
    const unreadable = sweepClaude({ ...args, roots: { claude: notADir } });
    assert.deepEqual(unreadable.examined, []);
    assert.deepEqual(unreadable.out, []);

    // One folder exists but cannot be stat-ed: it reads as mtime 0, which the gate calls current, but it was
    // not looked at.
    const bad = path.join(w.projectsDir, w.made[0].folder);
    const realStat = fs.statSync;
    fs.statSync = (p, ...rest) => {
      if (String(p) === bad) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realStat.call(fs, p, ...rest);
    };
    try {
      const partial = sweepClaude({ ...args, folderMeta: { [w.made[0].folder]: { indexMtimeMs: 1e15, projectPath: null } } });
      assert.deepEqual(partial.examined, [w.made[1].folder], 'the folder whose stat failed is not examined');
    } finally {
      fs.statSync = realStat;
    }
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('the client releases only handed-over folders the reply says were examined, and an error reply releases none (#881 R3)', async () => {
  const client = require('../src/index/index-worker-client');
  const w = setup(3);
  try {
    await sessionCache.populateCacheViaWorker();
    await sessionCache.populateCacheViaWorker({ incremental: true });
    const [a, b, c] = w.made.map(m => m.folder);
    assert.equal(storeIndexer.handedOverSnapshot().length, 3);

    client.init({
      PROJECTS_DIR: w.projectsDir, log: { info() {}, warn() {}, debug() {}, silly() {} }, db: w.db,
      isAppQuitting: () => false, afterReconcile: () => {}, onFileApplied: () => {},
    });
    const sent = [];
    client._setTransport((msg) => sent.push(msg));

    // A reply for a sweep that examined only `a`: `b` and `c` keep their guard.
    const p1 = client.postReconcile({ force: true });
    client._deliverReply({ type: 'reply', reqId: sent[0].reqId, kind: 'reconcile', claude: [], examined: [a], backends: [] });
    await p1;
    assert.deepEqual(storeIndexer.handedOverSnapshot().sort(), [b, c].sort());

    // An error reply applied nothing, so nothing is released.
    const p2 = client.postReconcile({ force: true });
    client._deliverReply({ type: 'error', reqId: sent[1].reqId, error: 'boom' });
    await p2;
    assert.deepEqual(storeIndexer.handedOverSnapshot().sort(), [b, c].sort());

    // A reply that names no examined folder (a store root it could not read) releases none either.
    const p3 = client.postReconcile({ force: true });
    client._deliverReply({ type: 'reply', reqId: sent[2].reqId, kind: 'reconcile', claude: [], examined: [], backends: [] });
    await p3;
    assert.deepEqual(storeIndexer.handedOverSnapshot().sort(), [b, c].sort());

    const p4 = client.postReconcile({ force: true });
    client._deliverReply({ type: 'reply', reqId: sent[3].reqId, kind: 'reconcile', claude: [], examined: [b, c], backends: [] });
    await p4;
    assert.deepEqual(storeIndexer.handedOverSnapshot(), []);
  } finally {
    client._setTransport(null);
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('a cold scan that reads a folder in full releases it from the hand-over', async () => {
  const w = setup(2);
  try {
    await sessionCache.populateCacheViaWorker();
    await sessionCache.populateCacheViaWorker({ incremental: true });
    assert.equal(storeIndexer.handedOverSnapshot().length, 2, 'both folders were handed over');
    await sessionCache.populateCacheViaWorker();   // full pass reads them
    assert.deepEqual(storeIndexer.handedOverSnapshot(), []);
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('a changed folder with a stale-version row is still read in full by the cold scan (#881)', async () => {
  const rec = recorder();
  const w = setup(3, { onUpsert: rec.onUpsert });
  try {
    await sessionCache.populateCacheViaWorker();
    rec.seen.length = 0;

    touchLater(w.made[1].file);
    for (const row of w.db._cache.values()) if (row.folder === w.made[1].folder) row.parserVersion = CLAUDE_PARSER_VERSION - 1;
    await sessionCache.populateCacheViaWorker({ incremental: true });

    assert.deepEqual(rec.seen, [w.made[1].folder], 'only the stale folder was read, in full');
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('a changed folder with no rows is read in full by the cold scan (#881)', async () => {
  const rec = recorder();
  const w = setup(3, { onUpsert: rec.onUpsert });
  try {
    await sessionCache.populateCacheViaWorker();
    rec.seen.length = 0;

    touchLater(w.made[0].file);
    for (const [id, row] of [...w.db._cache]) if (row.folder === w.made[0].folder) w.db._cache.delete(id);
    await sessionCache.populateCacheViaWorker({ incremental: true });

    assert.deepEqual(rec.seen, [w.made[0].folder]);
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('a stale parser version re-reads the folder even though its stamp has not moved', async () => {
  // A parser bump moves no file's mtime, so a stamp comparison ALONE cannot see one, and #152's per-row
  // gate sits behind the folder gate and never runs when the folder is skipped. Without this the metrics
  // a bump exists to rewrite would never be rewritten.
  const rec = recorder();
  const w = setup(3, { onUpsert: rec.onUpsert });
  try {
    await sessionCache.populateCacheViaWorker();
    rec.seen.length = 0;

    for (const row of w.db._cache.values()) row.parserVersion = CLAUDE_PARSER_VERSION - 1;
    await sessionCache.populateCacheViaWorker({ incremental: true });

    assert.equal(new Set(rec.seen).size, 3, 'every folder was re-read for the bumped parser');
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('a stamped folder with no cached rows is re-read', async () => {
  // The shape `refreshFilePrepare` leaves behind when its parse reply is lost: it stamps the folder BEFORE
  // posting. index-worker-client rolls that stamp back now, but a database carrying one from before this
  // change must still be repairable.
  const rec = recorder();
  const w = setup(3, { onUpsert: rec.onUpsert });
  try {
    await sessionCache.populateCacheViaWorker();
    rec.seen.length = 0;

    const orphaned = w.made[1].folder;
    for (const [id, row] of [...w.db._cache]) if (row.folder === orphaned) w.db._cache.delete(id);
    await sessionCache.populateCacheViaWorker({ incremental: true });

    assert.deepEqual(rec.seen, [orphaned], 'the folder whose rows had gone was opened again');
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('the default is still the unconditional full pass — rebuild-cache takes it', async () => {
  // `rebuild-cache` (main.js) calls populateCacheViaWorker() with no argument (the `claudeParserBumped`
  // branch of get-projects, its second caller, is gone, #880). Opt-IN is what makes that safe untouched.
  const rec = recorder();
  const w = setup(4, { onUpsert: rec.onUpsert });
  try {
    await sessionCache.populateCacheViaWorker();
    rec.seen.length = 0;

    await sessionCache.populateCacheViaWorker();
    assert.equal(new Set(rec.seen).size, 4, 'a bare call re-read every folder, stamps or no stamps');
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('a full request while a gated scan is in flight still gets a full pass', async () => {
  // Concurrent callers share one in-flight scan. Without the escalation, a rebuild-cache arriving during
  // the cold start would be handed the GATED promise and never get its full pass.
  const rec = recorder();
  const infoLines = [];
  const w = setup(4, { onUpsert: rec.onUpsert, infoLines });
  try {
    await sessionCache.populateCacheViaWorker();
    rec.seen.length = 0;
    infoLines.length = 0;

    const gated = sessionCache.populateCacheViaWorker({ incremental: true });
    const full = sessionCache.populateCacheViaWorker();
    await Promise.all([gated, full]);

    const scans = infoLines.filter(l => l.includes('cold scan:'));
    assert.equal(scans.length, 2, `two scans ran, not one (saw: ${scans.join(' | ')})`);
    assert.equal(new Set(rec.seen).size, 4, 'and the full one opened every folder');
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('a full request chained behind a CANCELLED gated scan does not start a scan at quit', async () => {
  // `terminateScanWorker` settles the in-flight scan from inside `will-quit`, and the escalation's
  // continuation is a microtask — so it would run after `closeDb()` and spawn a scan Worker whose folder
  // applies write to a closed database. The #76 hazard at the escalation seam.
  const infoLines = [];
  const w = setup(4, { infoLines });
  try {
    await sessionCache.populateCacheViaWorker();
    infoLines.length = 0;

    const gated = sessionCache.populateCacheViaWorker({ incremental: true });
    const full = sessionCache.populateCacheViaWorker();
    storeIndexer.terminateScanWorker();          // will-quit
    await Promise.all([gated, full]);
    await new Promise(r => setImmediate(r));     // let any chained continuation run

    const scans = infoLines.filter(l => l.includes('cold scan:'));
    assert.deepEqual(scans, [], 'nothing announced itself, so nothing was started after the cancel');
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('a full request while a FULL scan is in flight still shares it', async () => {
  const infoLines = [];
  const w = setup(3, { infoLines });
  try {
    const a = sessionCache.populateCacheViaWorker();
    const b = sessionCache.populateCacheViaWorker();
    await Promise.all([a, b]);
    const scans = infoLines.filter(l => l.includes('cold scan:'));
    assert.equal(scans.length, 1, `the shared-promise guard still holds (saw: ${scans.join(' | ')})`);
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('the cold scan reports what it skipped, or a warm launch reads as a scan that found nothing', async () => {
  const infoLines = [];
  const w = setup(3, { infoLines });
  try {
    await sessionCache.populateCacheViaWorker();
    infoLines.length = 0;
    await sessionCache.populateCacheViaWorker({ incremental: true });
    const line = infoLines.find(l => l.includes('cold scan:'));
    assert.ok(line && /3 unchanged/.test(line), `the summary names the skipped folders (saw: ${line})`);
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

// --- the lifecycle bypass (the one the gate must never swallow) -------------------------------------

// A ctx for `lifecycle.start` whose every hook is a no-op, so the test can watch the one call it is about.
function lifecycleCtx({ ftsRecreated, calls, sweeps = [] }) {
  const noop = () => {};
  return {
    app: {
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      on: noop,
      whenReady: () => Promise.resolve(),
      getPath: () => 'userData',
      quit: noop,
    },
    session: { defaultSession: { webRequest: { onHeadersReceived: noop } } },
    BrowserWindow: { getAllWindows: () => [{}] },
    getMainWindow: () => null,
    log: { info: noop, warn: noop, error: noop, debug: noop, silly: noop },
    cleanupSecretRefs: noop,
    cleanupClearBindings: noop,
    migrateClaudeLaunchDefaults: noop,
    migrateRetiredChoices: noop,
    buildMenu: noop,
    createWindow: noop,
    createTray: noop,
    startProjectsWatcher: noop,
    startBackendWatchers: noop,
    startAttentionHookServer: noop,
    startLiveOwners: noop,
    startDbUpkeep: noop,
    cleanStaleLockFiles: noop,
    applyAutoHide: noop,
    startTriggerWatcher: noop,
    activeSessions: new Map(),
    searchFtsRecreated: () => ftsRecreated,
    populateCacheViaWorker: (opts) => { calls.push(opts); return Promise.resolve(); },
    queueIndexSweep: () => { sweeps.push('sweep'); },
  };
}

test('lifecycle queues the reconcile itself once the cold scan has settled (#881 F2)', async () => {
  const { start } = require('../src/app/lifecycle');
  const calls = [];
  const sweeps = [];
  let settle;
  const ctx = lifecycleCtx({ ftsRecreated: false, calls, sweeps });
  ctx.populateCacheViaWorker = (opts) => { calls.push(opts); return new Promise(r => { settle = r; }); };
  start(ctx);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(sweeps, [], 'not while the scan is still running');
  settle();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(sweeps, ['sweep'], 'one reconcile request right after it settled');
});

test('lifecycle asks for the GATED pass on an ordinary launch', async () => {
  const { start } = require('../src/app/lifecycle');
  const calls = [];
  start(lifecycleCtx({ ftsRecreated: false, calls }));
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1, 'one cold scan was started');
  assert.deepEqual(calls[0], { incremental: true }, 'and it was the gated one');
});

test('lifecycle asks for the FULL pass when the FTS tables were recreated', async () => {
  // Migration v6 drops search_fts and leaves cache_meta stamped. A gated pass here skips every folder and
  // search stays empty for ever, behind a full sidebar, with nothing visibly broken.
  const { start } = require('../src/app/lifecycle');
  const calls = [];
  start(lifecycleCtx({ ftsRecreated: true, calls }));
  await new Promise(r => setImmediate(r));
  assert.ok(calls.length >= 1, 'a cold scan was started');
  assert.deepEqual(calls[0], { incremental: false }, 'the FIRST scan was the unconditional one');
});

// --- the up-front folder stamp, when its reply never comes -----------------------------------------

test('a file reply lost with the worker un-stamps its folder, so the next gate re-reads it', () => {
  // `refreshFilePrepare` stamps the folder as indexed-as-of-now BEFORE posting the parse, so the reconcile
  // cannot jump in underneath the in-flight read. Lose that reply — a respawn, a quit — and the row was
  // never written while the stamp says it was. The unconditional cold scan used to repair that for free.
  const client = require('../src/index/index-worker-client');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-unstamp-'));
  try {
    const projectsDir = path.join(root, 'claude-projects');
    const cwd = path.join(root, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    const folder = encodeProjectPath(cwd);
    const dir = path.join(projectsDir, folder);
    fs.mkdirSync(dir, { recursive: true });
    const sessionId = 'bbbbbbbb-0000-4000-8000-000000000001';
    fs.writeFileSync(
      path.join(dir, sessionId + '.jsonl'),
      JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } }) + '\n',
      'utf8',
    );

    backends.init({ getGlobalSettings: () => ({ backendEnabled: {} }) });
    const db = makeFakeDb();
    sessionCache.init({
      PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null,
      log: { info() {}, warn() {}, debug() {}, silly() {} }, db,
    });
    sessionBackends._configureForTests({ filePath: path.join(root, 'session-backends.json') });
    client.init({
      PROJECTS_DIR: projectsDir, log: { info() {}, warn() {}, debug() {}, silly() {} }, db,
      isAppQuitting: () => false, afterReconcile: () => {}, onFileApplied: () => {},
    });
    client._setTransport(() => { /* the request goes nowhere — the reply is lost */ });

    client.postFile(folder, path.join(folder, sessionId + '.jsonl'));
    assert.ok(db._folderMeta.get(folder).indexMtimeMs > 0, 'the folder was stamped up front, as it always is');

    client.terminate();
    assert.equal(db._folderMeta.get(folder).indexMtimeMs, 0,
      'the stamp was rolled back, so the next scan opens the folder again');
    assert.ok(getFolderIndexMtimeMs(dir) > 0, 'and the folder really does have a transcript to find');
  } finally {
    require('../src/index/index-worker-client')._setTransport(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
