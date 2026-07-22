'use strict';
// agy (Antigravity CLI) — the parser reads a real-shaped conversation `.db`, and the descriptor honours
// the contracts every backend owes (parity is asserted generically in backend-parity.test.js; this file
// pins the agy-specific extraction: sessionId from the filename, cwd from the metadata blob, the 14/15
// message count, and the best-effort title/model/prompt string extraction).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const parser = require('../src/backends/agy/parser');
const agy = require('../src/backends/agy');

// A protobuf string field (#1, wire type 2): tag 0x0a, a single-byte length, then the bytes. This is
// what agy's blobs really carry — the identity parser recovers it via a length-prefix scan, and
// `readMessages` recovers it via a proper wire-format walk (which needs the tag byte).
function field1(s) {
  const body = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([0x0a, body.length]), body]);
}

/**
 * Build a minimal but real-shaped conversation DB with node:sqlite (better-sqlite3 is Electron-only).
 * Mirrors the columns the parser reads: steps(idx, step_type, step_payload, metadata) and
 * trajectory_metadata_blob(id, data). Blobs carry the marker strings the parser extracts.
 */
function makeFixtureDb(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB, metadata BLOB);
    CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
  `);

  // cwd lives at the head of the trajectory metadata blob as a file:// URI.
  db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', field1('file:///X:/proj'));

  // idx 0: user prompt (14). idx 1: model reply (15) — a proto text field for the reply, plus the model
  // display string as a trailing raw run (that is where the model hunt reads it, not the message walk).
  // idx 2: a title step (23). idx 3: a tool step (9) — NOT a message, and NO prose to export.
  const insert = db.prepare('INSERT INTO steps (idx, step_type, step_payload, metadata) VALUES (?, ?, ?, ?)');
  insert.run(0, 14, field1('hello world'), null);
  insert.run(1, 15, Buffer.concat([field1('Hi there! How can I help you today?'), Buffer.from('Gemini 3.5 Flash (Medium)', 'utf8')]), null);
  insert.run(2, 23, field1('Test Title Here'), null);
  insert.run(3, 9, Buffer.concat([field1('list_dir'), Buffer.from('{"DirectoryPath":"X:/proj"}', 'utf8')]), null);
  db.close();
}

function withFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-'));
  const dbPath = path.join(dir, 'abcd1234-5678-4abc-8def-111122223333.db');
  try {
    makeFixtureDb(dbPath);
    fn(dbPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('agy parser: sessionId from the filename, cwd from the metadata blob, 14/15 message count', () => {
  withFixture((dbPath) => {
    const row = parser.parseSession({ kind: 'file', path: dbPath });
    assert.ok(row, 'a row is produced');
    assert.equal(row.sessionId, 'abcd1234-5678-4abc-8def-111122223333', 'id is the .db basename');
    assert.equal(row.backendId, 'agy');
    assert.equal(row.cwd, 'X:\\proj', 'file:///X:/proj decodes to the OS path');
    assert.equal(row.messageCount, 2, 'the two 14/15 steps — not the tool step');
    assert.equal(row.userMessageCount, 1);
    assert.equal(row.summary, 'Test Title Here', 'the generated title');
    assert.equal(row.firstPrompt, 'hello world');
    assert.equal(row.model, 'Gemini 3.5 Flash (Medium)', 'best-effort model from the blob');
    assert.equal(row.lastRole, 'assistant', 'the last message step was the model message -> idle');
  });
});

test('agy parser: parseSessionIncremental returns the { row, parseState } shape (parity §5.10)', () => {
  withFixture((dbPath) => {
    const out = parser.parseSessionIncremental({ kind: 'file', path: dbPath });
    assert.ok(out && typeof out === 'object' && 'row' in out && 'parseState' in out);
    assert.equal(out.parseState, null, 'SQLite is not tail-readable — no real incremental state');
    assert.equal(out.row.sessionId, 'abcd1234-5678-4abc-8def-111122223333');
  });
});

test('agy parser: readMessages exports the turns (viewer/handoff shape), tool step skipped', () => {
  withFixture((dbPath) => {
    const msgs = parser.readMessages(dbPath);
    assert.equal(msgs.length, 2, 'the two 14/15 turns — the tool step carries no prose');
    assert.deepEqual(msgs[0], { type: 'message', timestamp: null, message: { role: 'user', content: 'hello world' } });
    assert.deepEqual(msgs[1], { type: 'message', timestamp: null, message: { role: 'assistant', content: 'Hi there! How can I help you today?' } });
  });
});

test('agy parser: readMessages never throws — [] on a bad path', () => {
  assert.deepEqual(parser.readMessages('/no/such/conversation.db'), []);
});

test('agy parser: extractMessageText prefers the reply, drops ids/tool-json', () => {
  // a proto message with a uuid, a tool JSON, and the real reply (with markdown + a path IN it) — the
  // reply must win, and mentioning a path must not get it filtered as one.
  const reply = 'Sure — here is the plan for `Z:\\temp` today.';
  const buf = Buffer.concat([
    field1('30adb649-ad60-4eab-932b-75bd0c016e07'),
    field1('{"DirectoryPath":"Z:\\temp"}'),
    field1(reply),
  ]);
  assert.equal(parser.extractMessageText(buf), reply);
});

test('agy parser: a bad handle never throws — it returns null / the empty shape', () => {
  assert.equal(parser.parseSession({ kind: 'not-a-file' }), null);
  assert.equal(parser.parseSession(null), null);
  const out = parser.parseSessionIncremental({ kind: 'nope' });
  assert.deepEqual(out, { row: null, parseState: null });
});

test('agy parser: pure string helpers', () => {
  assert.equal(parser.fileUriToPath('file:///C:/proj'), 'C:\\proj');
  assert.equal(parser.fileUriToPath('file:///home/x/proj'), '/home/x/proj');
  assert.equal(parser.extractModel('noise Gemini 3.5 Flash (Medium) noise'), 'Gemini 3.5 Flash (Medium)');
  assert.equal(parser.extractModel('gemini-3.5-flash-low'), 'gemini-3.5-flash-low');
  assert.equal(parser.extractModel('gemini-default nothing here'), null, 'no version digit -> not a model');
  assert.equal(parser.extractModel('just some prose'), null);
});

test('agy descriptor: buildLaunch resumes with --conversation and maps every option to the argv', () => {
  const bare = agy.buildLaunch({ cwd: '/p', options: {} });
  assert.deepEqual(bare.args, [], 'a bare launch carries nothing');
  assert.equal(bare.command, 'agy');
  assert.equal(bare.spawnMode, 'argv');
  assert.deepEqual(bare.env, {}, 'agy self-authenticates — no injected env');

  const resumed = agy.buildLaunch({ cwd: '/p', resume: true, sessionId: 'CID', options: {} });
  assert.deepEqual(resumed.args, ['--conversation', 'CID']);

  const full = agy.buildLaunch({
    cwd: '/p',
    options: { model: 'Gemini 3.1 Pro (High)', mode: 'plan', sandbox: true, addDirs: '/a, /b' },
  });
  assert.deepEqual(full.args,
    ['--model', 'Gemini 3.1 Pro (High)', '--mode', 'plan', '--sandbox', '--add-dir', '/a', '--add-dir', '/b']);
});

test('agy descriptor: it does not pretend to fork', () => {
  assert.equal(agy.supportsFork, false);
  const args = agy.buildLaunch({ cwd: '/p', sessionId: 's1', forkFrom: 'PARENT' }).args.join(' ');
  assert.ok(!args.includes('PARENT'), 'forkFrom must be ignored, not launched into an unrelated session');
});

test('agy descriptor: probe reports installed/not-installed with an actionable reason', () => {
  const res = agy.probe();
  assert.equal(typeof res.ok, 'boolean');
  if (!res.ok) assert.ok(res.reason && res.reason.length > 10);
});

// #282 lever 1: busy/idle re-opens the conversation `.db` only when its signature (mtime+size, plus the
// `-wal` sibling) actually changed. adopt.updateBackendLiveStates re-reads liveState on every watcher
// flush from ANY backend, so without this an idle agy `.db` was re-opened several times a second.
test('#282 agy liveState gate: the `.db` is re-read only when its signature changes', () => {
  const { DatabaseSync } = require('node:sqlite');
  const state = require('../src/backends/agy/state');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-gate-'));
  const dbPath = path.join(dir, 'gate.db');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER)');
    db.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 14)').run();   // trailing USER step -> a turn is running
    db.close();

    // A whole-second mtime so restoring it later is exact on every filesystem. Recent, so not stale.
    const t0 = new Date(Math.floor(Date.now() / 1000) * 1000 - 2000);
    fs.utimesSync(dbPath, t0, t0);
    const now = Date.now();

    state._clearFactsCache();
    assert.equal(state.deriveStateFromDb(dbPath, now), 'busy', 'trailing user step, fresh mtime -> busy');

    // Flip the trailing step to assistant (15) IN PLACE (size unchanged), then restore the exact mtime so
    // the signature is identical. The gate must return the CACHED busy — proof it did not re-open the DB.
    const w = new DatabaseSync(dbPath);
    w.exec('UPDATE steps SET step_type = 15 WHERE idx = 0');
    w.close();
    fs.utimesSync(dbPath, t0, t0);
    assert.equal(state.deriveStateFromDb(dbPath, now), 'busy', 'signature unchanged -> cached facts, no re-read');

    // Bump the mtime (a real store change) -> the gate re-reads and now sees the assistant step -> idle.
    const t1 = new Date(t0.getTime() + 5000);
    fs.utimesSync(dbPath, t1, t1);
    assert.equal(state.deriveStateFromDb(dbPath, now), 'idle', 'signature changed -> re-read -> idle');
  } finally {
    state._clearFactsCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
