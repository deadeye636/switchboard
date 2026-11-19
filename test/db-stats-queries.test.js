'use strict';
// #877 (spec 48, plan step T2) — the shared predicate and the queries of the redesigned Stats page.
//
// Same method as the retired stats-queries test: the REAL SQL against a real in-memory SQLite, with the part of the real
// schema these queries touch. The old queries have their tests there; these take a filter OBJECT
// ({from, to, backend, projects, model}) and are the part of the page nothing else can check.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const q = require('../src/db/stats-queries');

function openMemory() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    return { exec: (sql) => db.exec(sql), all: (sql, params) => db.prepare(sql).all(...params), close: () => db.close() };
  } catch { /* fall through to node:sqlite, as that test did */ }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  return { exec: (sql) => db.exec(sql), all: (sql, params) => db.prepare(sql).all(...params), close: () => db.close() };
}

const SCHEMA = `
CREATE TABLE session_cache (
  sessionId TEXT PRIMARY KEY,
  parentSessionId TEXT,
  backendId TEXT,
  projectPath TEXT,
  costStatus TEXT,
  aiTitle TEXT,
  created TEXT
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

const ALPHA = '/p/alpha';
const ALPHA_WT = '/p/alpha-wt';
const BETA = '/p/beta';

// 2026-06-01 is a Monday. The range under test is 2026-06-02..2026-06-09 (8 days), the previous period
// 2026-05-25..2026-06-01.
const RANGE = { from: '2026-06-02', to: '2026-06-09' };
const PREV_FROM = '2026-05-25';

function seed() {
  const db = openMemory();
  db.exec(SCHEMA);
  db.exec(`
    INSERT INTO session_cache (sessionId, parentSessionId, backendId, projectPath, costStatus, aiTitle, created) VALUES
      ('p1', NULL, 'claude', '${ALPHA}',    NULL,      'Alpha work', '2026-06-02T09:00:00Z'),
      ('s1', 'p1', 'claude', '${ALPHA}',    NULL,      NULL,         '2026-06-02T09:30:00Z'),
      ('w1', NULL, 'claude', '${ALPHA_WT}', 'estimated', 'Worktree',  '2026-06-03T10:00:00Z'),
      ('b1', NULL, 'claude', '${BETA}',     'actual',  'Beta work',  '2026-06-08T11:00:00Z'),
      ('x1', NULL, 'codex',  '${ALPHA}',    NULL,      'Codex work', '2026-06-09T12:00:00Z'),
      ('n1', NULL, NULL,     '${BETA}',     NULL,      'Legacy',     '2026-06-01T08:00:00Z');
    INSERT INTO session_metrics
      (sessionId, date, hour, model, messageCount, toolCallCount, inputTokens, outputTokens,
       cacheReadTokens, cacheCreationTokens, estimatedCostUsd, actualCostUsd) VALUES
      ('p1', '2026-06-02',  9, 'opus', 4, 1, 100,  50, 10, 5, NULL, NULL),
      ('s1', '2026-06-02',  9, 'opus', 2, 0,  20,  10,  0, 0, NULL, NULL),
      -- the model-less bucket: messages it could not attribute, never tokens
      ('p1', '2026-06-02',  9, '',     3, 0,   0,   0,  0, 0, NULL, NULL),
      ('w1', '2026-06-03', 10, 'opus', 3, 0,  30,  10,  0, 0, 0.5,  NULL),
      -- an estimate AND a settled figure on one row: the settled one is the spend
      ('b1', '2026-06-08', 11, 'opus', 5, 2, 200, 100, 40, 0, 1.0,  0.8),
      -- a ZERO estimate with no actual: no pricing, not a free day
      ('x1', '2026-06-09', 12, 'gpt',  6, 3, 300, 100,  0, 0, 0,    NULL),
      -- previous period, and on its last day
      ('n1', '2026-06-01',  8, 'opus', 1, 0,  10,   5,  0, 0, NULL, NULL);
  `);
  return db;
}

const run = (db, spec) => db.all(spec.sql, spec.params);
const sum = (rows, f) => rows.reduce((n, r) => n + (f(r) || 0), 0);
const BIG = 500;
const cnt = (db, f, prevFrom = PREV_FROM) => Object.fromEntries(run(db, q.periodCounts(f, { prevFrom })).map(r => [r.cur, r]));

// F1/F2 fixture: ONE parent with a priced subagent that alone used model 'haiku'. Own db so the shared seed stays as is.
function seedSubagent() {
  const db = openMemory();
  db.exec(SCHEMA);
  db.exec(`
    INSERT INTO session_cache (sessionId, parentSessionId, backendId, projectPath, aiTitle) VALUES
      ('par', NULL, 'claude', '${ALPHA}', 'Parent'),
      ('sub', 'par', 'claude', '${ALPHA}', NULL);
    INSERT INTO session_metrics (sessionId, date, hour, model, messageCount, inputTokens, outputTokens, estimatedCostUsd) VALUES
      ('par', '2026-06-02', 9, 'opus',  2, 10, 5, 0.1),
      ('sub', '2026-06-02', 9, 'haiku', 3, 20, 5, 0.2);
  `);
  return db;
}

// --- the shared predicate -------------------------------------------------------------------------

test('buildPredicate: each field adds exactly its own clause and values', () => {
  const none = q.buildPredicate({});
  assert.deepEqual(none, { where: [], params: [] });

  assert.deepEqual(q.buildPredicate({ from: 'a', to: 'b' }).params, ['a', 'b']);
  assert.deepEqual(q.buildPredicate({ from: 'a' }).where, ['m.date >= ?']);
  assert.deepEqual(q.buildPredicate({ to: 'b' }).where, ['m.date <= ?']);
  assert.deepEqual(q.buildPredicate({ backend: ['x', 'y'] }).params, ['x', 'y']);
  // Bound three times: the parents, their subagents, and orphaned subagents on their own path.
  const three = ['/a', '/b', '/c'];
  assert.deepEqual(q.buildPredicate({ projects: three }).params, [...three, ...three, ...three]);
  assert.equal(q.buildPredicate({ projects: three }).where.length, 1, 'still one clause');
  assert.deepEqual(q.buildPredicate({ model: 'opus' }).params, ['opus']);
});

test('buildPredicate: an empty list or a missing value is not a filter', () => {
  const p = q.buildPredicate({ backend: [], projects: null, model: '', from: null });
  assert.deepEqual(p, { where: [], params: [] });
});

test('buildPredicate: `without` drops a field and only that one', () => {
  const f = { from: 'a', to: 'b', backend: ['x'], projects: ['/a'], model: 'm' };
  assert.equal(q.buildPredicate(f, { without: ['projects'] }).params.includes('/a'), false);
  assert.equal(q.buildPredicate(f, { without: ['projects'] }).params.includes('x'), true);
  assert.deepEqual(q.buildPredicate(f, { without: ['range', 'backend', 'projects', 'model'] }).params, []);
});

// --- every block narrows by every field ---------------------------------------------------------------

// What each block sums, so one table can check all of them. `tokens` = input + output over the range.
const BLOCKS = {
  keyFigures: {
    spec: (f) => q.keyFigures(f, { prevFrom: PREV_FROM }),
    total: (rows) => sum(rows.filter(r => r.cur === 1), r => r.inputTokens + r.outputTokens),
  },
  series: { spec: (f) => q.series(f, { measure: 'tokens', split: 'none', bucket: 'day' }), total: (rows) => sum(rows, r => r.value) },
  projects: { spec: (f) => q.projectsTable(f), total: (rows) => sum(rows, r => r.tokens) },
  models: { spec: (f) => q.modelsTable(f), total: (rows) => sum(rows, r => r.inputTokens + r.outputTokens) },
  backends: { spec: (f) => q.backendsTable(f), total: (rows) => sum(rows, r => r.inputTokens + r.outputTokens) },
  sessions: { spec: (f) => q.sessionsTable(f, { limit: BIG }), total: (rows) => sum(rows, r => r.tokens) },
  grid: { spec: (f) => q.rhythmGrid(f), total: (rows) => sum(rows, r => r.tokens) },
};
// expected tokens in the range 06-02..06-09 under each single filter field
const NARROWED = {
  none: { filter: {}, tokens: 920 },
  range: { filter: { from: '2026-06-03' }, tokens: 740 },       // drops the 06-02 rows (p1 150 + s1 30)
  backend: { filter: { backend: ['codex'] }, tokens: 400 },
  projects: { filter: { projects: [ALPHA, ALPHA_WT] }, tokens: 620 }, // the owner and its worktree: p1 150, s1 30, w1 40, x1 400
  model: { filter: { model: 'gpt' }, tokens: 400 },
};

for (const [name, block] of Object.entries(BLOCKS)) {
  test(`${name}: the range, the backend list, the project list and the model each narrow it`, () => {
    const db = seed();
    try {
      for (const [field, { filter, tokens }] of Object.entries(NARROWED)) {
        const got = block.total(run(db, block.spec({ ...RANGE, ...filter })));
        assert.equal(got, tokens, `${name} under ${field}`);
      }
    } finally { db.close(); }
  });
}

test('the heatmap days narrow by every field too (messages)', () => {
  const db = seed();
  try {
    const msgs = (f) => sum(run(db, q.rhythmDays({ ...RANGE, ...f })), r => r.messages);
    assert.equal(msgs({}), 23);
    assert.equal(msgs({ from: '2026-06-03' }), 14);
    assert.equal(msgs({ backend: ['codex'] }), 6);
    assert.equal(msgs({ projects: [ALPHA, ALPHA_WT] }), 18);
    assert.equal(msgs({ model: 'gpt' }), 6);
  } finally { db.close(); }
});

test('the sidebar list narrows by everything except the project filter', () => {
  const db = seed();
  try {
    const f = { ...RANGE, projects: [ALPHA] };
    const rows = run(db, q.sidebarSeries(f, { days: 8 }));
    const byProject = {};
    for (const r of rows) byProject[r.projectPath] = (byProject[r.projectPath] || 0) + r.tokens;
    assert.deepEqual(byProject, { [ALPHA]: 580, [ALPHA_WT]: 40, [BETA]: 300 }, 'a project filter does not hide the other rows');

    const codex = run(db, q.sidebarSeries({ ...RANGE, backend: ['codex'] }, { days: 8 }));
    assert.deepEqual(codex.map(r => r.projectPath), [ALPHA], 'a backend filter does');
    assert.equal(sum(run(db, q.sidebarSeries({ ...RANGE, model: 'gpt' }, { days: 8 })), r => r.tokens), 400);
    assert.equal(sum(run(db, q.sidebarSeries({ ...RANGE, from: '2026-06-03' }, { days: 7 })), r => r.tokens), 740);
  } finally { db.close(); }
});

test('the sidebar buckets stay within the point cap and start at 0', () => {
  const db = seed();
  try {
    const rows = run(db, q.sidebarSeries({ from: '2026-05-01', to: '2026-06-09' }, { days: 40, points: 30 }));
    assert.ok(rows.length > 0);
    assert.ok(rows.every(r => r.bucket >= 0 && r.bucket < 30), 'bucket numbers are within 0..29');
  } finally { db.close(); }
});

// --- key figures and the previous period ----------------------------------------------------------------

test('key figures: the previous period comes from the same pass, flagged by cur', () => {
  const db = seed();
  try {
    const rows = run(db, q.keyFigures(RANGE, { prevFrom: PREV_FROM }));
    const cur = rows.filter(r => r.cur === 1);
    const prev = rows.filter(r => r.cur === 0);
    assert.equal(sum(cur, r => r.messages), 23);
    assert.equal(sum(prev, r => r.messages), 1, 'the legacy session on 06-01, the last day of the previous period');
    assert.equal(sum(prev, r => r.inputTokens + r.outputTokens), 15);
    assert.equal(sum(cur, r => r.cacheReadTokens), 50);
    assert.equal(sum(cur, r => r.cacheCreationTokens), 5);
    assert.equal(sum(cur, r => r.toolCalls), 6);
  } finally { db.close(); }
});

test('key figures: no previous period means every row is the current one', () => {
  const db = seed();
  try {
    const rows = run(db, q.keyFigures({ to: '2026-06-09' }, { prevFrom: null }));
    assert.ok(rows.every(r => r.cur === 1));
    assert.equal(sum(rows, r => r.messages), 24, 'the 06-01 row is inside "all" and counts');
  } finally { db.close(); }
});

test('key figures: a day just before the previous period is in neither', () => {
  const db = seed();
  try {
    db.exec(`INSERT INTO session_metrics (sessionId, date, hour, model, messageCount, inputTokens)
             VALUES ('n1', '2026-05-24', 8, 'opus', 100, 999)`);
    const rows = run(db, q.keyFigures(RANGE, { prevFrom: PREV_FROM }));
    assert.equal(sum(rows, r => r.messages), 24, '23 + 1; the 05-24 row is outside [prevFrom, to]');
  } finally { db.close(); }
});

test('key figures: sessions are distinct PARENTS, a subagent adds none', () => {
  const db = seed();
  try {
    const rows = run(db, q.keyFigures(RANGE, { prevFrom: PREV_FROM })).filter(r => r.cur === 1);
    assert.equal(cnt(db, RANGE)[1].sessions, 4, 'p1, w1, b1, x1 — not s1');
    assert.equal(sum(rows, r => r.messages), 23, 'but the subagent\'s messages count');
  } finally { db.close(); }
});

test('a legacy NULL backendId is Claude: grouped as claude and found by a Claude filter', () => {
  const db = seed();
  try {
    const prev = run(db, q.keyFigures(RANGE, { prevFrom: PREV_FROM })).filter(r => r.cur === 0);
    assert.deepEqual(prev.map(r => r.backendId), ['claude']);
    const claude = run(db, q.keyFigures({ ...RANGE, backend: ['claude'] }, { prevFrom: PREV_FROM }));
    assert.equal(sum(claude.filter(r => r.cur === 0), r => r.messages), 1);
  } finally { db.close(); }
});

test('key figures: cost counts only rows with a figure, the settled one wins, the two never overlap', () => {
  const db = seed();
  try {
    const cur = run(db, q.keyFigures(RANGE, { prevFrom: PREV_FROM })).filter(r => r.cur === 1);
    assert.equal(sum(cur, r => r.estimatedCostUsd), 0.5, 'only w1: b1 has an actual, x1 is a zero estimate');
    assert.equal(sum(cur, r => r.actualCostUsd), 0.8);
    assert.equal(cnt(db, RANGE)[1].costSessions, 2, 'w1 and b1; x1 (zero estimate) and the unpriced ones are not "with a cost"');
    const statuses = cur.map(r => r.costStatus).sort((a, b) => String(a).localeCompare(String(b)));
    assert.deepEqual(statuses, ['actual', 'estimated', null, null], 'p1 and x1 carry no status, one group each');
  } finally { db.close(); }
});

test('active days: distinct days with a message, per period', () => {
  const db = seed();
  try {
    const rows = run(db, q.periodCounts(RANGE, { prevFrom: PREV_FROM }));
    assert.equal(rows.find(r => r.cur === 1).activeDays, 4, '06-02, 06-03, 06-08, 06-09');
    assert.equal(rows.find(r => r.cur === 0).activeDays, 1);
  } finally { db.close(); }
});

test('a priced parent plus a priced subagent is ONE session and ONE session with a cost', () => {
  const db = seedSubagent();
  try {
    const c = cnt(db, RANGE, null)[1];
    assert.equal(c.sessions, 1);
    assert.equal(c.costSessions, 1);
  } finally { db.close(); }
});

test('a parent counts when only its subagent matches the filter, and the tiles agree with the sessions table', () => {
  const db = seedSubagent();
  try {
    const f = { ...RANGE, model: 'haiku' };
    assert.equal(cnt(db, f, null)[1].sessions, 1);
    assert.equal(sum(run(db, q.modelsTable(f)), r => r.sessions), 1);
    assert.equal(sum(run(db, q.series(f, { measure: 'sessions', split: 'none', bucket: 'day' })), r => r.value), 1);
    assert.equal(sum(run(db, q.projectsTable(f)), r => r.sessions), 1);
    assert.equal(sum(run(db, q.backendsTable(f)), r => r.sessions), 1);
    assert.deepEqual(run(db, q.sessionsTable(f, {})).map(r => r.sessionId), ['par']);
  } finally { db.close(); }
});

// A few stored subagent rows carry another projectPath than their parent. The project is the PARENT's everywhere.
function seedStraySubagent() {
  const db = seedSubagent();
  db.exec(`UPDATE session_cache SET projectPath = '${BETA}' WHERE sessionId = 'sub'`);
  return db;
}

test('a subagent stored under another projectPath counts under its PARENT project', () => {
  const db = seedStraySubagent();
  try {
    const byPath = Object.fromEntries(run(db, q.projectsTable(RANGE)).map(r => [r.projectPath, r]));
    assert.deepEqual(Object.keys(byPath), [ALPHA], 'no second project row for the stray subagent');
    assert.equal(byPath[ALPHA].sessions, 1);
    assert.equal(byPath[ALPHA].tokens, 40, 'parent 15 + subagent 25');

    const split = run(db, q.series(RANGE, { measure: 'tokens', split: 'project', bucket: 'day' }));
    assert.deepEqual(split.map(r => [r.key, r.value]), [[ALPHA, 40]]);

    const side = run(db, q.sidebarSeries(RANGE, { days: 8 }));
    assert.deepEqual(side.map(r => [r.projectPath, r.tokens]), [[ALPHA, 40]]);
  } finally { db.close(); }
});

test('the project filter on the parent path includes the stray subagent, the filter on its own path does not', () => {
  const db = seedStraySubagent();
  try {
    const tokens = (projects) => sum(run(db, q.projectsTable({ ...RANGE, projects })), r => r.tokens);
    assert.equal(tokens([ALPHA]), 40);
    assert.equal(tokens([BETA]), 0, 'the stray row own path matches nothing');
    assert.equal(cnt(db, { ...RANGE, projects: [ALPHA] }, null)[1].sessions, 1);
    assert.equal(cnt(db, { ...RANGE, projects: [BETA] }, null)[1], undefined);
  } finally { db.close(); }
});

test('an orphaned subagent (parent row gone) groups AND filters on its own path, so the row total is reproducible', () => {
  const db = seedStraySubagent();
  try {
    db.exec(`DELETE FROM session_cache WHERE sessionId = 'par'`);
    const byPath = Object.fromEntries(run(db, q.projectsTable(RANGE)).map(r => [r.projectPath, r]));
    assert.equal(byPath[BETA].tokens, 25, 'the orphan shows under its own path');
    assert.equal(sum(run(db, q.projectsTable({ ...RANGE, projects: [BETA] })), r => r.tokens), 25,
      'filtering on that path keeps it, rather than dropping it silently');
    assert.equal(sum(run(db, q.projectsTable({ ...RANGE, projects: [ALPHA] })), r => r.tokens), 0);
  } finally { db.close(); }
});

test('a parent with a NULL path keeps its subagent under NULL, never under the subagent own path', () => {
  const db = seedStraySubagent();
  try {
    db.exec(`UPDATE session_cache SET projectPath = NULL WHERE sessionId = 'par'`);
    const rows = run(db, q.projectsTable(RANGE));
    assert.deepEqual(rows.map(r => [r.projectPath, r.sessions]), [[null, 1]], 'one parent, one row');
    assert.equal(sum(run(db, q.projectsTable({ ...RANGE, projects: [BETA] })), r => r.tokens), 0,
      'the subagent own path does not pull the parent in');
  } finally { db.close(); }
});

test('a parent whose priced subagent has ANOTHER costStatus counts once, not once per status group', () => {
  const db = seedSubagent();
  try {
    db.exec("UPDATE session_cache SET costStatus = 'actual' WHERE sessionId = 'sub'; UPDATE session_cache SET costStatus = 'estimated' WHERE sessionId = 'par'");
    db.exec("UPDATE session_metrics SET estimatedCostUsd = 0.3 WHERE sessionId = 'par'");
    const groups = run(db, q.keyFigures(RANGE, { prevFrom: null }));
    assert.equal(groups.length, 2, 'two (backend, status) groups: the parent falls into both');
    const c = cnt(db, RANGE, null)[1];
    assert.equal(c.sessions, 1);
    assert.equal(c.costSessions, 1);
  } finally { db.close(); }
});

test('periodCounts, activeDays and both facets narrow by every field they should', () => {
  const db = seed();
  try {
    const days = (f) => cnt(db, { ...RANGE, ...f }, null)[1].activeDays;
    assert.equal(days({}), 4);
    assert.equal(days({ from: '2026-06-09' }), 1);
    assert.equal(days({ backend: ['codex'] }), 1);
    assert.equal(days({ projects: [BETA] }), 1);
    assert.equal(days({ model: 'gpt' }), 1);

    const models = (f) => run(db, q.facetModels({ ...RANGE, ...f })).map(r => r.model).sort();
    assert.deepEqual(models({}), ['gpt', 'opus']);
    assert.deepEqual(models({ from: '2026-06-09' }), ['gpt'], 'range');
    assert.deepEqual(models({ backend: ['codex'] }), ['gpt'], 'backend');
    assert.deepEqual(models({ projects: [BETA] }), ['opus'], 'projects');
    assert.deepEqual(models({ model: 'gpt' }), ['gpt', 'opus'], 'its own field is left out');

    const backends = (f) => run(db, q.facetBackends({ ...RANGE, ...f })).map(r => r.backendId).sort();
    assert.deepEqual(backends({}), ['claude', 'codex']);
    assert.deepEqual(backends({ from: '2026-06-09' }), ['codex'], 'range');
    assert.deepEqual(backends({ projects: [BETA] }), ['claude'], 'projects');
    assert.deepEqual(backends({ model: 'gpt' }), ['codex'], 'model');
    assert.deepEqual(backends({ backend: ['codex'] }), ['claude', 'codex'], 'its own field is left out');
  } finally { db.close(); }
});

test('payloadPlan needs a resolved range and derives the bucket from it', () => {
  assert.throws(() => q.payloadPlan({ filter: { from: '2026-06-02' } }), /resolved range/);
  assert.throws(() => q.payloadPlan({ filter: { from: '2026-06-02', to: 'x' } }), /resolved range/);
  assert.throws(() => q.payloadPlan({ filter: { from: '2026-06-09', to: '2026-06-02' } }), /before/);
  const wk = q.payloadPlan({ filter: { from: '2026-01-01', to: '2026-12-31' } });
  assert.ok(wk.series.sql.includes('strftime'), '365 days -> weeks');
  const day = q.payloadPlan({ filter: RANGE });
  assert.ok(!day.series.sql.includes('strftime'), '8 days -> days');
  assert.throws(() => q.sidebarSeries(RANGE, {}), /days/);
  assert.throws(() => q.series(RANGE, { measure: 'tokens' }), /bucket/);
});

// --- the series -----------------------------------------------------------------------------------------

test('series: tokens by backend per day, the legacy row under claude', () => {
  const db = seed();
  try {
    const rows = run(db, q.series({ ...RANGE, from: '2026-05-25' }, { measure: 'tokens', split: 'backend', bucket: 'day' }));
    const at = (bucket, key) => (rows.find(r => r.bucket === bucket && r.key === key) || {}).value;
    assert.equal(at('2026-06-02', 'claude'), 180);
    assert.equal(at('2026-06-01', 'claude'), 15);
    assert.equal(at('2026-06-09', 'codex'), 400);
  } finally { db.close(); }
});

test('series: sessions are parents only, per bucket', () => {
  const db = seed();
  try {
    const rows = run(db, q.series(RANGE, { measure: 'sessions', split: 'none', bucket: 'day' }));
    assert.equal(rows.find(r => r.bucket === '2026-06-02').value, 1, 'p1 — its subagent is not a second session');
  } finally { db.close(); }
});

test('series: cost leaves unpriced rows out and prefers the settled figure', () => {
  const db = seed();
  try {
    const rows = run(db, q.series(RANGE, { measure: 'cost', split: 'none', bucket: 'day' }));
    assert.deepEqual(rows.map(r => r.bucket).sort(), ['2026-06-03', '2026-06-08'],
      'no bucket for the unpriced day or for the zero estimate');
    assert.equal(rows.find(r => r.bucket === '2026-06-08').value, 0.8, 'the actual, not estimate + actual');
    assert.equal(rows.find(r => r.bucket === '2026-06-03').value, 0.5);
  } finally { db.close(); }
});

test('series: the model-less bucket is out of a model split but still counts in messages elsewhere', () => {
  const db = seed();
  try {
    const split = run(db, q.series(RANGE, { measure: 'messages', split: 'model', bucket: 'day' }));
    assert.equal(split.some(r => r.key === ''), false);
    assert.equal(sum(split, r => r.value), 20, '23 minus the 3 model-less messages');
    const flat = run(db, q.series(RANGE, { measure: 'messages', split: 'none', bucket: 'day' }));
    assert.equal(sum(flat, r => r.value), 23);
  } finally { db.close(); }
});

test('series: a project split keys on the raw path, folding is the caller\'s', () => {
  const db = seed();
  try {
    const rows = run(db, q.series(RANGE, { measure: 'tokens', split: 'project', bucket: 'day' }));
    assert.deepEqual([...new Set(rows.map(r => r.key))].sort(), [ALPHA, ALPHA_WT, BETA].sort());
  } finally { db.close(); }
});

test('series: weeks start on Monday and a Sunday belongs to the week before it', () => {
  const db = openMemory();
  try {
    db.exec(SCHEMA);
    db.exec(`INSERT INTO session_cache (sessionId, backendId) VALUES ('a', 'claude')`);
    // 2026-06-01 Mon .. 2026-06-07 Sun, then 2026-06-08 Mon
    for (const d of ['2026-06-01', '2026-06-03', '2026-06-07', '2026-06-08']) {
      db.exec(`INSERT INTO session_metrics (sessionId, date, hour, model, inputTokens) VALUES ('a', '${d}', 1, 'm', 10)`);
    }
    const rows = run(db, q.series({}, { measure: 'tokens', split: 'none', bucket: 'week' }));
    const byWeek = Object.fromEntries(rows.map(r => [r.bucket, r.value]));
    assert.deepEqual(byWeek, { '2026-06-01': 30, '2026-06-08': 10 });
    const months = run(db, q.series({}, { measure: 'tokens', split: 'none', bucket: 'month' }));
    assert.deepEqual(months.map(r => r.bucket), ['2026-06']);
  } finally { db.close(); }
});

test('series: the bucket kind keeps a chart at about 100 bars or fewer', () => {
  assert.equal(q.bucketKindFor(7), 'day');
  assert.equal(q.bucketKindFor(90), 'day');
  assert.equal(q.bucketKindFor(91), 'week');
  assert.equal(q.bucketKindFor(365), 'week');
  assert.equal(q.bucketKindFor(1500), 'month');

  const db = openMemory();
  try {
    db.exec(SCHEMA);
    db.exec(`INSERT INTO session_cache (sessionId, backendId) VALUES ('a', 'claude')`);
    // 5 years of days, one row each
    db.exec(`WITH RECURSIVE d(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM d WHERE n < 1824)
             INSERT INTO session_metrics (sessionId, date, hour, model, inputTokens)
             SELECT 'a', date('2021-01-01', '+' || n || ' days'), 1, 'm', 1 FROM d`);
    const all = run(db, q.series({}, { split: 'none', bucket: q.bucketKindFor(1825) }));
    assert.ok(all.length <= 100, `all time: ${all.length}`);
    const year = run(db, q.series({ from: '2025-12-31', to: '2026-12-30' }, { split: 'none', bucket: q.bucketKindFor(365) }));
    assert.ok(year.length <= 100, `year: ${year.length}`);
    const quarter = run(db, q.series({ from: '2025-10-01', to: '2025-12-29' }, { split: 'none', bucket: q.bucketKindFor(90) }));
    assert.ok(quarter.length <= 100, `90 days: ${quarter.length}`);
  } finally { db.close(); }
});

test('series: an unknown measure, split or bucket is an error, never a guess', () => {
  assert.throws(() => q.series({}, { measure: 'nope', bucket: 'day' }), /unknown stats measure/);
  assert.throws(() => q.series({}, { split: 'nope', bucket: 'day' }), /unknown stats split/);
  assert.throws(() => q.series({}, { bucket: 'nope' }), /unknown stats bucket/);
  assert.throws(() => q.sessionsTable({}, { by: 'nope' }), /unknown stats sort measure/);
});

// --- tables ---------------------------------------------------------------------------------------------

// Rows are one per key AND cost group: the caller sums a key's rows (null stays null when every part is null).
function sumBy(rows, key, fields) {
  const out = {};
  for (const r of rows) {
    const e = out[r[key]] || (out[r[key]] = Object.fromEntries(fields.map(f => [f, null])));
    for (const f of fields) if (r[f] != null) e[f] = (e[f] || 0) + r[f];
  }
  return out;
}

test('cost parts: every table row names the backend and status its cost is settled under', () => {
  const db = seed();
  try {
    const proj = run(db, q.projectsTable(RANGE)).filter(r => r.projectPath === BETA);
    assert.deepEqual(proj.map(r => [r.costBackendId, r.costStatus, r.estimatedCostUsd, r.actualCostUsd]), [['claude', 'actual', null, 0.8]]);
    const wt = run(db, q.projectsTable(RANGE)).find(r => r.projectPath === ALPHA_WT);
    assert.deepEqual([wt.costBackendId, wt.costStatus, wt.estimatedCostUsd, wt.actualCostUsd], ['claude', 'estimated', 0.5, null]);
    const models = run(db, q.modelsTable(RANGE)).filter(r => r.model === 'opus');
    assert.equal(models.length >= 2, true, 'one row per model and cost group');
    // a subagent rides with its parent for cost: one group, one session
    const ses = run(db, q.sessionsTable(RANGE, { by: 'tokens', limit: 50 })).find(r => r.sessionId === 'b1');
    assert.deepEqual([ses.backendId, ses.costStatus, ses.estimatedCostUsd, ses.actualCostUsd], ['claude', 'actual', null, 0.8]);
    const cost = run(db, q.series(RANGE, { measure: 'cost', split: 'none', bucket: 'day' }));
    assert.deepEqual(cost.map(r => [r.bucket, r.costBackendId, r.costStatus]).sort(),
      [['2026-06-03', 'claude', 'estimated'], ['2026-06-08', 'claude', 'actual']]);
  } finally { db.close(); }
});

test('sessions: a NULL backendId is the legacy default, as in every other block', () => {
  const db = seed();
  try {
    const n1 = run(db, q.sessionsTable({}, { limit: 50 })).find(r => r.sessionId === 'n1');
    if (n1) assert.equal(n1.backendId, 'claude');
  } finally { db.close(); }
});

test('projects: raw paths, a worktree is its own row for the caller to fold', () => {
  const db = seed();
  try {
    const rows = run(db, q.projectsTable(RANGE));
    const byPath = sumBy(rows, 'projectPath', ['sessions', 'tokens', 'estimatedCostUsd', 'actualCostUsd']);
    assert.equal(byPath[ALPHA].sessions, 2, 'p1 and x1, not the subagent');
    assert.equal(byPath[ALPHA].tokens, 580);
    assert.equal(byPath[ALPHA_WT].tokens, 40);
    assert.equal(byPath[BETA].actualCostUsd, 0.8);
    assert.equal(byPath[BETA].estimatedCostUsd, null, 'the estimate under an actual is not a second figure');
    assert.equal(byPath[ALPHA].actualCostUsd, null, 'no figure is null, not 0');
    assert.equal(byPath[ALPHA].estimatedCostUsd, null);
    assert.equal(byPath[ALPHA_WT].estimatedCostUsd, 0.5);
  } finally { db.close(); }
});

test('models: the model-less bucket is not a model, cache columns come through', () => {
  const db = seed();
  try {
    const rows = run(db, q.modelsTable(RANGE));
    assert.deepEqual([...new Set(rows.map(r => r.model))].sort(), ['gpt', 'opus']);
    const opus = rows.filter(r => r.model === 'opus').reduce((t, r) => ({ cacheReadTokens: t.cacheReadTokens + r.cacheReadTokens }), { cacheReadTokens: 0 });
    assert.equal(opus.cacheReadTokens, 50);
    assert.equal(sumBy(rows, 'model', ['sessions']).opus.sessions, 3, 'p1, w1, b1');
    const cost = sumBy(rows, 'model', ['estimatedCostUsd', 'actualCostUsd']).opus;
    assert.equal(cost.estimatedCostUsd, 0.5);
    assert.equal(cost.actualCostUsd, 0.8);
  } finally { db.close(); }
});

test('with a model filter the model-less bucket is excluded and so is a session without that model', () => {
  const db = seed();
  try {
    const kf = run(db, q.keyFigures({ ...RANGE, model: 'opus' }, { prevFrom: PREV_FROM })).filter(r => r.cur === 1);
    assert.equal(sum(kf, r => r.messages), 14, '4 + 2 + 3 + 5, not the 3 model-less');
    assert.equal(cnt(db, { ...RANGE, model: 'opus' })[1].sessions, 3, 'x1 has no opus row');
  } finally { db.close(); }
});

test('backends: per stored id and cost status', () => {
  const db = seed();
  try {
    const rows = run(db, q.backendsTable(RANGE));
    const claude = rows.filter(r => r.backendId === 'claude');
    assert.equal(sum(claude, r => r.sessions), 3);
    assert.equal(sum(rows.filter(r => r.backendId === 'codex'), r => r.messages), 6);
    assert.equal(sum(rows, r => r.actualCostUsd), 0.8);
  } finally { db.close(); }
});

test('sessions: one line per parent, subagent rows folded into it, ordered by the measure', () => {
  const db = seed();
  try {
    const rows = run(db, q.sessionsTable(RANGE, { by: 'tokens', limit: 50 }));
    assert.deepEqual(rows.map(r => r.sessionId), ['x1', 'b1', 'p1', 'w1'], 'no s1 line');
    const p1 = rows.find(r => r.sessionId === 'p1');
    assert.equal(p1.tokens, 180, 'p1 150 + its subagent 30');
    assert.equal(p1.messages, 9);
    assert.equal(p1.aiTitle, 'Alpha work');
    assert.equal(p1.projectPath, ALPHA);
    assert.equal(p1.lastModel, 'opus');
    assert.equal(rows.find(r => r.sessionId === 'x1').backendId, 'codex');

    const byCost = run(db, q.sessionsTable(RANGE, { by: 'cost', limit: 50 }));
    assert.deepEqual(byCost.slice(0, 2).map(r => r.sessionId), ['b1', 'w1'], 'the priced ones first');
    assert.equal(byCost[2].cost, null, 'a session with no figure sorts last');
  } finally { db.close(); }
});

test('sessions: the limit is applied to parents', () => {
  const db = seed();
  try {
    assert.equal(run(db, q.sessionsTable(RANGE, { limit: 2 })).length, 2);
  } finally { db.close(); }
});

test('sessions: the limit is clamped at 501 (the export asks for its cap plus one), a smaller one is kept', () => {
  assert.match(q.sessionsTable(RANGE, { limit: 100000 }).sql, /LIMIT 501/);
  assert.match(q.sessionsTable(RANGE, { limit: 501 }).sql, /LIMIT 501/);
  assert.match(q.sessionsTable(RANGE, { limit: 50 }).sql, /LIMIT 50/);
});

test('the grid leaves hour -1 out', () => {
  const db = seed();
  try {
    db.exec(`INSERT INTO session_metrics (sessionId, date, hour, model, messageCount) VALUES ('p1', '2026-06-03', -1, 'opus', 77)`);
    const grid = run(db, q.rhythmGrid(RANGE));
    assert.equal(grid.some(r => r.hour < 0), false);
    assert.equal(run(db, q.rhythmDays(RANGE)).find(r => r.date === '2026-06-03').messages, 80, 'the per-day heatmap keeps it');
  } finally { db.close(); }
});

// --- facets ---------------------------------------------------------------------------------------------

test('facets: the choices under the OTHER filters, a field never narrows its own list', () => {
  const db = seed();
  try {
    assert.deepEqual(run(db, q.facetModels({ ...RANGE, backend: ['codex'] })).map(r => r.model), ['gpt']);
    assert.deepEqual(run(db, q.facetModels({ ...RANGE, model: 'gpt' })).map(r => r.model).sort(), ['gpt', 'opus'],
      'with gpt chosen the model list still offers opus');
    assert.deepEqual(run(db, q.facetBackends({ ...RANGE, projects: [BETA] })).map(r => r.backendId), ['claude']);
    assert.deepEqual(run(db, q.facetBackends({ ...RANGE, backend: ['codex'] })).map(r => r.backendId).sort(), ['claude', 'codex']);
  } finally { db.close(); }
});

// --- the payload ----------------------------------------------------------------------------------------

test('payloadPlan: every statement binds exactly as many values as it has placeholders', () => {
  const plan = q.payloadPlan({
    filter: { ...RANGE, backend: ['claude', 'tpl'], projects: [ALPHA, ALPHA_WT], model: 'opus' },
    prevFrom: PREV_FROM,
    series: { measure: 'cost', split: 'model', bucket: 'week' },
    sessions: { by: 'cost', limit: 10 },
    heatmap: { from: '2025-06-10', to: '2026-06-09' },
  });
  assert.deepEqual(Object.keys(plan).sort(),
    ['backends', 'grid', 'heatmap', 'keyFigures', 'models', 'periodCounts', 'projects', 'series', 'sessions', 'sidebar']);
  for (const [name, spec] of Object.entries(plan)) {
    assert.equal((spec.sql.match(/\?/g) || []).length, spec.params.length, name);
  }
});

test('payloadPlan: every block runs on the real schema, filtered and unfiltered', () => {
  const db = seed();
  try {
    for (const filter of [{}, { ...RANGE, backend: ['claude'], projects: [ALPHA, ALPHA_WT], model: 'opus' }]) {
      const plan = q.payloadPlan({ filter: { from: '2026-05-25', to: '2026-06-09', ...filter }, prevFrom: null });
      for (const [name, spec] of Object.entries(plan)) {
        assert.doesNotThrow(() => run(db, spec), name);
      }
    }
  } finally { db.close(); }
});

test('payloadPlan: the heatmap window overrides the range, the rest keep it', () => {
  const db = seed();
  try {
    const plan = q.payloadPlan({
      filter: { from: '2026-06-09', to: '2026-06-09' },
      heatmap: { from: '2026-05-01', to: '2026-06-09' },
    });
    assert.equal(sum(run(db, plan.heatmap), r => r.messages), 24, 'the whole year window');
    assert.equal(sum(run(db, plan.grid), r => r.messages), 6, 'the grid follows the range');
  } finally { db.close(); }
});

test('an empty database answers every block with no rows and no error', () => {
  const db = openMemory();
  try {
    db.exec(SCHEMA);
    const plan = q.payloadPlan({ filter: { from: '2026-06-02', to: '2026-06-09' }, prevFrom: PREV_FROM });
    for (const [name, spec] of Object.entries(plan)) assert.deepEqual(run(db, spec), [], name);
  } finally { db.close(); }
});

test('usageWindowFigures: exact backend ids, both hour bounds, no hour -1 rows, the parent cost status (#883)', () => {
  const db = openMemory();
  try {
    db.exec(SCHEMA);
    db.exec(`
      INSERT INTO session_cache (sessionId, parentSessionId, backendId, projectPath, costStatus) VALUES
        ('a', NULL, 'claude', '/p/a', 'actual'), ('sub', 'a', 'claude', '/p/a', 'estimated'),
        ('t', NULL, 'my-template', '/p/a', NULL), ('l', NULL, NULL, '/p/b', NULL);
      INSERT INTO session_metrics (sessionId, date, hour, model, inputTokens, outputTokens, estimatedCostUsd, actualCostUsd) VALUES
        ('a', '2026-06-02',  8, 'm', 100, 0, 1, NULL),
        ('a', '2026-06-02', 10, 'm',  10, 5, NULL, 3),
        ('sub', '2026-06-02', 11, 'm', 1, 1, 2, NULL),
        ('a', '2026-06-03',  0, 'm',   1, 1, NULL, NULL),
        ('a', '2026-06-03', -1, 'm', 999, 0, NULL, NULL),
        ('a', '2026-06-09',  4, 'm', 50, 0, NULL, NULL),
        ('a', '2026-06-09',  5, 'm', 50, 0, NULL, NULL),
        ('t', '2026-06-03',  5, 'm', 500, 0, 5, NULL),
        ('l', '2026-06-03',  6, 'm',   7, 0, NULL, NULL);
    `);
    const rows = run(db, q.usageWindowFigures(['claude'], '2026-06-02', 10, '2026-06-09', 5));
    assert.deepEqual(rows.map(r => r.costStatus).sort(), ['actual', null], 'the subagent rides with its parent status; the NULL-backend row has none of its own');
    const g = rows.find(r => r.costStatus === 'actual');
    assert.equal(g.costBackendId, 'claude');
    assert.equal(g.tokens, 15 + 2 + 2 + 50, 'start hour whole; earlier, hour -1, the reset hour, later rows and the template left out');
    assert.equal(g.actualCostUsd, 3);
    assert.equal(g.estimatedCostUsd, 2, 'the subagent estimate is an estimate under the parent status');
    assert.equal(rows.find(r => r.costStatus === null).tokens, 7, 'a NULL backend is claude');
  } finally { db.close(); }
});
