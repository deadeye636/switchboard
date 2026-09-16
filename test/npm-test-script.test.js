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

const { stripComments } = require('./helpers/strip-comments');

const root = path.join(__dirname, '..');
const script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test;

test('npm test runs the test files under test/, recursively and only those (#625)', () => {
  assert.match(script, /node --test\b/, 'still the node test runner');
  assert.match(script, /test\/\*\*\/\*\.test\.js/,
    'a recursive glob over the test files: `test/*.test.js` would miss a file in a subdirectory, and no '
    + 'argument at all runs every helper and fixture as a test entry');
  assert.match(script, /--test-timeout=\d+/, 'and the per-test timeout stays, or a hung test hangs the run');
  // …and it has a FLOOR, which is not the same requirement. Node applies this cap to each FILE as well as
  // to each test, so tightening it does not only make a hung test fail sooner — it cancels a file that is
  // merely slow, and a cancelled file prints `not ok … # fail 0` with nothing in it to look at. Measured
  // at #630: `panes-view.test.js` runs 41 s under the suite's own concurrency, so at 60 s one more agent
  // session on the machine was enough. The floor is that measurement with room over it; raise the number
  // here only with a new one, and never lower it to "make a hang fail faster".
  const cap = Number(/--test-timeout=(\d+)/.exec(script)[1]);
  assert.ok(cap >= 120000, `the cap is ${cap} ms — the slowest FILE was measured at 41 s under load, and `
    + 'node cancels a file that outruns this, so a tighter cap fails a file that is only slow');
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

// --- A test file that starts a watch hands it back (#630) -------------------------------------------
//
// The other way a run ends non-zero with no failing test in it, and the one the timeout cannot reach.
// `--test-timeout` catches a test that stops making progress; it does not catch a file whose tests all
// finish and whose process then sits there, because nothing is running to time out. Node applies that
// timeout to the FILE-level test too, so the run reports `not ok <n> - test\<file>.test.js` with the
// file's own tests all passing — which reads like an infrastructure hiccup and is not one.
//
// What causes it here is a module under test that opened something in `init`. `plans-memory.js` starts an
// `fs.watch` on every plans directory the backends it is handed declare, and one open watcher keeps the
// process alive for good. The file it happened to had been getting away with it: its last test re-set the
// module with a backend list declaring no plans store, which closed the watcher, and appending a test
// after that one brought it back.
//
// So the property this guard pins is NOT "the tree exits today" — it does, measured. It is that no file
// depends on the fixture it happens to hand `init`, because that dependence is invisible and the next
// test appended to the file silently changes it.
//
// **It carries no list.** Both halves are derived: the watching modules are whatever under `src/` calls
// `fs.watch`, and each one's teardown is whatever its own `module.exports` names `stop*`/`close*`/
// `dispose*`/`shutdown*`. Write a new watcher with a teardown and its callers are audited the same day; a
// list would have to be remembered. `unwatch*` is deliberately NOT a teardown: `unwatchFile(a, file)`
// hands back one entry and leaves the rest, and counting it would make a partial release look like a full
// one — the direction that goes quiet.
//
// **Its limits, stated because a guard that hides one reports success about what it never looked at:**
//
//   * It sees `fs.watch` and nothing else. `fs.watchFile` is outside the pattern; both of today's callers
//     pass `persistent: false` and hold nothing open, which is an accidental property of exactly the kind
//     this guard exists to stop relying on — it is simply not covered.
//   * A worker thread, a server socket and a child process opened by a test are not covered at all.
//   * Timers are a different convention rather than a guarantee: the main-process `setInterval`s are
//     `unref()`d, which is why none of them holds a run open, and the two in `src/renderer/**` are not —
//     a jsdom test that loads one of those modules is on its own.
//   * A test that reaches an owner through a helper under `test/helpers/` is not seen, because the scan
//     asks each test FILE what it requires. None does today.
//   * The teardown is matched as TEXT anywhere in the file, so a call sitting inside a helper closure
//     satisfies it whether or not that closure is ever invoked (`test/readable-error.test.js` is written
//     that way). Pairing the call with the hook that runs it needs a parser, not a scan.
//   * The entry point has to be reached through the module object or a plain destructure. An alias off the
//     require — `const init = require('…/plans-memory').init;` — binds nothing here, and a test written
//     that way reads as not starting anything.
//
// Those stay the reading in `.claude/rules/guards-and-scripts.md`.

const SRC = path.join(root, 'src');

// A generated bundle is not source. Told apart by a PROPERTY rather than by name, so the next one built is
// covered on the day it appears: measured, the longest hand-written line in this tree is under 4 000
// characters and the three bundles under `src/renderer/` run to hundreds of thousands. They are gitignored,
// so naming them would also make this guard red here and green on a fresh clone.
const GENERATED_LINE = 20000;
const isGenerated = (raw) => raw.split('\n').some((l) => l.length > GENERATED_LINE);

const walkJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  return e.isDirectory() ? walkJs(full) : (e.name.endsWith('.js') ? [full] : []);
});

