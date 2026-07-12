'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');
const backends = require('../backends');
const codex = require('../backends/codex');
const pi = require('../backends/pi');
const sessionBackends = require('../session-backends');
const { encodeProjectPath } = require('../encode-project-path');

// T-4.2 — the multi-source scanner. The invariant under test: Claude's folder-driven scan and a
// backend that owns its own store (Codex) share the SAME project/folder bucket (grouping is central
// and cwd-keyed, §5.9) without ever deleting each other's cached rows.

// --- a fake backend with its own store, used for the ready/enabled gate (§5.8) ---
let fakeDiscoverCalls = 0;
backends.register({
  id: 'faketest', label: 'Fake', tier: 1, axis: 'B', status: 'ready',
  monogram: 'F', colour: 'fake', configFields: [],
  buildLaunch() { throw new Error('nope'); },
  discoverSessions() { fakeDiscoverCalls++; return []; },
  parseSession() { return null; },
  watchTargets() { return []; },
  deriveState: null,
});

// --- in-memory mirror of the db layer (better-sqlite3 is built for Electron's ABI and cannot be
// required from node:test — same approach as db-session-metrics.test.js). The backend scoping here
// mirrors db.js backendScopeClause() 1:1. ---
function inScope(backendId, scope) {
  const id = backendId || 'claude';
  if (!scope) return true;
  if (Array.isArray(scope.only)) return scope.only.includes(id);
  if (Array.isArray(scope.except)) return scope.except.length === 0 || !scope.except.includes(id);
  return true;
}

function makeFakeDb(globalSettings = {}) {
  const cache = new Map();        // sessionId -> row
  const search = new Map();       // sessionId -> entry
  const meta = new Map();         // sessionId -> { name }
  const folderMeta = new Map();   // folder -> { folder, projectPath, indexMtimeMs }

  const api = {
    _cache: cache,
    _search: search,
    deleteCachedFolder(folder, scope) {
      for (const [id, row] of [...cache]) {
        if (row.folder === folder && inScope(row.backendId, scope)) cache.delete(id);
      }
      folderMeta.delete(folder);
    },
    deleteSearchFolder(folder, scope) {
      for (const [id, e] of [...search]) {
        if (e.folder !== folder) continue;
        // db.js resolves the scope through session_cache: an entry survives only while a cached row
        // owns it for a spared backend.
        const row = cache.get(id);
        const backendId = row ? row.backendId : null;
        if (inScope(backendId, scope)) search.delete(id);
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
        // db.js: backendId/filePath are COALESCEd — a NULL never downgrades a stored value.
        row.backendId = s.backendId || (prev && prev.backendId) || null;
        row.filePath = s.filePath || (prev && prev.filePath) || null;
        cache.set(s.sessionId, row);
      }
    },
    deleteCachedSession(id) { cache.delete(id); },
    deleteSearchSession(id) { search.delete(id); },
    upsertSearchEntries(entries) { for (const e of entries) search.set(e.id, e); },
    replaceSessionMetrics() {},
    setFolderMeta(folder, projectPath, indexMtimeMs) { folderMeta.set(folder, { folder, projectPath, indexMtimeMs }); },
    getFolderMeta(folder) { return folderMeta.get(folder) || null; },
    getAllFolderMeta() { return folderMeta; },
    getAllMeta() { return meta; },
    getAllCached() { return [...cache.values()].map(r => ({ ...r })); },
    getSetting() { return globalSettings; },
    getMeta(id) { return meta.get(id) || null; },
    setName(id, name) { meta.set(id, { ...(meta.get(id) || {}), name }); },
    getFavoritedProjects() { return new Set(); },
    getProjectDisplayNames() { return new Map(); },
    getAutoHiddenProjects() { return new Set(); },
  };
  return api;
}

