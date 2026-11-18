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
// are lazy), once as the sum of first runs and once as the sum of medians.
//
// Limits, so a number is not read as more than it is:
//   - The SQL is the PRODUCTION one (src/db/stats-queries.js, landed in #877 plan step T2); the probe only chooses the
//     filters. `payload.facade` times the whole payload through the real db facade (getStatsPayload).
//   - Only the SQL is timed. Main's work after it is NOT measured: the cap and the "Other" line of the projects table,
//     the top-8 fold with "Other" of the series, the worktree fold of the projects (O7), the backend fold.
//   - The project filter is the RAW `projectPath` of one project, without the O7 worktree fold (owner path plus its
//     worktrees as an `IN` list); a real filter binds more paths. The model filter is the model with the most rows.
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

// Refuse the app's own data folders BEFORE db.js opens anything: opening runs pending migrations, which writes, and
// --e2e writes statsFilter too. Compared on the REAL path, so a junction, a short name or a `\\?\` spelling is caught.
{
  const fs = require('fs');
  const os = require('os');
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const key = (p) => (process.platform === 'win32' ? real(p).toLowerCase() : real(p));
  const target = key(dataDir);
  for (const own of ['.switchboard', '.switchboard-dev']) {
    if (target === key(path.join(os.homedir(), own))) {
      console.error(`refusing to run against the app's own data folder (${own}): opening it migrates and --e2e writes. Use a copy.`);
      process.exit(2);
    }
  }
}

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

