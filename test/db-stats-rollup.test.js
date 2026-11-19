'use strict';
// #809 / #877 (spec 48 "As built (T9)") — the Sessions table's roll-up through `session_meta.spawnedBy`: the REAL SQL against
// a real in-memory SQLite with the part of the schema these queries touch (same method as db-stats-queries.test.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const q = require('../src/db/stats-queries');

function openMemory() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    return { exec: (sql) => db.exec(sql), all: (sql, params) => db.prepare(sql).all(...params), close: () => db.close() };
  } catch { /* fall through to node:sqlite */ }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  return { exec: (sql) => db.exec(sql), all: (sql, params) => db.prepare(sql).all(...params), close: () => db.close() };
}

const SCHEMA = `
CREATE TABLE session_cache (sessionId TEXT PRIMARY KEY, parentSessionId TEXT, backendId TEXT, projectPath TEXT, costStatus TEXT, aiTitle TEXT, created TEXT);
CREATE TABLE session_meta (sessionId TEXT PRIMARY KEY, spawnedBy TEXT, spawnKind TEXT);
CREATE TABLE session_metrics (
  sessionId TEXT NOT NULL, date TEXT NOT NULL, hour INTEGER NOT NULL DEFAULT -1, model TEXT NOT NULL DEFAULT '',
  messageCount INTEGER DEFAULT 0, toolCallCount INTEGER DEFAULT 0, inputTokens INTEGER DEFAULT 0, outputTokens INTEGER DEFAULT 0,
  cacheReadTokens INTEGER DEFAULT 0, cacheCreationTokens INTEGER DEFAULT 0, estimatedCostUsd REAL, actualCostUsd REAL,
  PRIMARY KEY (sessionId, date, hour, model)
);`;

const RANGE = { from: '2026-06-02', to: '2026-06-09' };
const IN = '2026-06-03';
const OUT = '2026-05-01';

/** `sessions`: [id, backendId, parentSessionId]; `spawns`: [child, caller]; `rows`: [id, date, tokens, estimatedCost, model]. */
function build({ sessions, spawns = [], rows }) {
  const db = openMemory();
  db.exec(SCHEMA);
  for (const [id, backend, parent] of sessions) {
    db.exec(`INSERT INTO session_cache (sessionId, parentSessionId, backendId, projectPath) VALUES ('${id}', ${parent ? `'${parent}'` : 'NULL'}, '${backend}', '/p/one')`);
  }
  for (const [child, caller] of spawns) db.exec(`INSERT INTO session_meta (sessionId, spawnedBy, spawnKind) VALUES ('${child}', '${caller}', 'review')`);
  for (const [id, date, tokens, cost, model] of rows) {
    db.exec(`INSERT INTO session_metrics (sessionId, date, hour, model, messageCount, inputTokens, outputTokens, estimatedCostUsd)
             VALUES ('${id}', '${date}', 9, '${model || 'm'}', 1, ${tokens}, 0, ${cost == null ? 'NULL' : cost})`);
  }
  return db;
}

const rollup = (db, filter, ids) => {
  const spec = q.sessionsRollup(filter, ids);
  return db.all(spec.sql, spec.params);
};
const byRoot = (rows) => Object.fromEntries(rows.map(r => [r.sessionId, r]));
const tokensOf = (rows, id) => rows.filter(r => r.sessionId === id).reduce((n, r) => n + r.tokens, 0);

test('a chain is followed transitively; the root itself is not in its own roll-up', () => {
  const db = build({
    sessions: [['r', 'claude'], ['c1', 'codex'], ['c2', 'codex'], ['other', 'claude']],
    spawns: [['c1', 'r'], ['c2', 'c1']],
    rows: [['r', IN, 100, 1], ['c1', IN, 10, 0.5], ['c2', IN, 1, 0.25], ['other', IN, 1000, 9]],
  });
  try {
    const rows = rollup(db, RANGE, ['r']);
    assert.equal(tokensOf(rows, 'r'), 11, 'c1 + c2, never r itself and never an unrelated session');
    assert.equal(rows.reduce((n, r) => n + (r.estimatedCostUsd || 0), 0), 0.75);
    assert.deepEqual(rollup(db, RANGE, ['c2']), [], 'a session that started nothing has no roll-up rows');
    assert.equal(tokensOf(rollup(db, RANGE, ['c1']), 'c1'), 1, 'each root sees only its own subtree');
  } finally { db.close(); }
});

