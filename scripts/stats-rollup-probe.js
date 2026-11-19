'use strict';
// Times the #809 roll-up of the Stats page's Sessions table (spec 48, "As built (T9)") so the figures in the spec can be
// measured again rather than trusted. Two modes, both under the app's runtime (better-sqlite3 is built for Electron):
//
//   ELECTRON_RUN_AS_NODE=1 electron scripts/stats-rollup-probe.js --synthetic
//   ELECTRON_RUN_AS_NODE=1 electron scripts/stats-rollup-probe.js <dataDir>
//
// --synthetic builds in-memory databases (20 000 sessions with ten metrics days and one subagent each; then 1 000 spawn
// rows in a fan-out of 100; then a 4 999-link chain on 5 000 sessions), runs `sessionsRollup` for 501 roots and prints the
// rows, the ms of a warm run and the query plan of the first case. Nothing on disk is touched.
//
// <dataDir> times the own sessions block against the roll-up (50 and 501 roots, first run and median of the rest) on a
// real database, then adds a synthetic spawn tree (40 roots, each with a chain of 5 started sessions) and times it again.
// POINT IT AT A COPY: requiring db.js opens `<dataDir>/switchboard.db` read-write and migrates it, and the spawn tree is
// WRITTEN into it. The app's own data folders are refused. Counts and timings only, no title, project or path.

const path = require('path');
const repo = path.join(__dirname, '..');
const q = require(path.join(repo, 'src', 'db', 'stats-queries.js'));

const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
function time(fn, n = 7) {
  const t = [];
  let out;
  for (let i = 0; i < n; i++) {
    const s = process.hrtime.bigint();
    out = fn();
    t.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  return { first: t[0], med: median(t.slice(1)), out };
}

// --- synthetic ------------------------------------------------------------------------------------------------------------

function synthetic(N, spawn, fanout) {
  const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
  const db = new Database(':memory:');
  // The columns the roll-up reads, with the production keys: the metrics primary key is what the plan must search by.
  db.exec(`CREATE TABLE session_cache (sessionId TEXT PRIMARY KEY, parentSessionId TEXT, backendId TEXT, projectPath TEXT,
      costStatus TEXT, aiTitle TEXT, created TEXT);
    CREATE INDEX ip ON session_cache(parentSessionId); CREATE INDEX ipp ON session_cache(projectPath);
    CREATE TABLE session_meta (sessionId TEXT PRIMARY KEY, name TEXT, spawnedBy TEXT, spawnKind TEXT);
    CREATE TABLE session_metrics (sessionId TEXT NOT NULL, date TEXT NOT NULL, hour INTEGER NOT NULL DEFAULT -1,
      model TEXT NOT NULL DEFAULT '', messageCount INTEGER DEFAULT 0, toolCallCount INTEGER DEFAULT 0,
      inputTokens INTEGER DEFAULT 0, outputTokens INTEGER DEFAULT 0, cacheReadTokens INTEGER DEFAULT 0,
      cacheCreationTokens INTEGER DEFAULT 0, estimatedCostUsd REAL, actualCostUsd REAL,
      PRIMARY KEY (sessionId, date, hour, model));
    CREATE INDEX idate ON session_metrics(date);`);
  const ic = db.prepare('INSERT INTO session_cache (sessionId, parentSessionId, backendId, projectPath) VALUES (?,?,?,?)');
  const im = db.prepare('INSERT INTO session_meta (sessionId, spawnedBy) VALUES (?,?)');
  const ix = db.prepare(`INSERT INTO session_metrics (sessionId, date, hour, model, messageCount, inputTokens, outputTokens,
    estimatedCostUsd) VALUES (?,?,?,?,1,?,0,0.01)`);
  db.transaction(() => {
    for (let i = 0; i < N; i++) {
      ic.run('s' + i, null, 'b', '/p/' + (i % 20));
      for (let d = 0; d < 10; d++) ix.run('s' + i, '2026-06-' + String(1 + d).padStart(2, '0'), 9, 'm', 1000 - (i % 1000));
      ic.run('s' + i + 'sub', 's' + i, 'b', '/p/' + (i % 20));
      ix.run('s' + i + 'sub', '2026-06-03', 9, 'm', 5);
    }
    for (let k = 1; k <= spawn; k++) im.run('s' + k, 's' + Math.floor((k - 1) / fanout));
  })();
  const ids = Array.from({ length: 501 }, (_, i) => 's' + i);
  const spec = q.sessionsRollup({ from: '2026-06-01', to: '2026-06-30' }, ids);
  const st = db.prepare(spec.sql);
  st.all(...spec.params);
  const s = process.hrtime.bigint();
  const rows = st.all(...spec.params);
  const ms = Number(process.hrtime.bigint() - s) / 1e6;
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + spec.sql).all(...spec.params).map((r) => r.detail);
  db.close();
  return { sessions: N, spawnRows: spawn, fanout, rows: rows.length, ms: Number(ms.toFixed(1)), plan };
}

