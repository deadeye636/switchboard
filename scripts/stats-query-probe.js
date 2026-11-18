// Times the PLANNED Stats-page block queries (spec 48, "Aggregates per block") against a real database, so the
// responsiveness question (O4) is answered from a measurement and not from a guess (#877, plan step T1).
//
// It runs under the same runtime as the app, because better-sqlite3 is built for Electron's ABI, and it loads the
// REAL db.js (migrations run, so an empty data dir gets the real schema):
//
//   ELECTRON_RUN_AS_NODE=1 electron scripts/stats-query-probe.js <dataDir> [--runs=<n>] [--json]
//
// POINT IT AT A COPY. Requiring db.js opens `<dataDir>/switchboard.db` read-write and may migrate it; copy the
// installed app's switchboard.db (with its -wal and -shm) first, and never aim this at the original. An empty
// <dataDir> is fine: the probe then times the same statements against empty tables.
//
// What it does, per range (`7d`, `year`, `all`) and per filter (none, the project with the most parent sessions, the
// backend with the most sessions): prepares each block's SQL once, runs it `--runs` times (default 7, minimum 3: a
// smaller value is raised to 3), and prints the first run (statement prepare + first execution, "cold" for the
// statement but NOT for the OS page cache, which this cannot flush) and the median of the rest, in ms, plus the rows
// the block returned. Per cell it also prints the PAYLOAD SUM: the blocks one page open runs (key figures, the
// tokens x backend series, projects, models, backends, sessions, both Rhythm grids, sidebar series; no facets, which
// are lazy), once as the sum of first runs and once as the sum of medians. It also times the CURRENT page's queries
// (what `get-stats-from-db` runs) for comparison.
//
// Limits, so a number is not read as more than it is:
//   - The SQL here is a measurement COPY of the planned shape, not the production query. T2 must first point `blocks`
//     at the new `src/db/stats-queries.js` functions (or the db facade) before re-running this against the landed
//     code; run as is, it re-measures this copy and nothing T2 wrote.
//   - Only the SQL is timed. Main's work after it is NOT measured: the cap and the "Other" line of the projects table,
//     the top-8 fold with "Other" of the series, the worktree fold of the projects (O7), the backend fold.
//   - The project filter is the RAW `projectPath` of one project, without the O7 worktree fold (owner path plus its
//     worktrees as an `IN` list); a real filter binds more paths. No model filter is timed.
//   - The sessions block's last model is the session's latest model over all its rows, not narrowed to the range.
//
// Output carries counts and timings only, never a project name, a path or a session id.
'use strict';

const path = require('path');

const args = process.argv.slice(2);
const dataDir = args.find(a => !a.startsWith('--'));
if (!dataDir) {
  console.error('usage: ELECTRON_RUN_AS_NODE=1 electron scripts/stats-query-probe.js <dataDir> [--runs=<n>] [--json]');
  process.exit(2);
}
const flag = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const RUNS = Math.max(3, parseInt(flag('runs', '7'), 10) || 7);
const AS_JSON = args.includes('--json');

process.env.SWITCHBOARD_DATA_DIR = dataDir;
const repo = path.join(__dirname, '..');
const dbFacade = require(path.join(repo, 'src', 'db', 'db.js'));
const { db } = require(path.join(repo, 'src', 'db', 'connection.js'));

// ---- dates: LOCAL day keys, never toISOString (spec 48 "Dates are LOCAL") ----
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (key, n) => {
  const [y, m, d] = key.split('-').map(Number);
  return keyOf(new Date(y, m - 1, d + n));
};
const daysBetween = (a, b) => {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
};

const today = keyOf(new Date());
const firstDate = (db.prepare('SELECT MIN(date) AS d FROM session_metrics').get() || {}).d || today;

function resolveRange(kind) {
  const to = today;
  if (kind === '7d') return { kind, from: addDays(to, -6), to, days: 7 };
  if (kind === 'year') return { kind, from: addDays(to, -364), to, days: 365 };
  return { kind: 'all', from: firstDate, to, days: daysBetween(firstDate, to) + 1 };
}

