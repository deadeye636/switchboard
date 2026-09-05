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
//     platform contributes its own name. That is the argument for an allow-list: it holds bot rooms
//     and gateway chats out without needing to know they exist.
//   - Two excluded values were not noise: `recovered` (a stub rebuilt from orphaned messages, no cwd,
//     #551) and `claude-code` / `codex-cli` (imported coding sessions, which DO carry a cwd, #552).
//     `SOURCE_DECISIONS` below is now the record of what happened to each, WITH the reason — including
//     for the values that stay out, whose reasons the reader's comment did not carry.
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

// ONE ENTRY PER `source` VALUE THIS READER HAS A DECISION ABOUT, AND EVERY ENTRY CARRIES ITS REASON.
//
// This is the second copy of the allow-list in `sourceFilter` (src/backends/hermes/reader.js) — change
// one and this fails, which is the point. It is checked BOTH ways: the store below is built from this
// table, and the ingested set has to equal exactly the entries marked `ingested`, so neither a value
// that quietly starts being read nor one that quietly stops can pass.
//
// The reasons matter as much as the booleans. The filter used to be a bare `source = 'cli'` with a
// comment that named the held-out values and said nothing about WHY two of them were held out — so
// #551 and #552 read as a deliberate rule for a release, when they were nobody's decision. A held-out
// entry with no sentence here is the same defect written as a test.
//
// `source` is an open set, so this table is not and cannot be exhaustive: an unlisted value is held out
// by absence, which is what `unknown-source-from-the-future` pins.
const SOURCE_DECISIONS = [
  {
    source: 'cli', ingested: true, row: { cwd: '/project' },
    why: 'a session the user drove from a terminal. Ours — cli_session_mixin.py writes it.',
  },
  {
    source: 'recovered', ingested: true, row: { title: 'Recovered session 1', message_count: 3 },
    why: 'a session row Hermes rebuilt from orphaned messages after a crash (#551). The messages are '
      + 'real and the work is real; the stub has no cwd, so it lands in the backend bucket.',
  },
  {
    source: 'claude-code', ingested: false, row: { cwd: '/imported/claude' },
    why: 'a transcript brought in by `hermes sessions import` (#552). Held out: Switchboard reads the '
      + 'Claude store directly, so ingesting it would show the same work twice under two backends.',
  },
  {
    source: 'codex-cli', ingested: false, row: { cwd: '/imported/codex' },
    why: 'the Codex half of the same import (#552), held out for the same reason.',
  },
  {
    source: 'bot_room', ingested: false, row: { title: 'a group room' },
    why: 'one row per Group Chat room (api_server_room_dispatch.py), not a session anybody coded in.',
  },
  {
    source: 'telegram', ingested: false, row: { chat_type: 'dm' },
    why: 'a gateway chat, named by the platform adapter that took the message. A conversation, not '
      + 'work in a project.',
  },
  {
    source: 'discord', ingested: false, row: { chat_type: 'group' },
    why: 'the same, from a different adapter — and the set of adapters grows, which is why these are '
      + 'held out by absence rather than by name.',
  },
  {
    source: 'subagent', ingested: false, row: { parent_session_id: 'cli' },
    why: 'a delegated child. It belongs to its parent\'s turn; Hermes\' own session search hides it too.',
  },
  {
    source: 'cron', ingested: false, row: {},
    why: 'a scheduled turn. Nobody is sitting in front of it.',
  },
  {
    source: 'acp', ingested: false, row: { cwd: '/editor' },
    why: 'an editor driving Hermes over the ACP bridge — machine-driven, like cron and the HTTP API.',
  },
  {
    source: 'unknown-source-from-the-future', ingested: false, row: {},
    why: 'the allow-list\'s whole reason for being: a value nobody has heard of is held out by not '
      + 'being listed, so a new gateway adapter cannot add noise to the sidebar on its own.',
  },
];

/** A store holding one row per decision above, id = the source value. */
function makeDecisionStore() {
  return makeStore(SOURCE_DECISIONS.map(d => ({
    id: d.source, source: d.source, started_at: 100, message_count: 1, ...d.row,
  })));
}

