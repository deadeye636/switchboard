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

/** A protobuf varint — the length prefix needs one byte below 128 and two above it, which is the whole
 *  of #508: the number of bytes it takes decided whether the cwd survived. */
function varint(n) {
  const bytes = [];
  let v = n;
  while (v > 0x7f) { bytes.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  bytes.push(v);
  return Buffer.from(bytes);
}

/** A length-delimited field of any size — `field1` only reaches 127 bytes. */
function lenField(fieldNo, body) {
  return Buffer.concat([Buffer.from([(fieldNo << 3) | 2]), varint(body.length), body]);
}

/** The metadata blob as agy really writes it: the workspace URI sits in a NESTED message, not at the
 *  head of the blob. `padTo` grows the submessage past 127 bytes so its outer length takes two bytes —
 *  the layout in which the old printable-run scan happened to line up (#508). */
function metadataBlob(uri, padTo = 0) {
  let inner = lenField(1, Buffer.from(uri, 'utf8'));
  if (padTo && inner.length < padTo) {
    inner = Buffer.concat([inner, lenField(9, Buffer.alloc(padTo - inner.length - 3, 0x61))]);
  }
  return lenField(1, inner);
}

/**
 * Build a minimal but real-shaped conversation DB with node:sqlite (better-sqlite3 is Electron-only).
 * Mirrors the columns the parser reads: steps(idx, step_type, step_payload, metadata) and
 * trajectory_metadata_blob(id, data). Blobs carry the marker strings the parser extracts.
 */
function makeFixtureDb(dbPath, { workspaceUri = 'file:///X:/proj', padTo = 0 } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB, metadata BLOB);
    CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
  `);

  // cwd lives in the trajectory metadata blob as a file:// URI, one message in.
  db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)')
    .run('main', metadataBlob(workspaceUri, padTo));

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

function withFixture(fn, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-'));
  const dbPath = path.join(dir, 'abcd1234-5678-4abc-8def-111122223333.db');
  try {
    makeFixtureDb(dbPath, opts);
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

// #508 — the cwd used to come out of a printable-run scan, and whether it survived depended on bytes
// that have nothing to do with the string: a one-byte outer length puts a `0a` where the scan reads a
// length, and it swallowed the URI as "%file:///C". A session with no cwd is never paired with its
// running CLI, so its tab reads "Running" for its whole life however busy agy is. Both layouts are real
// — one store, one agy version, two conversations.
// `uriLen` is asserted rather than commented: the length IS the case each row stands for, and a URI
// edited for readability would otherwise leave the row passing while testing a layout it no longer builds.
const WORKSPACE_LAYOUTS = [
  // A length byte of 0x25 — printable, so the scan lined up on it. This is the shape that lost its cwd.
  { name: 'a one-byte outer length', uri: 'file:///X:/workspace-with-a-long-name', uriLen: 37, padTo: 0, cwd: 'X:\\workspace-with-a-long-name' },
  // The same URI in a submessage past 127 bytes, so the outer length takes two — the shape that survived.
  { name: 'a two-byte outer length', uri: 'file:///X:/workspace-with-a-long-name', uriLen: 37, padTo: 200, cwd: 'X:\\workspace-with-a-long-name' },
  // 0x1f is below printable, which is the other reason a blob happened to line up.
  { name: 'a length byte below printable', uri: 'file:///X:/short-workspace-name', uriLen: 31, padTo: 0, cwd: 'X:\\short-workspace-name' },
];

for (const layout of WORKSPACE_LAYOUTS) {
  test(`agy parser: the cwd survives ${layout.name} (#508)`, () => {
    assert.equal(layout.uri.length, layout.uriLen, 'the URI length is the case this row builds');
    withFixture((dbPath) => {
      const row = parser.parseSession({ kind: 'file', path: dbPath });
      assert.equal(row.cwd, layout.cwd);
    }, { workspaceUri: layout.uri, padTo: layout.padTo });
  });
}

test('agy parser: findWorkspaceUri reads the field, not a run of printable bytes (#508)', () => {
  // The layout of a real conversation that lost its cwd, written out as bytes: field 1 is a submessage,
  // its own field 1 is the URI (0x25 = 37 bytes), and a `1a 00` follows. The scan read the `0a` at offset
  // 2 as a length and took the ten bytes after it — "%file:///C" — stepping over the URI entirely.
  const blob = Buffer.from('0a270a2566696c653a2f2f2f583a2f776f726b73706163652d776974682d612d6c6f6e672d6e616d651a00', 'hex');
  assert.equal(parser.findWorkspaceUri(blob), 'file:///X:/workspace-with-a-long-name');
  assert.equal(parser.findWorkspaceUri(Buffer.alloc(0)), null);
  assert.equal(parser.findWorkspaceUri(null), null);
  assert.equal(parser.findWorkspaceUri(field1('nothing here')), null, 'a blob with no workspace says so');
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
    options: { model: 'gemini-3.1-pro-high', mode: 'plan', effort: 'high', sandbox: true, addDirs: '/a, /b' },
  });
  assert.deepEqual(full.args,
    ['--model', 'gemini-3.1-pro-high', '--mode', 'plan', '--effort', 'high', '--sandbox', '--add-dir', '/a', '--add-dir', '/b']);
});

