'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');
const backends = require('../backends');
const codex = require('../backends/codex');
const sessionBackends = require('../session-backends');
const { encodeProjectPath } = require('../encode-project-path');
// #208: the Axis-B scan runs in the index worker now — drive the real worker parse + main apply in one call.
const { runBackendScan } = require('./helpers/run-backend-scan');

// #199 step 5.1b — CHARACTERIZATION tests for the side-effects the "extract the generic Axis-B parse-loop
// (refreshBackendSessions) as a PURE snapshot-in/reply-out function" claim rests on, and which the rest of
// the suite does NOT cover. They are written GREEN on today's (pre-extraction) code and must stay green
// after the extraction: they lock the behaviours that must be REPRESENTED in the reply and REPLAYED on
// main, or 5.1b silently drops them even on-thread. Each proven sharp by stash-and-mutate during dev.
//
//   1. noteStoreProject — UNCONDITIONAL, per session, BEFORE the removal check (backend-scan.js:182).
//      Axis-B's fires for EVERY session (not just the removed branch like Claude) — the biggest #167 risk.
//   2. markPersisted on the SKIP path (#155) — both the file-mtime skip branch AND the db-marker skip
//      branch call it. A skipped session never reaches the sink, so its mark must ride the reply.
//   3. the #197 partial-read guard (handles.incomplete) keeps rows — a half-read store must not reconcile
//      its unseen sessions away.
//   4. the store-not-found guard keeps rows — no handles + a store that is not there is not "the user
//      deleted everything".
//   5. a Hermes-style db-row (null filePath, changeMarker, lineageParentId remap) survives the extraction.
//   6. metrics 'if-nonempty' (#154) — an empty-metrics session does NOT clear existing metrics.

// --- in-memory db fake (better-sqlite3 can't load under node:test); scope semantics mirror db.js
// backendScopeClause() 1:1, and it records per-day metrics so the if-nonempty case is observable. ---
function inScope(backendId, scope) {
  const id = backendId || 'claude';
  if (!scope) return true;
  if (Array.isArray(scope.only)) return scope.only.includes(id);
  if (Array.isArray(scope.except)) return scope.except.length === 0 || !scope.except.includes(id);
  return true;
}

function makeFakeDb(globalSettings = {}) {
  const cache = new Map();
  const search = new Map();
  const meta = new Map();
  const folderMeta = new Map();
  const metrics = new Map();
  const projectStates = new Map();

  const api = {
    _cache: cache, _search: search, _meta: meta, _folderMeta: folderMeta, _metrics: metrics, _states: projectStates,
    deleteCachedFolder(folder, scope) {
      for (const [id, row] of [...cache]) {
        if (row.folder === folder && inScope(row.backendId, scope)) cache.delete(id);
      }
      folderMeta.delete(folder);
    },
    deleteSearchFolder(folder, scope) {
      for (const [id, e] of [...search]) {
        if (e.folder !== folder) continue;
        const row = cache.get(id);
        if (inScope(row ? row.backendId : null, scope)) search.delete(id);
      }
    },
    getCachedByFolder(folder, scope) {
      const out = [];
      for (const row of cache.values()) {
        if (row.folder === folder && inScope(row.backendId, scope)) out.push({ ...row });
      }
      return out;
    },
    upsertCachedSessions(sessions) {
      for (const s of sessions) {
        const prev = cache.get(s.sessionId);
        const row = { ...(prev || {}), ...s };
        row.backendId = s.backendId || (prev && prev.backendId) || null;
        row.filePath = s.filePath || (prev && prev.filePath) || null;
        cache.set(s.sessionId, row);
      }
    },
    deleteCachedSession(id) { cache.delete(id); },
    deleteSearchSession(id) { search.delete(id); },
    upsertSearchEntries(entries) { for (const e of entries) search.set(e.id, e); },
    replaceSessionMetrics(sessionId, rows) { metrics.set(sessionId, rows); },
    setFolderMeta(folder, projectPath, indexMtimeMs) { folderMeta.set(folder, { folder, projectPath, indexMtimeMs }); },
    getFolderMeta(folder) { return folderMeta.get(folder) || null; },
    getAllFolderMeta() { return folderMeta; },
    getAllMeta() { return meta; },
    getAllCached() { return [...cache.values()].map(r => ({ ...r })); },
    getSetting() { return globalSettings; },
    getMeta(id) { return meta.get(id) || null; },
    setName(id, name) { meta.set(id, { ...(meta.get(id) || {}), name }); },
    getProjectMeta(p) { return projectStates.get(p) || null; },
  };
  return api;
}

