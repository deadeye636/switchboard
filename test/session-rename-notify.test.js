const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../src/index/session-cache');
const storeIndexer = require('../src/backends/claude/store-indexer');
const { parseClaudeFile } = require('../src/backends/claude/folder-parse');

// #60: a rename (Claude /rename -> JSONL custom-title, promoted via setName) must
// notify the renderer, else the sidebar keeps showing the old name.
//
// #199 CLEANUP: the single-file parse moved off-thread, so the on-thread flow is now the pure parse leaf
// (parseClaudeFile) + the shared apply helper (applyClaudeFileReply) — the exact pair the worker's file
// lane runs. `reindex` drives that synchronously, so these assertions stay synchronous.
function reindex(folder, filePath, projectPath) {
  const parsed = parseClaudeFile(filePath, folder, projectPath, { parentSessionId: null });
  if (parsed.session) storeIndexer.applyClaudeFileReply(parsed.session);
}

function writeSession(folderPath, cwd, { customTitle } = {}) {
  fs.mkdirSync(folderPath, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } }),
  ];
  if (customTitle) lines.push(JSON.stringify({ type: 'custom-title', customTitle }));
  fs.writeFileSync(path.join(folderPath, 'session.jsonl'), lines.join('\n') + '\n', 'utf8');
}

test('rename fires projects-changed on first index, then stays quiet when unchanged', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-rename-'));
  try {
    const folder = 'proj';
    writeSession(path.join(projectsDir, folder), '/tmp/proj', { customTitle: 'Renamed_A' });

    const sends = [];
    const names = new Map();
    const win = { isDestroyed: () => false, webContents: { send: (ch) => sends.push(ch) } };
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => win,
      log: { info() {}, debug() {}, warn() {}, error() {} },
      db: {
        deleteCachedFolder() {}, getCachedByFolder() { return []; }, upsertCachedSessions() {},
        deleteCachedSession() {}, replaceSessionMetrics() {}, deleteSearchFolder() {},
        deleteSearchSession() {}, upsertSearchEntries() {},
        setFolderMeta() {}, getFolderMeta() { return null; }, getAllFolderMeta() { return new Map(); },
        getAllMeta() { return new Map(); }, getAllCached() { return []; }, getSetting() { return {}; },
        getMeta(id) { return names.has(id) ? { name: names.get(id) } : null; },
        setName(id, name) { names.set(id, name); },
        getFavoritedProjects() { return new Set(); }, getProjectDisplayNames() { return new Map(); },
        getAutoHiddenProjects() { return new Set(); },
      },
    });

    // First immediate refresh: name goes null -> "Renamed_A" -> must notify.
    reindex(folder, path.join(projectsDir, folder, 'session.jsonl'), '/tmp/proj');
    assert.equal(names.get('session'), 'Renamed_A', 'custom-title promoted to session_meta.name');
    assert.equal(sends.filter(c => c === 'projects-changed').length, 1, 'rename must notify the renderer');

    // Second immediate refresh, nothing changed: must NOT notify again.
    reindex(folder, path.join(projectsDir, folder, 'session.jsonl'), '/tmp/proj');
    assert.equal(sends.filter(c => c === 'projects-changed').length, 1, 'no rename → no extra notify');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('a later /rename to a new title notifies again', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-rename2-'));
  try {
    const folder = 'proj';
    const folderPath = path.join(projectsDir, folder);
    writeSession(folderPath, '/tmp/proj', { customTitle: 'First' });

    const sends = [];
    const names = new Map();
    const win = { isDestroyed: () => false, webContents: { send: (ch) => sends.push(ch) } };
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => win,
      log: { info() {}, debug() {}, warn() {}, error() {} },
      db: {
        deleteCachedFolder() {}, getCachedByFolder() { return []; }, upsertCachedSessions() {},
        deleteCachedSession() {}, replaceSessionMetrics() {}, deleteSearchFolder() {},
        deleteSearchSession() {}, upsertSearchEntries() {},
        setFolderMeta() {}, getFolderMeta() { return null; }, getAllFolderMeta() { return new Map(); },
        getAllMeta() { return new Map(); }, getAllCached() { return []; }, getSetting() { return {}; },
        getMeta(id) { return names.has(id) ? { name: names.get(id) } : null; },
        setName(id, name) { names.set(id, name); },
        getFavoritedProjects() { return new Set(); }, getProjectDisplayNames() { return new Map(); },
        getAutoHiddenProjects() { return new Set(); },
      },
    });

    reindex(folder, path.join(projectsDir, folder, 'session.jsonl'), '/tmp/proj');
    assert.equal(sends.filter(c => c === 'projects-changed').length, 1);

    // User renames again → new custom-title in the JSONL.
    writeSession(folderPath, '/tmp/proj', { customTitle: 'Second' });
    reindex(folder, path.join(projectsDir, folder, 'session.jsonl'), '/tmp/proj');

    assert.equal(names.get('session'), 'Second');
    assert.equal(sends.filter(c => c === 'projects-changed').length, 2, 'new title must notify again');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

// #199 step 4: the writes moved into the neutral sink, but the #60 rename push must still be derived
// from the effective name captured BEFORE the sink vs AFTER it — NOT from "did the sink write". A change
// that grows the transcript body while the name stays the same runs the full write path (upsert + FTS +
// metrics) yet must fire NOTHING, or the sidebar would repaint on every append. This guards the
// prevName/newName straddle around applyIndexResults.
test('a body change with an unchanged name writes but does NOT re-notify (#60 through the sink)', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-rename3-'));
  try {
    const folder = 'proj';
    const folderPath = path.join(projectsDir, folder);
    writeSession(folderPath, '/tmp/proj', { customTitle: 'Stable' });

    const sends = [];
    const names = new Map();
    let upserts = 0;
    const win = { isDestroyed: () => false, webContents: { send: (ch) => sends.push(ch) } };
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => win,
      log: { info() {}, debug() {}, warn() {}, error() {} },
      db: {
        deleteCachedFolder() {}, getCachedByFolder() { return []; },
        upsertCachedSessions() { upserts++; },
        deleteCachedSession() {}, replaceSessionMetrics() {}, deleteSearchFolder() {},
        deleteSearchSession() {}, upsertSearchEntries() {},
        setFolderMeta() {}, getFolderMeta() { return null; }, getAllFolderMeta() { return new Map(); },
        getAllMeta() { return new Map(); }, getAllCached() { return []; }, getSetting() { return {}; },
        getMeta(id) { return names.has(id) ? { name: names.get(id) } : null; },
        setName(id, name) { names.set(id, name); },
        getFavoritedProjects() { return new Set(); }, getProjectDisplayNames() { return new Map(); },
        getAutoHiddenProjects() { return new Set(); },
      },
    });

    // First index: null → "Stable" notifies once.
    reindex(folder, path.join(projectsDir, folder, 'session.jsonl'), '/tmp/proj');
    assert.equal(sends.filter(c => c === 'projects-changed').length, 1);
    const upsertsAfterFirst = upserts;

    // Append a body line, keep the SAME custom-title. The sink must still write (upsert runs)...
    fs.appendFileSync(path.join(folderPath, 'session.jsonl'),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'more output' } }) + '\n', 'utf8');
    reindex(folder, path.join(projectsDir, folder, 'session.jsonl'), '/tmp/proj');

    assert.ok(upserts > upsertsAfterFirst, 'the body change is written through the sink');
    assert.equal(names.get('session'), 'Stable');
    assert.equal(sends.filter(c => c === 'projects-changed').length, 1, 'but an unchanged name must NOT re-notify');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