test('every source value this reader decides about is pinned with its reason (#535, #551, #552)', SKIP, () => {
  for (const d of SOURCE_DECISIONS) {
    assert.ok(d.why && d.why.length > 30, `${d.source} needs a reason, not a category`);
  }
  const dir = makeDecisionStore();
  const ids = withStore(dir, () => reader.discoverSessions({}).map(h => h.sessionId).sort());
  const expected = SOURCE_DECISIONS.filter(d => d.ingested).map(d => d.source).sort();
  assert.deepEqual(ids, expected,
    'the ingested set must equal exactly the entries marked ingested — both directions');
});

test('every session is still offered when the caller asks for all of them (#535)', SKIP, () => {
  const dir = makeDecisionStore();
  const ids = withStore(dir, () => reader.discoverSessions({ includeAll: true }).map(h => h.sessionId).sort());
  assert.deepEqual(ids, SOURCE_DECISIONS.map(d => d.source).sort(),
    'includeAll bypasses the allow-list entirely, so even a held-out kind is there to be found');
});

test('a repaired session is offered, and lands in the bucket for a session with no project (#551)', SKIP, () => {
  // Hermes writes `source: 'recovered'` when it rebuilds a session row from orphaned messages — a crash
  // mid-session is the ordinary way to get one, so these are the sessions a user is most likely to go
  // looking for. Its INSERT names id/source/started_at/title/message_count, so there is no cwd; the
  // answer to "which project" is the backend-scoped bucket the gateway/cron chats already use, NOT a cwd
  // derived from the messages.
  const dir = makeStore([
    { id: 'a', source: 'cli', started_at: 100, cwd: '/project', message_count: 1 },
    { id: 'rec', source: 'recovered', started_at: 100, title: 'Recovered session 1', message_count: 3 },
  ]);
  withStore(dir, () => {
    const found = reader.discoverSessions({});
    assert.deepEqual(found.map(h => h.sessionId).sort(), ['a', 'rec'],
      'the repaired session is offered like any other');
    const parsed = reader.parseSession(found.find(h => h.sessionId === 'rec'));
    assert.ok(parsed, 'and it parses');
    assert.equal(parsed.cwd, null, 'with no working directory of its own');
  });
});

test('a repaired session is NOT a candidate for the session we just launched (#551)', SKIP, () => {
  // Ingest and live pairing ask different questions, and widening the first must not widen the second.
  // A `recovered` row is a rebuild of a session that already ended, so it can never be the row a spawn
  // just wrote — offering it to matchLiveSession would let a launch adopt somebody else's identity.
  const dir = makeStore([
    { id: 'a', source: 'cli', started_at: 100, cwd: '/project', message_count: 1 },
    { id: 'rec', source: 'recovered', started_at: 100, message_count: 1 },
  ]);
  const ids = withStore(dir, () => reader.listLiveCandidates().map(c => c.sessionId));
  assert.deepEqual(ids, ['a'], 'only the CLI writes the row a launch just created');
});

test('a cwd-less Hermes session has a bucket to fall into, and it is not invented here (#551)', SKIP, () => {
  // The mechanism #551 reuses rather than a third pattern: the descriptor already answers
  // `sessionBucketPath` for the gateway/cron chats, and src/backends/parse.js falls back to it whenever a
  // parsed row has no cwd (§5.9). If that hook ever goes away, a recovered session silently stops being
  // indexed instead of landing somewhere — so this pins the hook, not just the null cwd above.
  const hermes = require('../src/backends/hermes');
  assert.equal(typeof hermes.sessionBucketPath, 'function', 'the backend bucket is a descriptor hook');
  const dir = makeStore([{ id: 'rec', source: 'recovered', started_at: 100, message_count: 1 }]);
  withStore(dir, () => {
    assert.equal(hermes.sessionBucketPath(), dir,
      'and it is the store root, which is a real path the Projects view can handle');
  });
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
