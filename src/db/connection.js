// The database connection — the one place that decides WHICH file we open, and WHEN (#217 step 1).
//
// THE TIMING IS THE CONTRACT. `DATA_DIR` is resolved at MODULE LOAD, which is why `src/main.js` (~L75)
// must set `SWITCHBOARD_DATA_DIR` before it requires db.js. Splitting db.js must not change when that
// happens: `db.js` requires this module first, so `require('../db/db')` resolves the path at exactly the
// moment it always did. Nothing here may be made lazy — a later mutation of the env var is ignored on
// purpose, because a run that switched databases half-way would be far worse than one that picked wrong.
//
// The other half of that contract lives in `test/main-modules-no-db.test.js`: no module under `src/app/`
// or `src/watch/` may top-level-require this file (or db.js), because that would run at main.js's require
// line — before DATA_DIR is set — and a dev build would silently open the INSTALLED app's database.
//
// Everything under `src/db/` takes `db` from here. It is a `const` holding one better-sqlite3 handle:
// the single-writer invariant (#199) means the main thread owns every write, and a second module opening
// its own connection would be a second writer. Import it; never open another.
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

// SWITCHBOARD_DATA_DIR lets dev/agent runs use a separate DB from the
// installed app so they don't race on session_cache. Default stays
// ~/.switchboard so existing installs keep working. Resolve env var at
// require-time (any later mutation would be ignored).
const DATA_DIR = process.env.SWITCHBOARD_DATA_DIR
  ? path.resolve(process.env.SWITCHBOARD_DATA_DIR.replace(/^~(?=$|\/)/, os.homedir()))
  : path.join(os.homedir(), '.switchboard');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'switchboard.db');

// Migrate from old locations if needed
const OLD_LOCATIONS = [
  path.join(os.homedir(), '.claude', 'browser', 'switchboard.db'),
  path.join(os.homedir(), '.claude', 'browser', 'session-browser.db'),
  path.join(os.homedir(), '.claude', 'session-browser.db'),
];
// Skip the legacy ~/.claude/browser/ migration when running with a custom
// DATA_DIR (typical dev/agent setup) — otherwise a fresh dev DB would steal
// the installed app's old data on first launch.
const IS_DEFAULT_DATA_DIR = !process.env.SWITCHBOARD_DATA_DIR;
if (IS_DEFAULT_DATA_DIR && !fs.existsSync(DB_PATH)) {
  for (const oldPath of OLD_LOCATIONS) {
    if (fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, DB_PATH);
      try { fs.renameSync(oldPath + '-wal', DB_PATH + '-wal'); } catch {}
      try { fs.renameSync(oldPath + '-shm', DB_PATH + '-shm'); } catch {}
      break;
    }
  }
}
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
// NORMAL fsyncs only at checkpoints, not every commit — the standard WAL
// pairing; FULL adds no extra integrity in WAL mode but fsyncs every write.
db.pragma('synchronous = NORMAL');
// Bigger page cache + mmap so the hot indexing path (busy multi-agent sessions
// re-index folders on every JSONL append) reads/writes mostly in memory instead
// of hammering the disk. cache_size is negative = KiB (16 MiB); mmap_size in bytes.
db.pragma('cache_size = -16000');
db.pragma('mmap_size = 268435456'); // 256 MiB
// Keep the WAL from ballooning under sustained writes: auto-checkpoint roughly
// every ~8 MiB of WAL (2000 pages) instead of the 4 MiB default, plus a periodic
// PASSIVE checkpoint that reclaims WAL space without ever blocking writers.
db.pragma('wal_autocheckpoint = 2000');
// Only the main process runs the periodic reclaim; a worker thread that opens
// the DB (read-only search connection) must not fire its own checkpoints.
let _isMainThread = true;
try { _isMainThread = require('worker_threads').isMainThread; } catch {}
if (_isMainThread) {
  const _walCheckpointTimer = setInterval(() => {
    try { db.pragma('wal_checkpoint(PASSIVE)'); } catch {}
  }, 60000);
  if (typeof _walCheckpointTimer.unref === 'function') _walCheckpointTimer.unref();
}

function closeDb() {
  // Truncate the WAL back into the main file on clean shutdown. Long-lived
  // reader connections (the scan worker) can starve SQLite's automatic
  // checkpoints, letting the -wal file grow to tens of MB and adding read
  // amplification on the next run.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  try { db.close(); } catch {}
}

module.exports = { db, DB_PATH, DATA_DIR, closeDb };
