'use strict';

// #880 — a parser bump is repaired by ONE gated cold scan. The global `claudeParserVersion` mark is gone:
// get-projects no longer chains a full pass for it, and nothing is written after a failed, cancelled or
// interrupted scan. Sibling of cold-scan-gate.test.js (same fake db, same real scan worker).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../src/index/session-cache');
const backends = require('../src/backends');
const sessionBackends = require('../src/session/session-backends');
const { encodeProjectPath } = require('../src/session/encode-project-path');
const { stripComments } = require('./helpers/strip-comments');

const CLAUDE_PARSER_VERSION = backends.get('claude').PARSER_SCHEMA_VERSION;

function makeFakeDb(onUpsert) {
  const cache = new Map();
  const search = new Map();
  const meta = new Map();
  const folderMeta = new Map();
  return {
    _cache: cache,
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

function setup(folders) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-parserbump-'));
  const projectsDir = path.join(root, 'claude-projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  const made = [];
  for (let i = 0; i < folders; i++) {
    const cwd = path.join(root, `proj-${i}`);
    fs.mkdirSync(cwd, { recursive: true });
    const folder = encodeProjectPath(cwd);
    const dir = path.join(projectsDir, folder);
    fs.mkdirSync(dir, { recursive: true });
    const sessionId = `cccccccc-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`;
    fs.writeFileSync(
      path.join(dir, sessionId + '.jsonl'),
      JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } }) + '\n',
      'utf8',
    );
    made.push({ folder, sessionId });
  }
  const seen = [];
  const infoLines = [];
  backends.init({ getGlobalSettings: () => ({ backendEnabled: {} }) });
  const db = makeFakeDb((sessions) => { for (const s of sessions) seen.push(s.folder); });
  sessionCache.init({
    PROJECTS_DIR: projectsDir,
    activeSessions: new Map(),
    getMainWindow: () => null,
    log: { info(msg) { infoLines.push(String(msg)); }, warn() {}, debug() {}, silly() {} },
    db,
  });
  sessionBackends._configureForTests({ filePath: path.join(root, 'session-backends.json') });
  return { root, db, made, seen, infoLines };
}

const scansOf = (w) => w.infoLines.filter(l => l.includes('cold scan:'));

test('stale rows: ONE gated scan repairs them and no second pass is chained', async () => {
  const w = setup(4);
  try {
    await sessionCache.populateCacheViaWorker();
    for (const row of w.db._cache.values()) row.parserVersion = CLAUDE_PARSER_VERSION - 1;
    w.seen.length = 0;
    w.infoLines.length = 0;

    // What the app does on whenReady, then what get-projects does when it races it: it joins the scan in
    // flight (main.js) instead of requesting another one.
    const cold = sessionCache.populateCacheViaWorker({ incremental: true });
    const joined = sessionCache.scanInFlight();
    assert.ok(joined, 'a scan is in flight for get-projects to wait on');
    await Promise.all([cold, joined]);

    assert.equal(scansOf(w).length, 1, `exactly one scan ran (saw: ${scansOf(w).join(' | ')})`);
    assert.equal(new Set(w.seen).size, 4, 'and it re-read every stale folder');
    assert.ok([...w.db._cache.values()].every(r => r.parserVersion === CLAUDE_PARSER_VERSION), 'rows are current');
    assert.equal(sessionCache.scanInFlight(), null, 'nothing is in flight afterwards');
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('a run interrupted half-way resumes: folders already applied are skipped', async () => {
  const w = setup(4);
  try {
    await sessionCache.populateCacheViaWorker();
    // The shape an interrupted gated run leaves: two folders already on the new parser, two still stale.
    const stale = new Set([w.made[1].folder, w.made[3].folder]);
    for (const row of w.db._cache.values()) if (stale.has(row.folder)) row.parserVersion = CLAUDE_PARSER_VERSION - 1;
    w.seen.length = 0;

    await sessionCache.populateCacheViaWorker({ incremental: true });
    assert.deepEqual([...new Set(w.seen)].sort(), [...stale].sort(), 'only the stale folders were read');
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

// The "no mark after a failed or cancelled scan" half of #880 is a source property, not a runtime one: the
// mark lived in main.js and is gone, so the checks below are what can fail if it comes back.
test('main.js: the parser mark is gone and get-projects only joins or escalates', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8'));
  for (const gone of ['claudeParserBumped', 'markClaudeParserRead', 'claudeParserVersion']) {
    assert.ok(!src.includes(gone), `${gone} is retired (#880)`);
  }
  assert.match(src, /searchEmpty\s*\?\s*populateCacheViaWorker\(\)\s*:\s*\(scanInFlight\(\)\s*\|\|\s*populateCacheViaWorker\(\)\)/,
    'an empty search index asks for the full pass; an empty cache joins the scan in flight, or starts one if it raced whenReady');
});

test('an empty search index still gets a full pass behind a gated scan', async () => {
  // get-projects asks populateCacheViaWorker() with no argument for that case (source check above); this
  // pins that the request escalates rather than joining the gated pass, which would skip stamped folders.
  const w = setup(3);
  try {
    await sessionCache.populateCacheViaWorker();
    w.seen.length = 0;
    w.infoLines.length = 0;

    const gated = sessionCache.populateCacheViaWorker({ incremental: true });
    const full = sessionCache.populateCacheViaWorker();
    await Promise.all([gated, full]);

    assert.equal(scansOf(w).length, 2, 'the full request ran its own scan');
    assert.equal(new Set(w.seen).size, 3, 'and it read every folder');
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});
