'use strict';
// The append-only rule, as a test (#217).
//
// `migrations.length` IS the schema version: it is read from the user's database, the entries from that
// index on are run, and the new length is written back. So the array's order and length are DATA. Insert
// an entry in the middle and every migration after it silently re-numbers — an existing database then
// skips the steps it has already counted and never runs the ones it needs. Edit an entry that shipped and
// you have changed a step that already ran on every user's machine and will never run again.
//
// None of that is catchable by reading the file, and none of it fails loudly: it lands as a corrupted
// database on someone else's machine, the next time the installed app starts. Until #217 this rule was a
// comment. It is testable now only because migrations.js takes `db` as a parameter instead of importing
// it — so it loads under plain `node --test`, without better-sqlite3's Electron ABI and without resolving
// DATA_DIR. Nothing else in db.js can say that, which is why nothing else in db.js has ever had a test.
//
// FINGERPRINTS: one per migration that has shipped, whitespace-normalised.
//   - APPENDING costs nothing — a new entry beyond this list is expected and passes untouched.
//   - INSERTING, REORDERING, DELETING or EDITING a shipped entry changes a fingerprint, and that is red.
// If you appended and want the new one pinned too, add its fingerprint at the END. Never renumber.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { migrations, runMigrations, SCHEMA_VERSION } = require('../src/db/migrations');

const SHIPPED = [
  '5fa8c711247d', // v1  — retired, kept as a no-op in place
  '8f61d02c8c55', // v2  — clears the cache, drops search_fts (sets searchFtsRecreated)
  '5368fc1d53ab', // v3  — aiTitle
  'ec192a6eb32f', // v4
  '4754ab4b7f46', // v5
  'e0386b8b8a1a', // v6
  'a10a99182cdf', // v7
  '75b6c743a559', // v8
  '85fce23f6366', // v9
  'd12a8ecbd6f5', // v10
  'c603c8a81c66', // v11
  'd26f2b5ccbd4', // v12
  'a8bd71745eb6', // v13
  'cc0dc7b32f2c', // v14
  '39d49d2bf6f0', // v15
];

function fingerprint(fn) {
  return crypto.createHash('sha256').update(fn.toString().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
}

test('every shipped migration is untouched and still in its original position', () => {
  assert.ok(migrations.length >= SHIPPED.length,
    `migrations shrank from ${SHIPPED.length} to ${migrations.length}. Deleting an entry renumbers every ` +
    'one after it. Retire a migration by making it a no-op `() => {}` IN PLACE, the way v1 is.');

  const actual = migrations.slice(0, SHIPPED.length).map(fingerprint);
  const drifted = SHIPPED.map((want, i) => (actual[i] === want ? null : i + 1)).filter(Boolean);

  assert.deepEqual(drifted, [],
    `migration(s) v${drifted.join(', v')} are not what shipped.\n\n` +
    'These already ran on every existing database and will never run again, so changing one changes\n' +
    'nothing for anyone who already has it — while a fresh install gets the new behaviour. The two\n' +
    'shapes then differ forever.\n\n' +
    'If you INSERTED one: do not. Every entry after it just renumbered, and an existing database will\n' +
    'skip steps it thinks it has already run. Append to the END instead.\n' +
    'If you deliberately appended and only want to pin the new entry: add its fingerprint to the END of\n' +
    'SHIPPED in this file, changing no other line.');
});

test('the schema version is derived from the array, never written down', () => {
  assert.equal(SCHEMA_VERSION, migrations.length,
    'SCHEMA_VERSION must BE migrations.length. A literal is a second source of truth, and the one that ' +
    'disagrees is the one that writes a wrong db_version into a user database.');

  // The equality above is NOT enough on its own, and finding that out cost a mutation: replacing the
  // expression with the literal `15` keeps it green, because 15 === migrations.length today. It only
  // starts lying on the day someone appends — which is the exact day it matters. So check the source.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrations.js'), 'utf8');
  assert.match(src, /SCHEMA_VERSION:\s*migrations\.length/,
    'SCHEMA_VERSION must be exported as `migrations.length` itself');
  assert.doesNotMatch(src, /SCHEMA_VERSION:\s*\d/,
    'SCHEMA_VERSION is a hardcoded number. It agrees with the array today and will silently stop agreeing ' +
    'the next time someone appends a migration — at which point the app writes a db_version that does not ' +
    'match what it actually ran.');
});

test('every migration is a callable taking the db handle', () => {
  const bad = migrations.map((f, i) => (typeof f === 'function' ? null : i + 1)).filter(Boolean);
  assert.deepEqual(bad, [], `migrations v${bad.join(', v')} are not functions; the runner calls each with db`);
});

test('the array is ONE literal in ONE file, not assembled', () => {
  // A concatenation is a renumbering waiting for an import order to change.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrations.js'), 'utf8');
  assert.equal((src.match(/const migrations = \[/g) || []).length, 1,
    'migrations.js must declare exactly one migrations array literal');
  assert.doesNotMatch(src, /migrations\s*=\s*\[[^\]]*\]\s*\.concat|\.\.\.\s*require\(/,
    'the array must not be built from pieces — one array, one place');
  assert.doesNotMatch(src, /migrations\.(push|splice|unshift|shift|pop|sort|reverse)\(/,
    'the array must not be mutated at runtime; append to the literal instead');
});

test('runMigrations does nothing to an already-current database', () => {
  // The acceptance line of #217, without a real database: a fake handle that records every write. The
  // version row says we are current, so not one migration may fire and not one write may happen.
  const writes = [];
  const fakeDb = {
    prepare(sql) {
      return {
        get: () => (/db_version/.test(sql) ? { value: JSON.stringify(SCHEMA_VERSION) } : undefined),
        run: (...args) => { writes.push([sql, ...args]); },
      };
    },
    exec: (sql) => { writes.push([sql]); },
  };

  const res = runMigrations(fakeDb);

  assert.equal(res.from, SCHEMA_VERSION, 'it must read the version the database already carries');
  assert.equal(res.to, SCHEMA_VERSION, 'and report the same one back');
  assert.deepEqual(writes, [],
    'an up-to-date database was written to. The version row must not be touched when nothing ran — ' +
    `got: ${JSON.stringify(writes)}`);
});

test('runMigrations runs only the entries a stale database has not seen, and writes the new version', () => {
  const fired = [];
  const original = migrations.slice();
  // Swap in spies IN PLACE so the runner's own closure over `migrations` sees them, then restore.
  try {
    for (let i = 0; i < migrations.length; i++) migrations[i] = () => fired.push(i);

    const writes = [];
    const fakeDb = {
      prepare(sql) {
        return {
          get: () => (/db_version/.test(sql) ? { value: JSON.stringify(SCHEMA_VERSION - 2) } : undefined),
          run: (...args) => { writes.push(args[0]); },
        };
      },
      exec: () => {},
    };

    const res = runMigrations(fakeDb);

    assert.deepEqual(fired, [SCHEMA_VERSION - 2, SCHEMA_VERSION - 1],
      'exactly the unseen entries must run, in order');
    assert.equal(res.from, SCHEMA_VERSION - 2);
    assert.equal(res.to, SCHEMA_VERSION);
    assert.deepEqual(writes, [JSON.stringify(SCHEMA_VERSION)],
      'the new version must be written back exactly once, as the array length');
  } finally {
    for (let i = 0; i < original.length; i++) migrations[i] = original[i];
  }
});
