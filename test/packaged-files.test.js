'use strict';
// The installer shipped without `backends/`, and the app died on its first line: "Cannot find module
// './backends'". Every packaged build since the multi-LLM work was broken this way. Nothing caught it —
// `npm test` runs from the repo, where every file is simply there, and `npm start` does too. Only the
// INSTALLER is missing anything, and nobody installs their own build to check.
//
// The cause is that `build.files` is an ALLOW-LIST, and `*.js` in it matches the TOP LEVEL ONLY. So the
// day someone adds a directory — backends/, and whatever comes next — the package silently loses it. The
// repo keeps working. The release does not.
//
// This test walks the REAL require graph from the two entry points and asserts that every file it reaches
// is one the allow-list would actually ship. A list of "directories we remembered to add" would be the
// same mistake one level up; the graph cannot forget.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const ENTRIES = ['main.js', 'preload.js'];

/** `build.files`, as predicates. Kept in step with package.json by the test below. */
function shippedBy(patterns) {
  const matchers = patterns.map((p) => {
    if (p === '*.js') return (rel) => /^[^/]+\.js$/.test(rel);          // TOP LEVEL only — the whole trap
    if (p.endsWith('/**/*')) { const dir = p.slice(0, -5) + '/'; return (rel) => rel.startsWith(dir); }
    if (p.includes('*')) {
      const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
      return (rel) => re.test(rel);
    }
    return (rel) => rel === p;
  });
  return (rel) => matchers.some((m) => m(rel.replace(/\\/g, '/')));
}

/** Every file the app loads at runtime, following relative requires from the entry points. */
function runtimeFiles() {
  const seen = new Set();

  const resolve = (fromFile, spec) => {
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const cand of [base, base + '.js', path.join(base, 'index.js')]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
    }
    return null;
  };

  const walk = (file) => {
    const abs = path.resolve(file);
    if (seen.has(abs)) return;
    seen.add(abs);

    let src = '';
    try { src = fs.readFileSync(abs, 'utf8'); } catch { return; }
    for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const target = resolve(abs, m[1]);
      if (target) walk(target);
    }
  };

  for (const e of ENTRIES) walk(path.join(root, e));
  return [...seen].map((abs) => path.relative(root, abs).replace(/\\/g, '/'));
}

test('every file the app requires at runtime is one the installer would actually ship', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const patterns = pkg.build && pkg.build.files;
  assert.ok(Array.isArray(patterns) && patterns.length, 'package.json build.files must exist');

  const ships = shippedBy(patterns);
  const files = runtimeFiles();
  assert.ok(files.length > 30, 'the require walk found suspiciously little — did the entry points move?');

  const missing = files.filter((f) => !ships(f)).sort();
  assert.deepEqual(missing, [],
    'these are loaded at runtime but not packaged — the installed app dies on the first require');
});

test('`*.js` in build.files covers the top level ONLY — which is the trap', () => {
  // Written down because it is the whole reason the bug existed: it LOOKS like it covers every .js file
  // in the project. It does not. A new directory of modules needs its own entry.
  const ships = shippedBy(['*.js']);
  assert.equal(ships('main.js'), true);
  assert.equal(ships('backends/index.js'), false, 'a nested .js is NOT matched by *.js');
  assert.equal(ships('backends/codex/parser.js'), false);
});