const ns2ms = (n) => Number(n) / 1e6;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ---- --e2e: the whole `stats.getStats` call (src/app/stats.js), not only the SQL ----
// Drives the module with a ctx built the way src/main.js builds it: the real db facade, the real backend registry (profiles
// stubbed: they need Electron's userData), the real settings table and the real worktree knowledge, under a fixed clock
// (noon of the newest metrics day, so `7d` has data on an old copy). It WRITES `statsFilter` into <dataDir>, so it refuses
// the app's own data folders: aim it at a copy or an empty directory. Prints counts and milliseconds only.
//
//   ELECTRON_RUN_AS_NODE=1 electron scripts/stats-query-probe.js <dataDir> --e2e [--runs=<n>]
if (args.includes('--e2e')) {
  // The app's own data folders were refused above, before the database opened.
  const stats = require(path.join(repo, 'src', 'app', 'stats.js'));
  const backends = require(path.join(repo, 'src', 'backends'));
  const { isForeignNetworkPath } = require(path.join(repo, 'src', 'app', 'network-path.js'));
  backends.init({ getGlobalSettings: () => dbFacade.getSetting('global') || {}, profiles: { list: () => [] } });
  require(path.join(repo, 'src', 'projects', 'known-worktree.js')).init({
    db: { getKnownWorktrees: dbFacade.getKnownWorktrees, recordKnownWorktree: dbFacade.recordKnownWorktree, forgetKnownWorktree: dbFacade.forgetKnownWorktree },
    log: { info() {}, debug() {}, warn() {}, error() {} },
  });
  const newest = (db.prepare('SELECT MAX(date) AS d FROM session_metrics').get() || {}).d || today;
  const [ny, nm, nd] = newest.split('-').map(Number);
  const knownProjects = () => { const out = []; for (const [p, s] of dbFacade.getProjectStates()) if (!(s && s.removedAt)) out.push(p); return out; };
  // Every ctx call is timed, so a slow call can be split into the database's share and the module's own (`split`).
  const spent = {};
  const timed = (name, fn) => (...a) => {
    const t = process.hrtime.bigint();
    try { return fn(...a); } finally { spent[name] = (spent[name] || 0) + ns2ms(process.hrtime.bigint() - t); }
  };
  const listOf = backends.list;
  const timedBackends = Object.assign(Object.create(backends), { list: timed('backends.list', listOf), rowOwnerOf: backends.rowOwnerOf });
  stats.init({
    getSetting: dbFacade.getSetting, setSetting: dbFacade.setSetting, backends: timedBackends,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    now: () => new Date(ny, nm - 1, nd, 12, 0, 0),
    isForeignNetworkFile: timed('isForeignNetworkFile', (p) => isForeignNetworkPath(p, knownProjects())),
    refreshKnownWorktrees: timed('known-worktree.refresh', (paths, states) => require(path.join(repo, 'src', 'projects', 'known-worktree.js')).refresh(paths, states)),
    db: {
      getStatsPayload: timed('db.getStatsPayload', dbFacade.getStatsPayload), getStatsFacets: dbFacade.getStatsFacets,
      getStatsFirstDate: timed('db.getStatsFirstDate', dbFacade.getStatsFirstDate),
      getStatsProjectPaths: timed('db.getStatsProjectPaths', dbFacade.getStatsProjectPaths),
      getProjectStates: timed('db.getProjectStates', dbFacade.getProjectStates),
      getProjectDisplayNames: timed('db.getProjectDisplayNames', dbFacade.getProjectDisplayNames),
    },
  });
  const t0 = process.hrtime.bigint();
  backends.list();                                   // the registry's first answer probes PATH once; the app has it warm
  const registryWarmMs = ns2ms(process.hrtime.bigint() - t0);
  const topProject = (db.prepare('SELECT projectPath AS p FROM session_cache WHERE parentSessionId IS NULL AND projectPath IS NOT NULL GROUP BY projectPath ORDER BY COUNT(*) DESC LIMIT 1').get() || {}).p || null;
  const topBackend = (db.prepare("SELECT COALESCE(backendId, 'claude') AS b FROM session_cache GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1").get() || {}).b || null;
  const rows = [];
  for (const kind of ['7d', 'year', 'all']) {
    for (const [fname, extra] of [['none', {}], ['project', { project: topProject }], ['backend', { backend: topBackend }]]) {
      if (fname !== 'none' && !extra.project && !extra.backend) continue;
      const filter = { v: 1, range: { kind }, backend: null, project: null, model: null, ...extra };
      let first = null;
      const warm = [];
      let echo = null;
      let split = null;
      let firstSplit = null;
      for (let i = 0; i <= RUNS; i++) {
        for (const k of Object.keys(spent)) delete spent[k];
        const t = process.hrtime.bigint();
        const res = stats.getStats(filter, { measure: 'tokens', split: 'backend' });
        const ms = ns2ms(process.hrtime.bigint() - t);
        if (!res.ok) { console.error(`getStats failed for ${kind}/${fname}: ${res.error}`); process.exit(1); }
        echo = res.filter;
        if (i === 0) first = ms; else warm.push(ms);
        // the split of the last call: the module's own work is the call minus the timed ctx calls
        split = { ...spent, 'module (folds, knowledge)': ms - Object.values(spent).reduce((a, b) => a + b, 0) };
        if (i === 0) firstSplit = split;
      }
      rows.push({ range: kind, filter: fname, kept: fname === 'none' ? true : !!(echo.project || echo.backend), firstMs: first, medianMs: median(warm), split, firstSplit });
    }
  }
  const empty = stats.getStats({ v: 1, range: { kind: 'all' } });
  const result = { today: newest, runs: RUNS, registryWarmMs, emptyOk: empty.ok, rows };
  dbFacade.closeDb();
  if (AS_JSON) console.log(JSON.stringify(result, null, 2));
  else {
    const f1 = (n) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
    console.log(`e2e runs=${RUNS} newest=${newest} registry first list() ${f1(registryWarmMs)} ms, all-time ok=${empty.ok}`);
    for (const r of rows) {
      console.log(`  ${r.range} ${r.filter}${r.kept ? '' : ' (FILTER DROPPED)'}: first ${f1(r.firstMs)} ms, median ${f1(r.medianMs)} ms`);
      console.log('      first call split: ' + Object.entries(r.firstSplit).map(([k, v]) => `${k} ${f1(v)}`).join(', '));
      console.log('      last call split: ' + Object.entries(r.split).map(([k, v]) => `${k} ${f1(v)}`).join(', '));
    }
  }
  process.exit(0);
}

function resolveRange(kind) {
  const to = today;
  if (kind === '7d') return { kind, from: addDays(to, -6), to, days: 7 };
  if (kind === 'year') return { kind, from: addDays(to, -364), to, days: 365 };
  return { kind: 'all', from: firstDate, to, days: daysBetween(firstDate, to) + 1 };
}

