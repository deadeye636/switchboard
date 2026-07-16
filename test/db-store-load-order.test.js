'use strict';
// Stores load after the schema (#217).
//
// Every `*-store.js` under src/db prepares its statements at module load, and `db.prepare` fails if the
// table is not there yet. db.js creates the tables (applySchema) and upgrades them (runMigrations) at ITS
// load — so a store required ABOVE those two calls prepares against a database that has no tables.
//
// The failure is invisible where you would look for it. An existing install has had those tables for
// months, so it starts fine; only a FRESH database dies, on the very first launch, with
// `SqliteError: no such table: settings`. This was not hypothetical: it happened while extracting
// settings-store.js, the probe against a real database was byte-identical and green, and only the probe
// against an empty one caught it. That is the first-run experience of a new user, and nothing in the
// suite could see it — nothing loads db.js.
//
// So this reads the order out of the source. It is a grep, and a grep cannot tell you the line does
// anything — but it can tell you the requires are still below the two calls they depend on, which is the
// whole mistake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DB_JS = path.join(__dirname, '..', 'src', 'db', 'db.js');

test('db.js requires every store AFTER applySchema and runMigrations', () => {
  const src = fs.readFileSync(DB_JS, 'utf8');

  const schemaAt = src.search(/^applySchema\(db\);/m);
  const migrateAt = src.search(/^const \{ searchFtsRecreated \} = runMigrations\(db\);/m);
  assert.ok(schemaAt > -1, 'db.js must call applySchema(db) at load');
  assert.ok(migrateAt > -1, 'db.js must call runMigrations(db) at load');
  assert.ok(schemaAt < migrateAt, 'the schema must be created before the migrations run against it');

  const stores = [...src.matchAll(/^const \w+ = require\('\.\/([\w-]*store)'\);/gm)];
  assert.ok(stores.length > 0, 'db.js requires at least one store module');

  const tooEarly = stores.filter(m => m.index < migrateAt).map(m => m[1]);
  assert.deepEqual(tooEarly, [],
    `these stores are required before the tables exist: ${tooEarly.join(', ')}\n\n` +
    'They prepare their statements at module load, so on a FRESH database this throws\n' +
    '"SqliteError: no such table: ..." on first launch — while every existing install starts fine,\n' +
    'because its tables have been there for months.\n' +
    'Move the require BELOW `const { searchFtsRecreated } = runMigrations(db);` in src/db/db.js.');
});

test('every db store prepares against the shared connection, never its own', () => {
  // The single-writer invariant: one parser (the worker), one writer (main). A store that opened its own
  // handle would be a second writer, and SQLITE_BUSY is what that looks like in the wild.
  const dir = path.join(__dirname, '..', 'src', 'db');
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('-store.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/new Database\(/.test(src)) offenders.push(f);
    if (!/require\('\.\/connection'\)/.test(src) && /\bdb\./.test(src)) {
      offenders.push(`${f} (uses db without taking it from ./connection)`);
    }
  }
  assert.deepEqual(offenders, [],
    'a store must take the handle from ./connection — opening another is a second writer:\n  ' +
    offenders.join('\n  '));
});
