'use strict';
// The DATA_DIR ordering, as a test.
//
// db.js resolves DATA_DIR at MODULE LOAD, and main.js sets DATA_DIR (:81-85) before it requires db.js.
// So the order is the contract: anything main.js loads before that point must not pull db.js in with it.
// An extracted module that top-level-requires db.js runs at main.js's require line — before DATA_DIR is
// set — and a dev build silently opens the installed app's database instead of ~/.switchboard-dev. No
// error, no failing test: the dev instance just "verifies" against a store that has not moved in weeks.
//
// So the modules split out of main.js (#213) take the DB through ctx — `getSetting`/`setSetting` are
// handed to app/windows.js, not required by it. A lazy require inside a function body is fine (it runs
// after main.js has finished its own requires); the top-level one is what is banned.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'src');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// A require of db.js at the start of a line = top level. Anything indented sits inside a block, which
// means it runs when that function is called, not when main.js loads the module.
const TOP_LEVEL_DB_REQUIRE = /^(?:const|let|var|\s*)?[^\n]*require\((['"])[^'"]*\/db\/db(?:\.js)?\1\)/;

test('no module split out of main.js top-level-requires db.js', () => {
  const dirs = ['app', 'watch'].map(d => path.join(root, d)).filter(d => fs.existsSync(d));
  const offenders = [];

  for (const file of dirs.flatMap(walk)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s/.test(line)) return;              // indented -> inside a function, allowed
      if (line.trim().startsWith('//')) return;  // a comment about the rule is not a violation
      if (TOP_LEVEL_DB_REQUIRE.test(line)) {
        offenders.push(`${path.relative(root, file)}:${i + 1}`);
      }
    });
  }

  assert.deepEqual(offenders, [],
    'these take db.js through ctx instead — a top-level require runs before main.js sets DATA_DIR, ' +
    'and the dev build then writes to the installed app\'s database with nothing to say so:\n  ' +
    offenders.join('\n  '));
});

test('main.js still sets DATA_DIR before it requires db.js', () => {
  const src = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const setAt = src.search(/process\.env\.SWITCHBOARD_DATA_DIR\s*=/);
  const requireAt = src.search(/require\(['"]\.\/db\/db['"]\)/);

  assert.ok(setAt > -1, 'main.js sets SWITCHBOARD_DATA_DIR');
  assert.ok(requireAt > -1, 'and requires db.js');
  assert.ok(setAt < requireAt,
    'db.js resolves DATA_DIR at module load — requiring it first pins the wrong database for the run');
});
