'use strict';
// #159 — the queries the whole Stats page believes.
//
// These run the REAL SQL against a real (in-memory) SQLite with the real v14 schema. The old
// db-session-metrics tests could not: db.js requires Electron, so they re-implemented each query in JS
// and asserted the re-implementation — which passes whether or not the SQL is right. Pulling the SQL
// into stats-queries.js (Electron-free) is what makes an honest test possible, and the backend filter
// is exactly the kind of thing a mirror test cannot check: it is a JOIN, and a mirror has no JOIN.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const q = require('../stats-queries');

// The same two drivers the app accepts (backends/hermes/reader.js). better-sqlite3 is a native module
// built for Electron's ABI, so it may not load under plain `node --test`; node:sqlite (Node >= 22.5) is
// the fallback that always can.
function openMemory() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    return {
      exec: (sql) => db.exec(sql),
      all: (sql, params) => db.prepare(sql).all(...params),
      close: () => db.close(),
    };
  } catch { /* fall through */ }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  return {
    exec: (sql) => db.exec(sql),
    all: (sql, params) => db.prepare(sql).all(...params),
    close: () => db.close(),
  };
}

// The v14 schema, only as much of session_cache as the JOIN touches.
const SCHEMA = `
CREATE TABLE session_cache (
  sessionId TEXT PRIMARY KEY,
  parentSessionId TEXT,
  backendId TEXT
);
CREATE TABLE session_metrics (
  sessionId TEXT NOT NULL,
  date TEXT NOT NULL,
  hour INTEGER NOT NULL DEFAULT -1,
  model TEXT NOT NULL DEFAULT '',
  messageCount INTEGER DEFAULT 0,
  toolCallCount INTEGER DEFAULT 0,
  inputTokens INTEGER DEFAULT 0,
  outputTokens INTEGER DEFAULT 0,
  cacheReadTokens INTEGER DEFAULT 0,
  cacheCreationTokens INTEGER DEFAULT 0,
  estimatedCostUsd REAL,
  actualCostUsd REAL,
  PRIMARY KEY (sessionId, date, hour, model)
);
`;

// 2026-06-01 is a MONDAY -> strftime('%w') = 1. 2026-06-06 is a Saturday -> 6.
const MONDAY = '2026-06-01';
const SATURDAY = '2026-06-06';

function seed() {
  const db = openMemory();
  db.exec(SCHEMA);

  // Sessions: two Claude (one a SUBAGENT of the other), one Codex, one Hermes. The subagent is what
  // makes `totalSessions` a real question — counting it would inflate every user's session count.
  db.exec(`
    INSERT INTO session_cache (sessionId, parentSessionId, backendId) VALUES
      ('c1',  NULL, 'claude'),
      ('sub', 'c1', 'claude'),
      ('x1',  NULL, 'codex'),
      ('tpl', NULL, 'test-1'),        -- a TEMPLATE that runs the Codex binary: its provenance is the template
      ('h1',  NULL, 'hermes'),
      ('old', NULL, NULL);            -- indexed before backends existed: NULL means Claude
  `);

  db.exec(`
    INSERT INTO session_metrics
      (sessionId, date, hour, model, messageCount, toolCallCount, inputTokens, outputTokens,
       cacheReadTokens, cacheCreationTokens, estimatedCostUsd, actualCostUsd) VALUES
      -- Claude: two hours on the Monday, one on the Saturday. Reports no money at all.
      ('c1',  '${MONDAY}',   9,  'opus',   4, 2, 100,  40, 0, 0, NULL, NULL),
      ('c1',  '${MONDAY}',   10, 'opus',   2, 0,  50,  10, 0, 0, NULL, NULL),
      ('c1',  '${SATURDAY}', 14, 'opus',   1, 0,  10,   5, 0, 0, NULL, NULL),
      -- A synthetic / model-less bucket: still a message, never any tokens.
      ('c1',  '${MONDAY}',   9,  '',       3, 0,   0,   0, 0, 0, NULL, NULL),
      -- The subagent's work is real work: it counts in messages/tokens, but NOT as a session.
      ('sub', '${MONDAY}',   9,  'opus',   5, 1,  20,  10, 0, 0, NULL, NULL),
      -- A row from before backends existed (backendId NULL) — it is Claude's.
      ('old', '${MONDAY}',   9,  'opus',   1, 0,   7,   3, 0, 0, NULL, NULL),
      -- Codex: also no money.
      ('x1',  '${MONDAY}',   9,  'gpt',    2, 1, 200,  60, 0, 0, NULL, NULL),
      -- ...and a session run from a TEMPLATE on Codex. Filtering by "Codex" has to find this too.
      ('tpl', '${MONDAY}',   11, 'gpt',    7, 3, 500, 100, 0, 0, NULL, NULL),
      -- Hermes: money. One bucket is an ESTIMATE, one is SETTLED. And one bucket has no hour at all,
      -- because Hermes cannot always say when within the day — it must still count per day.
      ('h1',  '${MONDAY}',   20, 'sonnet', 6, 0, 300,  90, 0, 0, 0.02, NULL),
      ('h1',  '${SATURDAY}', 21, 'sonnet', 2, 0,  10,   5, 0, 0, 0.04, 0.03),
      ('h1',  '${SATURDAY}', -1, 'sonnet', 9, 0,   0,   0, 0, 0, NULL, NULL);
  `);
  return db;
}

