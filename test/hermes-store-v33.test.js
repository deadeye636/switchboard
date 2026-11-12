'use strict';
// #864 — what the Hermes reader returns for a schema-33 (Hermes 0.23) store.
//
// 0.23 stopped deleting message rows: a rewind / undo sets `active = 0`, an in-place compaction archives
// the folded rows as `active = 0, compacted = 1`, and scaffolding the person never saw carries a
// `display_kind` (`hidden`, `internal_notification`, `failed_turn`). The reader has to read only the live
// conversation, and a store WITHOUT those columns has to keep the old, unfiltered queries.
//
// The DDL is deliberately partial (the columns the reader asks for plus the ones under test), like
// hermes-store-v21.test.js: the assertions are about our filter, and the rows follow the shapes Hermes'
// source says it writes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* older Node: the file skips */ }

const reader = require('../src/backends/hermes/reader');
const { readTurnDigest } = require('../src/backends/hermes/turn-digest');
const { deriveState } = require('../src/backends/hermes/state');

const SKIP = { skip: !DatabaseSync && 'node:sqlite is not available in this runtime' };

const SESSIONS_DDL = `CREATE TABLE sessions (
  id TEXT PRIMARY KEY, source TEXT, started_at REAL, ended_at REAL, message_count INTEGER, cwd TEXT, title TEXT
)`;
const V33_MESSAGES = `CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL,
  finish_reason TEXT, active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0, display_kind TEXT
)`;
const OLD_MESSAGES = `CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, finish_reason TEXT
)`;

const T0 = 1780000000;

