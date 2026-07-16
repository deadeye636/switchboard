// Does an EXISTING database get re-migrated? (#217's acceptance line.)
//
// Reading db_version afterwards is not enough: on an up-to-date database no migration runs anyway, so the
// number stays 15 whether the runner works or is broken into a no-op. This drives the arithmetic instead:
// it pretends the database is older, runs the real runner, and checks exactly which entries fired.
//
// Run under: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/db-migrate-probe.js <dataDir>
const dataDir = process.argv[2];
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

// 1. An up-to-date database: NOTHING may run, and the version must not move.
out.upToDate = runAt(SCHEMA_VERSION);
// 2. One version behind: exactly the last migration runs.
out.oneBehind = runAt(SCHEMA_VERSION - 1);
// 3. Two behind: exactly the last two, in order.
out.twoBehind = runAt(SCHEMA_VERSION - 2);
// 4. A virgin database: every migration runs, in order.
out.fromZero = runAt(0);

// 5. And the real runner, on an up-to-date database — the actual code path, not a copy of the loop.
const real = runMigrations(new Database(dbPath));
out.realRunnerOnUpToDate = { from: real.from, to: real.to, ranAnything: real.from !== real.to };

console.log(JSON.stringify(out, null, 2));
