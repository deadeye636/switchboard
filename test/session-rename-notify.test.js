const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');

// #60: a rename (Claude /rename -> JSONL custom-title, promoted via setName) must
// notify the renderer, else the sidebar keeps showing the old name. The immediate
// refresh path (used by the Stop-hook fast-path) runs the reindex inline, so these
// assertions are synchronous.

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
    sessionCache.refreshFile(folder, folder + '/session.jsonl', { immediate: true });
    assert.equal(names.get('session'), 'Renamed_A', 'custom-title promoted to session_meta.name');
    assert.equal(sends.filter(c => c === 'projects-changed').length, 1, 'rename must notify the renderer');

    // Second immediate refresh, nothing changed: must NOT notify again.
    sessionCache.refreshFile(folder, folder + '/session.jsonl', { immediate: true });
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

    sessionCache.refreshFile(folder, folder + '/session.jsonl', { immediate: true });
    assert.equal(sends.filter(c => c === 'projects-changed').length, 1);

    // User renames again → new custom-title in the JSONL.
    writeSession(folderPath, '/tmp/proj', { customTitle: 'Second' });
    sessionCache.refreshFile(folder, folder + '/session.jsonl', { immediate: true });

    assert.equal(names.get('session'), 'Second');
    assert.equal(sends.filter(c => c === 'projects-changed').length, 2, 'new title must notify again');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