// The names a `module.exports = { … }` object literal actually exports. Nested braces, brackets and
// parentheses are blanked first, so a method body cannot contribute a name and a renamed key
// (`_typeLabel: typeLabel`) contributes the key rather than the value.
function exportedNames(code) {
  const at = code.indexOf('module.exports');
  if (at < 0) return [];
  const open = code.indexOf('{', at);
  if (open < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return [];
  const body = code.slice(open + 1, end);
  let flat = '';
  let d = 0;
  for (const ch of body) {
    if ('{[('.includes(ch)) { d++; flat += ' '; continue; }
    if (')]}'.includes(ch)) { d--; flat += ' '; continue; }
    flat += d > 0 ? ' ' : ch;
  }
  return [...flat.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?=[,:]|$)/g)].map((m) => m[1]);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What a module that calls `fs.watch` offers a caller: what starts it, and what hands it back.
//
// `watch*` is a starter as much as `init` is: `file-watch.js` only stores its ctx in `init` and opens the
// watcher from `watchFile`, so a model built on `init` alone audits that module by accident.
function ownerShape(code) {
  const names = exportedNames(code);
  return {
    watches: /\bfs\.watch\s*\(/.test(code),
    starters: names.filter((n) => n === 'init' || /^(start|watch)/.test(n)),
    teardowns: names.filter((n) => /^(stop|close|dispose|shutdown)/.test(n)),
    // `trigger-watcher.js` exports only `start` and hands the caller a `{ close() }` back, so closing what
    // the starter returned is the teardown there.
    handsBackACloser: /return\s*\{[\s\S]{0,80}?\bclose\s*[(:]/.test(code),
  };
}

// Does this test file start that owner, and does it hand it back? Binding-aware, so a file that requires
// the module for a pure helper and never starts anything is not in scope. `spec` is the require specifier
// as THIS file would have to spell it, which is why it is passed in: the suite glob is recursive, so a test
// file in a subdirectory reaches the same module through one more `../`.
function testUsesOwner(code, owner, spec) {
  const req = `require\\(\\s*['"\`]${esc(spec)}(?:\\.js)?['"\`]\\s*\\)`;
  // A namespace binding, with or without its declarator — `let mod; mod = require(…)` binds the same way.
  const ns = [...code.matchAll(new RegExp(`(?:(?:const|let|var)\\s+)?([A-Za-z_$][\\w$]*)\\s*=\\s*${req}`, 'g'))]
    .map((m) => m[1]);
  // A destructure, keyed by the EXPORT name and valued by whatever local name it was given: a renamed key
  // (`const { init: startPlans } = …`) is what somebody writes the moment two modules both export `init`.
  const picked = new Map();
  for (const m of code.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${req}`, 'g'))) {
    for (const part of m[1].split(',')) {
      const [key, alias] = part.split(':').map((s) => s.trim());
      if (key) picked.set(key, alias || key);
    }
  }
  // …and the chained form, which binds nothing at all.
  const chained = new RegExp(`${req}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
  const chainedCalls = [...code.matchAll(chained)].map((m) => m[1]);
  if (!ns.length && !picked.size && !chainedCalls.length) return { inScope: false };

  const calls = (name) => ns.some((n) => new RegExp(`\\b${esc(n)}\\.${esc(name)}\\s*\\(`).test(code))
    || (picked.has(name) && new RegExp(`\\b${esc(picked.get(name))}\\s*\\(`).test(code))
    || chainedCalls.includes(name);

  // What the starter handed back, so a `.close()` counts only on THAT handle — a `db.close()` elsewhere in
  // the file is not this watcher's teardown.
  const closed = owner.handsBackACloser && owner.starters.some((s) => {
    const local = picked.has(s) ? esc(picked.get(s)) : `(?:${ns.map(esc).join('|') || '\\0'})\\.${esc(s)}`;
    const held = [...code.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${local}\\s*\\(`, 'g'))]
      .map((m) => m[1]);
    return held.some((h) => new RegExp(`\\b${esc(h)}\\.close\\s*\\(`).test(code));
  });

  return {
    inScope: true,
    starts: owner.starters.some(calls),
    handsBack: owner.teardowns.some(calls) || closed,
  };
}

// Every file under `src/` is stripped, with no cheap pre-filter on the raw text. A pre-filter would be
// unsound in the one direction that matters: removing a block comment JOINS its two sides, so
// `fs./* the node one */watch(dir)` carries no `fs.watch(` until it is stripped — and a file skipped there
// is an owner the scan never reads, which is the failure the rules file calls the worst a guard can have.
// Measured at a few hundred milliseconds for the tree, which is what that soundness costs.
function watchOwners() {
  return walkJs(SRC).flatMap((file) => {
    const raw = fs.readFileSync(file, 'utf8');
    if (isGenerated(raw)) return [];
    const shape = ownerShape(stripComments(raw));
    if (!shape.watches) return [];
    const rel = path.relative(root, file).replace(/\\/g, '/');
    return [{ ...shape, file: rel, abs: file }];
  });
}

// How a test file in THIS directory would have to spell the require.
function specFor(testFile, owner) {
  const rel = path.relative(path.dirname(testFile), owner.abs).replace(/\\/g, '/').replace(/\.js$/, '');
  return rel.startsWith('.') ? rel : './' + rel;
}

test('a test file that starts a watch hands it back before the process is expected to exit (#630)', () => {
  const owners = watchOwners();
  assert.ok(owners.length, 'the scan found no module under src/ that calls fs.watch — it is broken, not clean');

  // Per owner, not "at least one of them": a module whose exports this scan cannot read comes back with no
  // starter and no teardown, contributes no pairing, and would slip past a canary that only counts. Failing
  // by NAME is also what keeps the offender message honest — it can never advise closing a handle a module
  // does not hand back, because such a module fails here first.
  const unreadable = owners.filter((o) => !o.starters.length || (!o.teardowns.length && !o.handsBackACloser));
  assert.deepEqual(unreadable.map((o) => o.file), [],
    unreadable.map((o) => `${o.file} opens an fs.watch and this scan cannot see how a caller starts it `
      + '(init/start*/watch* in module.exports) or hands it back (stop*/close*/dispose*/shutdown*, or a '
      + 'returned { close() }). Either the module offers no teardown — write one — or it exports in a shape '
      + 'this scan does not read, and the scan is now blind to every test that starts it').join('\n'));

  const testFiles = walkJs(path.join(root, 'test')).filter((f) => f.endsWith('.test.js'));
  const offenders = [];
  let pairings = 0;
  for (const f of testFiles) {
    const raw = fs.readFileSync(f, 'utf8');
    const specs = owners.map((o) => specFor(f, o));
    // This pre-filter IS sound where the one over `src/` was not: a require specifier sits inside a string
    // literal, and the shared scanner never opens a comment from inside a string — so stripping can neither
    // create one nor join one across a comment.
    if (!specs.some((s) => raw.includes(s))) continue;
    const code = stripComments(raw);
    owners.forEach((owner, i) => {
      const use = testUsesOwner(code, owner, specs[i]);
      if (!use.inScope || !use.starts) return;
      pairings++;
      if (use.handsBack) return;
      const how = owner.teardowns.length
        ? owner.teardowns.map((t) => `${t}()`).join(' or ')
        : 'close() on the handle its starter returned';
      offenders.push(`${path.relative(root, f).replace(/\\/g, '/')} starts ${owner.file} `
        + `and never calls ${how} — put it in a test.after(), and do not rely on what the last test in `
        + 'the file happens to leave behind');
    });
  }

  assert.ok(pairings, 'no test file starts any of those modules — the pairing scan matched nothing, so '
    + 'this guard would pass whatever the tree looked like');
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('…and the scan catches the shapes a real violation would take (#630)', () => {
  // A guard that carries its own pattern is a second copy of the thing it audits, so the pattern is
  // checked in the direction that matters: against text that SHOULD be caught.
  const ownerSrc = `
    const fs = require('node:fs');
    let w = null;
    function init(ctx) { w = fs.watch(ctx.dir, () => {}); }
    function stopWatchingThings() { if (w) w.close(); }
    module.exports = { init, registerIpc, stopWatchingThings };
  `;
  const SPEC = '../src/app/invented';
  const owner = { ...ownerShape(ownerSrc), file: 'src/app/invented.js' };
  const used = (code) => testUsesOwner(code, owner, SPEC);
  assert.equal(owner.watches, true);
  assert.deepEqual(owner.starters, ['init']);
  assert.deepEqual(owner.teardowns, ['stopWatchingThings']);

  const starts = `const mod = require('${SPEC}');\nmod.init({ dir: '/somewhere' });\n`;
  assert.deepEqual(used(starts), { inScope: true, starts: true, handsBack: false },
    'a file that starts it and never stops it is the violation');
  assert.equal(used(starts + 'test.after(() => mod.stopWatchingThings());\n').handsBack, true,
    'and the teardown in a test.after is what clears it');
  assert.equal(used(`const mod = require('${SPEC}');\nmod.readThing();\n`).starts,
    false, 'requiring it for a pure helper is not starting it');
  assert.equal(used("const other = require('../src/app/elsewhere');\nother.init({});\n").inScope,
    false, 'and another module\'s init is not this module\'s');

  // The shapes somebody actually writes, each of which bound nothing at all in the first version of this.
  assert.equal(used(`const { init: startInvented } = require('${SPEC}');\nstartInvented({});\n`).starts, true,
    'a RENAMED destructure — what you write the moment two modules under test both export `init`');
  assert.equal(used(`require('${SPEC}').init({});\n`).starts, true, 'the chained require, which binds nothing');
  assert.equal(used(`let mod;\nmod = require('${SPEC}');\nmod.init({});\n`).starts, true,
    'and an assignment without its declarator');
  assert.equal(used(`const mod = require('${SPEC}.js');\nmod.init({});\n`).starts, true,
    'the specifier spelled with its extension');

  // The one that hides in a comment: a block comment INSIDE the call. Removing it joins the two halves, so
  // the raw text carries no `fs.watch(` and only the stripped text does — which is why nothing pre-filters
  // `src/` on the raw text.
  assert.equal(ownerShape(stripComments('fs./* the node one */watch(dir, cb);\nmodule.exports = { init };')).watches,
    true, 'a comment inside the call must not hide an owner from the scan');

  // The destructured entry point, which is how `trigger-watcher` is reached, with its returned closer.
  const closerSrc = `
    const fs = require('node:fs');
    function start(ctx) {
      const watcher = fs.watch(ctx.dir, () => {});
      return { close() { watcher.close(); } };
    }
    module.exports = { start };
  `;
  const CSPEC = '../src/watch/invented';
  const closer = { ...ownerShape(closerSrc), file: 'src/watch/invented.js' };
  const cUsed = (code) => testUsesOwner(code, closer, CSPEC);
  assert.deepEqual(closer.starters, ['start']);
  assert.deepEqual(closer.teardowns, []);
  assert.equal(closer.handsBackACloser, true, 'it hands a closer back, so closing it is the teardown');
  const picks = `const { start } = require('${CSPEC}');\nconst h = start(ctx);\n`;
  assert.deepEqual(cUsed(picks), { inScope: true, starts: true, handsBack: false });
  assert.equal(cUsed(picks + 'h.close();\n').handsBack, true);
  assert.equal(cUsed(picks + 'db.close();\n').handsBack, false,
    'and it has to be THAT handle — any other close() in the file is not this watcher\'s teardown');

  // A release that is not a release: one entry handed back while the rest stay open.
  assert.deepEqual(ownerShape('fs.watch(d); module.exports = { watchFile, unwatchFile, closeAll };'),
    { watches: true, starters: ['watchFile'], teardowns: ['closeAll'], handsBackACloser: false },
    '`watch*` starts it, and `unwatch*` is a partial release rather than the teardown');

  // And the stripper is doing its half: a module that only MENTIONS fs.watch in prose is not an owner.
  assert.equal(ownerShape(stripComments('// it used to call fs.watch(dir)\nmodule.exports = {};')).watches,
    false, 'a mention in a comment must not make a file an owner — that would need an exemption to silence');
});
