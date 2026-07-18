// Does an EXISTING database get re-migrated? (#217's acceptance line.)
//
// Reading db_version afterwards is not enough: on an up-to-date database no migration runs anyway, so the
// number stays at the current schema version whether the runner works or is broken into a no-op (no
// literal here on purpose — the array is append-only, so any version written down goes stale on the next
// append, which is how the seed check below came to test the wrong migration). This drives the arithmetic:
// it pretends the database is older, runs the real runner, and checks exactly which entries fired.
//
// Run under: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/db-migrate-probe.js <dataDir>
// No argument used to mean `SWITCHBOARD_DATA_DIR = undefined`, which connection.js reads as "not set" —
// so a forgotten argument pointed this at the REAL ~/.switchboard and rewound a live database's version.
// Its sibling db-probe.js has always refused; this one now does too.
const dataDir = process.argv[2];
if (!dataDir) {
  console.error('usage: ELECTRON_RUN_AS_NODE=1 electron scripts/db-migrate-probe.js <dataDir>');
  console.error('       point it at a COPY of a database — it rewinds db_version and replays migrations.');
  process.exit(2);
}
process.env.SWITCHBOARD_DATA_DIR = dataDir;
const path = require('path');
const repo = path.join(__dirname, '..');
const Database = require('better-sqlite3');

const { migrations, runMigrations, SCHEMA_VERSION } = require(path.join(repo, 'src', 'db', 'migrations.js'));
const dbPath = path.join(dataDir, 'switchboard.db');

const out = { SCHEMA_VERSION, arrayLength: migrations.length };

// Instrument the array: record which indices actually run.
const fired = [];
const instrumented = migrations.map((fn, i) => (db) => { fired.push(i); return fn(db); });

function runAt(version) {
  fired.length = 0;
  const db = new Database(dbPath);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(JSON.stringify(version));
  // Same loop the real runner uses, over the instrumented copy.
  const current = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='db_version'").get().value);
  for (let i = current; i < instrumented.length; i++) instrumented[i](db);
  if (instrumented.length > current) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(JSON.stringify(instrumented.length));
  }
  const after = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='db_version'").get().value);
  db.close();
  return { fired: [...fired], after };
}

// 1. DID THE LAST MIGRATION ACTUALLY DO ANYTHING? "fired" below only proves it was CALLED.
//
// Every migration wraps itself in try/catch, so one that throws reports success and the runner stamps the
// new version anyway — the migration is then marked done forever and can never run again. That is not
// hypothetical: extracting migrations.js dropped its `path`/`os`/`fs` requires, so the #167 register seed
// threw ReferenceError, swallowed it, seeded NOTHING, and stamped db_version 15. Silent, permanent, and
// invisible to every check that only counts calls.
//
// So measure the EFFECT: rewind a real database to just before the SEED and see whether the register
// fills up. It is the seed specifically, not "the last migration": the array is append-only, so anything
// appended after it (#193's lineageKind, #224's projectPath index) moves it away from the end. Rewinding
// by one version therefore stopped testing the seed the moment the next migration landed, and reported
// BROKEN against correct code — which is exactly what it did from #193 until #224 found it. The seed is
// located by what it writes, so appending stays free.
//
// THIS RUNS FIRST, and that is not tidiness. The replays below execute the REAL migrations, and several of
// them (v2/v3/v4) DELETE FROM session_cache — the very rows the seed reads to decide what to register.
// Run this after them and it reports BROKEN against perfectly correct code.
// Needs a database with real rows — on an empty one there is nothing to seed, and that is reported.
const seedIndex = migrations.findIndex(fn => /registered\s*=\s*1/.test(String(fn)));
try {
  const d = new Database(dbPath);
  const projects = d.prepare('SELECT COUNT(*) c FROM project_meta').get().c;
  if (seedIndex < 0) {
    out.seedEffect = 'skipped: no register-seed migration found in the array';
  } else if (!projects) {
    out.seedEffect = 'skipped: no project_meta rows in this database (use a copy of a real one)';
  } else {
    d.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('db_version', ?)").run(JSON.stringify(seedIndex));
    d.prepare('UPDATE project_meta SET registered = NULL, registeredAt = NULL').run();
    const before = d.prepare('SELECT COUNT(*) c FROM project_meta WHERE registered = 1').get().c;
    const res = runMigrations(d);
    const after = d.prepare('SELECT COUNT(*) c FROM project_meta WHERE registered = 1').get().c;
    out.seedEffect = {
      seedMigrationIndex: seedIndex,
      from: res.from, to: res.to, registeredBefore: before, registeredAfter: after,
      verdict: after > before
        ? 'OK — the register seed had a real effect'
        : 'BROKEN — it reported success and did nothing. Look for a swallowed throw inside it.',
    };
  }
  d.close();
} catch (e) { out.seedEffect = `THREW: ${e.message}`; }

// 2. An up-to-date database: NOTHING may run, and the version must not move.
out.upToDate = runAt(SCHEMA_VERSION);
// 3. One version behind: exactly the last migration runs.
out.oneBehind = runAt(SCHEMA_VERSION - 1);
// 4. Two behind: exactly the last two, in order.
out.twoBehind = runAt(SCHEMA_VERSION - 2);
// 5. A virgin database: every migration runs, in order.
out.fromZero = runAt(0);

// 6. And the real runner, on an up-to-date database — the actual code path, not a copy of the loop.
const real = runMigrations(new Database(dbPath));
out.realRunnerOnUpToDate = { from: real.from, to: real.to, ranAnything: real.from !== real.to };

console.log(JSON.stringify(out, null, 2));