test('cost parts come per cost group, so a settled and an estimated child fold apart', () => {
  const db = build({
    sessions: [['r', 'claude'], ['a', 'claude'], ['b', 'codex']],
    spawns: [['a', 'r'], ['b', 'r']],
    rows: [['a', IN, 1, 1], ['b', IN, 1, 2]],
  });
  try {
    db.exec("UPDATE session_cache SET costStatus = 'actual' WHERE sessionId = 'b'");
    const rows = rollup(db, RANGE, ['r']);
    assert.deepEqual(rows.map(r => r.costBackendId).sort(), ['claude', 'codex']);
    assert.equal(rows.find(r => r.costBackendId === 'codex').costStatus, 'actual');
    assert.equal(rows.find(r => r.costBackendId === 'claude').costStatus, null);
  } finally { db.close(); }
});

test('a cycle (A spawns B spawns A) ends and counts each session once', () => {
  const db = build({
    sessions: [['a', 'claude'], ['b', 'claude']],
    spawns: [['b', 'a'], ['a', 'b']],
    rows: [['a', IN, 100, null], ['b', IN, 7, null]],
  });
  try {
    assert.equal(tokensOf(rollup(db, RANGE, ['a']), 'a'), 7, 'only B; A is not its own started session');
    assert.equal(tokensOf(rollup(db, RANGE, ['b']), 'b'), 100);
    const both = byRoot(rollup(db, RANGE, ['a', 'b']));
    assert.equal(both.a.tokens, 7);
    assert.equal(both.b.tokens, 100);
  } finally { db.close(); }
});

test('a session that spawned itself adds nothing', () => {
  const db = build({ sessions: [['a', 'claude']], spawns: [['a', 'a']], rows: [['a', IN, 5, null]] });
  try { assert.deepEqual(rollup(db, RANGE, ['a']), []); } finally { db.close(); }
});

test('the depth cap cuts a long chain, it does not fail', () => {
  const n = q.ROLLUP_MAX_DEPTH + 4;
  const sessions = [];
  const spawns = [];
  const rows = [];
  for (let i = 0; i <= n; i++) {
    sessions.push(['d' + i, 'claude']);
    rows.push(['d' + i, IN, 1, null]);
    if (i > 0) spawns.push(['d' + i, 'd' + (i - 1)]);
  }
  const db = build({ sessions, spawns, rows });
  try {
    assert.equal(tokensOf(rollup(db, RANGE, ['d0']), 'd0'), q.ROLLUP_MAX_DEPTH, 'generations 1..cap, the rest is cut');
  } finally { db.close(); }
});

test('a subagent is never counted twice: its rows ride with its parent, and it as a spawn node adds nothing', () => {
  const db = build({
    sessions: [['r', 'claude'], ['c1', 'claude'], ['sub', 'claude', 'c1'], ['subOfRoot', 'claude', 'r']],
    // 'sub' also carries a spawn record (an odd but possible row); 'subOfRoot' is r's OWN subagent and spawned nothing.
    spawns: [['c1', 'r'], ['sub', 'r']],
    rows: [['r', IN, 100, null], ['c1', IN, 10, null], ['sub', IN, 3, null], ['subOfRoot', IN, 50, null]],
  });
  try {
    const rows = rollup(db, RANGE, ['r']);
    assert.equal(tokensOf(rows, 'r'), 13, 'c1 10 + its subagent 3 once; r\'s own subagent (50) is own, not started');
    // The own column of the same root folds its subagent in already (the sessions table), and the roll-up excludes it.
    const own = db.all(...(({ sql, params }) => [sql, params])(q.sessionsTable(RANGE, { limit: 50 }))).find(r => r.sessionId === 'r');
    assert.equal(own.tokens, 150);
    assert.equal(own.tokens + tokensOf(rows, 'r'), 163, 'own + started has every row exactly once');
  } finally { db.close(); }
});