const run = (db, spec) => db.all(spec.sql, spec.params);

// --- the backend filter -------------------------------------------------------------------------

test('unfiltered, the daily figures cover every backend', () => {
  const db = seed();
  try {
    const rows = run(db, q.dailyMetrics(null));
    const monday = rows.find(r => r.date === MONDAY);
    // 4+2+3 (claude) + 5 (subagent) + 1 (legacy NULL) + 2 (codex) + 7 (a template ON codex) + 6 (hermes)
    assert.equal(monday.messageCount, 30);
    assert.equal(monday.sessionCount, 6, 'six distinct sessions were active that day');
  } finally { db.close(); }
});

test('a backend filter scopes the daily figures — this is the whole point of #159', () => {
  const db = seed();
  try {
    const codex = run(db, q.dailyMetrics('codex'));
    assert.equal(codex.length, 1, 'Codex only ever worked on the Monday');
    assert.equal(codex[0].messageCount, 2);
    assert.equal(codex[0].tokens, 260);

    const hermes = run(db, q.dailyMetrics('hermes'));
    assert.equal(hermes.length, 2);
    assert.equal(hermes.find(r => r.date === SATURDAY).messageCount, 11, '2 in the 21:00 bucket + 9 with no hour');
  } finally { db.close(); }
});

// A row indexed before backends existed has backendId NULL. If the filter compared it literally, a
// Claude user's entire history before the multi-LLM release would vanish the moment they clicked
// "Claude" — the one filter they would actually use.
test('a legacy row with no backendId counts as Claude, not as nothing', () => {
  const db = seed();
  try {
    const claude = run(db, q.dailyMetrics('claude'));
    const monday = claude.find(r => r.date === MONDAY);
    assert.equal(monday.messageCount, 15, '4+2+3 own + 5 subagent + 1 legacy');
    assert.equal(monday.sessionCount, 3, 'c1, sub and the legacy row');
  } finally { db.close(); }
});

test('an orphan metrics row is not counted into a filtered chart', () => {
  const db = seed();
  try {
    db.exec(`INSERT INTO session_metrics (sessionId, date, hour, model, messageCount)
             VALUES ('ghost', '${MONDAY}', 9, 'opus', 999)`);
    const claude = run(db, q.dailyMetrics('claude'));
    assert.equal(claude.find(r => r.date === MONDAY).messageCount, 15, 'the ghost has no session — the INNER JOIN drops it');
  } finally { db.close(); }
});

