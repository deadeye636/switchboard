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

// INDEXED BY POSITION, not by the `// vN` labels in migrations.js. Those labels are HISTORICAL and they
// do NOT line up: the array jumps v4 -> "v6" and v8 -> "v10", so the file's "v6" is index 4. Only the
// position is real — it is what the version arithmetic counts. Do not "reconcile" the two: renumbering a
// label is harmless, renumbering an ENTRY corrupts databases.
const SHIPPED = [
  '5fa8c711247d', // [0]  labelled v1  — retired, kept as a no-op in place
  '8f61d02c8c55', // [1]  labelled v2  — clears the cache, drops search_fts (sets searchFtsRecreated)
  '5368fc1d53ab', // [2]  labelled v3  — aiTitle
  'ec192a6eb32f', // [3]  labelled v4
  '4754ab4b7f46', // [4]  labelled v6  — the label skips v5; the position does not
  'e0386b8b8a1a', // [5]  labelled v7
  'a10a99182cdf', // [6]  labelled v8
  '75b6c743a559', // [7]  labelled v10 — the label skips v9
  '85fce23f6366', // [8]  labelled v11
  'd12a8ecbd6f5', // [9]  labelled v12
  'c603c8a81c66', // [10] labelled v13
  'd26f2b5ccbd4', // [11] labelled v14
  'a8bd71745eb6', // [12]
  'cc0dc7b32f2c', // [13]
  '39d49d2bf6f0', // [14]
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
  // The acceptance line of #217, without a real database: a fake handle that records everything asked of
  // it. The version row says we are current, so not one migration may fire.
  //
  // COUNTING WRITES IS NOT ENOUGH, and that took a second pass to see: every migration wraps its own
  // statements in try/catch, so one running against a fake that lacks `.all()` throws, gets swallowed by
  // the migration itself, and records no write — leaving this test green for exactly the reason it exists
  // to catch. So count what the runner ASKS FOR: an up-to-date run must prepare the version query and
  // nothing else. A migration cannot execute without reaching this handle.
  const asked = [];
  const stmt = (sql) => ({
    get: () => (/db_version/.test(sql) ? { value: JSON.stringify(SCHEMA_VERSION) } : undefined),
    all: () => [],
    run: () => {},
  });
  const fakeDb = {
    // Record the SQL in full: the truncated version cut off at 40 chars, which is just before the
    // `db_version` literal that identifies the one legal query.
    prepare(sql) { asked.push(`prepare: ${sql.trim()}`); return stmt(sql); },
    exec(sql) { asked.push(`exec: ${String(sql).trim()}`); },
    pragma(p) { asked.push(`pragma: ${p}`); },
  };

  const res = runMigrations(fakeDb);

  assert.equal(res.from, SCHEMA_VERSION, 'it must read the version the database already carries');
  assert.equal(res.to, SCHEMA_VERSION, 'and report the same one back');
  assert.equal(res.searchFtsRecreated, false, 'nothing dropped search_fts, so nothing may claim it did');
  assert.equal(asked.length, 1,
    'an up-to-date database was touched beyond reading its version. Exactly one prepare (the db_version ' +
    `SELECT) is allowed; nothing may run and the version row must not be rewritten. Got:\n  ${asked.join('\n  ')}`);
  assert.match(asked[0], /db_version/);
});

test('searchFtsRecreated reports what THIS run did, not what the last one did', () => {
  // The flag is module state that the migrations set. Production calls runMigrations exactly once, so
  // nothing noticed that it was never reset — but the moment it became an exported, callable function, a
  // second call could still be carrying the first call's `true`. main.js reads this to decide whether to
  // repopulate the entire search index, so a stale `true` is a full reindex for nothing.
  //
  // Found by review, then pinned here: without the reset this test is green on the first call and wrong on
  // the second, which is exactly the shape of bug that survives a suite.
  const mkDb = (version) => ({
    prepare: (sql) => ({
      get: () => (/db_version/.test(sql) ? { value: JSON.stringify(version) } : undefined),
      all: () => [],
      run: () => {},
    }),
    exec: () => {},
    pragma: () => {},
  });

  // A run from zero fires the migration that drops search_fts, so the flag goes up.
  const first = runMigrations(mkDb(0));
  assert.equal(first.searchFtsRecreated, true,
    'a run from zero must report that search_fts was recreated');

  // A second run against an up-to-date database ran nothing, so it must claim nothing.
  const second = runMigrations(mkDb(SCHEMA_VERSION));
  assert.equal(second.searchFtsRecreated, false,
    'no migration ran, so searchFtsRecreated must be false. It is reporting the PREVIOUS run\'s value — ' +
    'reset it at the top of runMigrations.');
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