// --- fixtures on disk ---
function writeClaudeSession(projectsDir, folder, cwd, sessionId) {
  const dir = path.join(projectsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello claude' } });
  const file = path.join(dir, sessionId + '.jsonl');
  fs.writeFileSync(file, line + '\n', 'utf8');
  return file;
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

// One temp world per test: a Claude projects root, a CODEX_HOME, and a real project dir (the shared cwd).
function setup({ enabledMap = { codex: true }, globalSettings = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-multiscan-'));
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

  // Keep the launch overlay off the real userData dir.
  sessionBackends._configureForTests({ filePath: path.join(root, 'session-backends.json') });

  return { root, projectsDir, codexHome, projectCwd, db, folder: encodeProjectPath(projectCwd) };
}

function cleanup(w) {
  fs.rmSync(w.root, { recursive: true, force: true });
}

// --- (a) shared project bucket ---

test('a Codex session and a Claude session with the same cwd land in the same project', () => {
  const w = setup();
  try {
    writeClaudeSession(w.projectsDir, w.folder, w.projectCwd, 'aaaaaaaa-0000-4000-8000-000000000001');
    writeCodexRollout(w.codexHome, w.projectCwd, 'bbbbbbbb-0000-4000-8000-000000000002');

    sessionCache.refreshFolder(w.folder);
    const stats = sessionCache.refreshBackendSessions('codex');
    assert.equal(stats.scanned, 1);
    assert.equal(stats.upserted, 1);

    const claudeRow = w.db._cache.get('aaaaaaaa-0000-4000-8000-000000000001');
    const codexRow = w.db._cache.get('bbbbbbbb-0000-4000-8000-000000000002');
    assert.ok(claudeRow && codexRow, 'both rows cached');
    assert.equal(codexRow.backendId, 'codex', 'Axis-B provenance comes from the parser/root');
    assert.equal(codexRow.projectPath, w.projectCwd);
    assert.equal(claudeRow.projectPath, w.projectCwd);
    assert.equal(codexRow.folder, claudeRow.folder, 'same folder key -> same bucket');
    assert.equal(codexRow.filePath, path.join(
      w.codexHome, 'sessions', '2026', '07', '01',
      'rollout-2026-07-01T10-00-00-bbbbbbbb-0000-4000-8000-000000000002.jsonl'
    ), 'absolute path stored (v11) — a rollout path cannot be reconstructed from folder+id');

    // The sidebar groups by projectPath: exactly ONE project holding both sessions.
    const projects = sessionCache.buildProjectsFromCache(false);
    const proj = projects.filter(p => p.projectPath === w.projectCwd);
    assert.equal(proj.length, 1, 'one project, not two');
    const ids = proj[0].sessions.map(s => s.sessionId).sort();
    assert.deepEqual(ids, [
      'aaaaaaaa-0000-4000-8000-000000000001',
      'bbbbbbbb-0000-4000-8000-000000000002',
    ]);
    assert.equal(proj[0].sessions.find(s => s.sessionId.startsWith('bbbb')).backendId, 'codex');
    assert.equal(proj[0].sessions.find(s => s.sessionId.startsWith('aaaa')).backendId, 'claude');

    // ...and the Codex session is searchable exactly like a Claude one.
    const entry = w.db._search.get('bbbbbbbb-0000-4000-8000-000000000002');
    assert.ok(entry, 'codex session indexed for FTS');
    assert.match(entry.body, /hello codex/);
    assert.equal(entry.folder, w.folder);
  } finally { cleanup(w); }
});

// --- (b) cross-backend delete isolation (the regression this task exists to prevent) ---

test('refreshing Claude does not delete the Codex rows in the same folder', () => {
  const w = setup();
  try {
    const claudeFile = writeClaudeSession(w.projectsDir, w.folder, w.projectCwd, 'aaaaaaaa-0000-4000-8000-000000000001');
    writeCodexRollout(w.codexHome, w.projectCwd, 'bbbbbbbb-0000-4000-8000-000000000002');
    sessionCache.refreshFolder(w.folder);
    sessionCache.refreshBackendSessions('codex');
    assert.equal(w.db._cache.size, 2);

    // A plain re-sweep must be a no-op for the Codex row.
    sessionCache.refreshFolder(w.folder);
    assert.ok(w.db._cache.has('bbbbbbbb-0000-4000-8000-000000000002'), 'codex row survives a Claude sweep');

    // The Claude transcript disappears -> its row goes, the Codex row stays.
    fs.rmSync(claudeFile);
    sessionCache.refreshFolder(w.folder);
    assert.ok(!w.db._cache.has('aaaaaaaa-0000-4000-8000-000000000001'), 'deleted claude session is reconciled away');
    assert.ok(w.db._cache.has('bbbbbbbb-0000-4000-8000-000000000002'), 'codex row still there');
    assert.ok(w.db._search.has('bbbbbbbb-0000-4000-8000-000000000002'), 'codex search entry still there');

    // The whole Claude folder disappears -> same deal (the folder-wipe path).
    fs.rmSync(path.join(w.projectsDir, w.folder), { recursive: true, force: true });
    sessionCache.refreshFolder(w.folder);
    assert.ok(w.db._cache.has('bbbbbbbb-0000-4000-8000-000000000002'), 'codex row survives the folder wipe');
  } finally { cleanup(w); }
});

test('refreshing Codex does not delete the Claude rows in the same folder', () => {
  const w = setup();
  try {
    writeClaudeSession(w.projectsDir, w.folder, w.projectCwd, 'aaaaaaaa-0000-4000-8000-000000000001');
    const rollout = writeCodexRollout(w.codexHome, w.projectCwd, 'bbbbbbbb-0000-4000-8000-000000000002');
    sessionCache.refreshFolder(w.folder);
    sessionCache.refreshBackendSessions('codex');

    sessionCache.refreshBackendSessions('codex');
    assert.ok(w.db._cache.has('aaaaaaaa-0000-4000-8000-000000000001'), 'claude row survives a Codex sweep');

    // The rollout disappears -> only the Codex row is reconciled away.
    fs.rmSync(rollout);
    const stats = sessionCache.refreshBackendSessions('codex');
    assert.equal(stats.deleted, 1);
    assert.ok(!w.db._cache.has('bbbbbbbb-0000-4000-8000-000000000002'), 'deleted rollout is reconciled away');
    assert.ok(!w.db._search.has('bbbbbbbb-0000-4000-8000-000000000002'), 'and so is its search entry');
    assert.ok(w.db._cache.has('aaaaaaaa-0000-4000-8000-000000000001'), 'claude row untouched');
    assert.ok(w.db._search.has('aaaaaaaa-0000-4000-8000-000000000001'), 'claude search entry untouched');
  } finally { cleanup(w); }
});

test('an unchanged rollout is not re-parsed on the next sweep', () => {
  const w = setup();
  try {
    writeCodexRollout(w.codexHome, w.projectCwd, 'bbbbbbbb-0000-4000-8000-000000000002');
    const first = sessionCache.refreshBackendSessions('codex');
    assert.equal(first.upserted, 1);
    assert.equal(first.skipped, 0);

    const second = sessionCache.refreshBackendSessions('codex');
    assert.equal(second.upserted, 0);
    assert.equal(second.skipped, 1, 'mtime gate holds — no re-parse, no re-index');
    assert.equal(second.deleted, 0);
  } finally { cleanup(w); }
});

// --- (c) Axis-A provenance comes from the launch overlay ---

test('an Axis-A overlay entry makes a Claude-root session carry the profile backendId', () => {
  const w = setup();
  try {
    const sid = 'aaaaaaaa-0000-4000-8000-000000000001';
    sessionBackends.record(sid, 'deepseek-profile', 'deepseek-profile');
    writeClaudeSession(w.projectsDir, w.folder, w.projectCwd, sid);

    sessionCache.refreshFolder(w.folder);

    const row = w.db._cache.get(sid);
    assert.equal(row.backendId, 'deepseek-profile', 'overlay wins for a shared-root session (§5.7)');
    assert.ok(sessionBackends.isPersisted(sid), 'the scanner marks the overlay entry persisted after writing the row');

    // Without an overlay entry the same root means plain Claude.
    const sid2 = 'aaaaaaaa-0000-4000-8000-000000000009';
    writeClaudeSession(w.projectsDir, w.folder, w.projectCwd, sid2);
    sessionCache.refreshFolder(w.folder);
    const row2 = w.db._cache.get(sid2);
    assert.ok(!row2.backendId, 'no overlay -> nothing written -> reads back as claude (db DEFAULT)');
    assert.equal(sessionCache.buildProjectsFromCache(false)
      .find(p => p.projectPath === w.projectCwd)
      .sessions.find(s => s.sessionId === sid2).backendId, 'claude');
  } finally { cleanup(w); }
});

test('an evicted overlay entry does not downgrade an already-recorded profile row', () => {
  const w = setup();
  try {
    const sid = 'aaaaaaaa-0000-4000-8000-000000000001';
    sessionBackends.record(sid, 'deepseek-profile', 'deepseek-profile');
    const file = writeClaudeSession(w.projectsDir, w.folder, w.projectCwd, sid);
    sessionCache.refreshFolder(w.folder);
    assert.equal(w.db._cache.get(sid).backendId, 'deepseek-profile');

    // Simulate the overlay being gone (FIFO eviction after the row was persisted), then re-index.
    sessionBackends._configureForTests({ filePath: path.join(w.root, 'gone.json') });
    fs.appendFileSync(file, JSON.stringify({ type: 'user', cwd: w.projectCwd, message: { role: 'user', content: 'more' } }) + '\n');
    fs.utimesSync(file, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    sessionCache.refreshFolder(w.folder);

    assert.equal(w.db._cache.get(sid).backendId, 'deepseek-profile',
      'the row is authoritative once written — a missing overlay must not reset it to claude');
  } finally { cleanup(w); }
});

// --- (d) the ready && enabled gate (§5.8): never scan, never erase ---

test('a disabled backend is never scanned but keeps its cached rows', () => {
  const w = setup({ enabledMap: { codex: false } });
  try {
    // A row cached from an earlier, enabled run.
    w.db.upsertCachedSessions([{
      sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', folder: w.folder, projectPath: w.projectCwd,
      backendId: 'codex', filePath: path.join(w.codexHome, 'sessions', 'gone.jsonl'),
      summary: 'old codex session', modified: '2026-07-01T10:00:05.000Z',
    }]);
    // ...and a rollout sitting in the store that a scan WOULD pick up.
    writeCodexRollout(w.codexHome, w.projectCwd, 'cccccccc-0000-4000-8000-000000000003');

    const stats = sessionCache.refreshBackendSessions('codex');
    assert.deepEqual(stats, { scanned: 0, upserted: 0, skipped: 0, deleted: 0 }, 'store not enumerated');
    assert.ok(!w.db._cache.has('cccccccc-0000-4000-8000-000000000003'), 'the disabled backend\'s store is not indexed');
    assert.ok(w.db._cache.has('bbbbbbbb-0000-4000-8000-000000000002'), 'disable != erase — existing rows survive');

    // ...and refreshAllBackendSessions skips it too.
    fakeDiscoverCalls = 0;
    const all = sessionCache.refreshAllBackendSessions();
    assert.ok(!('codex' in all), 'disabled backend not swept');
  } finally { cleanup(w); }
});

test('a planned backend is never scanned and its roots are never enumerated', () => {
  // agy is still a `planned` dummy (hermes became ready in Phase 5, codex in Phase 4).
  const w = setup({ enabledMap: { agy: true, faketest: true } });
  try {
    w.db.upsertCachedSessions([{
      sessionId: 'dddddddd-0000-4000-8000-000000000004', folder: w.folder, projectPath: w.projectCwd,
      backendId: 'agy', filePath: null, summary: 'old agy session',
    }]);

    // `planned` can never be enabled (backends.isEnabled), so this is a no-op by construction.
    const stats = sessionCache.refreshBackendSessions('agy');
    assert.deepEqual(stats, { scanned: 0, upserted: 0, skipped: 0, deleted: 0 });
    assert.ok(w.db._cache.has('dddddddd-0000-4000-8000-000000000004'), 'planned backend keeps its cached rows');

    // A ready+enabled Axis-B backend, by contrast, DOES get its store enumerated.
    fakeDiscoverCalls = 0;
    sessionCache.refreshBackendSessions('faketest');
    assert.equal(fakeDiscoverCalls, 1, 'ready && enabled -> discoverSessions() called');

    // ...and a disabled one does not.
    backends.init({ getGlobalSettings: () => ({ backendEnabled: { faketest: false } }) });
    fakeDiscoverCalls = 0;
    sessionCache.refreshBackendSessions('faketest');
    assert.equal(fakeDiscoverCalls, 0, 'disabled -> discoverSessions() never called');
  } finally { cleanup(w); }
});

test('refreshBackendSessions is a no-op for Claude and for Axis-A profiles', () => {
  const w = setup();
  try {
    writeClaudeSession(w.projectsDir, w.folder, w.projectCwd, 'aaaaaaaa-0000-4000-8000-000000000001');
    // Claude's store is owned by refreshFolder/populateCacheViaWorker — this must not double-scan it.
    assert.deepEqual(sessionCache.refreshBackendSessions('claude'),
      { scanned: 0, upserted: 0, skipped: 0, deleted: 0 });
    assert.equal(w.db._cache.size, 0);
    assert.deepEqual(sessionCache.refreshBackendSessions('nonexistent-backend'),
      { scanned: 0, upserted: 0, skipped: 0, deleted: 0 });
  } finally { cleanup(w); }
});

// --- hidden projects ---

test('a hidden project is not re-indexed but its cached Codex rows are left alone', () => {
  const w = setup();
  try {
    writeCodexRollout(w.codexHome, w.projectCwd, 'bbbbbbbb-0000-4000-8000-000000000002');
    sessionCache.refreshBackendSessions('codex');
    assert.ok(w.db._cache.has('bbbbbbbb-0000-4000-8000-000000000002'));

    // Hide the project, then re-sweep: the row must survive (hiding is a view decision).
    const w2 = { ...w };
    sessionCache.init({
      PROJECTS_DIR: w.projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: { info() {}, debug() {}, silly() {} },
      db: Object.assign(w2.db, { getSetting: () => ({ hiddenProjects: [w.projectCwd] }) }),
    });
    // Touch the rollout so the mtime gate does not short-circuit the hidden-project branch.
    const rollout = w.db._cache.get('bbbbbbbb-0000-4000-8000-000000000002').filePath;
    fs.utimesSync(rollout, new Date(Date.now() + 2000), new Date(Date.now() + 2000));

    const stats = sessionCache.refreshBackendSessions('codex');
    assert.equal(stats.upserted, 0, 'hidden project is not re-indexed');
    assert.equal(stats.deleted, 0, 'and its rows are not swept away');
    assert.ok(w.db._cache.has('bbbbbbbb-0000-4000-8000-000000000002'));
  } finally { cleanup(w); }
});

// --- (e) DB-MODE (Phase 5, Hermes): the scanner must handle {kind:'db'} handles, not just files.
//
// This is the whole point of the dual-mode seam. A db-store session has NO file, so:
//   - the change gate rides on a backend-supplied marker instead of a file mtime,
//   - the reconcile keys on the session id instead of a file path,
//   - a session with no cwd (a general agent's gateway/cron chat) must land in a backend-scoped
//     bucket rather than being dropped or force-fitted into some project.

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

test('db-mode: a {kind:db} session is indexed and grouped by its cwd like any other backend', () => {
  const w = setup({ enabledMap: { dbtest: true } });
  try {
    backends.register(fakeDbBackend('dbtest', {
      bucketPath: w.root,
      sessions: [{
        sessionId: 'hsess-1', marker: 'm1',
        row: { cwd: w.projectCwd, summary: 'from a database', messageCount: 2, textContent: 'hello db' },
      }],
    }));

    const stats = sessionCache.refreshBackendSessions('dbtest');
    assert.equal(stats.upserted, 1, 'a db handle is parsed and cached (not skipped as "not a file")');

    const row = w.db._cache.get('hsess-1');
    assert.ok(row, 'the db session is in the cache');
    assert.equal(row.backendId, 'dbtest');
    assert.equal(row.projectPath, w.projectCwd, 'grouped by its cwd, centrally, like everyone else');
    assert.equal(row.folder, w.folder, 'same folder key a Claude session with that cwd would get');
    assert.ok(!row.filePath, 'a db session has no file path');
    assert.equal(row.changeMarker, 'm1', 'its change gate rides on the backend-supplied marker instead');
    assert.ok(w.db._search.has('hsess-1'), 'and it is searchable');
  } finally { cleanup(w); }
});

// T-5.5 — the cost/lineage columns are worthless if they stop at the cache: Stats reads them off the
// renderer's session rows, so the whole chain parser -> upsert -> buildProjectsFromCache must carry
// them. (Hermes' own parent link rides in `lineageParentId`, NOT `parentSessionId` = Claude subagent.)
test('db-mode: cost + lineage reach the renderer session rows', () => {
  const w = setup({ enabledMap: { dbtest: true } });
  try {
    backends.register(fakeDbBackend('dbtest', {
      bucketPath: w.root,
      sessions: [{
        sessionId: 'hsess-1', marker: 'm1',
        // The parser reports the backend's own parent as `parentSessionId` (see hermes/reader.js) —
        // the scanner is what moves it to `lineageParentId`, so the fixture must use the real shape
        // or the remap under test never runs.
        row: {
          cwd: w.projectCwd, summary: 'costed', messageCount: 2,
          estimatedCostUsd: 0.0123, actualCostUsd: null, costStatus: 'estimated',
          parentSessionId: 'hsess-0',
        },
      }],
    }));
    sessionCache.refreshBackendSessions('dbtest');

    const session = sessionCache.buildProjectsFromCache(false)
      .find(p => p.projectPath === w.projectCwd)
      .sessions.find(s => s.sessionId === 'hsess-1');
    assert.equal(session.estimatedCostUsd, 0.0123);
    assert.equal(session.actualCostUsd, null, 'an unsettled cost stays null — never coerced to 0');
    assert.equal(session.costStatus, 'estimated', 'so Stats can label the figure as an estimate');
    assert.equal(session.lineageParentId, 'hsess-0');
    assert.equal(session.parentSessionId, null, 'a backend lineage parent is not a Claude subagent');
  } finally { cleanup(w); }
});

test('db-mode: the change marker is the gate — an unchanged session is not re-parsed', () => {
  const w = setup({ enabledMap: { dbtest: true } });
  try {
    let parses = 0;
    const be = fakeDbBackend('dbtest', {
      bucketPath: w.root,
      sessions: [{ sessionId: 'hsess-1', marker: 'm1', row: { cwd: w.projectCwd, summary: 'v1', messageCount: 1 } }],
    });
    const realParse = be.parseSession;
    be.parseSession = (h) => { parses++; return realParse(h); };
    backends.register(be);

    assert.equal(sessionCache.refreshBackendSessions('dbtest').upserted, 1);
    assert.equal(parses, 1);

    // Same marker -> the scanner must skip it without touching the store.
    const second = sessionCache.refreshBackendSessions('dbtest');
    assert.equal(second.skipped, 1, 'unchanged session skipped via its marker');
    assert.equal(second.upserted, 0);
    assert.equal(parses, 1, 'and NOT re-parsed');
  } finally { cleanup(w); }
});

test('db-mode: a moved marker re-reads the session', () => {
  const w = setup({ enabledMap: { dbtest: true } });
  try {
    const sessions = [{ sessionId: 'hsess-1', marker: 'm1', row: { cwd: w.projectCwd, summary: 'v1', messageCount: 1 } }];
    backends.register(fakeDbBackend('dbtest', { bucketPath: w.root, sessions }));
    sessionCache.refreshBackendSessions('dbtest');

    // The session gained a message -> its marker moves -> it must be re-read.
    sessions[0].marker = 'm2';
    sessions[0].row.summary = 'v2';
    const stats = sessionCache.refreshBackendSessions('dbtest');
    assert.equal(stats.upserted, 1, 'a changed marker forces a re-read');
    assert.equal(w.db._cache.get('hsess-1').summary, 'v2');
  } finally { cleanup(w); }
});

test('db-mode: a cwd-LESS session lands in the backend bucket, not dropped and not in a real project', () => {
  const w = setup({ enabledMap: { dbtest: true } });
  try {
    backends.register(fakeDbBackend('dbtest', {
      bucketPath: w.root,   // the backend's own store root stands in as its bucket
      sessions: [{
        sessionId: 'hsess-nocwd', marker: 'm1',
        row: { cwd: null, summary: 'a gateway chat with no working dir', messageCount: 1 },
      }],
    }));

    const stats = sessionCache.refreshBackendSessions('dbtest');
    assert.equal(stats.upserted, 1, 'a general agent session with no cwd is still ingested');
    const row = w.db._cache.get('hsess-nocwd');
    assert.equal(row.projectPath, w.root, 'bucketed under the backend, not forced into a project');
    assert.notEqual(row.projectPath, w.projectCwd);
  } finally { cleanup(w); }
});

test('db-mode: a session that disappears from the DB is reconciled away (keyed on id, not a file)', () => {
  const w = setup({ enabledMap: { dbtest: true } });
  try {
    const sessions = [
      { sessionId: 'hsess-1', marker: 'm1', row: { cwd: w.projectCwd, summary: 'a', messageCount: 1 } },
      { sessionId: 'hsess-2', marker: 'm1', row: { cwd: w.projectCwd, summary: 'b', messageCount: 1 } },
    ];
    backends.register(fakeDbBackend('dbtest', { bucketPath: w.root, sessions }));
    sessionCache.refreshBackendSessions('dbtest');
    assert.ok(w.db._cache.has('hsess-2'));

    sessions.pop();   // hermes deleted a session
    const stats = sessionCache.refreshBackendSessions('dbtest');
    assert.equal(stats.deleted, 1);
    assert.ok(!w.db._cache.has('hsess-2'), 'gone from the store -> gone from the cache');
    assert.ok(w.db._cache.has('hsess-1'), 'the survivor is untouched');
  } finally { cleanup(w); }
});

// --- (f) Pi: the REAL module through the REAL scanner (T-6.4) -------------------------------------
//
// pi.test.js covers the parser in isolation. This is the other half: that the generic scanner picks Pi
// up with no Pi-specific code anywhere in it — same integration Codex gets above, so a regression in the
// shared path cannot hide behind a green unit test.

test('a Pi session is scanned by the generic path: cached, grouped by its cwd, searchable, with cost', () => {
  const w = setup({ enabledMap: { pi: true } });
  try {
    // Pi's store: <root>/<cwd-encoded>/<ISO>_<uuid>.jsonl. The cwd comes from the HEADER, so the folder
    // name here is deliberately NOT derived from the project path — the parser must not read it.
    const piRoot = path.join(w.root, 'pi-sessions');
    const dir = path.join(piRoot, '--whatever--');
    fs.mkdirSync(dir, { recursive: true });
    const id = 'aaaaaaaa-1111-4000-8000-000000000001';
    fs.writeFileSync(path.join(dir, `2026-07-12T08-30-53-415Z_${id}.jsonl`), [
      JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-07-12T08:30:53.415Z', cwd: w.projectCwd }),
      JSON.stringify({ type: 'message', timestamp: '2026-07-12T08:31:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello pi' }] } }),
      JSON.stringify({ type: 'message', timestamp: '2026-07-12T08:31:05.000Z', message: {
        role: 'assistant', content: [{ type: 'text', text: 'hi there' }], model: 'gpt-5.5', provider: 'openai-codex',
        stopReason: 'stop', usage: { input: 100, output: 10, totalTokens: 110, cost: { total: 0.0042 } },
      } }),
    ].join('\n') + '\n', 'utf8');
    pi.setRoot(piRoot);

    // A Claude session in the SAME cwd — the two must share one project bucket (§5.9).
    writeClaudeSession(w.projectsDir, w.folder, w.projectCwd, 'cccccccc-0000-4000-8000-000000000003');
    sessionCache.refreshFolder(w.folder);

    const stats = sessionCache.refreshBackendSessions('pi');
    assert.equal(stats.upserted, 1, 'the generic scanner parsed Pi with no Pi-specific code in it');

    const row = w.db._cache.get(id);
    assert.ok(row, 'cached');
    assert.equal(row.backendId, 'pi');
    assert.equal(row.projectPath, w.projectCwd, 'grouped by the cwd from its HEADER, not by the folder name');
    assert.equal(row.folder, w.folder, 'the same bucket a Claude session with that cwd gets');
    assert.equal(row.estimatedCostUsd, 0.0042, "Pi's own price estimate rides along");
    assert.equal(row.costStatus, 'estimated');
    assert.equal(row.actualCostUsd, null, 'an estimate is never a settled amount');
    assert.equal(row.model, 'gpt-5.5');

    const entry = w.db._search.get(id);
    assert.ok(entry, 'indexed for search');
    assert.match(entry.body, /hello pi/);

    // ...and refreshing Claude must not touch it (the cross-backend delete invariant).
    sessionCache.refreshFolder(w.folder);
    assert.ok(w.db._cache.get(id), 'a Claude refresh leaves the Pi row alone');
  } finally { pi.setRoot(null); cleanup(w); }
});

test('a MISSING store keeps the cached rows — an unreachable root is not "the user deleted everything"', () => {
  // Pi's root can come from PI_CODING_AGENT_SESSION_DIR, which is set in the user's shell but NOT when
  // the app is started from the Start menu. The root then resolves elsewhere, discovery returns nothing,
  // and reconciling "nothing" against the cache would delete the user's entire Pi history.
  const w = setup({ enabledMap: { pi: true } });
  try {
    pi.setRoot(path.join(w.root, 'does-not-exist'));
    w.db._cache.set('pi-old', {
      sessionId: 'pi-old', backendId: 'pi', folder: w.folder, projectPath: w.projectCwd,
      summary: 'indexed under the other root',
    });

    const stats = sessionCache.refreshBackendSessions('pi');
    assert.equal(stats.deleted, 0, 'nothing is reconciled away when the store is not even there');
    assert.ok(w.db._cache.get('pi-old'), 'the history survives an unreachable root');
  } finally { pi.setRoot(null); cleanup(w); }
});

test('an EMPTY but existing store DOES reconcile — that really is "the sessions are gone"', () => {
  const w = setup({ enabledMap: { pi: true } });
  try {
    const piRoot = path.join(w.root, 'pi-empty');
    fs.mkdirSync(piRoot, { recursive: true });
    pi.setRoot(piRoot);
    w.db._cache.set('pi-gone', {
      sessionId: 'pi-gone', backendId: 'pi', folder: w.folder, projectPath: w.projectCwd, summary: 'deleted',
    });

    const stats = sessionCache.refreshBackendSessions('pi');
    assert.equal(stats.deleted, 1, 'the store is reachable and empty -> the row is stale');
    assert.equal(w.db._cache.get('pi-gone'), undefined);
  } finally { pi.setRoot(null); cleanup(w); }
});

test('a disabled Pi is never scanned, but keeps its cached rows (5.8)', () => {
  const w = setup({ enabledMap: { pi: false } });
  try {
    w.db._cache.set('pi-old', { sessionId: 'pi-old', backendId: 'pi', folder: w.folder, projectPath: w.projectCwd, summary: 'old pi session' });
    const stats = sessionCache.refreshBackendSessions('pi');
    assert.equal(stats.scanned, 0, 'a disabled backend has its store left alone entirely');
    assert.ok(w.db._cache.get('pi-old'), 'disable is not erase');
  } finally { cleanup(w); }
});
