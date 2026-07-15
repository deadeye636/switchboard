'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');
const backends = require('../backends');
const sessionBackends = require('../session-backends');
const { encodeProjectPath } = require('../encode-project-path');

// #199 step 5.1a — CHARACTERIZATION tests for the four behaviours the "extract the Claude parse-loop as a
// PURE function" claim rests on, and which the rest of the suite does NOT cover. They are written GREEN on
// today's (pre-extraction) code and must stay green after the extraction: they lock the side-effects that
// live on MAIN and must be replayed from the pure loop's reply, or 5.1a silently drops them even on-thread.
//
//   1. noteStoreProject — refreshFolder's REMOVED branch + the cold-scan REMOVED branch. Drop it and
//      storeProjectPaths empties -> syncRegistry breaks the #167 tombstone/bring-back.
//   2. vanished-folder scoped wipe — deleteCachedFolder(folder, scope) WITHOUT deleteSearchFolder (the
//      deliberate A-4 asymmetry). Route it through the sink's search-first wipeFolders and behaviour changes.
//   3. cancelReindex — the sweep cancels the pending debounced refreshFile for a file it re-read (the
//      double-read #199 kills). The debounce timers live on main.
//   4. rename straddle (#60) — prevName-before / newName-after around the sink; notify the renderer only
//      when the effective name actually changed, NOT on a body-only append.

// --- in-memory db fake (better-sqlite3 can't load under node:test), trimmed from scan-multi-backend +
// per-call recording for the assertions below. Scope semantics mirror db.js backendScopeClause() 1:1. ---
function inScope(backendId, scope) {
  const id = backendId || 'claude';
  if (!scope) return true;
  if (Array.isArray(scope.only)) return scope.only.includes(id);
  if (Array.isArray(scope.except)) return scope.except.length === 0 || !scope.except.includes(id);
  return true;
}

function makeFakeDb() {
  const cache = new Map();
  const search = new Map();
  const meta = new Map();
  const folderMeta = new Map();
  const metrics = new Map();
  const projectStates = new Map();
  const rec = { deleteCachedFolder: [], deleteSearchFolder: [], upsertIds: [] };

  const api = {
    _cache: cache, _search: search, _meta: meta, _folderMeta: folderMeta, _states: projectStates, _rec: rec,
    deleteCachedFolder(folder, scope) {
      rec.deleteCachedFolder.push({ folder, scope });
      for (const [id, row] of [...cache]) {
        if (row.folder === folder && inScope(row.backendId, scope)) cache.delete(id);
      }
      folderMeta.delete(folder);
    },
    deleteSearchFolder(folder, scope) {
      rec.deleteSearchFolder.push({ folder, scope });
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
        rec.upsertIds.push(s.sessionId);
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
    replaceSessionMetrics(id, rows) { metrics.set(id, rows); },
    setFolderMeta(folder, projectPath, indexMtimeMs) { folderMeta.set(folder, { folder, projectPath, indexMtimeMs }); },
    getFolderMeta(folder) { return folderMeta.get(folder) || null; },
    getAllFolderMeta() { return folderMeta; },
    getAllMeta() { return meta; },
    getAllCached() { return [...cache.values()].map(r => ({ ...r })); },
    getSetting() { return {}; },
    getMeta(id) { return meta.get(id) || null; },
    setName(id, name) { meta.set(id, { ...(meta.get(id) || {}), name }); },
    getProjectMeta(p) { return projectStates.get(p) || null; },
  };
  return api;
}

function writeClaudeSession(projectsDir, folder, cwd, sessionId, extraLines = []) {
  const dir = path.join(projectsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } }), ...extraLines];
  const file = path.join(dir, sessionId + '.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

// A fake BrowserWindow that records the channels it is asked to push, so we can see the #60 rename notify.
function makeWindow(pushed) {
  return { isDestroyed: () => false, webContents: { send: (ch) => pushed.push(ch) } };
}

function setup({ pushed = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-storeidx-'));
  const projectsDir = path.join(root, 'claude-projects');
  const projectCwd = path.join(root, 'demo');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(projectCwd, { recursive: true });

  backends.init({ getGlobalSettings: () => ({ backendEnabled: {} }) });
  const db = makeFakeDb();
  sessionCache.init({
    PROJECTS_DIR: projectsDir,
    activeSessions: new Map(),
    getMainWindow: () => makeWindow(pushed),
    log: { info() {}, debug() {}, silly() {} },
    db,
  });
  sessionBackends._configureForTests({ filePath: path.join(root, 'session-backends.json') });
  return { root, projectsDir, projectCwd, db, folder: encodeProjectPath(projectCwd) };
}

function cleanup(w) { fs.rmSync(w.root, { recursive: true, force: true }); }

// --- 1. noteStoreProject on the REMOVED branch of refreshFolder ---
test('refreshFolder notes a REMOVED project in the store scan-state (does not index it back in)', () => {
  const w = setup();
  const id = 'aaaaaaaa-0000-4000-8000-000000000001';
  try {
    writeClaudeSession(w.projectsDir, w.folder, w.projectCwd, id);
    // The project is removed (#167): registered off, tombstoned.
    w.db._states.set(w.projectCwd, { registered: 0, removedAt: new Date().toISOString() });

    const changed = sessionCache.refreshFolder(w.folder);

    assert.equal(changed, false, 'a removed folder reports no cache change');
    assert.equal(w.db._cache.has(id), false, 'its session is NOT indexed back into the cache');
    assert.ok(sessionCache.getStoreProjectPaths().has(w.projectCwd),
      'but the store scan-state must still know a transcript exists there (#167 tombstone/bring-back)');
    // and the folder was still stamped so the sweep gate does not re-trip forever
    assert.ok(w.db._folderMeta.has(w.folder), 'the visited removed folder is still stamped');
  } finally { cleanup(w); }
});

// --- 1b. noteStoreProject on the cold-scan REMOVED branch (real worker) ---
test('the cold-scan worker handler notes a REMOVED project instead of indexing it', async () => {
  const w = setup();
  const id = 'aaaaaaaa-0000-4000-8000-00000000c01d';
  try {
    writeClaudeSession(w.projectsDir, w.folder, w.projectCwd, id);
    w.db._states.set(w.projectCwd, { registered: 0, removedAt: new Date().toISOString() });

    await sessionCache.populateCacheViaWorker();

    assert.equal(w.db._cache.has(id), false, 'the cold scan does not resurrect a removed project');
    assert.ok(sessionCache.getStoreProjectPaths().has(w.projectCwd),
      'the cold-scan removed branch still records the store sighting');
  } finally { cleanup(w); }
});

// --- 2. vanished-folder scoped wipe (A-4 asymmetry) ---
test('a vanished folder does the scoped deleteCachedFolder WITHOUT deleteSearchFolder (A-4 asymmetry)', () => {
  const w = setup();
  const id = 'bbbbbbbb-0000-4000-8000-000000000002';
  try {
    // Seed a cached row + its search entry for a folder that does NOT exist on disk.
    w.db._cache.set(id, { sessionId: id, folder: w.folder, backendId: 'claude', modified: 'x', filePath: 'p' });
    w.db._search.set(id, { id, type: 'session', folder: w.folder, title: 't', body: 'b' });

    const changed = sessionCache.refreshFolder(w.folder);

    assert.equal(changed, true, 'a vanished folder reports a change');
    assert.equal(w.db._rec.deleteCachedFolder.length, 1, 'deleteCachedFolder ran exactly once');
    assert.deepEqual(w.db._rec.deleteCachedFolder[0].folder, w.folder);
    assert.ok(w.db._rec.deleteCachedFolder[0].scope, 'and it was scoped (claudeStoreScope)');
    assert.equal(w.db._rec.deleteSearchFolder.length, 0,
      'deleteSearchFolder is deliberately NOT called on the vanished-folder branch (A-4)');
    assert.equal(w.db._cache.has(id), false, 'the cache row is gone');
    assert.equal(w.db._search.has(id), true, 'the search entry is deliberately left (the pre-existing orphan)');
  } finally { cleanup(w); }
});

// --- 3. cancelReindex — the sweep cancels a pending debounced refreshFile for a file it re-read ---
test('refreshFolder cancels the pending debounced reindex for a file it re-read (no double read)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = setup();
  const id = 'cccccccc-0000-4000-8000-000000000003';
  try {
    writeClaudeSession(w.projectsDir, w.folder, w.projectCwd, id);
    const rel = w.folder + '/' + id + '.jsonl';
    const filePath = path.join(w.projectsDir, w.folder, id + '.jsonl');

    // Watcher path: schedule a debounced reindex for this file (run() not yet executed).
    sessionCache.refreshFile(w.folder, rel);
    assert.equal(w.db._rec.upsertIds.filter(x => x === id).length, 0, 'the debounce has not upserted yet');

    // The sweep re-reads the whole folder — reads this file and must cancel the pending debounce for it.
    sessionCache.refreshFolder(w.folder);
    assert.equal(w.db._rec.upsertIds.filter(x => x === id).length, 1, 'the sweep read + upserted the file once');

    // Append MORE bytes: if the debounce were NOT cancelled, its run() would now fire and read+upsert again.
    fs.appendFileSync(filePath, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'more' } }) + '\n', 'utf8');
    t.mock.timers.tick(5000);

    assert.equal(w.db._rec.upsertIds.filter(x => x === id).length, 1,
      'the pending debounce was cancelled by the sweep — no second read (the #199 double-read)');
  } finally { cleanup(w); t.mock.timers.reset(); }
});

