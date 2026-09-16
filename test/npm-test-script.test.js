'use strict';
// What `npm test` is pointed at (#625).
//
// Node's default discovery — `node --test` with no path — runs EVERY `.js` under `test/`, not only the test
// files: the two jsdom harnesses in `test/helpers/` ran as entries of their own at about ten seconds each,
// and a run could end non-zero with no failing test in it, which is the one state a suite may not be in.
// The script therefore carries a recursive glob, and this guard is here because the argument is one token
// that a future edit can drop without anything else noticing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test;

test('npm test runs the test files under test/, recursively and only those (#625)', () => {
  assert.match(script, /node --test\b/, 'still the node test runner');
  assert.match(script, /test\/\*\*\/\*\.test\.js/,
    'a recursive glob over the test files: `test/*.test.js` would miss a file in a subdirectory, and no '
    + 'argument at all runs every helper and fixture as a test entry');
  assert.match(script, /--test-timeout=\d+/, 'and the per-test timeout stays, or a hung test hangs the run');
});

test('the helpers and fixtures under test/ are not test files, so the glob leaves them out (#625)', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [path.relative(root, full).replace(/\\/g, '/')];
  });
  const js = walk(path.join(root, 'test')).filter((p) => p.endsWith('.js'));
  const helpers = js.filter((p) => !p.endsWith('.test.js'));

  assert.ok(helpers.length, 'there are such files — otherwise this guard proves nothing');
  assert.ok(helpers.every((p) => /^test\/(helpers|fixtures)\//.test(p)),
    'a helper lives under test/helpers/ or test/fixtures/: ' + helpers.filter((p) => !/^test\/(helpers|fixtures)\//.test(p)).join(', '));
  // The glob's own rule, spelled out: a path is run when it ends in `.test.js` under `test/`.
  const matched = js.filter((p) => p.startsWith('test/') && p.endsWith('.test.js'));
  assert.equal(matched.length, js.length - helpers.length);
  assert.ok(matched.includes('test/npm-test-script.test.js'), 'this file is one of them');
});
