'use strict';
// The Hermes test fixture — BUILT, not shipped (#158).
//
// This used to be a checked-in `hermes-state.db`. It never was checked in: `.gitignore` excludes
// `*.db`, so the file only ever existed on the machine that made it, and the Hermes tests failed on
// every clone with ENOENT. Building it here fixes that for good — the fixture exists wherever the
// test runs, and it is reviewable in a diff instead of being an opaque blob.
//
// It was always meant to be synthetic. Hermes' own store on a real install has ZERO sessions
// (docs/plans/research/hermes-format.md §2: "the parser must be proven against a synthetic fixture
// built from this exact schema, not against live rows"). What is real is the SCHEMA — 33 `sessions`
// columns and 19 `messages` columns, dumped read-only off a live install and reproduced verbatim
// below, including the columns we never read. A fixture with only the columns we happen to use would
// stop proving the one thing it is for: that our SELECTs survive contact with Hermes' actual table.
//
// Journal mode: default (rollback), NOT WAL. The real store runs in WAL — the reader is built for it
// and the watcher polls the `-wal` — but a WAL database needs to write its `-shm` even to be read,
// and the reader opens strictly read-only. A rollback-journal fixture reads identically and leaves no
// sidecar files behind in the temp dir.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The fixture's fixed epoch, in seconds. The tests derive every expected timestamp from it, so it must
// never drift — this is why nothing here reads the clock.
const T0 = 1780000000;

// --- schema: verbatim from the live install (docs/plans/research/hermes-format.md §2) ---