test('agy descriptor: model discovery parses agy models output', () => {
  assert.deepEqual(agy._parseModelList('gemini-3.6-flash-high\n\nclaude-sonnet-4-6\n'), [
    { id: 'gemini-3.6-flash-high', label: 'gemini-3.6-flash-high' },
    { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
  ]);
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

// #510 — agy inserts the MODEL row when a turn starts and fills it in as the answer streams, so the last
// message step is 15 from the first moment and the old role rule could never report busy. `steps.status`
// is what says so: 8 while a step runs, 3 once it is done.
test('agy state: the last step\'s status decides busy, not which role wrote it (#510)', () => {
  const state = require('../src/backends/agy/state');
  const fresh = new Date().toISOString();
  // The exact shape a live turn produces: a model step (15) that has not finished.
  assert.equal(state.deriveState({ lastStatus: 8, lastRole: 'assistant', lastEntryAt: fresh }, Date.now()), 'busy',
    'a running model step is a turn in progress, whatever the role says');
  assert.equal(state.deriveState({ lastStatus: 3, lastRole: 'assistant', lastEntryAt: fresh }, Date.now()), 'idle');
  // A tool step runs too, and the question about it is the same one.
  assert.equal(state.deriveState({ lastStatus: 8, lastRole: 'user', lastEntryAt: fresh }, Date.now()), 'busy');
  assert.equal(state.deriveState({ lastStatus: 3, lastRole: 'user', lastEntryAt: fresh }, Date.now()), 'idle',
    'a finished step is finished even behind a trailing user message');
  // Anything not known to mean "in progress" is idle: a session stuck on Working is the worse failure.
  for (const unknown of [0, 7, 99]) {
    assert.equal(state.deriveState({ lastStatus: unknown, lastRole: 'user', lastEntryAt: fresh }, Date.now()), 'idle',
      `status ${unknown} is not a turn in progress`);
  }
  // No status at all (a scanned row, or a store that reports none) falls back to the role rule.
  assert.equal(state.deriveState({ lastRole: 'user', lastEntryAt: fresh }, Date.now()), 'busy');
  assert.equal(state.deriveState({ lastRole: 'assistant', lastEntryAt: fresh }, Date.now()), 'idle');
});

test('agy state: the safeguards still bound a step left running (#166, #510)', () => {
  const state = require('../src/backends/agy/state');
  const now = Date.now();
  const stale = new Date(now - state.ACTIVITY_WINDOW_MS - 1000).toISOString();
  const running = { lastStatus: 8, lastRole: 'assistant', lastEntryAt: stale };

  assert.equal(state.deriveState(running, now), 'idle', 'silent past the activity window -> idle');
  assert.equal(state.deriveState(running, now, { lastOutputMs: now - 5000 }), 'busy',
    'the PTY keeps it alive, but only because the store already said running');
  assert.equal(state.deriveState({ lastStatus: 3, lastRole: 'assistant', lastEntryAt: stale }, now, { lastOutputMs: now }), 'idle',
    'output never DECLARES a turn — a finished step stays finished');

  const wedged = { lastStatus: 8, lastRole: 'assistant', lastEntryAt: new Date(now - state.OUTPUT_LIVENESS_CEILING_MS - 1000).toISOString() };
  assert.equal(state.deriveState(wedged, now, { lastOutputMs: now }), 'idle', 'past the ceiling it heals itself');
});

test('agy state: readDbFacts reports the last step\'s status, and copes without the column (#510)', () => {
  const { DatabaseSync } = require('node:sqlite');
  const state = require('../src/backends/agy/state');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-status-'));
  try {
    const withStatus = path.join(dir, 'with-status.db');
    let db = new DatabaseSync(withStatus);
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER)');
    db.exec('INSERT INTO steps (idx, step_type, status) VALUES (0, 14, 3), (1, 15, 8)');
    db.close();
    let facts = state.readDbFacts(withStatus);
    assert.equal(facts.lastStatus, 8, 'the LAST step, not the last message step');
    assert.equal(facts.lastRole, 'assistant');

    // A store with no status column must still be readable — the role rule takes over.
    const noStatus = path.join(dir, 'no-status.db');
    db = new DatabaseSync(noStatus);
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER)');
    db.exec('INSERT INTO steps (idx, step_type) VALUES (0, 14)');
    db.close();
    facts = state.readDbFacts(noStatus);
    assert.equal(facts.lastStatus, null, 'no column -> no answer, rather than a failed read');
    assert.equal(facts.lastRole, 'user');
  } finally {
    state._clearFactsCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