// rows: [role, content, finish_reason, extra columns]; row n has timestamp T0 + 10n
function makeStore(ddl, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v33-'));
  const db = new DatabaseSync(path.join(dir, 'state.db'));
  db.exec(SESSIONS_DDL);
  db.exec(ddl);
  db.exec(`INSERT INTO sessions (id, source, started_at, message_count, cwd) VALUES ('s1', 'cli', ${T0}, ${rows.length}, 'proj')`);
  let t = T0;
  for (const [role, content, finish, extra] of rows) {
    t += 10;
    const cols = ['session_id', 'role', 'content', 'timestamp', 'finish_reason', ...Object.keys(extra || {})];
    const vals = ['s1', role, content, t, finish, ...Object.values(extra || {})];
    db.prepare(`INSERT INTO messages (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  }
  db.close();
  return dir;
}

function withStore(dir, fn) {
  const saved = process.env.SWITCHBOARD_STORE_HERMES;
  process.env.SWITCHBOARD_STORE_HERMES = dir;
  const restore = () => {
    if (saved === undefined) delete process.env.SWITCHBOARD_STORE_HERMES;
    else process.env.SWITCHBOARD_STORE_HERMES = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

// A rewound first prompt, an archived pre-compaction row, three scaffolding kinds and a live conversation
// ("real question" -> "real answer"), then a failed-turn notice and a rewound last prompt.
const MIXED = [
  ['user', 'undone prompt', null, { active: 0 }],                                  // 1
  ['assistant', 'undone answer', 'stop', { active: 0 }],                           // 2
  ['user', 'archived before compaction', null, { active: 0, compacted: 1 }],       // 3
  ['user', 'hidden goal control', null, { display_kind: 'hidden' }],               // 4
  ['user', 'async result note', null, { display_kind: 'internal_notification' }],  // 5
  ['user', 'real question', null, {}],                                             // 6
  ['assistant', 'real answer', 'stop', {}],                                        // 7
  ['assistant', 'turn failed notice', null, { display_kind: 'failed_turn' }],      // 8
  ['user', 'rewound last prompt', null, { active: 0 }],                            // 9
];

test('parseSession on a v33 store: first prompt and user count are live rows; the search body keeps archived ones', SKIP, () => {
  withStore(makeStore(V33_MESSAGES, MIXED), () => {
    const row = reader.parseSession({ kind: 'db', sessionId: 's1' });
    assert.equal(row.firstPrompt, 'real question', 'neither an undone nor an archived row is the first prompt');
    assert.equal(row.userMessageCount, 1);
    // Compaction-archived history stays searchable (like Hermes' own search); undone and scaffolding rows do not.
    assert.equal(row.textContent, 'archived before compaction\nreal question\nreal answer');
  });
});

test('busy/idle on a v33 store: the rewound last prompt is not the last row, live and parsed agree', SKIP, () => {
  withStore(makeStore(V33_MESSAGES, MIXED), () => {
    // Live rows end with the failed_turn notice (kept: it ENDS a turn), row 8.
    const live = reader.readLiveState('s1');
    assert.equal(live.lastRole, 'assistant');
    assert.equal(live.lastActivityMs, (T0 + 80) * 1000, 'the rewound row (90) is not the last activity');
    const parsed = reader.parseSession({ kind: 'db', sessionId: 's1' });
    assert.equal(parsed.lastRole, live.lastRole);
    assert.equal(parsed.lastActivityMs, live.lastActivityMs);
    // Hermes writes the failed_turn notice with no finish_reason; it still ENDS the turn, so it is idle, not
    // "still generating" for the activity window.
    assert.equal(live.lastFinishReason, 'failed_turn');
    assert.equal(deriveState(live, (T0 + 85) * 1000), 'idle');
  });
  const undone = [
    ['user', 'q', null, {}],
    ['assistant', 'a', 'stop', {}],
    ['user', 'undone follow-up', null, { active: 0 }],
  ];
  withStore(makeStore(V33_MESSAGES, undone), () => {
    const live = reader.readLiveState('s1');
    assert.equal(live.lastRole, 'assistant');
    assert.equal(live.lastFinishReason, 'stop');
    assert.equal(deriveState(live, (T0 + 25) * 1000), 'idle');
  });
});

test('a hidden user row still starts a turn: busy/idle keeps scaffolding rows', SKIP, () => {
  const rows = [
    ['user', 'q', null, {}],
    ['assistant', 'a', 'stop', {}],
    ['user', 'goal control', null, { display_kind: 'hidden' }],
  ];
  withStore(makeStore(V33_MESSAGES, rows), () => {
    const live = reader.readLiveState('s1');
    assert.equal(live.lastRole, 'user');
    assert.equal(deriveState(live, (T0 + 35) * 1000), 'busy');
  });
});

test('readMessages and the turn digest read only the live conversation', SKIP, async () => {
  await withStore(makeStore(V33_MESSAGES, MIXED), async () => {
    assert.deepEqual(reader.readMessages('s1').map(m => m.message.content), ['real question', 'real answer']);
    const digest = await readTurnDigest('s1');
    assert.deepEqual(digest.messages.map(m => m.text), ['real question', 'real answer']);
  });
});

test('a NULL active is a live row (older tables carry the column without filling it)', SKIP, () => {
  const ddl = V33_MESSAGES.replace('active INTEGER NOT NULL DEFAULT 1', 'active INTEGER');
  const rows = [['user', 'hello', null, { active: null }], ['assistant', 'hi', 'stop', { active: null }]];
  withStore(makeStore(ddl, rows), () => {
    assert.equal(reader.parseSession({ kind: 'db', sessionId: 's1' }).firstPrompt, 'hello');
    assert.equal(reader.readMessages('s1').length, 2);
  });
});

test('a store without the columns keeps the old, unfiltered queries', SKIP, () => {
  const rows = [
    ['user', 'first', null, {}],
    ['assistant', 'reply', 'stop', {}],
    ['user', 'second', null, {}],
  ];
  withStore(makeStore(OLD_MESSAGES, rows), () => {
    const row = reader.parseSession({ kind: 'db', sessionId: 's1' });
    assert.equal(row.firstPrompt, 'first');
    assert.equal(row.userMessageCount, 2);
    assert.equal(row.textContent, 'first\nreply\nsecond');
    assert.equal(reader.readLiveState('s1').lastRole, 'user');
    assert.equal(reader.readMessages('s1').length, 3);
  });
});

const NON_PROMPT_USER_KINDS = [
  'hidden', 'internal_notification', 'process_complete', 'async_delegation_complete',
  'auto_continue', 'model_switch', 'personality_switch',
];

test('non-prompt user kinds are not the first prompt, a user message or a viewer message', SKIP, () => {
  const rows = NON_PROMPT_USER_KINDS.map(k => ['user', `marker ${k}`, null, { display_kind: k }]);
  rows.push(['user', 'real question', null, {}], ['assistant', 'real answer', 'stop', {}]);
  withStore(makeStore(V33_MESSAGES, rows), () => {
    const row = reader.parseSession({ kind: 'db', sessionId: 's1' });
    assert.equal(row.firstPrompt, 'real question');
    assert.equal(row.userMessageCount, 1);
    assert.equal(row.textContent, 'real question\nreal answer');
    assert.deepEqual(reader.readMessages('s1').map(m => m.message.content), ['real question', 'real answer']);
  });
});

test('busy/idle: a trailing model or personality switch marker is ignored, a turn-starting kind is not', SKIP, () => {
  for (const marker of ['model_switch', 'personality_switch']) {
    const rows = [
      ['user', 'q', null, {}], ['assistant', 'a', 'stop', {}],
      ['user', 'switched', null, { display_kind: marker }],
    ];
    withStore(makeStore(V33_MESSAGES, rows), () => {
      const live = reader.readLiveState('s1');
      assert.equal(live.lastRole, 'assistant', marker);
      assert.equal(live.lastActivityMs, (T0 + 20) * 1000, `${marker} is no activity`);
      assert.equal(deriveState(live, (T0 + 35) * 1000), 'idle');
    });
  }
  for (const kind of ['auto_continue', 'internal_notification', 'process_complete', 'async_delegation_complete']) {
    const rows = [
      ['user', 'q', null, {}], ['assistant', 'a', 'stop', {}],
      ['user', 'machinery', null, { display_kind: kind }],
    ];
    withStore(makeStore(V33_MESSAGES, rows), () => {
      assert.equal(deriveState(reader.readLiveState('s1'), (T0 + 35) * 1000), 'busy', kind);
    });
  }
});

test('the first prompt is found beyond the 500-row search window of a long compacted session', SKIP, () => {
  const rows = [];
  for (let i = 0; i < 520; i++) rows.push(['user', `archived ${i}`, null, { active: 0, compacted: 1 }]);
  rows.push(['user', 'first live prompt', null, {}], ['assistant', 'answer', 'stop', {}]);
  withStore(makeStore(V33_MESSAGES, rows), () => {
    const row = reader.parseSession({ kind: 'db', sessionId: 's1' });
    assert.equal(row.firstPrompt, 'first live prompt');
    assert.equal(row.userMessageCount, 1);
    assert.ok(row.textContent.startsWith('archived 0\n'), 'archived history is still searchable');
  });
});

test('per-bucket message counts skip undone and archived rows', SKIP, () => {
  withStore(makeStore(V33_MESSAGES, MIXED), () => {
    const row = reader.parseSession({ kind: 'db', sessionId: 's1' });
    // Live rows of MIXED: hidden, internal_notification, real question, real answer, failed_turn notice.
    assert.equal(row.dailyMetrics.reduce((n, b) => n + b.messageCount, 0), 5);
  });
});

test('PARSER_SCHEMA_VERSION moved with the changed field semantics', () => {
  assert.ok(reader.PARSER_SCHEMA_VERSION >= 5);
});