function writeCodexRollout(codexHome, cwd, sessionId, day = '2026/07/01') {
  const dir = path.join(codexHome, 'sessions', ...day.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      timestamp: '2026-07-01T10:00:00.000Z', type: 'session_meta',
      payload: { id: sessionId, cwd, timestamp: '2026-07-01T10:00:00.000Z', cli_version: '0.142.2' },
    }),
    JSON.stringify({
      timestamp: '2026-07-01T10:00:04.000Z', type: 'turn_context',
      payload: { model: 'gpt-5.5' },
    }),
    JSON.stringify({
      timestamp: '2026-07-01T10:00:05.000Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello codex' }] },
    }),
  ];
  const file = path.join(dir, `rollout-2026-07-01T10-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

// A db-mode (Hermes-shaped) backend: {kind:'db'} handles, no files, its own marker as the change gate.
function fakeDbBackend(id, { sessions, bucketPath }) {
  return {
    id, label: id, tier: 1, axis: 'B', status: 'ready',
    monogram: 'X', colour: 'x', configFields: [],
    buildLaunch() { throw new Error('nope'); },
    discoverSessions() {
      return sessions.map(s => ({ kind: 'db', ref: 'store.db', sessionId: s.sessionId, marker: s.marker }));
    },
    parseSession(h) {
      const s = sessions.find(x => x.sessionId === h.sessionId);
      return s ? { ...s.row, sessionId: s.sessionId, backendId: id } : null;
    },
    watchTargets() { return [{ kind: 'db', path: 'store.db' }]; },
    deriveState: null,
    sessionBucketPath: () => bucketPath,
  };
}

// A configurable Axis-B backend whose discovery + watchTargets are driven per test, so the incomplete
// (#197) and store-not-found guards can be exercised deterministically.
function configurableBackend(id, cfg) {
  return {
    id, label: id, tier: 1, axis: 'B', status: 'ready',
    monogram: 'C', colour: 'c', configFields: [],
    buildLaunch() { throw new Error('nope'); },
    discoverSessions() { return cfg.handles(); },
    parseSession(h) { return cfg.parse ? cfg.parse(h) : null; },
    watchTargets() { return cfg.targets ? cfg.targets() : []; },
    deriveState: null,
  };
}

function setup({ enabledMap = { codex: true }, globalSettings = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bscan-'));
  const projectsDir = path.join(root, 'claude-projects');
  const codexHome = path.join(root, 'codex-home');
  const projectCwd = path.join(root, 'demo');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(projectCwd, { recursive: true });

  codex.setHome(codexHome);
  backends.init({ getGlobalSettings: () => ({ backendEnabled: enabledMap }) });

  const db = makeFakeDb(globalSettings);
  sessionCache.init({
    PROJECTS_DIR: projectsDir,
    activeSessions: new Map(),
    getMainWindow: () => null,
    log: { info() {}, debug() {}, silly() {} },
    db,
  });
  sessionBackends._configureForTests({ filePath: path.join(root, 'session-backends.json') });
  return { root, projectsDir, codexHome, projectCwd, db, folder: encodeProjectPath(projectCwd) };
}

function cleanup(w) { fs.rmSync(w.root, { recursive: true, force: true }); }

// --- 1. UNCONDITIONAL per-session noteStoreProject — even for a NON-removed project ---
// Claude only notes a REMOVED project; Axis-B notes EVERY session it parses, before the removal check.
// Drop that (move it under the removed branch), and a normal project vanishes from storeProjectPaths ->
// syncRegistry (#167 tombstone/bring-back) breaks. projectCwd is under a unique temp root, so a hit here
// can only come from THIS scan (the scan-state Map is process-global and never cleared).
test('refreshBackendSessions notes EVERY parsed session in the store scan-state (not just removed ones)', () => {
  const w = setup();
  try {
    assert.equal(sessionCache.getStoreProjectPaths().has(w.projectCwd), false, 'precondition: unseen path');
    writeCodexRollout(w.codexHome, w.projectCwd, 'aaaaaaaa-0000-4000-8000-000000000001');

    const stats = runBackendScan('codex');
    assert.equal(stats.upserted, 1, 'the (non-removed) session is indexed normally');
    assert.ok(sessionCache.getStoreProjectPaths().has(w.projectCwd),
      'and its project is recorded in the store scan-state UNCONDITIONALLY (#167) — not only for removed projects');
  } finally { cleanup(w); }
});

// --- 2a. skip-path markPersisted (#155), FILE-mtime branch ---
test('the file-mtime SKIP branch marks the overlay entry persisted (#155)', () => {
  const w = setup();
  const id = 'bbbbbbbb-0000-4000-8000-000000000002';
  try {
    writeCodexRollout(w.codexHome, w.projectCwd, id);
    // First scan: upsert path (the sink also marks persisted). Now the row exists with a matching mtime.
    assert.equal(runBackendScan('codex').upserted, 1);

    // Re-record the overlay entry: `record` un-persists it. Only the SKIP-path markPersisted can now
    // re-persist it, because a matching mtime means the session never reaches the sink again.
    sessionBackends.record(id, 'codex');
    assert.equal(sessionBackends.isPersisted(id), false, 'a fresh record is un-scanned');

    const stats = runBackendScan('codex');
    assert.equal(stats.skipped, 1, 'the mtime gate holds — the session is skipped');
    assert.equal(stats.upserted, 0, 'so it never reaches the sink');
    assert.ok(sessionBackends.isPersisted(id),
      'yet the SKIP branch marked it persisted (#155) — the overlay entry can be evicted');
  } finally { cleanup(w); }
});

// --- 2b. skip-path markPersisted (#155), DB-marker branch ---
test('the db-marker SKIP branch marks the overlay entry persisted (#155)', () => {
  const w = setup({ enabledMap: { dbtest: true } });
  const id = 'hsess-skip-1';
  try {
    backends.register(fakeDbBackend('dbtest', {
      bucketPath: w.root,
      sessions: [{ sessionId: id, marker: 'm1', row: { cwd: w.projectCwd, summary: 'v1', messageCount: 1 } }],
    }));
    assert.equal(runBackendScan('dbtest').upserted, 1);

    sessionBackends.record(id, 'dbtest');
    assert.equal(sessionBackends.isPersisted(id), false, 'a fresh record is un-scanned');

    const stats = runBackendScan('dbtest');
    assert.equal(stats.skipped, 1, 'the same marker skips the session');
    assert.equal(stats.upserted, 0);
    assert.ok(sessionBackends.isPersisted(id), 'the db-marker skip branch marked it persisted (#155)');
  } finally { cleanup(w); }
});

// --- 3. #197 partial-read guard: handles.incomplete keeps the unseen rows ---
test('a partially-readable store (handles.incomplete) keeps rows it did not see (#197)', () => {
  const w = setup({ enabledMap: { inctest: true } });
  const present = 'inc-present-1';
  const missing = 'inc-missing-2';
  try {
    let sessions = [
      { sessionId: present, marker: 'm1', row: { cwd: w.projectCwd, summary: 'a', messageCount: 1 } },
      { sessionId: missing, marker: 'm1', row: { cwd: w.projectCwd, summary: 'b', messageCount: 1 } },
    ];
    let incomplete = false;
    backends.register(configurableBackend('inctest', {
      handles() {
        const h = sessions.map(s => ({ kind: 'db', ref: 'store.db', sessionId: s.sessionId, marker: s.marker }));
        if (incomplete) h.incomplete = true;
        return h;
      },
      parse(h) {
        const s = sessions.find(x => x.sessionId === h.sessionId);
        return s ? { ...s.row, sessionId: s.sessionId, backendId: 'inctest' } : null;
      },
      targets() { return [{ kind: 'db', path: 'store.db' }]; },
    }));

    // Both indexed.
    runBackendScan('inctest');
    assert.ok(w.db._cache.has(present) && w.db._cache.has(missing), 'both rows cached');

    // A subtree failed to read: only one handle comes back, and discovery flags itself incomplete.
    sessions = sessions.filter(s => s.sessionId === present);
    incomplete = true;
    const stats = runBackendScan('inctest');
    assert.equal(stats.deleted, 0, 'a partial read reconciles NOTHING away (#197)');
    assert.ok(w.db._cache.has(missing), 'the unseen session survives — a half-read store is not a deletion');
    assert.ok(w.db._cache.has(present), 'the seen one too');
  } finally { cleanup(w); }
});

// --- 4. store-not-found guard: no handles + a store that is not there keeps the rows ---
test('a store that is not there keeps its cached rows (no handles + missing store != "user deleted all")', () => {
  const w = setup({ enabledMap: { gonetest: true } });
  try {
    backends.register(configurableBackend('gonetest', {
      handles() { return []; },                                              // discovery finds nothing
      targets() { return [{ kind: 'dir', path: path.join(w.root, 'not-here') }]; },   // ...because the store is absent
    }));
    w.db._cache.set('gt-old', {
      sessionId: 'gt-old', backendId: 'gonetest', folder: w.folder, projectPath: w.projectCwd, summary: 'kept',
    });

    const stats = runBackendScan('gonetest');
    assert.equal(stats.deleted, 0, 'nothing reconciled when the store itself is not present');
    assert.ok(w.db._cache.has('gt-old'), 'the history survives an unreachable store');
  } finally { cleanup(w); }
});

// --- 4b. discovery-FAILURE guard (#208): a THROW mid-discovery keeps the cached rows ---
// Distinct from #4: here the store IS present, but reading it FAILS transiently (EMFILE/EACCES, a locked
// db). That must not read as "the store is empty". The worker returns an `incomplete` reply (not an empty
// one), so main keeps every cached row and reconciles nothing away. Before #208 the worker's discovery
// catch returned an EMPTY reply with incomplete:false, and — now that the worker is the ONLY scan path —
// the reconcile delete-diff would then have wiped the backend's entire history on one transient error.
test('a discovery error keeps the cached rows (#208 — incomplete, not an empty store)', () => {
  const w = setup({ enabledMap: { throwtest: true } });
  try {
    backends.register(configurableBackend('throwtest', {
      handles() { throw new Error('EMFILE: too many open files'); },
      targets() { return [{ kind: 'dir', path: w.root }]; },   // the store IS there — this is a read failure
    }));
    w.db._cache.set('tt-old', {
      sessionId: 'tt-old', backendId: 'throwtest', folder: w.folder, projectPath: w.projectCwd, summary: 'kept',
    });

    const stats = runBackendScan('throwtest');
    assert.equal(stats.deleted, 0, 'a discovery throw reconciles NOTHING away');
    assert.ok(w.db._cache.has('tt-old'), 'the history survives a transient discovery error');
  } finally { cleanup(w); }
});

// --- 5. a Hermes-style db-row survives the extraction: null filePath, changeMarker, lineageParentId ---
test('a db-mode row keeps null filePath + changeMarker + the lineageParentId remap through the extraction', () => {
  const w = setup({ enabledMap: { dbtest: true } });
  const id = 'hsess-shape-1';
  try {
    backends.register(fakeDbBackend('dbtest', {
      bucketPath: w.root,
      sessions: [{
        sessionId: id, marker: 'mk-42',
        // The parser reports the backend's own parent as `parentSessionId` (hermes/reader.js). The SCANNER
        // moves it to `lineageParentId` so a Hermes child does not render as a Claude subagent.
        row: { cwd: w.projectCwd, summary: 'db row', messageCount: 2, parentSessionId: 'hsess-parent-0' },
      }],
    }));

    assert.equal(runBackendScan('dbtest').upserted, 1);
    const row = w.db._cache.get(id);
    assert.ok(row, 'cached');
    assert.equal(row.filePath, null, 'a db session has no file path (v11 tolerates null)');
    assert.equal(row.changeMarker, 'mk-42', 'the change gate rides on the backend marker');
    assert.equal(row.lineageParentId, 'hsess-parent-0', 'the backend parent is remapped into lineageParentId');
    assert.equal(row.parentSessionId, null, 'and cleared from parentSessionId (not a Claude subagent)');
    assert.equal(row.folder, w.folder, 'grouped by its cwd like any other backend');
  } finally { cleanup(w); }
});

// --- 6. metrics 'if-nonempty' (#154): an empty-metrics session does NOT clear existing metrics ---
test('an empty-metrics session does not clobber existing metrics (metricsMode if-nonempty, #154)', () => {
  const w = setup({ enabledMap: { dbtest: true } });
  const id = 'hsess-metrics-1';
  try {
    // A db backend whose parser emits NO per-day metrics (row has no dailyMetrics).
    backends.register(fakeDbBackend('dbtest', {
      bucketPath: w.root,
      sessions: [{ sessionId: id, marker: 'm1', row: { cwd: w.projectCwd, summary: 'no metrics', messageCount: 1 } }],
    }));
    // Metrics already stored for this id (e.g. by a prior richer parse or another path).
    w.db._metrics.set(id, [{ date: '2026-07-01', model: 'x', inputTokens: 5, outputTokens: 1, messageCount: 1 }]);

    assert.equal(runBackendScan('dbtest').upserted, 1, 'the row is upserted (reaches the sink)');
    const kept = w.db._metrics.get(id);
    assert.ok(kept && kept.length === 1, 'the existing metrics survive — if-nonempty does not clear on an empty batch (#154)');
    assert.equal(kept[0].inputTokens, 5);
  } finally { cleanup(w); }
});
