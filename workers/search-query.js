'use strict';

// Dedicated read-only search-query worker.
//
// Why a separate worker (not the scan-projects worker)?
// The scan-projects worker is used for cold-start index population and may be
// busy with a long sequential scan when the user types a query. Routing search
// through it would queue the query behind a full project scan, making the UI
// unresponsive for up to tens of seconds. A dedicated read-only worker handles
// queries on its own thread with no contention from index writes.
//
// Protocol (via parentPort):
//   inbound:  { id: string, type: string, query: string, limit: number, titleOnly: boolean }
//   outbound: { id: string, results: Array } on success
//             { id: string, error: string }  on error
//
// The worker opens its own read-only better-sqlite3 connection. SQLite WAL mode
// supports multiple concurrent readers — a reader on this thread never blocks
// writers on the main thread and vice-versa.

const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs');

// DB path is passed from main thread via workerData to respect SWITCHBOARD_DATA_DIR.
const DB_PATH = workerData.dbPath;

// Ensure DB directory exists (belt-and-braces; main process already created it).
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

// Open read-only to avoid any accidental write and to allow this connection to
// coexist without locking the WAL writer on the main thread.
// readonly:true → SQLite OPEN_READONLY flag; throws if the file does not exist.
// If better-sqlite3 fails to load (ABI mismatch) or the DB is unavailable,
// catch below and respond to every incoming query with [] rather than crashing —
// an uncaught throw here would cause the worker to exit, which triggers an
// immediate restart in main.js, creating an infinite tight loop.
let db;
try {
  // require() is inside the try block so a native-module load failure (e.g.
  // ABI mismatch after npm rebuild) is caught rather than thrown at top level.
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH, { readonly: true });
  // WAL coexistence: the main thread's connection sets journal_mode=WAL at startup.
  // A readonly connection in WAL mode never blocks writers and vice-versa.
  // Setting journal_mode on a SQLITE_OPEN_READONLY connection is a no-op, so we
  // rely on the DB-level mode rather than issuing a redundant pragma here.
} catch (err) {
  // DB not yet created or native module unavailable (e.g. ABI mismatch). Exit
  // non-zero so the client's circuit-breaker (backoff, then permanent sync
  // fallback after maxRestarts) engages, instead of staying "online" and
  // answering every query with [] forever — which masks the failure and never
  // lets main fall back to the working synchronous search (issue #76).
  console.error('[search-worker] DB unavailable, exiting so the client falls back to sync search:', err && err.message);
  process.exit(1);
}

// Query length cap + MATCH building shared with db.js searchByType — the cap
// stays applied here too as a belt-and-braces defence in case the main-thread
// truncation is bypassed by future callers (#79 rationale in search-query-util.js).
const { buildFtsMatch } = require('../search-query-util');

const searchQuery = db.prepare(`
  SELECT search_map.id, snippet(search_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
  FROM search_fts
  JOIN search_map ON search_fts.rowid = search_map.rowid
  WHERE search_map.type = ? AND search_fts MATCH ?
  ORDER BY rank
  LIMIT ?
`);

parentPort.on('message', (msg) => {
  const { id, type, query, limit, titleOnly } = msg;
  try {
    const results = searchQuery.all(type, buildFtsMatch(query, titleOnly), limit || 50);
    parentPort.postMessage({ id, results });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