test('only the filter\'s range counts for a started session', () => {
  const db = build({
    sessions: [['r', 'claude'], ['c1', 'claude']],
    spawns: [['c1', 'r']],
    rows: [['c1', IN, 10, null], ['c1', OUT, 999, null], ['c1', '2026-07-01', 999, null]],
  });
  try {
    assert.equal(tokensOf(rollup(db, RANGE, ['r']), 'r'), 10);
    assert.equal(tokensOf(rollup(db, { from: OUT, to: OUT }, ['r']), 'r'), 999, 'a range that holds the other day sees it');
    assert.deepEqual(rollup(db, { from: '2026-08-01', to: '2026-08-02' }, ['r']), []);
  } finally { db.close(); }
});

test('a started session is filtered by the RANGE only: backend, project and model do not narrow it (owner decision 20)', () => {
  const db = build({
    sessions: [['r', 'claude'], ['k1', 'claude'], ['x1', 'codex']],
    spawns: [['k1', 'r'], ['x1', 'r']],
    rows: [['k1', IN, 10, null, 'opus'], ['x1', IN, 100, null, 'gpt'], ['x1', OUT, 7000, null, 'gpt']],
  });
  try {
    db.exec("UPDATE session_cache SET projectPath = '/p/other' WHERE sessionId = 'x1'");
    assert.equal(tokensOf(rollup(db, { ...RANGE, backend: ['claude'] }, ['r']), 'r'), 110, 'a Codex session started by a Claude one counts under a Claude filter');
    assert.equal(tokensOf(rollup(db, { ...RANGE, projects: ['/p/one'] }, ['r']), 'r'), 110, 'a session in another project counts under a project filter');
    assert.equal(tokensOf(rollup(db, { ...RANGE, model: 'opus' }, ['r']), 'r'), 110, 'and under a model filter');
    assert.equal(tokensOf(rollup(db, RANGE, ['r']), 'r'), 110, 'no filter: the same');
    assert.equal(tokensOf(rollup(db, { from: OUT, to: OUT, backend: ['claude'] }, ['r']), 'r'), 7000, 'the range still decides, whatever the other fields say');
  } finally { db.close(); }
});

test('a spawn record whose caller is a SUBAGENT counts under the top-level parent of the subagent, once (owner decision 21)', () => {
  const db = build({
    sessions: [['r', 'claude'], ['rsub', 'claude', 'r'], ['x', 'codex'], ['y', 'claude'], ['xchild', 'codex']],
    // x was started by r's subagent; y directly by r; xchild by x (a chain below the lifted one).
    spawns: [['x', 'rsub'], ['y', 'r'], ['xchild', 'x']],
    rows: [['r', IN, 1000, null], ['rsub', IN, 500, null], ['x', IN, 10, null], ['y', IN, 100, null], ['xchild', IN, 1, null]],
  });
  try {
    const rows = rollup(db, RANGE, ['r']);
    assert.equal(tokensOf(rows, 'r'), 111, 'x 10 + y 100 + xchild 1, each once; r and its own subagent are own figures');
    assert.deepEqual(rollup(db, RANGE, ['rsub']), [], 'a subagent id is not a line of its own');
    const two = rollup(db, RANGE, ['r', 'y']);
    assert.equal(tokensOf(two, 'r'), 111);
    assert.equal(tokensOf(two, 'y'), 0, 'y started nothing');
  } finally { db.close(); }
});

test('a started session never counts twice when a parent and its subagent both have spawn records', () => {
  const db = build({
    sessions: [['r', 'claude'], ['rsub', 'claude', 'r'], ['x', 'claude']],
    spawns: [['rsub', 'r'], ['x', 'rsub']],
    rows: [['r', IN, 1000, null], ['rsub', IN, 500, null], ['x', IN, 10, null]],
  });
  try {
    assert.equal(tokensOf(rollup(db, RANGE, ['r']), 'r'), 10, 'rsub as a spawn node adds nothing; x is counted once under r');
  } finally { db.close(); }
});

