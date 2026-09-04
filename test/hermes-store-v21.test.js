'use strict';
// #535 — what the Hermes reader returns for a v0.21.0 store, measured rather than reasoned about.
//
// Two things changed under us. Bot Mode ships default-on with named bots and group chat rooms, and those
// are rows in the same `state.db` this reader walks. And 0.20.4 landed SessionDB contention fixes, which
// says the CLI and a second reader really do contend on that file.
//
// The answers, from the installed 0.21.0's own source:
//
//   - `source` is an OPEN set — `hermes --source <anything>` writes a free value and every gateway
//     platform contributes its own name. That is the argument for the `cli` allow-list: it holds bot rooms
//     and gateway chats out without needing to know they exist.
//   - Two excluded values are not noise: `recovered` (a stub rebuilt from orphaned messages, no cwd) and
//     `claude-code` / `codex-cli` (imported coding sessions, which DO carry a cwd).
//   - The columns arrive through `SELECT *` and the change marker touches none of them.
//
// **What these do NOT do is measure a real Bot Mode store.** No such store exists on the machine this was
// written on — a CLI at 0.21.0 does not mean a store at 0.21.0, because Hermes migrates on open, and the
// one here was still at schema 23 while 0.21.0's own SCHEMA_VERSION is 30. So the rows below are built to
// the shapes Hermes' source says it writes, and the assertions are about OUR filter, not about a store
// somebody observed. That distinction is why the DDL here is deliberately partial.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* older Node: the whole file skips */ }

const reader = require('../src/backends/hermes/reader');

// Enough of the table for the reader's own queries, plus the columns a row kind under test needs. NOT a
// claim about any schema version: 0.21.0's canonical `sessions` has 58 columns and this has a fraction of
// them. `parseSession` reads with `SELECT *` and coalesces, so an absent column is simply absent.
const SESSIONS_DDL = `CREATE TABLE sessions (
  id TEXT PRIMARY KEY, source TEXT, started_at REAL, ended_at REAL, message_count INTEGER,
  cwd TEXT, title TEXT, parent_session_id TEXT,
  session_key TEXT, chat_id TEXT, chat_type TEXT, thread_id TEXT, display_name TEXT, origin_json TEXT,
  archived INTEGER, pinned INTEGER, profile_name TEXT, git_branch TEXT, git_repo_root TEXT
)`;
const MESSAGES_DDL = `CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL,
  finish_reason TEXT
)`;

function makeStore(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v21-'));
  const db = new DatabaseSync(path.join(dir, 'state.db'));
  db.exec(SESSIONS_DDL);
  db.exec(MESSAGES_DDL);
  for (const r of rows) {
    const cols = Object.keys(r).join(', ');
    const vals = Object.values(r).map(v => (typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v)).join(', ');
    db.exec(`INSERT INTO sessions (${cols}) VALUES (${vals})`);
    db.exec(`INSERT INTO messages (session_id, role, content, timestamp) VALUES ('${r.id}', 'user', 'hello', ${(r.started_at || 1) + 1})`);
  }
  db.close();
  return dir;
}

function withStore(dir, fn) {
  const saved = process.env.SWITCHBOARD_STORE_HERMES;
  process.env.SWITCHBOARD_STORE_HERMES = dir;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.SWITCHBOARD_STORE_HERMES;
    else process.env.SWITCHBOARD_STORE_HERMES = saved;
  }
}

const SKIP = { skip: !DatabaseSync && 'node:sqlite is not available in this runtime' };

test('Bot Mode rooms and gateway chats are not offered as sessions (#535)', SKIP, () => {
  // The question #535 asks. They are held out by the `cli` filter without it naming any of them — the
  // filter is an allow-list, which is why a default-on feature that adds new row kinds did not need a
  // change here.
  const dir = makeStore([
    { id: 'a', source: 'cli', started_at: 100, cwd: '/project', message_count: 1 },
    { id: 'room', source: 'bot_room', started_at: 100, title: 'a group room', message_count: 1 },
    { id: 'tg', source: 'telegram', started_at: 100, chat_type: 'dm', message_count: 1 },
    { id: 'dc', source: 'discord', started_at: 100, chat_type: 'group', message_count: 1 },
    { id: 'sub', source: 'subagent', started_at: 100, parent_session_id: 'a', message_count: 1 },
    { id: 'imp', source: 'claude-code', started_at: 100, cwd: '/imported', message_count: 1 },
  ]);
  const ids = withStore(dir, () => reader.discoverSessions({}).map(h => h.sessionId));
  assert.deepEqual(ids, ['a']);
});