// --- the filter is a LIST: the backend, plus every template that runs on it (#168) ---------------
//
// The bug: db.js took the expanded list and flattened it with `String(backendId)`, binding the literal
// `"codex,test-1"` against a column that holds neither. So the moment ONE template ran on a backend,
// filtering by that backend reported ZERO sessions and the whole Stats page came back blank — no
// heatmap, no bars, no cost. Claude only escaped it because no template ran on Claude.
//
// The SQL was right and tested all along. The decision that was wrong lived in db.js, which no test can
// load (better-sqlite3 is built for Electron's ABI) — so it now lives in `plan()`, here.

test('filtering by a backend finds the sessions its TEMPLATES ran, too', () => {
  const db = seed();
  try {
    // What main.js hands down: "Codex" expands to the backend plus every template on it.
    const spec = q.plan('dailyMetrics', ['codex', 'test-1']);
    assert.deepEqual(spec.params, ['codex', 'test-1'], 'one bound value per id — not one flattened string');

    const monday = run(db, spec).find(r => r.date === MONDAY);
    assert.equal(monday.messageCount, 9, '2 from the plain Codex session + 7 from the one run on the template');
    assert.equal(monday.sessionCount, 2);

    const total = run(db, q.plan('totalSessions', ['codex', 'test-1']))[0];
    assert.equal(total.cnt, 2, 'and the page does not report zero sessions while two are plainly there');
  } finally { db.close(); }
});

test('the statement cache is keyed on HOW MANY ids, because that is what the SQL is shaped by', () => {
  // One `?` per id. A cache keyed on "filtered or not" would hand a statement prepared for two ids to a
  // filter with three — a different query, silently. The old bug hid this: with the ids flattened into
  // one string there was never more than one placeholder to get wrong.
  const one = q.plan('dailyMetrics', ['codex']);
  const two = q.plan('dailyMetrics', ['codex', 'test-1']);
  const none = q.plan('dailyMetrics', 'all');

  assert.notEqual(one.cacheKey, two.cacheKey);
  assert.notEqual(one.cacheKey, none.cacheKey);
  assert.equal((one.sql.match(/\?/g) || []).length, 1);
  assert.equal((two.sql.match(/\?/g) || []).length, 2);
  assert.deepEqual(none.params, [], 'no filter binds nothing');
});

test('plan() takes a bare id as readily as a list, and "all" as no filter at all', () => {
  const db = seed();
  try {
    assert.deepEqual(q.plan('dailyMetrics', 'hermes').params, ['hermes']);
    assert.deepEqual(q.plan('dailyMetrics', null).params, []);
    assert.deepEqual(q.plan('dailyMetrics', 'all').params, []);
    assert.equal(run(db, q.plan('totalSessions', null))[0].cnt, 5, 'unfiltered still means everything');
  } finally { db.close(); }
});

test('an unknown query name is an error, not an empty page', () => {
  assert.throws(() => q.plan('nonesuch', 'codex'), /unknown stats query/);
});

// --- totals -------------------------------------------------------------------------------------

test('the session count excludes subagents — they are work, not sessions', () => {
  const db = seed();
  try {
    assert.equal(run(db, q.totalSessions(null))[0].cnt, 5, 'c1, x1, tpl, h1, old — NOT sub');
    assert.equal(run(db, q.totalSessions('claude'))[0].cnt, 2, 'c1 and the legacy row');
    assert.equal(run(db, q.totalSessions('hermes'))[0].cnt, 1);
    assert.equal(run(db, q.totalSessions('pi'))[0].cnt, 0, 'a backend with no sessions is 0, not an error');
  } finally { db.close(); }
});