const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT,
  user_id TEXT,
  model TEXT,
  model_config TEXT,
  system_prompt TEXT,
  parent_session_id TEXT,
  started_at REAL,
  ended_at REAL,
  end_reason TEXT,
  message_count INTEGER,
  tool_call_count INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  cwd TEXT,
  billing_provider TEXT,
  billing_base_url TEXT,
  billing_mode TEXT,
  estimated_cost_usd REAL,
  actual_cost_usd REAL,
  cost_status TEXT,
  cost_source TEXT,
  pricing_version TEXT,
  title TEXT,
  api_call_count INTEGER,
  handoff_state TEXT,
  handoff_platform TEXT,
  handoff_error TEXT,
  rewind_count INTEGER,
  archived INTEGER
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  role TEXT,
  content TEXT,
  tool_call_id TEXT,
  tool_calls TEXT,
  tool_name TEXT,
  timestamp REAL,
  token_count INTEGER,
  finish_reason TEXT,
  reasoning TEXT,
  reasoning_content TEXT,
  reasoning_details TEXT,
  codex_reasoning_items TEXT,
  codex_message_items TEXT,
  platform_message_id TEXT,
  observed INTEGER,
  active INTEGER,
  compacted INTEGER
);
`;

// --- rows ---
//
// Each session earns its place by proving something the reader has to get right:
//
//   sess-cli-1       the ordinary case: a finished session with a cwd, the full token breakdown, an
//                    ESTIMATED cost (actual is null — the UI must not sell an estimate as billing truth),
//                    and a transcript incl. a tool row that is not a conversation turn.
//   sess-cli-2       an ACTUAL cost alongside the estimate, and lineage (parent_session_id).
//   sess-cli-nocwd   no cwd at all (a gateway/cron-style agent). Must parse, must NOT be dropped, and
//                    must not be mistaken for a session launched in a project.
//   sess-running     mid-turn: the prompt is in, the answer is not. THAT is what running looks like.
//   sess-answered    answered, and still open (ended_at null — as every real session is). The row that
//                    used to read "working" for three minutes after every reply (#165).
//   sess-tool-turn   a tool-using turn, copied row for row off a real run: user → EMPTY assistant row with
//                    finish_reason 'tool_calls' → a `tool` row per result → the answer, with 'stop'.
//   sess-no-messages a row with no message rows and a null message_count — the change marker's join has
//                    no partner here, and both of its COALESCEs have to earn their keep.
//   sess-gateway-1   source='gateway' — a Telegram/cron chat. Default ingest must leave it out.

const SESSIONS = [
  {
    id: 'sess-cli-1',
    source: 'cli',
    model: 'claude-opus-4.6',
    parent_session_id: null,
    started_at: T0,
    ended_at: T0 + 600,                 // -> lastEntryAt = T0+600, activeMinutes = 10
    end_reason: 'completed',
    message_count: 4,                   // Hermes' own column: the 4 conversation turns below
    tool_call_count: 2,
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_tokens: 50,
    cache_write_tokens: 10,
    reasoning_tokens: 25,
    cwd: 'D:\\Projekte\\demo',
    estimated_cost_usd: 0.0123,
    actual_cost_usd: null,              // the common case — Hermes often never settles a price
    cost_status: 'estimated',
    cost_source: 'pricing-table',
    title: 'Refactor the auth middleware',
  },
  {
    id: 'sess-cli-2',
    source: 'cli',
    model: 'claude-opus-4.6',
    parent_session_id: 'sess-cli-1',    // lineage
    started_at: T0 + 1000,              // starts AFTER sess-cli-1 — launch-order matching depends on it
    ended_at: T0 + 1200,
    end_reason: 'completed',
    message_count: 2,
    tool_call_count: 0,
    input_tokens: 300,
    output_tokens: 80,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cwd: 'D:\\Projekte\\demo',
    estimated_cost_usd: 0.004,
    actual_cost_usd: 0.0038,            // settled: both figures are reported
    cost_status: 'actual',
    cost_source: 'provider',
    title: 'Add the middleware tests',
  },
  {
    id: 'sess-cli-nocwd',
    source: 'cli',
    model: 'claude-opus-4.6',
    parent_session_id: null,
    started_at: T0 + 2000,
    ended_at: T0 + 2100,
    end_reason: 'completed',
    message_count: 2,
    tool_call_count: 0,
    input_tokens: 120,
    output_tokens: 40,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cwd: null,                          // genuinely none — belongs in the backend bucket, not a project
    estimated_cost_usd: 0.001,
    actual_cost_usd: null,
    cost_status: 'estimated',
    cost_source: 'pricing-table',
    title: 'General agent chat',
  },
  {
    id: 'sess-running',
    source: 'cli',
    model: 'claude-opus-4.6',
    parent_session_id: null,
    started_at: T0 + 900,
    ended_at: null,                     // still running: Hermes only ever states that a turn ENDED
    end_reason: null,
    message_count: 2,
    tool_call_count: 1,
    input_tokens: 500,
    output_tokens: 90,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cwd: 'D:\\Projekte\\demo',
    estimated_cost_usd: 0.002,
    actual_cost_usd: null,
    cost_status: 'estimated',
    cost_source: 'pricing-table',
    title: 'Trace the flaky test',
  },
  {
    // Hermes priced this one at ZERO — which means it had no price table for the model, not that the
    // work was free. Reported as 0 it would draw a $0.00 bar in the cost chart: a made-up fact.
    id: 'sess-zero-cost',
    source: 'cli',
    model: 'some-unpriced-model',
    parent_session_id: null,
    started_at: T0 + 4000,
    ended_at: T0 + 4100,
    end_reason: 'completed',
    message_count: 2,
    tool_call_count: 0,
    input_tokens: 400,
    output_tokens: 100,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cwd: 'D:\\Projekte\\demo',
    estimated_cost_usd: 0,              // <- the point of this row
    actual_cost_usd: null,
    cost_status: 'n/a',
    cost_source: null,
    title: 'Unpriced model',
  },
  {
    // A TOOL-USING turn, copied row for row off a real run (#165). This is the shape the state rule has to
    // walk without flinching: Hermes writes an EMPTY assistant row with `finish_reason: 'tool_calls'` the
    // moment it reaches for a tool, then a `tool` row per result, then the real answer with `stop`.
    id: 'sess-tool-turn',
    source: 'cli',
    model: 'claude-opus-4.6',
    parent_session_id: null,
    started_at: T0 + 7000,
    ended_at: null,
    end_reason: null,
    message_count: 5,
    tool_call_count: 2,
    input_tokens: 900,
    output_tokens: 120,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cwd: 'D:\\Projekte\\demo',
    estimated_cost_usd: 0.003,
    actual_cost_usd: null,
    cost_status: 'estimated',
    cost_source: 'pricing-table',
    title: 'List the files',
  },
  {
    // The shape EVERY session in a real store has: `ended_at` is null — Hermes never writes it, not even
    // for a session finished the day before — and yet the turn is plainly answered. This is the row that
    // used to read "working" for three minutes after every reply (#165); only the last message says so.
    id: 'sess-answered',
    source: 'cli',
    model: 'claude-opus-4.6',
    parent_session_id: null,
    started_at: T0 + 6000,
    ended_at: null,                     // <- the point of this row
    end_reason: null,
    message_count: 2,
    tool_call_count: 0,
    input_tokens: 300,
    output_tokens: 80,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cwd: 'D:\\Projekte\\demo',
    estimated_cost_usd: 0.002,
    actual_cost_usd: null,
    cost_status: 'estimated',
    cost_source: 'pricing-table',
    title: 'Answered, and still open',
  },
  {
    // A session with NO message rows at all — Hermes writes the row when the session starts, so this is
    // simply one that was opened and never spoken to. It exists to keep the change marker honest (#155):
    // the marker gets the last message time from a GROUPED JOIN, and this is the row that HAS no join
    // partner. `message_count` is null on top, so both COALESCEs are exercised on the same row.
    id: 'sess-no-messages',
    source: 'cli',
    model: 'claude-opus-4.6',
    parent_session_id: null,
    started_at: T0 + 5000,
    ended_at: null,                     // opened, never used
    end_reason: null,
    message_count: null,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cwd: 'D:\\Projekte\\demo',
    estimated_cost_usd: null,
    actual_cost_usd: null,
    cost_status: null,
    cost_source: null,
    title: 'Opened and left alone',
  },
  {
    id: 'sess-gateway-1',
    source: 'gateway',                  // not a coding session — excluded unless includeAll
    model: 'claude-opus-4.6',
    parent_session_id: null,
    started_at: T0 + 3000,
    ended_at: T0 + 3060,
    end_reason: 'completed',
    message_count: 2,
    tool_call_count: 0,
    input_tokens: 60,
    output_tokens: 20,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cwd: null,
    estimated_cost_usd: 0.0005,
    actual_cost_usd: null,
    cost_status: 'estimated',
    cost_source: 'pricing-table',
    title: 'Telegram chat',
  },
];

// `role` is 'tool' for scaffolding. It carries text (so it reaches our FTS body, which indexes every
// message), but it is NOT a conversation turn — readMessages must not hand it to the viewer or let the
// handoff mistake it for the packet the agent wrote.
// `finish_reason` is what says a turn is OVER: on a real store it is `stop` on every assistant row and
// null on every user row (#165). It is the busy/idle signal — `ended_at`, which sounded like it, is null
// on every session there, finished or not. So every assistant row here carries one, and the one session
// that is meant to be MID-TURN ends on an unanswered user prompt, which is what mid-turn looks like.
const MESSAGES = [
  // sess-cli-1 — the last turn is an assistant one, and it is the packet a handoff pre-fills from.
  { session_id: 'sess-cli-1', role: 'user',      timestamp: T0 + 10,  content: 'Refactor the auth middleware and add tests' },
  { session_id: 'sess-cli-1', role: 'assistant', timestamp: T0 + 100, content: 'Looking at the middleware now.', finish_reason: 'stop' },
  { session_id: 'sess-cli-1', role: 'tool',      timestamp: T0 + 200, content: 'read_file(src/auth.js)', tool_name: 'read_file' },
  { session_id: 'sess-cli-1', role: 'user',      timestamp: T0 + 300, content: 'Keep the public signature stable.' },
  { session_id: 'sess-cli-1', role: 'assistant', timestamp: T0 + 590, content: 'Done — I extracted the token check into its own function and covered it with tests.', finish_reason: 'stop' },

  { session_id: 'sess-cli-2', role: 'user',      timestamp: T0 + 1010, content: 'Now cover the refresh path.' },
  { session_id: 'sess-cli-2', role: 'assistant', timestamp: T0 + 1190, content: 'Added a test for the refresh path.', finish_reason: 'stop' },

  { session_id: 'sess-cli-nocwd', role: 'user',      timestamp: T0 + 2010, content: 'What does a JWT nonce protect against?' },
  { session_id: 'sess-cli-nocwd', role: 'assistant', timestamp: T0 + 2090, content: 'Replay of a captured token.', finish_reason: 'stop' },

  // sess-running — a turn IS running: the prompt is in, the answer is not. That is what the store looks
  // like mid-turn, and it is the only thing that distinguishes it from a session waiting at its prompt
  // (`ended_at` is null in both cases — it is null in every case).
  { session_id: 'sess-running', role: 'assistant', timestamp: T0 + 900,  content: 'Earlier answer.', finish_reason: 'stop' },
  { session_id: 'sess-running', role: 'user',      timestamp: T0 + 1001, content: 'Why does this test fail every third run?' },

  { session_id: 'sess-gateway-1', role: 'user',      timestamp: T0 + 3010, content: 'status?' },
  { session_id: 'sess-gateway-1', role: 'assistant', timestamp: T0 + 3050, content: 'All green.', finish_reason: 'stop' },

  { session_id: 'sess-zero-cost', role: 'user',      timestamp: T0 + 4010, content: 'Try the new model.' },
  { session_id: 'sess-zero-cost', role: 'assistant', timestamp: T0 + 4090, content: 'Done.', finish_reason: 'stop' },

  // sess-answered — answered, and the session is still open (ended_at null, as it always is).
  { session_id: 'sess-answered', role: 'user',      timestamp: T0 + 6010, content: 'What time is it in Tokyo?' },
  { session_id: 'sess-answered', role: 'assistant', timestamp: T0 + 6020, content: 'Just past nine in the evening.', finish_reason: 'stop' },

  // sess-tool-turn — a real tool-using turn, row for row as Hermes writes it. The empty assistant row with
  // `finish_reason: 'tool_calls'` is the one that matters: read as "finished", the session would flash idle
  // at every single tool call, which for a coding agent is most of what it does.
  { session_id: 'sess-tool-turn', role: 'user',      timestamp: T0 + 7010, content: 'List the files here and read one.txt.' },
  { session_id: 'sess-tool-turn', role: 'assistant', timestamp: T0 + 7020, content: '', finish_reason: 'tool_calls', tool_calls: '[{"id":"c1","name":"search_files"}]' },
  { session_id: 'sess-tool-turn', role: 'tool',      timestamp: T0 + 7030, content: '{"total_count": 2, "files": ["one.txt", "two.txt"]}', tool_name: 'search_files', tool_call_id: 'c1' },
  { session_id: 'sess-tool-turn', role: 'tool',      timestamp: T0 + 7040, content: '{"content": "alpha", "total_lines": 1}', tool_name: 'read_file', tool_call_id: 'c2' },
  { session_id: 'sess-tool-turn', role: 'assistant', timestamp: T0 + 7050, content: 'Two files. one.txt says: alpha', finish_reason: 'stop' },
];

// --- build ---

// The same two drivers the reader accepts (backends/hermes/reader.js), opened for WRITING. Both speak
// `prepare(sql).run(...positional)`, so one call shape covers them.
function openWritable(file) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(file);
    return {
      exec: (sql) => db.exec(sql),
      run: (sql, ...params) => db.prepare(sql).run(...params),
      close: () => db.close(),
    };
  } catch { /* fall through to the built-in driver */ }

  const { DatabaseSync } = require('node:sqlite');   // Node ≥ 22.5, no native build needed
  const db = new DatabaseSync(file);
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => db.prepare(sql).run(...params),
    close: () => db.close(),
  };
}

const SESSION_COLS = [
  'id', 'source', 'user_id', 'model', 'model_config', 'system_prompt', 'parent_session_id',
  'started_at', 'ended_at', 'end_reason', 'message_count', 'tool_call_count',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens',
  'cwd', 'billing_provider', 'billing_base_url', 'billing_mode',
  'estimated_cost_usd', 'actual_cost_usd', 'cost_status', 'cost_source', 'pricing_version',
  'title', 'api_call_count', 'handoff_state', 'handoff_platform', 'handoff_error',
  'rewind_count', 'archived',
];

const MESSAGE_COLS = [
  'session_id', 'role', 'content', 'tool_call_id', 'tool_calls', 'tool_name', 'timestamp',
  'token_count', 'finish_reason', 'reasoning', 'reasoning_content', 'reasoning_details',
  'codex_reasoning_items', 'codex_message_items', 'platform_message_id',
  'observed', 'active', 'compacted',
];

function insert(db, table, cols, row) {
  db.run(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    // A column the row does not name is genuinely NULL in Hermes' table — never undefined, which the
    // node:sqlite driver refuses to bind.
    ...cols.map(c => (row[c] === undefined ? null : row[c])),
  );
}

/** Write a fresh Hermes store at `file`. Deterministic: same bytes-worth of rows on every run. */
function writeHermesDb(file) {
  const db = openWritable(file);
  try {
    db.exec(SCHEMA);
    for (const s of SESSIONS) insert(db, 'sessions', SESSION_COLS, s);
    // `id` is left to AUTOINCREMENT: readMessages orders by it, so insertion order IS chronological
    // order — which is what a real store gives us too.
    for (const m of MESSAGES) insert(db, 'messages', MESSAGE_COLS, m);
  } finally {
    db.close();
  }
  return file;
}

// BUILD ONCE, COPY MANY.
//
// The fixture is deterministic — that is the whole idea — so building it is the same 260 ms of SQLite
// work every single time. `hermes.test.js` asked for a fresh home 35 times and spent nine seconds
// rebuilding a file it already had, byte for byte. That is not thoroughness, it is a loop.
//
// Every caller still gets its OWN COPY, so a test that writes to the store cannot reach another's.
let templateDb = null;
function template() {
  if (templateDb && fs.existsSync(templateDb)) return templateDb;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-template-'));
  templateDb = writeHermesDb(path.join(dir, 'state.db'));
  return templateDb;
}

/** A throwaway HERMES_HOME containing its own copy of the fixture store. */
function makeHermesHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-'));
  fs.copyFileSync(template(), path.join(home, 'state.db'));
  return home;
}

module.exports = { T0, SCHEMA, SESSIONS, MESSAGES, writeHermesDb, makeHermesHome };
