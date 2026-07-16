// backends/sqlite-driver.js — the dual SQLite driver, shared by every SQLite-backed backend (#192).
//
// Two backends read a SQLite store rather than text files: Hermes (one `state.db`) and agy (one `.db`
// per conversation). Both need the same trick, so it lives here once instead of being copied.
//
// `better-sqlite3` is what the app ships and what runs in production — but it is compiled against
// Electron's ABI and CANNOT be loaded by a plain `node --test` process. Node 22 ships `node:sqlite`,
// which can — so the reader falls back to it. That keeps these backends testable in the normal suite
// instead of untested, and makes the reader work even where the native module is unavailable.
//
// The wrapper normalises the two APIs down to what we actually use: prepare().all/get, a pragma read,
// and close. Every connection opened through here is READ-ONLY (and `query_only` on top for
// better-sqlite3): a reader must never block the CLI writing (upstream Hermes issue #2914).
'use strict';

function loadDriver() {
  try {
    const Database = require('better-sqlite3');
    // require() alone proves nothing: better-sqlite3 loads its native binding LAZILY, on first open.
    // Under a plain `node` process that binding is the wrong ABI (it is built for Electron) and only
    // blows up here. Probe it for real, so we can fall through to node:sqlite instead of silently
    // returning "no sessions".
    new Database(':memory:').close();
    return {
      open(file) {
        const db = new Database(file, { readonly: true, fileMustExist: true });
        db.pragma('query_only = 1');   // belt and braces: we can never write, even by mistake
        return {
          all: (sql, ...p) => db.prepare(sql).all(...p),
          get: (sql, ...p) => db.prepare(sql).get(...p),
          pragma: (name) => db.pragma(name, { simple: true }),
          close: () => db.close(),
        };
      },
    };
  } catch { /* fall through */ }

  try {
    const { DatabaseSync } = require('node:sqlite');
    return {
      open(file) {
        const db = new DatabaseSync(file, { readOnly: true });
        return {
          all: (sql, ...p) => db.prepare(sql).all(...p),
          get: (sql, ...p) => db.prepare(sql).get(...p),
          pragma: (name) => {
            const row = db.prepare(`PRAGMA ${name}`).get();
            return row ? Object.values(row)[0] : null;
          },
          close: () => db.close(),
        };
      },
    };
  } catch { /* no driver at all */ }

  return null;
}

// One resolved driver per process — the load probe (opening an in-memory db) is not free, and the
// answer never changes for the life of the process.
let _driver;
function driver() {
  if (_driver === undefined) _driver = loadDriver();
  return _driver;
}

module.exports = { loadDriver, driver };