// --- a copy of a real database ---------------------------------------------------------------------------------------------

function onCopy(dataDir) {
  // Refuse the app's own data folders BEFORE db.js opens anything (opening migrates, and the spawn tree is written).
  // Compared on the real path, as scripts/stats-query-probe.js does.
  const fs = require('fs');
  const os = require('os');
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const key = (p) => (process.platform === 'win32' ? real(p).toLowerCase() : real(p));
  for (const own of ['.switchboard', '.switchboard-dev']) {
    if (key(dataDir) === key(path.join(os.homedir(), own))) {
      console.error(`refusing to run against the app's own data folder (${own}): it migrates and writes. Use a copy.`);
      process.exit(2);
    }
  }
  process.env.SWITCHBOARD_DATA_DIR = dataDir;
  const facade = require(path.join(repo, 'src', 'db', 'db.js'));
  const { db } = require(path.join(repo, 'src', 'db', 'connection.js'));

  const span = db.prepare('SELECT MIN(date) d, MAX(date) e FROM session_metrics').get();
  const spawns = db.prepare('SELECT COUNT(*) n FROM session_meta WHERE spawnedBy IS NOT NULL').get().n;
  console.log(`metrics: ${span.d ? 'present' : 'none'}, spawn rows: ${spawns}`);
  const filter = { from: span.d || '2020-01-01', to: span.e || '2030-01-01' };
  for (const limit of [50, 501]) {
    const s = q.sessionsTable(filter, { by: 'tokens', limit });
    const own = time(() => db.prepare(s.sql).all(...s.params));
    const r = q.sessionsRollup(filter, own.out.map((row) => row.sessionId));
    const roll = time(() => db.prepare(r.sql).all(...r.params));
    console.log(`limit ${limit}: own ${own.med.toFixed(1)} ms (first ${own.first.toFixed(1)}), `
      + `roll-up ${roll.med.toFixed(1)} ms (first ${roll.first.toFixed(1)}), rows ${own.out.length}/${roll.out.length}`);
  }

  // A synthetic spawn tree, written into the COPY: 40 roots, each with a chain of five started sessions.
  const ids = db.prepare('SELECT sessionId FROM session_cache WHERE parentSessionId IS NULL ORDER BY rowid LIMIT 400')
    .all().map((row) => row.sessionId);
  const ins = db.prepare('INSERT OR REPLACE INTO session_meta (sessionId, spawnedBy, spawnKind) VALUES (?, ?, ?)');
  let added = 0;
  for (let i = 0; i < 40; i++) {
    for (let d = 1; d <= 5; d++) {
      const child = ids[40 + i * 5 + d - 1];
      const parent = d === 1 ? ids[i] : ids[40 + i * 5 + d - 2];
      if (child && parent) { ins.run(child, parent, 'review'); added++; }
    }
  }
  const s = q.sessionsTable(filter, { by: 'tokens', limit: 501 });
  const roots = ids.slice(0, 40).concat(db.prepare(s.sql).all(...s.params).map((row) => row.sessionId)).slice(0, 501);
  const r2 = q.sessionsRollup(filter, roots);
  const roll = time(() => db.prepare(r2.sql).all(...r2.params));
  console.log(`synthetic spawn rows written: ${added}; roll-up for ${roots.length} roots ${roll.med.toFixed(1)} ms, `
    + `rows ${roll.out.length}`);
  if (facade.closeDb) facade.closeDb();
}

const arg = process.argv[2];
if (arg === '--synthetic') {
  const first = synthetic(20000, 0, 1);
  console.log(JSON.stringify({ ...first, plan: undefined }));
  console.log('plan:', first.plan.join(' | '));
  console.log(JSON.stringify({ ...synthetic(20000, 1000, 100), plan: undefined }));
  console.log(JSON.stringify({ ...synthetic(5000, 4999, 1), plan: undefined }));
} else if (arg) {
  onCopy(arg);
} else {
  console.error('usage: ELECTRON_RUN_AS_NODE=1 electron scripts/stats-rollup-probe.js --synthetic | <dataDir of a copy>');
  process.exit(1);
}
