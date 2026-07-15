const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');
const { getFolderIndexMtimeMs } = require('../folder-index-state');

// Minimal valid session transcript: one line carries `cwd` (for deriveProjectPath)
// and a user message (so readSessionFile yields a non-null session).
function writeSession(folderPath, cwd) {
  fs.mkdirSync(folderPath, { recursive: true });
  const line = JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } });
  fs.writeFileSync(path.join(folderPath, 'session.jsonl'), line + '\n', 'utf8');
}

// In-memory fake of the db layer that init() expects, recording which folders
// actually got (re)indexed (i.e. had refreshFolder do work and upsert sessions).
function makeFakeDb(metaMap) {
  const indexedFolders = new Set();
  return {
    indexedFolders,
    db: {
      deleteCachedFolder() {},
      getCachedByFolder() { return []; },
      upsertCachedSessions(sessions) { for (const s of sessions) indexedFolders.add(s.folder); },
      deleteCachedSession() {},
      replaceSessionMetrics() {},
      deleteSearchFolder() {},
      deleteSearchSession() {},
      upsertSearchEntries() {},
      setFolderMeta(folder, projectPath, indexMtimeMs) { metaMap.set(folder, { folder, projectPath, indexMtimeMs }); },
      getAllFolderMeta() { return metaMap; },
      getAllMeta() { return new Map(); },
      getAllCached() { return []; },
      getSetting() { return {}; },
      getMeta() { return null; },
      setName() {},
    },
  };
}

// #199 step 2: the reconcile sweep must re-read a changed file INCREMENTALLY, sharing the watcher's
// retained parse state — it used to full-read every changed file (and delete the incremental memo, so
// the pending refreshFile then full-read the same growing transcript again). Assert refreshFolder never
// takes the old full-read path and that the second sweep reuses the retained state.
test('refreshFolder re-reads a changed file incrementally, never via the full-read path', () => {
  // #199 step 5.2a: the reconcile parse-loop moved into the Electron-free leaf backends/claude/folder-parse.js,
  // which calls the session-reader DIRECTLY (no longer through the `claude` descriptor). The reader module IS
  // the mock seam now — patch it there, not on the descriptor.
  const reader = require('../backends/claude/session-reader');
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-incr-'));
  const folder = 'proj-incr';
  const folderPath = path.join(projectsDir, folder);
  const sessionPath = path.join(folderPath, 'session.jsonl');

  const origFull = reader.readSessionFile;
  const origIncr = reader.readSessionFileIncremental;
  let fullCalls = 0;
  const prevSeen = [];
  reader.readSessionFile = (...a) => { fullCalls++; return origFull(...a); };
  reader.readSessionFileIncremental = (fp, f, pp, opts, prev) => { prevSeen.push(prev); return origIncr(fp, f, pp, opts, prev); };

  try {
    writeSession(folderPath, '/tmp/proj-incr');

    const fake = makeFakeDb(new Map());
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: console,
      db: fake.db,
    });

    // First touch: no memo yet -> a full read happens INSIDE readSessionFileIncremental (prev === null),
    // but the deprecated readSessionFile full path is never used.
    const stats1 = { foldersTripped: 0, filesFull: 0, filesIncremental: 0, bytes: 0 };
    sessionCache.refreshFolder(folder, { stats: stats1 });
    assert.equal(prevSeen.length, 1, 'first sweep reads the file once');
    assert.equal(prevSeen[0], null, 'first read has no retained state');
    assert.equal(stats1.filesFull, 1, 'first touch counts as a full read');
    assert.equal(stats1.filesIncremental, 0);

    // Append to the transcript, then sweep again. The retained state is reused (prev !== null) so only
    // the appended bytes are read — and still never the full-read path.
    fs.appendFileSync(sessionPath, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'more' } }) + '\n', 'utf8');
    const stats2 = { foldersTripped: 0, filesFull: 0, filesIncremental: 0, bytes: 0 };
    sessionCache.refreshFolder(folder, { stats: stats2 });
    assert.equal(prevSeen.length, 2, 'second sweep reads the file again');
    assert.notEqual(prevSeen[1], null, 'second read reuses the retained parse state (incremental)');
    assert.equal(stats2.filesIncremental, 1, 'second read is counted incremental');
    assert.equal(stats2.filesFull, 0, 'and is not a full re-read');
    assert.ok(stats2.bytes > 0, 'the appended bytes were consumed');

    assert.equal(fullCalls, 0, 'refreshFolder must never use the deprecated full-read path');
  } finally {
    reader.readSessionFile = origFull;
    reader.readSessionFileIncremental = origIncr;
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

// #199 step 3: the get-projects IPC handler is a PURE cache read — reconcile and the backend sweep must
// not run inline on the response path (they run in queueIndexSweep, off the paint). Source-scan the
// handler body, matching the established main.js-scanning pattern in claude-disable.test.js.
test('the get-projects handler does no filesystem reconcile inline', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = src.indexOf("ipcMain.handle('get-projects'");
  assert.ok(start > 0, 'the handler exists');
  const body = src.slice(start, src.indexOf('ipcMain.handle(', start + 1));
  assert.ok(!/reconcileCacheFromFilesystem\(/.test(body), 'reconcile must not run inline in get-projects');
  assert.ok(!/refreshAllBackendSessions\(/.test(body), 'the backend sweep must not run inline in get-projects');
  assert.ok(/queueIndexSweep\(\)/.test(body), 'get-projects defers repair work to the coalesced sweep');
});

test('reconcileCacheFromFilesystem indexes new and stale folders but skips up-to-date ones', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-reconcile-'));
  try {
    // never-indexed (no meta), stale (meta older than disk), and up-to-date folders
    writeSession(path.join(projectsDir, 'proj-new'), '/tmp/proj-new');
    writeSession(path.join(projectsDir, 'proj-stale'), '/tmp/proj-stale');
    writeSession(path.join(projectsDir, 'proj-current'), '/tmp/proj-current');

    const metaMap = new Map();
    metaMap.set('proj-stale', { folder: 'proj-stale', projectPath: '/tmp/proj-stale', indexMtimeMs: 0 });
    metaMap.set('proj-current', {
      folder: 'proj-current', projectPath: '/tmp/proj-current',
      indexMtimeMs: getFolderIndexMtimeMs(path.join(projectsDir, 'proj-current')),
    });

    const fake = makeFakeDb(metaMap);
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: console,
      db: fake.db,
    });

    sessionCache.reconcileCacheFromFilesystem();

    assert.ok(fake.indexedFolders.has('proj-new'), 'new folder should be indexed');
    assert.ok(fake.indexedFolders.has('proj-stale'), 'stale folder (older indexMtimeMs) should be re-indexed');
    assert.ok(!fake.indexedFolders.has('proj-current'), 'up-to-date folder should be skipped');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
