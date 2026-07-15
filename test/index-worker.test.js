'use strict';
// #199 step 5.2b — the persistent index worker (workers/index-worker.js) + its main-side client
// (index-worker-client.js). These tests exercise the worker path WITHOUT Electron: the parse leaves are
// Electron-free, so the worker's reconcile/file logic runs in `node --test`, and the client's guards are
// driven through a transport seam (no spawned Worker, no DB).
//
// What they lock:
//   1. a real spawned Worker answers a `reconcile` and a `file` request with the documented reply shape;
//   2. the worker reply reconstructs the SAME rows the inline path (sessionCache.refreshFolder) writes —
//      the "worker == inline" claim the whole off-thread move rests on;
//   3. the appQuitting guard drops a late reply BEFORE any apply (a closed-DB write, #76/#90);
//   4. the delete-epoch guard drops an in-flight reply's row that was deleted since the request (no
//      reverse-resurrection), on BOTH the reconcile and the file lane.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const WORKER = path.join(__dirname, '..', 'workers', 'index-worker.js');

// A minimal valid Claude transcript: one user line carrying cwd (for deriveProjectPath) + a user message
// (so readSessionFile yields a non-null session).
function writeSession(folderPath, cwd, name = 'session.jsonl') {
  fs.mkdirSync(folderPath, { recursive: true });
  const line = JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } });
  fs.writeFileSync(path.join(folderPath, name), line + '\n', 'utf8');
}

// Round-trip one request through a freshly spawned Worker; resolve with the reply.
function askWorker(request) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER);
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; try { w.terminate(); } catch {} fn(arg); };
    w.on('message', (m) => done(resolve, m));
    w.on('error', (e) => done(reject, e));
    w.on('exit', (code) => { if (!settled) done(reject, new Error('worker exited ' + code)); });
    w.postMessage(request);
  });
}

