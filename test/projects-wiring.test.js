'use strict';
// Regression guard for the silent bug an injected context invites (#170).
//
// projects.js reads everything it needs through `ctx.db.<name>` / `ctx.cache.<name>`, and main.js
// hand-builds those objects as an explicit ALLOW-LIST. Wire a new function into projects.js, forget to
// add it to that literal, and the call site gets `undefined` — it throws at runtime, in an IPC handler,
// where the user sees "an error occurred" and the log sees a TypeError about a function that plainly
// exists. That is exactly what happened to session-cache.js once (see main-ctx-db-wiring.test.js), and
// the same shape of gap is now open here.
//
// Static analysis: db.js cannot be required under plain node (better-sqlite3 is built for Electron's ABI).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/** The keys projects.js actually reads off the context. */
function keysReadFrom(namespace) {
  const src = read('projects.js');
  const re = new RegExp(`ctx\\.${namespace}\\.(\\w+)`, 'g');
  const out = new Set();
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return out;
}

/** The `<name>: { ... }` literal main.js passes to projects.init(), as a set of keys. */
function keysPassedIn(namespace) {
  const src = read('main.js');
  const initAt = src.indexOf('projects.init(');
  assert.ok(initAt !== -1, 'main.js must call projects.init()');

  const nsAt = src.indexOf(`${namespace}: {`, initAt);
  assert.ok(nsAt !== -1, `main.js must pass a ${namespace}: { ... } object to projects.init()`);

  const open = src.indexOf('{', nsAt);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end !== -1, `the ${namespace}: { ... } literal must be balanced`);

  return new Set(
    src.slice(open + 1, end)
      .split(',')
      .map(s => s.trim().split(':')[0].trim())
      .filter(Boolean)
      .filter(k => /^[A-Za-z_$][\w$]*$/.test(k))
  );
}

for (const namespace of ['db', 'cache']) {
  test(`main.js passes every ctx.${namespace}.* function projects.js reads`, () => {
    const needed = keysReadFrom(namespace);
    const passed = keysPassedIn(namespace);

    assert.ok(needed.size > 0, `projects.js should read something off ctx.${namespace}`);
    const missing = [...needed].filter(k => !passed.has(k)).sort();
    assert.deepEqual(missing, [],
      `projects.js reads ctx.${namespace}.${missing.join(', ')} — main.js never hands it over, so it is undefined at runtime`);
  });
}

test('projects.js stays free of Electron, or it cannot be tested at all', () => {
  const src = read('projects.js');
  assert.ok(!/require\(['"]electron['"]\)/.test(src),
    'the whole point of the module is that a plain node process can load it');
  // The one Electron surface it needs — the folder picker — is injected.
  assert.match(src, /ctx\.showOpenDialog\(\)/, 'the dialog is handed in, not reached for');
});

test('main.js hands over the state projects.js cannot know about itself', () => {
  const src = read('projects.js');
  const passed = read('main.js').slice(read('main.js').indexOf('projects.init('));
  for (const key of ['PROJECTS_DIR', 'activeSessions', 'log', 'showOpenDialog']) {
    if (!new RegExp(`ctx\\.${key}\\b`).test(src)) continue;   // not read -> not required
    assert.match(passed, new RegExp(`\\b${key}\\b`), `projects.js reads ctx.${key}, so main.js must pass it`);
  }
});