// ---- the blocks: the PRODUCTION queries of src/db/stats-queries.js (T2 landed them), fed the probe's filters ----
// Each takes (range, filter) and returns { sql, params }. `filter.project` is a list of raw paths (no worktree fold:
// that is the caller's, see buildPredicate); `filter.backend` is a list of ids.
const queries = require(path.join(repo, 'src', 'db', 'stats-queries.js'));
const shared = (r, f) => ({ from: r.from, to: r.to, backend: f.backend, projects: f.project, model: f.model });
const blocks = {
  'key figures (+prev period)': (r, f) => queries.keyFigures(shared(r, f), { prevFrom: r.kind === 'all' ? null : addDays(r.from, -r.days) }),
  'period counts (+prev period)': (r, f) => queries.periodCounts(shared(r, f), { prevFrom: r.kind === 'all' ? null : addDays(r.from, -r.days) }),
  'projects': (r, f) => queries.projectsTable(shared(r, f)),
  'models': (r, f) => queries.modelsTable(shared(r, f)),
  'backends': (r, f) => queries.backendsTable(shared(r, f)),
  'sessions (top 50 by tokens)': (r, f) => queries.sessionsTable(shared(r, f), { by: 'tokens', limit: 50 }),
  'rhythm: year heatmap': (r, f) => queries.rhythmDays({ ...shared(r, f), from: addDays(r.to, -364) }),
  'rhythm: weekday x hour': (r, f) => queries.rhythmGrid(shared(r, f)),
  'sidebar series (top 50 x <=30 pts)': (r, f) => queries.sidebarSeries(shared(r, f), { days: r.days }),
  'facets: models': (r, f) => queries.facetModels(shared(r, f)),
  'facets: backends': (r, f) => queries.facetBackends(shared(r, f)),
};
// The main series: measure x split. The page runs ONE of these per payload; all sixteen are timed.
for (const measure of ['tokens', 'cost', 'messages', 'sessions']) {
  for (const split of ['none', 'backend', 'model', 'project']) {
    blocks[`series: ${measure} x ${split}`] = (r, f) =>
      queries.series(shared(r, f), { measure, split, bucket: queries.bucketKindFor(r.days) });
  }
}
// The request the page sends in one call (db.getStatsPayload), timed as ONE unit per cell below.
const wholePayload = (r, f) => ({
  filter: shared(r, f), prevFrom: r.kind === 'all' ? null : addDays(r.from, -r.days),
  series: { measure: 'tokens', split: 'backend' },
  sessions: { by: 'tokens', limit: 50 }, heatmap: { from: addDays(r.to, -364), to: r.to },
});


// ---- timing ----

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

const topModel = db.prepare("SELECT model AS v, COUNT(*) AS n FROM session_metrics WHERE model != '' GROUP BY model ORDER BY n DESC LIMIT 1").get();

const FILTERS = {
  'no filter': {},
  'project filter': { project: [topProject ? topProject.v : '__none__'] },
  'backend filter': { backend: [topBackend ? topBackend.v : '__none__'] },
  'model filter': { model: topModel ? topModel.v : '__none__' },
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
};
// What one page open runs (spec 48): the series is the default measure x split; facets are lazy and left out.
const PAYLOAD_BLOCKS = [
  'key figures (+prev period)', 'period counts (+prev period)', 'series: tokens x backend', 'projects', 'models', 'backends',
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
    // The same payload through the real facade (db.getStatsPayload): plan + prepare + run, the unit T4 will call.
    const request = wholePayload(range, filter);
    out.payload[key].facade = timeFn(() => dbFacade.getStatsPayload(request));
  }
}

function timeFn(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  const cold = ns2ms(process.hrtime.bigint() - t0);
  const warm = [];
  for (let i = 0; i < RUNS; i++) { const t = process.hrtime.bigint(); fn(); warm.push(ns2ms(process.hrtime.bigint() - t)); }
  return { cold, median: median(warm) };
}

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
  console.log('\n== PAYLOAD SUM per cell (no facets) [sum of first runs ms / sum of medians ms | whole payload through db.getStatsPayload: first / median] ==');
  for (const [key, p] of Object.entries(out.payload)) console.log(`  ${key}: ${f1(p.firstRunMs)} / ${f1(p.medianMs)} | ${f1(p.facade.cold)} / ${f1(p.facade.median)}`);
}