test('the same id twice is walked once', () => {
  const db = build({ sessions: [['r', 'claude'], ['c1', 'claude']], spawns: [['c1', 'r']], rows: [['c1', IN, 10, null]] });
  try {
    assert.equal(tokensOf(rollup(db, RANGE, ['r', 'r', 'r']), 'r'), 10);
    assert.equal(q.sessionsRollup(RANGE, ['r', 'r']).params.filter(p => p === 'r').length, 1);
  } finally { db.close(); }
});

test('the gate: false when no spawn record names the ids (or their subagents) as caller, true when one does', () => {
  const db = build({
    sessions: [['r', 'claude'], ['rsub', 'claude', 'r'], ['x', 'claude'], ['z', 'claude']],
    spawns: [['x', 'rsub']],
    rows: [['x', IN, 1, null]],
  });
  try {
    const ask = (ids) => { const g = q.rollupGate(ids); return db.all(g.sql, g.params)[0].any; };
    assert.equal(ask(['z']), 0);
    assert.equal(ask(['r']), 1, 'a caller that is a subagent of a given id counts');
    assert.equal(ask(['z', 'r']), 1);
    assert.equal(q.rollupGate([]), null);
  } finally { db.close(); }
});

test('the plan starts from the walked sessions and looks metrics up by sessionId (no scan of the range)', () => {
  const db = build({ sessions: [['r', 'claude']], rows: [['r', IN, 1, null]] });
  try {
    db.exec('CREATE INDEX idate ON session_metrics(date)');
    const spec = q.sessionsRollup(RANGE, ['r']);
    const plan = db.all('EXPLAIN QUERY PLAN ' + spec.sql, spec.params).map(r => r.detail).join(' | ');
    assert.ok(/SEARCH m USING (COVERING )?INDEX sqlite_autoindex_session_metrics_1 \(sessionId=\?/.test(plan), plan);
    assert.ok(!/SEARCH m USING INDEX idate/.test(plan), plan);
  } finally { db.close(); }
});

test('a started session without a cost figure gives parts with no money ("—" for the fold), tokens still counted', () => {
  const db = build({ sessions: [['r', 'claude'], ['c1', 'claude']], spawns: [['c1', 'r']], rows: [['c1', IN, 10, null]] });
  try {
    const [row] = rollup(db, RANGE, ['r']);
    assert.equal(row.tokens, 10);
    assert.equal(row.estimatedCostUsd, null);
    assert.equal(row.actualCostUsd, null);
  } finally { db.close(); }
});

test('the roll-up touches no total: no other query reads session_meta, and the own table is unchanged by spawn rows', () => {
  const f = { ...RANGE };
  const plan = q.payloadPlan({ filter: f, sessions: { limit: 50 }, series: { measure: 'tokens', split: 'backend' }, heatmap: { from: f.from, to: f.to } });
  for (const [name, spec] of Object.entries(plan)) assert.ok(!/session_meta/.test(spec.sql), `${name} must not know about spawns`);
  const sessions = [['r', 'claude'], ['c1', 'claude']];
  const rows = [['r', IN, 100, null], ['c1', IN, 10, null]];
  const without = build({ sessions, rows });
  const withSpawn = build({ sessions, rows, spawns: [['c1', 'r']] });
  try {
    const ask = (db) => { const s = q.sessionsTable(RANGE, { limit: 50 }); return db.all(s.sql, s.params).map(r => [r.sessionId, r.tokens]); };
    assert.deepEqual(ask(withSpawn), ask(without));
    const kf = (db) => { const s = q.keyFigures(RANGE); return db.all(s.sql, s.params); };
    assert.deepEqual(kf(withSpawn), kf(without));
  } finally { without.close(); withSpawn.close(); }
});

test('no ids, no rows; ids are bound, never spliced', () => {
  assert.deepEqual(q.sessionsRollup(RANGE, []).params, []);
  const spec = q.sessionsRollup(RANGE, ["x'); DROP TABLE session_meta;--"]);
  assert.ok(!spec.sql.includes('DROP'));
  assert.ok(spec.params.includes("x'); DROP TABLE session_meta;--"));
});
