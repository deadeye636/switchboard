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

test('only the folder whose transcript moved is re-read', async () => {
  const rec = recorder();
  const w = setup(4, { onUpsert: rec.onUpsert });
  try {
    await sessionCache.populateCacheViaWorker();
    rec.seen.length = 0;

    touchLater(w.made[2].file);
    await sessionCache.populateCacheViaWorker({ incremental: true });

    assert.deepEqual(rec.seen, [w.made[2].folder],
      `exactly the changed folder was opened (saw: ${rec.seen.join(',')})`);
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

test('the default is still the unconditional full pass — rebuild-cache and a parser bump take it', async () => {
  // `rebuild-cache` (main.js) and the `claudeParserBumped` branch of get-projects both call
  // populateCacheViaWorker() with no argument. Opt-IN is what makes those two safe without touching them.
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
  // Concurrent callers share one in-flight scan. Without the escalation, a get-projects that finds a
  // bumped parser during the cold start would be handed the GATED promise, await it, mark the parser read
  // and never re-parse anything.
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
function lifecycleCtx({ ftsRecreated, calls }) {
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
  };
}

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