test('every session is still offered when the caller asks for all of them (#535)', SKIP, () => {
  const dir = makeStore([
    { id: 'a', source: 'cli', started_at: 100, cwd: '/project', message_count: 1 },
    { id: 'room', source: 'bot_room', started_at: 100, title: 'a group room', message_count: 1 },
  ]);
  const ids = withStore(dir, () => reader.discoverSessions({ includeAll: true }).map(h => h.sessionId).sort());
  assert.deepEqual(ids, ['a', 'room']);
});

test('a repaired session is filtered out, and that is a known gap (#535)', SKIP, () => {
  // Hermes writes `source: 'recovered'` when it rebuilds a session row from orphaned messages — a crash
  // is the ordinary way to get one. The messages are real and the original source is gone, so a CLI
  // session Hermes repaired does not come back here. Pinned as it stands: changing it is a decision about
  // what a session with no `cwd` should do, not a one-word filter edit.
  const dir = makeStore([
    { id: 'a', source: 'cli', started_at: 100, cwd: '/project', message_count: 1 },
    { id: 'rec', source: 'recovered', started_at: 100, title: 'Recovered session 1', message_count: 3 },
  ]);
  const ids = withStore(dir, () => reader.discoverSessions({}).map(h => h.sessionId));
  assert.deepEqual(ids, ['a'], 'the repaired session is not offered today');

  const all = withStore(dir, () => reader.discoverSessions({ includeAll: true }).map(h => h.sessionId).sort());
  assert.deepEqual(all, ['a', 'rec'], 'and it is there to be found when asked for');
});

test("a row carrying every column this reader ignores still parses (#535)", SKIP, () => {
  // They arrive through `SELECT *` and the change marker reads only ended_at / the last message / the
  // message count, so a column the reader does not name cannot move it.
  const dir = makeStore([{
    id: 'a', source: 'cli', started_at: 100, cwd: '/project', message_count: 1,
    session_key: 'agent:main', chat_id: 'C1', chat_type: 'dm', thread_id: 'T1',
    display_name: 'a name', origin_json: '{"k":1}', archived: 0, pinned: 1,
    profile_name: 'default', git_branch: 'main', git_repo_root: '/project',
  }]);
  withStore(dir, () => {
    const found = reader.discoverSessions({});
    assert.equal(found.length, 1);
    const parsed = reader.parseSession(found[0]);
    assert.ok(parsed, 'a row with every new column still parses');
    assert.equal(parsed.cwd, '/project');
    // The marker is what lets the scanner skip an unchanged session, and it must stay exactly three
    // fields. A character-class check does not pin that — a numeric column appended to MARKER_SQL passes
    // one, which is how this assertion was defeated the first time it was written.
    assert.equal(String(found[0].marker).split(':').length, 3,
      'ended_at:last_message:count — three fields, no more');
    assert.match(String(found[0].marker), /^0:\d/, 'a running session has no ended_at, and a last message');
  });
});

test('a session with no cwd does not take the scan down (#535)', SKIP, () => {
  // What a `recovered` stub looks like, and the reason including one is not a one-word change: the scan
  // groups by cwd, and this row has none.
  const dir = makeStore([{ id: 'rec', source: 'cli', started_at: 100, message_count: 1 }]);
  withStore(dir, () => {
    const found = reader.discoverSessions({});
    assert.equal(found.length, 1);
    const parsed = reader.parseSession(found[0]);
    assert.ok(parsed, 'it parses');
    assert.equal(parsed.cwd, null, 'with no working directory to group it under');
  });
});