test('the totals follow the filter too', () => {
  const db = seed();
  try {
    const all = run(db, q.totals(null))[0];
    assert.equal(all.totalTokens, 100 + 40 + 50 + 10 + 10 + 5 + 20 + 10 + 7 + 3 + 200 + 60 + 500 + 100 + 300 + 90 + 10 + 5);
    const codex = run(db, q.totals('codex'))[0];
    assert.equal(codex.totalTokens, 260);
    assert.equal(codex.totalToolCalls, 1);
  } finally { db.close(); }
});

// --- models -------------------------------------------------------------------------------------

test('the model-less bucket is excluded from model charts (it never carried tokens)', () => {
  const db = seed();
  try {
    const models = run(db, q.modelUsage(null)).map(r => r.model).sort();
    assert.deepEqual(models, ['gpt', 'opus', 'sonnet'], 'the \'\' bucket is not a model');
  } finally { db.close(); }
});

test('model usage is scoped by backend', () => {
  const db = seed();
  try {
    const rows = run(db, q.modelUsage('claude'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, 'opus');
    assert.equal(rows[0].inputTokens, 100 + 50 + 10 + 20 + 7);
  } finally { db.close(); }
});

// --- the stacked bars ---------------------------------------------------------------------------

test('daily backend tokens split the day per backend', () => {
  const db = seed();
  try {
    const rows = run(db, q.dailyBackendTokens(null)).filter(r => r.date === MONDAY);
    const byBackend = Object.fromEntries(rows.map(r => [r.backendId, r.tokens]));
    assert.equal(byBackend.codex, 260);
    assert.equal(byBackend.hermes, 390);
    assert.equal(byBackend.claude, 100 + 40 + 50 + 10 + 20 + 10 + 7 + 3, 'incl. the subagent and the legacy row');
  } finally { db.close(); }
});

test('filtering the stacked bars leaves exactly one series', () => {
  const db = seed();
  try {
    const rows = run(db, q.dailyBackendTokens('hermes'));
    assert.equal(new Set(rows.map(r => r.backendId)).size, 1);
    assert.equal(rows.every(r => r.backendId === 'hermes'), true);
  } finally { db.close(); }
});

// --- cost ---------------------------------------------------------------------------------------

// Claude and Codex report no money. A cost chart that summed their NULLs into 0 would draw them a line
// of free days — a claim the data never made, and the one thing a cost chart must never say.
test('a day nobody priced does not appear in the cost series at all', () => {
  const db = seed();
  try {
    const rows = run(db, q.dailyCost('claude'));
    assert.equal(rows.length, 0, 'Claude priced nothing, so Claude has no cost series');
    const codex = run(db, q.dailyCost('codex'));
    assert.equal(codex.length, 0);
  } finally { db.close(); }
});

test('estimated and settled cost stay separate — an estimate is not a bill', () => {
  const db = seed();
  try {
    const rows = run(db, q.dailyCost('hermes'));
    const monday = rows.find(r => r.date === MONDAY);
    assert.equal(monday.estimatedCostUsd, 0.02);
    assert.equal(monday.actualCostUsd, null, 'never settled — and NOT rendered as 0');

    const saturday = rows.find(r => r.date === SATURDAY);
    assert.equal(saturday.estimatedCostUsd, 0.04);
    assert.equal(saturday.actualCostUsd, 0.03, 'the settled figure is its own number, not a replacement');
  } finally { db.close(); }
});

// --- the hour grid ------------------------------------------------------------------------------

test('the hour grid groups by weekday and hour, Sunday = 0', () => {
  const db = seed();
  try {
    const rows = run(db, q.hourlyActivity(null));
    const mon9 = rows.find(r => r.weekday === 1 && r.hour === 9);
    assert.ok(mon9, '2026-06-01 is a Monday');
    // claude 4 + model-less 3 + subagent 5 + legacy 1 + codex 2
    assert.equal(mon9.messageCount, 15);

    const sat21 = rows.find(r => r.weekday === 6 && r.hour === 21);
    assert.equal(sat21.messageCount, 2, '2026-06-06 is a Saturday');
  } finally { db.close(); }
});

// A backend that cannot say WHEN within the day writes hour = -1. Drawing those at midnight would
// invent a working habit nobody has — so the grid does not show them at all, while every per-day chart
// still counts them.
test('buckets with no hour are kept out of the grid but stay in the daily figures', () => {
  const db = seed();
  try {
    const grid = run(db, q.hourlyActivity('hermes'));
    assert.equal(grid.some(r => r.hour < 0), false, 'no hour-less bucket reaches the grid');
    assert.equal(grid.reduce((n, r) => n + r.messageCount, 0), 8, 'only the 6 + 2 placed messages');

    const daily = run(db, q.dailyMetrics('hermes'));
    assert.equal(daily.reduce((n, r) => n + r.messageCount, 0), 17, 'but all 17 still count per day');
  } finally { db.close(); }
});

// --- the filter is a BACKEND, and a backend means "everything that ran its binary" ------------------
//
// The Stats page filters by backend, never by template: a template is a set of defaults, not a provider,
// and a pill per template would split Codex' own numbers across "Codex" and "my Codex template" while
// answering nothing.
//
// But a session launched from a template records the TEMPLATE's id as its provenance (§5.7) — which is
// right, the sidebar badge should say which one launched it. So the filter takes a LIST: the backend
// plus every template that runs on it. Get this wrong and a user's template sessions silently vanish
// from the very chart they went looking for.

test('a backend filter takes a list, so a template\'s sessions count towards its backend', () => {
  const db = seed();
  try {
    db.exec(`
      INSERT INTO session_cache (sessionId, parentSessionId, backendId) VALUES ('tpl1', NULL, 'codex-fast');
      INSERT INTO session_metrics (sessionId, date, hour, model, messageCount, inputTokens, outputTokens)
        VALUES ('tpl1', '${MONDAY}', 9, 'gpt', 5, 500, 100);
    `);

    // 'codex' alone: only the sessions that recorded 'codex'.
    const bare = run(db, q.dailyMetrics('codex'));
    assert.equal(bare[0].messageCount, 2, 'the template session is not there');

    // 'codex' EXPANDED to its templates — what the page actually asks for.
    const expanded = run(db, q.dailyMetrics(['codex', 'codex-fast']));
    assert.equal(expanded[0].messageCount, 7, '2 + 5: the work went to Codex either way');
    assert.equal(expanded[0].tokens, 260 + 600);
  } finally { db.close(); }
});

test('the expansion works for every aggregate, not just the daily one', () => {
  const db = seed();
  try {
    db.exec(`
      INSERT INTO session_cache (sessionId, parentSessionId, backendId) VALUES ('tpl1', NULL, 'codex-fast');
      INSERT INTO session_metrics (sessionId, date, hour, model, messageCount, inputTokens, outputTokens)
        VALUES ('tpl1', '${MONDAY}', 9, 'gpt', 5, 500, 100);
    `);
    const ids = ['codex', 'codex-fast'];
    assert.equal(run(db, q.totalSessions(ids))[0].cnt, 2, 'both count as sessions of this backend');
    assert.equal(run(db, q.totals(ids))[0].totalTokens, 260 + 600);
    assert.equal(run(db, q.modelUsage(ids))[0].inputTokens, 200 + 500);

    const stacked = run(db, q.dailyBackendTokens(ids));
    const backendsSeen = new Set(stacked.map(r => r.backendId));
    assert.deepEqual([...backendsSeen].sort(), ['codex', 'codex-fast'],
      'the stacked chart still shows them apart — the FILTER is what merges them, not the data');
  } finally { db.close(); }
});

test('an empty list is not a filter — it must not silently match nothing', () => {
  const db = seed();
  try {
    assert.equal(run(db, q.dailyMetrics([])).length, run(db, q.dailyMetrics(null)).length,
      'an empty expansion means "no filter", never "no rows"');
  } finally { db.close(); }
});
