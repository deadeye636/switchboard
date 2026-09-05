'use strict';
// What the scan reports about a project it saw in a store, and specifically the difference between the
// two times it reports (#575).
//
// The register admits a session past a removal's tombstone only when that session STARTED after it. The
// scan used to hand it a single time — the newest RECENCY (`lastEntryAt || modified`) — and a CLI that was
// live in the project at the moment of removal appends within seconds, so the recency moved past the
// tombstone and "remove" was a no-op for exactly the project the user was working in. These tests pin the
// reporting half: every path that notes a store sighting carries the start ALONGSIDE the recency, and a
// path that cannot determine a start says so instead of passing the recency off as one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseBackendSessions } = require('../src/backends/parse');
const { parseClaudeFolder, _sessionStartAt } = require('../src/backends/claude/folder-parse');
const indexWrites = require('../src/index/index-writes');

const STARTED = '2026-07-01T10:00:00.000Z';
const WROTE = '2026-07-01T18:30:00.000Z';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-startedat-'));
}

// A minimal Axis-B descriptor: one file handle, one row, whatever the test wants the reader to know.
function fakeBackend(id, row) {
  return { id, parseSession: () => ({ ...row }) };
}

function runParse(b, filePath) {
  return parseBackendSessions(b, {
    handles: [{ kind: 'file', path: filePath }],
    cachedByFile: new Map(),
    cachedById: new Map(),
  });
}

// --- the generic Axis-B loop ---------------------------------------------------------------------------

test('a store sighting carries the session START, not only its recency', () => {
  const root = tempRoot();
  try {
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const file = path.join(root, 'session.jsonl');
    fs.writeFileSync(file, '{}\n', 'utf8');

    const reply = runParse(fakeBackend('demo', {
      sessionId: 's1', cwd, startedAt: STARTED, lastEntryAt: WROTE, modified: WROTE,
    }), file);

    assert.equal(reply.storeProjects.length, 1);
    const sp = reply.storeProjects[0];
    assert.equal(sp.startedAt, STARTED, 'the tombstone is judged on this one');
    assert.equal(sp.newestAt, WROTE, 'and the recency still rides along beside it');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a store that has no timestamps reports NO start — the recency does not stand in for one', () => {
  // The decision for agy (`startedAt: null` in its parser, on purpose — its `.db` carries no timestamp).
  // Substituting the recency here would restore the #575 bug for precisely the backend that cannot argue
  // with it; the register refuses the bring-back instead, and an explicit act is the way back.
  const root = tempRoot();
  try {
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const file = path.join(root, 'session.jsonl');
    fs.writeFileSync(file, '{}\n', 'utf8');

    const reply = runParse(fakeBackend('timeless', {
      sessionId: 's1', cwd, startedAt: null, lastEntryAt: WROTE, modified: WROTE,
    }), file);

    assert.equal(reply.storeProjects[0].startedAt, null);
    assert.equal(reply.storeProjects[0].newestAt, WROTE, 'the sighting is still recorded — only the start is absent');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- Claude's REMOVED-folder branch ---------------------------------------------------------------------

function writeTranscript(folderPath, name, firstTimestamp, lastTimestamp) {
  const file = path.join(folderPath, name);
  const lines = [
    JSON.stringify({ type: 'user', timestamp: firstTimestamp, cwd: folderPath, message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', timestamp: lastTimestamp, message: { role: 'assistant', content: 'ok' } }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

function parseRemovedFolder(folderPath, projectPath) {
  return parseClaudeFolder({
    folder: 'removed-folder', folderPath, exists: true, projectPath, removed: true,
    cachedMap: new Map(), cachedByFilePath: new Map(),
  });
}

test('a REMOVED Claude folder reports the newest session START, read from the transcript heads', () => {
  // This branch parses no session — it never has — so before #575 the only time it had was the folder
  // index mtime, a recency it reported as if it were a start. A session that was already running keeps
  // moving that mtime, which is what brought the project straight back.
  const root = tempRoot();
  try {
    const folderPath = path.join(root, 'store', 'folder');
    fs.mkdirSync(folderPath, { recursive: true });
    const projectPath = path.join(root, 'project');

    writeTranscript(folderPath, 'old.jsonl', '2026-07-01T08:00:00.000Z', '2026-07-09T23:00:00.000Z');
    writeTranscript(folderPath, 'newer.jsonl', '2026-07-04T12:00:00.000Z', '2026-07-04T12:30:00.000Z');

    const reply = parseRemovedFolder(folderPath, projectPath);
    assert.equal(reply.storeProjects.length, 1);
    assert.equal(reply.storeProjects[0].startedAt, '2026-07-04T12:00:00.000Z',
      'the newest FIRST entry across the folder — not the newest last entry, which belongs to the older session');
    assert.ok(reply.storeProjects[0].newestAt, 'and the folder mtime still rides along as the recency');
    assert.equal(reply.sessions.length, 0, 'a removed folder is still not parsed back into the cache');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a transcript with no entry yet reports no start — and is re-read once it has one', () => {
  // A header-only file is a session about to exist, not one that started at an unknown time. Remembering
  // "no start" for it would make that permanent, and the session that begins a second later would never
  // bring its project back.
  const root = tempRoot();
  try {
    const folderPath = path.join(root, 'store', 'folder');
    fs.mkdirSync(folderPath, { recursive: true });
    const projectPath = path.join(root, 'project');
    const file = path.join(folderPath, 'fresh.jsonl');

    fs.writeFileSync(file, JSON.stringify({ type: 'summary', summary: 'no timestamp here' }) + '\n', 'utf8');
    assert.equal(parseRemovedFolder(folderPath, projectPath).storeProjects[0].startedAt, null);

    writeTranscript(folderPath, 'fresh.jsonl', STARTED, WROTE);
    assert.equal(parseRemovedFolder(folderPath, projectPath).storeProjects[0].startedAt, STARTED,
      'the absence was not memoised, so the first real entry is picked up');
    assert.equal(_sessionStartAt.get(file), STARTED, 'and THAT is remembered — a start never changes');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- the scan-state map ---------------------------------------------------------------------------------

test('the store scan-state keeps the newest start and the newest write independently', () => {
  // They need not come from the same session: the newest session can be the one that has written least
  // recently. Folding them into one maximum would answer the tombstone with a time no session has.
  const root = tempRoot();
  try {
    const projectPath = path.join(root, 'project');
    indexWrites.noteStoreProject(projectPath, WROTE, '2026-07-01T08:00:00.000Z');
    indexWrites.noteStoreProject(projectPath, '2026-07-01T09:00:00.000Z', STARTED);

    const seen = indexWrites.getStoreProjectPaths().get(projectPath);
    assert.equal(seen.newestAt, WROTE);
    assert.equal(seen.startedAt, STARTED);

    // A sighting with no start at all must not erase one another session already established.
    indexWrites.noteStoreProject(projectPath, WROTE, null);
    assert.equal(indexWrites.getStoreProjectPaths().get(projectPath).startedAt, STARTED);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('newestStartedAt is an absence when not one session in the batch can say', () => {
  assert.equal(indexWrites.newestStartedAt([
    { startedAt: STARTED, modified: WROTE },
    { startedAt: null, modified: WROTE },
  ]), STARTED);
  assert.equal(indexWrites.newestStartedAt([{ startedAt: null, modified: WROTE }]), null,
    'never the recency, which is exactly the substitution #575 undoes');
  assert.equal(indexWrites.newestStartedAt([]), null);
});