// --- 4. rename straddle (#60): notify on a real rename, NOT on a body-only append ---
test('refreshFile notifies the renderer on a real /rename but not on a body-only change (#60 straddle)', () => {
  const pushed = [];
  const w = setup({ pushed });
  const id = 'dddddddd-0000-4000-8000-000000000004';
  try {
    const filePath = writeClaudeSession(w.projectsDir, w.folder, w.projectCwd, id, [
      JSON.stringify({ type: 'custom-title', customTitle: 'First name' }),
    ]);
    // Initial index — sets the name for the first time (null -> "First name").
    sessionCache.refreshFile(w.folder, w.folder + '/' + id + '.jsonl', { immediate: true });
    const afterInitial = pushed.filter(c => c === 'projects-changed').length;
    assert.ok(afterInitial >= 1, 'first index establishes the name and pushes');

    // A real rename: the /title custom-title changes.
    fs.appendFileSync(filePath, JSON.stringify({ type: 'custom-title', customTitle: 'Renamed' }) + '\n', 'utf8');
    sessionCache.refreshFile(w.folder, w.folder + '/' + id + '.jsonl', { immediate: true });
    const afterRename = pushed.filter(c => c === 'projects-changed').length;
    assert.equal(afterRename, afterInitial + 1, 'a real rename straddle notifies the renderer');
    assert.equal((w.db._meta.get(id) || {}).name, 'Renamed', 'and the new name was written');

    // A body-only change: a message append, same title -> the effective name is unchanged -> NO notify.
    fs.appendFileSync(filePath, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'body only' } }) + '\n', 'utf8');
    sessionCache.refreshFile(w.folder, w.folder + '/' + id + '.jsonl', { immediate: true });
    const afterBody = pushed.filter(c => c === 'projects-changed').length;
    assert.equal(afterBody, afterRename, 'a body-only change must NOT fire the rename notify');
  } finally { cleanup(w); }
});
