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
//   sess-running     ended_at IS NULL — the busy signal. Its last message is what moves.
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
const MESSAGES = [
  // sess-cli-1 — the last turn is an assistant one, and it is the packet a handoff pre-fills from.
  { session_id: 'sess-cli-1', role: 'user',      timestamp: T0 + 10,  content: 'Refactor the auth middleware and add tests' },
  { session_id: 'sess-cli-1', role: 'assistant', timestamp: T0 + 100, content: 'Looking at the middleware now.' },
  { session_id: 'sess-cli-1', role: 'tool',      timestamp: T0 + 200, content: 'read_file(src/auth.js)', tool_name: 'read_file' },
  { session_id: 'sess-cli-1', role: 'user',      timestamp: T0 + 300, content: 'Keep the public signature stable.' },
  { session_id: 'sess-cli-1', role: 'assistant', timestamp: T0 + 590, content: 'Done — I extracted the token check into its own function and covered it with tests.' },

  { session_id: 'sess-cli-2', role: 'user',      timestamp: T0 + 1010, content: 'Now cover the refresh path.' },
  { session_id: 'sess-cli-2', role: 'assistant', timestamp: T0 + 1190, content: 'Added a test for the refresh path.' },

  { session_id: 'sess-cli-nocwd', role: 'user',      timestamp: T0 + 2010, content: 'What does a JWT nonce protect against?' },
  { session_id: 'sess-cli-nocwd', role: 'assistant', timestamp: T0 + 2090, content: 'Replay of a captured token.' },

  // sess-running — no ended_at, so its LAST message is the activity signal the state derivation reads.
  { session_id: 'sess-running', role: 'user',      timestamp: T0 + 950,  content: 'Why does this test fail every third run?' },
  { session_id: 'sess-running', role: 'assistant', timestamp: T0 + 1001, content: 'Reproducing it now…' },

  { session_id: 'sess-gateway-1', role: 'user',      timestamp: T0 + 3010, content: 'status?' },
  { session_id: 'sess-gateway-1', role: 'assistant', timestamp: T0 + 3050, content: 'All green.' },

  { session_id: 'sess-zero-cost', role: 'user',      timestamp: T0 + 4010, content: 'Try the new model.' },
  { session_id: 'sess-zero-cost', role: 'assistant', timestamp: T0 + 4090, content: 'Done.' },
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

/** A throwaway HERMES_HOME containing a freshly built `state.db`. */
function makeHermesHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-'));
  writeHermesDb(path.join(home, 'state.db'));
  return home;
}

module.exports = { T0, SCHEMA, SESSIONS, MESSAGES, writeHermesDb, makeHermesHome };