// ---- the shared predicate (the planned `compose()`): date range, backend list, project list, model ----
const BACKEND = "COALESCE(sc.backendId, 'claude')";
const FROM = 'FROM session_metrics m JOIN session_cache sc ON sc.sessionId = m.sessionId';
const PARENT = 'COUNT(DISTINCT CASE WHEN sc.parentSessionId IS NULL THEN m.sessionId END)';
const COST_OK = '(m.estimatedCostUsd IS NOT NULL OR m.actualCostUsd IS NOT NULL) AND NOT (m.estimatedCostUsd = 0 AND m.actualCostUsd IS NULL)';

// `projectForm`: 'subquery' is the spec's wording (IN list on a session_cache subquery), 'join' reuses the join.
function predicate({ from, to }, filter, projectForm = 'subquery') {
  const where = [];
  const params = [];
  if (from && to) { where.push('m.date BETWEEN ? AND ?'); params.push(from, to); }
  if (filter.backend) { where.push(`${BACKEND} IN (${filter.backend.map(() => '?').join(', ')})`); params.push(...filter.backend); }
  if (filter.project) {
    const marks = filter.project.map(() => '?').join(', ');
    where.push(projectForm === 'join'
      ? `sc.projectPath IN (${marks})`
      : `m.sessionId IN (SELECT sessionId FROM session_cache WHERE projectPath IN (${marks}))`);
    params.push(...filter.project);
  }
  if (filter.model) { where.push('m.model = ?'); params.push(filter.model); }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

function bucketExpr(range) {
  if (range.days <= 90) return 'm.date';
  if (range.kind === 'year') return "date(m.date, '-' || ((CAST(strftime('%w', m.date) AS INTEGER) + 6) % 7) || ' days')";
  return 'substr(m.date, 1, 7)';
}
const MEASURES = {
  tokens: 'SUM(m.inputTokens + m.outputTokens)',
  cost: `SUM(CASE WHEN ${COST_OK} THEN COALESCE(m.estimatedCostUsd, 0) + COALESCE(m.actualCostUsd, 0) END)`,
  messages: 'SUM(m.messageCount)',
  sessions: PARENT,
};
const SPLITS = { none: "''", backend: BACKEND, model: 'm.model', project: 'sc.projectPath' };

// ---- the blocks. Each takes (range, filter) and returns { sql, params } ----
const blocks = {
  'key figures (+prev period)': (r, f, form) => {
    const prevFrom = r.kind === 'all' ? r.from : addDays(r.from, -r.days);
    const p = predicate({ from: prevFrom, to: r.to }, f, form);
    return {
      sql: `SELECT ${BACKEND} AS backendId, sc.costStatus AS costStatus,
                   CASE WHEN m.date >= ? THEN 1 ELSE 0 END AS cur,
                   ${PARENT} AS sessions, SUM(m.messageCount) AS messages, SUM(m.toolCallCount) AS tools,
                   SUM(m.inputTokens) AS inTok, SUM(m.outputTokens) AS outTok,
                   SUM(m.cacheReadTokens) AS cacheRead, SUM(m.cacheCreationTokens) AS cacheWrite,
                   SUM(CASE WHEN ${COST_OK} THEN m.estimatedCostUsd END) AS est,
                   SUM(CASE WHEN ${COST_OK} THEN m.actualCostUsd END) AS act,
                   COUNT(DISTINCT CASE WHEN ${COST_OK} THEN m.sessionId END) AS costSessions,
                   COUNT(DISTINCT CASE WHEN m.messageCount > 0 THEN m.date END) AS activeDays
            ${FROM} ${p.where} GROUP BY 1, 2, 3`,
      params: [r.from, ...p.params],
    };
  },
  'projects': (r, f) => {
    const p = predicate(r, f);
    return {
      sql: `SELECT sc.projectPath AS projectPath, ${PARENT} AS sessions, SUM(m.messageCount) AS messages,
                   SUM(m.inputTokens + m.outputTokens) AS tokens,
                   SUM(CASE WHEN ${COST_OK} THEN COALESCE(m.estimatedCostUsd, 0) + COALESCE(m.actualCostUsd, 0) END) AS cost
            ${FROM} ${p.where} GROUP BY sc.projectPath`,
      params: p.params,
    };
  },
  'models': (r, f) => {
    const p = predicate(r, f);
    const where = p.where ? p.where + " AND m.model != ''" : "WHERE m.model != ''";
    return {
      sql: `SELECT m.model AS model, SUM(m.inputTokens) AS inTok, SUM(m.outputTokens) AS outTok,
                   SUM(m.cacheReadTokens) AS cacheRead,
                   SUM(CASE WHEN ${COST_OK} THEN COALESCE(m.estimatedCostUsd, 0) + COALESCE(m.actualCostUsd, 0) END) AS cost,
                   ${PARENT} AS sessions
            ${FROM} ${where} GROUP BY m.model`,
      params: p.params,
    };
  },
  'backends': (r, f) => {
    const p = predicate(r, f);
    return {
      sql: `SELECT ${BACKEND} AS backendId, sc.costStatus AS costStatus, ${PARENT} AS sessions,
                   SUM(m.messageCount) AS messages, SUM(m.inputTokens) AS inTok, SUM(m.outputTokens) AS outTok,
                   SUM(m.cacheReadTokens) AS cacheRead, SUM(m.cacheCreationTokens) AS cacheWrite,
                   SUM(CASE WHEN ${COST_OK} THEN m.estimatedCostUsd END) AS est,
                   SUM(CASE WHEN ${COST_OK} THEN m.actualCostUsd END) AS act
            ${FROM} ${p.where} GROUP BY 1, 2`,
      params: p.params,
    };
  },
  'sessions (top 50 by tokens)': (r, f) => {
    const p = predicate(r, f);
    return {
      sql: `SELECT g.key, g.messages, g.tokens, g.cost, g.lastDate, s.aiTitle, s.projectPath, s.backendId, s.created,
                   (SELECT m2.model FROM session_metrics m2
                    WHERE m2.model != '' AND m2.sessionId IN
                          (SELECT g.key UNION ALL SELECT c2.sessionId FROM session_cache c2 WHERE c2.parentSessionId = g.key)
                    ORDER BY m2.date DESC, m2.hour DESC LIMIT 1) AS lastModel
            FROM (SELECT COALESCE(sc.parentSessionId, m.sessionId) AS key, SUM(m.messageCount) AS messages,
                         SUM(m.inputTokens + m.outputTokens) AS tokens, MAX(m.date) AS lastDate,
                         SUM(CASE WHEN ${COST_OK} THEN COALESCE(m.estimatedCostUsd, 0) + COALESCE(m.actualCostUsd, 0) END) AS cost
                  ${FROM} ${p.where} GROUP BY 1 ORDER BY tokens DESC LIMIT 50) g
            LEFT JOIN session_cache s ON s.sessionId = g.key`,
      params: p.params,
    };
  },
  'rhythm: year heatmap': (r, f) => {
    const p = predicate({ from: addDays(r.to, -364), to: r.to }, f);
    return {
      sql: `SELECT m.date AS date, SUM(m.messageCount) AS messages ${FROM} ${p.where} GROUP BY m.date`,
      params: p.params,
    };
  },
  'rhythm: weekday x hour': (r, f) => {
    const p = predicate(r, f);
    const where = p.where ? p.where + ' AND m.hour >= 0' : 'WHERE m.hour >= 0';
    return {
      sql: `SELECT CAST(strftime('%w', m.date) AS INTEGER) AS weekday, m.hour AS hour,
                   SUM(m.messageCount) AS messages, SUM(m.inputTokens + m.outputTokens) AS tokens
            ${FROM} ${where} GROUP BY weekday, m.hour`,
      params: p.params,
    };
  },
  'sidebar series (top 50 x <=30 pts)': (r, f) => {
    // The sidebar list is NOT narrowed by the project filter itself (spec "The left sidebar").
    const p = predicate(r, { ...f, project: null });
    const size = Math.max(1, Math.ceil(r.days / 30));
    return {
      sql: `WITH top AS (SELECT sc.projectPath AS projectPath ${FROM} ${p.where}
                         GROUP BY sc.projectPath ORDER BY SUM(m.inputTokens + m.outputTokens) DESC LIMIT 50)
            SELECT sc.projectPath AS projectPath,
                   CAST((julianday(m.date) - julianday(?)) / ? AS INTEGER) AS bucket,
                   SUM(m.inputTokens + m.outputTokens) AS tokens
            ${FROM} ${p.where ? p.where + ' AND' : 'WHERE'} sc.projectPath IN (SELECT projectPath FROM top)
            GROUP BY sc.projectPath, bucket`,
      params: [...p.params, r.from, size, ...p.params],
    };
  },
  'facets: models': (r, f) => {
    const p = predicate(r, { ...f, model: null });
    const where = p.where ? p.where + " AND m.model != ''" : "WHERE m.model != ''";
    return { sql: `SELECT DISTINCT m.model AS model ${FROM} ${where}`, params: p.params };
  },
  'facets: backends': (r, f) => {
    const p = predicate(r, { ...f, backend: null });
    return { sql: `SELECT DISTINCT ${BACKEND} AS backendId ${FROM} ${p.where}`, params: p.params };
  },
};
// The main series: measure x split. The page runs ONE of these per payload; all sixteen are timed.
for (const measure of Object.keys(MEASURES)) {
  for (const split of Object.keys(SPLITS)) {
    blocks[`series: ${measure} x ${split}`] = (r, f) => {
      const p = predicate(r, f);
      const where = split === 'model' ? (p.where ? p.where + " AND m.model != ''" : "WHERE m.model != ''") : p.where;
      return {
        sql: `SELECT ${bucketExpr(r)} AS bucket, ${SPLITS[split]} AS key, ${MEASURES[measure]} AS value
              ${FROM} ${where} GROUP BY 1, 2`,
        params: p.params,
      };
    };
  }
}

// ---- timing ----
const ns2ms = (n) => Number(n) / 1e6;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function timeStatement(build) {
  const { sql, params } = build();
  const t0 = process.hrtime.bigint();
  const stmt = db.prepare(sql);
  let rows = stmt.all(...params);
  const cold = ns2ms(process.hrtime.bigint() - t0);
  const warm = [];
  for (let i = 0; i < RUNS; i++) {
    const t = process.hrtime.bigint();
    rows = stmt.all(...params);
    warm.push(ns2ms(process.hrtime.bigint() - t));
  }
  return { cold, median: median(warm), rows: rows.length };
}

// ---- the filters: the project and the backend with the most sessions (counts only are ever printed) ----
const topProject = db.prepare(
  `SELECT projectPath AS v, COUNT(*) AS n FROM session_cache
   WHERE parentSessionId IS NULL AND projectPath IS NOT NULL GROUP BY projectPath ORDER BY n DESC LIMIT 1`).get();
const topBackend = db.prepare(
  `SELECT COALESCE(backendId, 'claude') AS v, COUNT(*) AS n FROM session_cache
   WHERE parentSessionId IS NULL GROUP BY 1 ORDER BY n DESC LIMIT 1`).get();

const FILTERS = {
  'no filter': {},
  'project filter': { project: [topProject ? topProject.v : '__none__'] },
  'backend filter': { backend: [topBackend ? topBackend.v : '__none__'] },
};

const out = {
  runs: RUNS,
  today,
  counts: {},
  filters: {
    topProjectSessions: topProject ? topProject.n : 0,
    topBackendSessions: topBackend ? topBackend.n : 0,
  },
  timings: {},
  payload: {},
  current: {},
};
// What one page open runs (spec 48): the series is the default measure x split; facets are lazy and left out.
const PAYLOAD_BLOCKS = [
  'key figures (+prev period)', 'series: tokens x backend', 'projects', 'models', 'backends',
  'sessions (top 50 by tokens)', 'rhythm: year heatmap', 'rhythm: weekday x hour', 'sidebar series (top 50 x <=30 pts)',
];
for (const t of ['session_cache', 'session_metrics', 'session_meta']) {
  out.counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
}
out.counts.metricsDistinctDates = db.prepare('SELECT COUNT(DISTINCT date) AS n FROM session_metrics').get().n;
out.counts.metricsFirstDate = firstDate;
out.counts.parentSessions = db.prepare('SELECT COUNT(*) AS n FROM session_cache WHERE parentSessionId IS NULL').get().n;
out.counts.dailyTables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE '%daily%'").get().n;

for (const kind of ['7d', 'year', 'all']) {
  const range = resolveRange(kind);
  for (const [fname, filter] of Object.entries(FILTERS)) {
    const key = `${kind} / ${fname}`;
    out.timings[key] = { days: range.days };
    for (const [bname, build] of Object.entries(blocks)) {
      try { out.timings[key][bname] = timeStatement(() => build(range, filter)); }
      catch (e) { out.timings[key][bname] = { error: e.message }; }
    }
    out.payload[key] = {
      firstRunMs: PAYLOAD_BLOCKS.reduce((a, n) => a + (out.timings[key][n].cold || 0), 0),
      medianMs: PAYLOAD_BLOCKS.reduce((a, n) => a + (out.timings[key][n].median || 0), 0),
    };
    if (filter.project) {
      // The two ways to say "this project's sessions" in the shared predicate.
      for (const form of ['join', 'subquery']) {
        try { out.timings[key][`key figures [project via ${form}]`] = timeStatement(() => blocks['key figures (+prev period)'](range, filter, form)); }
        catch (e) { out.timings[key][`key figures [project via ${form}]`] = { error: e.message }; }
      }
    }
  }
}

// ---- the CURRENT page's queries (what `get-stats-from-db` runs), through the real facade, unfiltered ----
const cur = {
  getDailyMetrics: () => dbFacade.getDailyMetrics(null),
  getTotalCounts: () => dbFacade.getTotalCounts(null),
  getDailyModelTokens: () => dbFacade.getDailyModelTokens(null),
  getDailyBackendTokens: () => dbFacade.getDailyBackendTokens(null),
  getDailyCost: () => dbFacade.getDailyCost(null),
  getHourlyActivity: () => dbFacade.getHourlyActivity(null),
  getModelUsage: () => dbFacade.getModelUsage(null),
};
function timeFn(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  const cold = ns2ms(process.hrtime.bigint() - t0);
  const warm = [];
  for (let i = 0; i < RUNS; i++) { const t = process.hrtime.bigint(); fn(); warm.push(ns2ms(process.hrtime.bigint() - t)); }
  return { cold, median: median(warm) };
}
for (const [name, fn] of Object.entries(cur)) out.current[name] = timeFn(fn);
out.current['whole get-stats-from-db (all seven)'] = timeFn(() => { for (const fn of Object.values(cur)) fn(); });

dbFacade.closeDb();

// ---- print ----
if (AS_JSON) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const f1 = (n) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
  console.log(`runs=${RUNS} today=${today} counts=${JSON.stringify(out.counts)} filters=${JSON.stringify(out.filters)}`);
  for (const [key, blocksOut] of Object.entries(out.timings)) {
    console.log(`\n== ${key} (${blocksOut.days} days) ==  [cold ms / median ms / rows]`);
    for (const [bname, r] of Object.entries(blocksOut)) {
      if (bname === 'days') continue;
      console.log(r.error ? `  ${bname}: ERROR ${r.error}` : `  ${bname}: ${f1(r.cold)} / ${f1(r.median)} / ${r.rows}`);
    }
  }
  console.log('\n== PAYLOAD SUM per cell (no facets) [sum of first runs ms / sum of medians ms] ==');
  for (const [key, p] of Object.entries(out.payload)) console.log(`  ${key}: ${f1(p.firstRunMs)} / ${f1(p.medianMs)}`);
  console.log('\n== current page queries (unfiltered, all time) [cold ms / median ms] ==');
  for (const [name, r] of Object.entries(out.current)) console.log(`  ${name}: ${f1(r.cold)} / ${f1(r.median)}`);
}