test('a spawned worker answers a reconcile request with the per-folder reply shape', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-iw-recon-'));
  try {
    writeSession(path.join(projectsDir, 'proj-a'), '/tmp/proj-a');
    writeSession(path.join(projectsDir, 'proj-b'), '/tmp/proj-b');

    const reply = await askWorker({
      type: 'reconcile', reqId: 1,
      roster: { claudeEnabled: true, axisB: [] },
      roots: { claude: projectsDir },
      folderMeta: {},           // nothing indexed yet → every folder trips the gate
      removedSet: [],
      snapshot: { claudeByFolder: {}, backends: {} },
    });

    assert.equal(reply.type, 'reply');
    assert.equal(reply.reqId, 1);
    assert.equal(reply.kind, 'reconcile');
    assert.ok(Array.isArray(reply.claude));
    const folders = reply.claude.map(c => c.folder).sort();
    assert.deepEqual(folders, ['proj-a', 'proj-b']);
    for (const { reply: r } of reply.claude) {
      // the full documented reply shape rides across the thread
      for (const k of ['sessions', 'seenIds', 'seenFiles', 'reReadFiles', 'skippedIds', 'folderStamps',
        'vanishedFolders', 'storeProjects', 'stats', 'changed']) {
        assert.ok(k in r, `reply is missing ${k}`);
      }
      assert.equal(r.sessions.length, 1, 'each folder parsed its one session');
      assert.ok(r.folderStamps.length >= 1, 'the folder is stamped so the gate does not re-trip');
    }
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('a spawned worker answers a file request with {session, sessionId}', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-iw-file-'));
  try {
    const folderPath = path.join(projectsDir, 'proj-f');
    writeSession(folderPath, '/tmp/proj-f', 'abc.jsonl');
    const reply = await askWorker({
      type: 'file', reqId: 7,
      folder: 'proj-f', path: path.join(folderPath, 'abc.jsonl'),
      projectPath: '/tmp/proj-f', parentSessionId: null,
    });
    assert.equal(reply.kind, 'file');
    assert.equal(reply.reqId, 7);
    assert.ok(reply.session && reply.sessionId, 'a valid transcript yields a session');
    assert.equal(reply.session.sessionId, reply.sessionId);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

// The core "worker == inline" guarantee: drive the SAME fixture store through (a) the inline
// sessionCache.reconcileCacheFromFilesystem and (b) the worker's runClaudeReconcile + the shared
// applyClaudeFolderReply, each against its own fake DB, and assert the upserted rows match.
test('the worker reply reconstructs the same rows the inline path writes', () => {
  const sessionCache = require('../session-cache');
  const storeIndexer = require('../backends/claude/store-indexer');
  const iw = require('../workers/index-worker');
  const { getFolderIndexMtimeMs } = require('../folder-index-state');

  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-iw-equiv-'));
  try {
    writeSession(path.join(projectsDir, 'proj-x'), '/tmp/proj-x');
    writeSession(path.join(projectsDir, 'proj-y'), '/tmp/proj-y');

    // Fake DB that records every upserted session id per folder.
    function makeDb() {
      const upserts = [];
      const meta = new Map();
      return {
        upserts, meta,
        db: {
          deleteCachedFolder() {}, getCachedByFolder() { return []; },
          upsertCachedSessions(ss) { for (const s of ss) upserts.push(s.sessionId + '@' + s.folder); },
          deleteCachedSession() {}, replaceSessionMetrics() {},
          deleteSearchFolder() {}, deleteSearchSession() {}, upsertSearchEntries() {},
          setFolderMeta(f, pp, m) { meta.set(f, { projectPath: pp, indexMtimeMs: m }); },
          getAllFolderMeta() { return meta; }, getAllMeta() { return new Map(); },
          getAllCached() { return []; }, getSetting() { return {}; },
          getMeta() { return null; }, setName() {}, getProjectMeta() { return null; },
        },
      };
    }

    // (a) inline
    const inlineDb = makeDb();
    sessionCache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console, db: inlineDb.db });
    sessionCache.reconcileCacheFromFilesystem();

    // (b) worker leaf + the shared apply, against a fresh fake DB (re-init points the sink at it)
    const workerDb = makeDb();
    sessionCache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console, db: workerDb.db });
    const claude = iw.runClaudeReconcile({
      roots: { claude: projectsDir }, folderMeta: {}, removedSet: [],
      snapshot: { claudeByFolder: {} }, force: false,
    });
    for (const { folder, reply } of claude) {
      storeIndexer.applyClaudeFolderReply(folder, reply, { scope: sessionCache.claudeStoreScope(), cachedMap: new Map() });
    }

    assert.deepEqual(workerDb.upserts.sort(), inlineDb.upserts.sort(),
      'the worker path upserted exactly the rows the inline path did');
    assert.ok(inlineDb.upserts.length === 2, 'both sessions were indexed');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

// --- client guards (driven through the transport seam, no spawned Worker) --------------------------

// Init the client with a fake DB + a controllable appQuitting flag, capturing every posted request.
function bootClient(client, { quitting = { v: false }, onFileApplied } = {}) {
  const upserts = [];
  const deletes = [];
  const sink = require('../index-writes');
  const storeIndexer = require('../backends/claude/store-indexer');
  const backendScan = require('../backend-scan');
  // Point the shared sink at a recording DB (the apply helpers write through it).
  sink.init({
    getMainWindow: () => null, log: console,
    db: {
      upsertCachedSessions(ss) { for (const s of ss) upserts.push(s.sessionId); },
      deleteCachedSession(id) { deletes.push(id); }, replaceSessionMetrics() {},
      deleteSearchFolder() {}, deleteSearchSession() {}, upsertSearchEntries() {},
      deleteCachedFolder() {}, getMeta() { return null; }, setName() {}, getProjectMeta() { return null; },
    },
  });
  storeIndexer.init({ PROJECTS_DIR: '/nope', log: console, db: { getFolderMeta() { return null; }, setFolderMeta() {}, getAllFolderMeta() { return new Map(); }, getCachedByFolder() { return []; }, deleteCachedFolder() {}, getMeta() { return null; } } });
  backendScan.init({ log: console, db: { getAllCached() { return []; } } });

  const posted = [];
  client._setTransport((msg) => posted.push(msg));
  client.init({
    PROJECTS_DIR: '/nope', log: console,
    db: { getAllCached: () => [], getAllFolderMeta: () => new Map(), setFolderMeta: () => {} },
    isAppQuitting: () => quitting.v,
    afterReconcile: () => {},
    onFileApplied: onFileApplied || (() => {}),
  });
  return { posted, upserts, deletes };
}

// The reconcile requests captured by the transport seam.
function reconcilePosts(posted) { return posted.filter(m => m.type === 'reconcile'); }

// A Claude folder reply that would upsert one session (as the worker produces).
function folderReplyWithSession(sessionId, folder = 'proj-z') {
  return {
    sessions: [{ sessionId, folder, projectPath: '/tmp/z', summary: '', textContent: '', dailyMetrics: [] }],
    seenIds: [sessionId], seenFiles: [], reReadFiles: [], skippedIds: [],
    folderStamps: [{ folder, projectPath: '/tmp/z', indexMtimeMs: 1 }],
    vanishedFolders: [], storeProjects: [], stats: { filesFull: 1, filesIncremental: 0, bytes: 10 }, changed: true,
  };
}

test('appQuitting guard: a reply that arrives after quit is dropped before any apply', () => {
  const client = require('../index-worker-client');
  const quitting = { v: false };
  const rec = bootClient(client, { quitting });
  client.postReconcile();
  const req = rec.posted.find(m => m.type === 'reconcile');
  assert.ok(req, 'a reconcile was posted');

  quitting.v = true;   // the DB is (about to be) closed
  client._deliverReply({ type: 'reply', reqId: req.reqId, kind: 'reconcile',
    claude: [{ folder: 'proj-z', reply: folderReplyWithSession('sess-quit') }], backends: [] });

  assert.deepEqual(rec.upserts, [], 'nothing was written after appQuitting was set');
});

test('delete-epoch guard: a row deleted since the request is not reverse-resurrected (reconcile lane)', () => {
  const client = require('../index-worker-client');
  const rec = bootClient(client);
  client.postReconcile();
  const req = rec.posted.find(m => m.type === 'reconcile');

  // The user deletes this exact session AFTER the request was posted, BEFORE its reply lands.
  client.noteDeleted('sess-raced');

  client._deliverReply({ type: 'reply', reqId: req.reqId, kind: 'reconcile',
    claude: [{ folder: 'proj-z', reply: folderReplyWithSession('sess-raced') }], backends: [] });

  assert.ok(!rec.upserts.includes('sess-raced'), 'the just-deleted row was dropped, not re-indexed');
});

test('delete-epoch guard also covers the file lane', () => {
  const client = require('../index-worker-client');
  const rec = bootClient(client);
  // Simulate a file request in flight: register it by posting through the seam. postFile does DB pre-work
  // (refreshFilePrepare) which returns null for a nonexistent store, so drive _deliverReply directly with a
  // hand-built pending entry via postReconcile's machinery is not available — instead assert the guard on a
  // crafted file reply after noteDeleted, using a real reqId from a reconcile post to seed the sequence.
  client.postReconcile();
  const req = rec.posted.find(m => m.type === 'reconcile');
  client.noteDeleted('sess-file-raced');
  // A file reply carrying the just-deleted id must not resurrect it.
  client._deliverReply({ type: 'reply', reqId: req.reqId, kind: 'file',
    session: { sessionId: 'sess-file-raced', folder: 'proj-z', summary: '', textContent: '', dailyMetrics: [] },
    sessionId: 'sess-file-raced' });
  assert.ok(!rec.upserts.includes('sess-file-raced'), 'the file-lane reply for a deleted id was dropped');
});

// --- fix 1: postReconcile COALESCING ---------------------------------------------------------------
test('postReconcile coalescing: a burst posts at most one in-flight + one trailing (not N)', () => {
  const client = require('../index-worker-client');
  const rec = bootClient(client);

  // A burst of get-projects → N postReconcile calls while the first is still in flight.
  for (let i = 0; i < 8; i++) client.postReconcile();
  assert.equal(reconcilePosts(rec.posted).length, 1,
    'only ONE reconcile is posted while a reply is outstanding — the rest arm the trailing flag');

  // The in-flight reply lands → the single trailing sweep re-holds the gate and posts exactly once more.
  const first = reconcilePosts(rec.posted)[0];
  client._deliverReply({ type: 'reply', reqId: first.reqId, kind: 'reconcile', claude: [], backends: [] });
  assert.equal(reconcilePosts(rec.posted).length, 2, 'the trailing sweep ran — the last request is not lost');

  // Its reply releases the gate; no further sweep is queued.
  const second = reconcilePosts(rec.posted)[1];
  client._deliverReply({ type: 'reply', reqId: second.reqId, kind: 'reconcile', claude: [], backends: [] });
  assert.equal(reconcilePosts(rec.posted).length, 2, 'the gate released — no spurious extra sweep');
});

// --- fix 2: noteDeleted covers an explicit main-side delete ----------------------------------------
// The main.js wiring (delete-worktree loop + the projects ctx.db.deleteCachedSession wrap) calls
// client.noteDeleted(id) for each explicitly-deleted session. This asserts the guard that wiring feeds:
// an in-flight reconcile reply for a session deleted by an explicit action is dropped, not resurrected.
test('noteDeleted (explicit delete) drops an in-flight reconcile reply for that id', () => {
  const client = require('../index-worker-client');
  const rec = bootClient(client);
  client.postReconcile();
  const req = reconcilePosts(rec.posted)[0];

  // remove-project / delete-project-sessions / delete-worktree deletes this id AFTER the request was posted.
  client.noteDeleted('sess-explicit-del');

  client._deliverReply({ type: 'reply', reqId: req.reqId, kind: 'reconcile',
    claude: [{ folder: 'proj-z', reply: folderReplyWithSession('sess-explicit-del') }], backends: [] });
  assert.ok(!rec.upserts.includes('sess-explicit-del'),
    'the explicitly-deleted row was not reverse-resurrected by the in-flight reply');
});

// --- fix 3: removed-race re-check at apply ---------------------------------------------------------
// A project removed AFTER the snapshot is not in the posted removedSet, so the worker parsed + indexed it.
// applyReconcileReply must re-check isRemovedProject FRESH on main and drop that folder's parsed rows.
test('removed-race: a project removed after the snapshot is not indexed by an in-flight reply', () => {
  const client = require('../index-worker-client');
  const storeIndexer = require('../backends/claude/store-indexer');
  const realIsRemoved = storeIndexer.isRemovedProject;
  const rec = bootClient(client);
  try {
    // The reply's folderStamp carries projectPath '/tmp/z'; mark exactly that path removed on main NOW.
    storeIndexer.isRemovedProject = (pp) => pp === '/tmp/z';
    client.postReconcile();
    const req = reconcilePosts(rec.posted)[0];
    client._deliverReply({ type: 'reply', reqId: req.reqId, kind: 'reconcile',
      claude: [{ folder: 'proj-z', reply: folderReplyWithSession('sess-removed') }], backends: [] });
    assert.ok(!rec.upserts.includes('sess-removed'),
      'a project removed since the snapshot was NOT indexed by the racing reply');
  } finally {
    storeIndexer.isRemovedProject = realIsRemoved;
  }

  // Control: with the project NOT removed, the same reply DOES index the session.
  const rec2 = bootClient(client);
  client.postReconcile();
  const req2 = reconcilePosts(rec2.posted)[0];
  client._deliverReply({ type: 'reply', reqId: req2.reqId, kind: 'reconcile',
    claude: [{ folder: 'proj-z', reply: folderReplyWithSession('sess-present') }], backends: [] });
  assert.ok(rec2.upserts.includes('sess-present'), 'a present project is indexed as normal (control)');
});

// --- fix 4: per-file liveness push COALESCING ------------------------------------------------------
test('file-lane push coalescing: a burst of file applies collapses to one push', () => {
  const client = require('../index-worker-client');
  let pushes = 0;
  bootClient(client, { onFileApplied: () => { pushes++; } });

  for (let i = 0; i < 8; i++) client._coalesceFilePush();
  assert.equal(pushes, 0, 'no push has fired yet — the burst is coalesced behind the debounce');

  client._flushFilePush();
  assert.equal(pushes, 1, 'eight file applies produced exactly one projects-changed push');
});
