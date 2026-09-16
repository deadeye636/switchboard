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
//   * The projection below costs a jsdom build from a RECORDED number, so a harness that gets slower — a
//     bigger page, another script loaded per build — does not move it. Only the test count does. That is
//     the price of a guard that gives the same answer inside `npm test` as it does alone; re-measure
//     MEASURED_BUILD_MS when the harness changes shape.
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

// --- The slow half: a jsdom file must not creep back up towards the cap (#630) ------------------------
//
// The other reason a run ends `not ok <n> - test\<file>.test.js` with `# fail 0` in it, and the one the
// watch guard above cannot see: the file is not leaking anything, it is simply slow, and it runs past the
// cap that node applies to the file-level wrapper as well as to each test. Nothing guarded it. It is what
// happened to `panes-view.test.js`, which grew to 206 tests against a harness that builds a fresh jsdom
// per test — 16.8 s alone, 41 s under the suite's own 20-way concurrency, against a 60 s cap at the time.
// One more agent session on the machine was enough, and the red run reads like an infrastructure hiccup.
//
// This is a PROJECTION, not a timing run. A timing run would be the thing it is trying to prevent: it
// would sit in the suite for as long as the file it measures and would be exactly as sensitive to what
// else the machine is doing. Instead it costs one jsdom build per harness, a few times over, and
// multiplies.
//
// **It carries no list.** A harness is whatever file under `test/helpers/` builds a `new JSDOM` and
// exports exactly one `setup*`; the files it covers are whatever test files require that harness; and the
// number of tests in one of them is counted by LOADING it with `node:test` swapped for a recorder, which
// is the only count that sees a test generated inside a `for` loop — `panes-view-views.test.js` registers
// 65 and spells `test(` forty-five times.
//
// **Its limits, stated because a guard that hides one reports success about what it never looked at:**
//
//   * A harness is recognised by `exportedNames`, which reads a `module.exports = { … }` object literal and
//     nothing else. A helper written `exports.setupX = …` or `module.exports = setupX` yields no names and
//     therefore fails the skipped-harness check rather than being costed. Both of today's harnesses use the
//     literal, so this is latent — and it fails LOUDLY, which is the direction to be latent in.
//   * The projection counts jsdom BUILDS and nothing else, so it is a FLOOR. Measured, the build is about
//     a third of what one of these tests really costs (206 builds at ~24 ms is ~5 s of a 16.8 s file); the
//     rest is the render and the `settle()` each body awaits, and that ratio is not the same for both of
//     today's harnesses. The budget is therefore set against the floor rather than near the cap.
//   * EVERY harness is costed at the one recorded number, whatever it really costs to build. That number is
//     the panes harness's; `file-panel-dom.js` measured 15.9 ms against its 20.7 ms, so its files are
//     over-projected by about half — the catching direction, and deliberate, but it is one measurement
//     applied to two things rather than two measurements.
//   * `describe`/`it` nesting would be counted as nothing at all, so a covered file that uses `describe`
//     fails here too. None does today.
//   * Loading a test file runs its module body. Today that is `test(...)` registrations and helper
//     definitions; a covered file that does real work at load time would do it here as well.
//   * It is wall clock against a wall-clock cap, so on hardware much slower than this it fires early. That
//     is the right direction: `--test-timeout` is an absolute number and does not scale with the machine.

// Measured at #630 on the file this guard was written for: `panes-view.test.js`, 206 tests, 16.8 s alone
// and 41 s under the suite's own concurrency. Those two numbers ARE the concurrency penalty — a factor of
// about two and a half — and they are a second copy of the measurement written down in
// `.claude/rules/guards-and-scripts.md` and cited by the `--test-timeout` floor at the top of this file.
// Re-measure and all three change together; the penalty is derived from the pair rather than typed, so
// there is one place to correct it here.
const MEASURED_ALONE_MS = 16800;
const MEASURED_UNDER_LOAD_MS = 41000;
const CONCURRENCY_PENALTY = MEASURED_UNDER_LOAD_MS / MEASURED_ALONE_MS;

// A SIXTEENTH of the cap — 7.5 s of the 120 s in package.json — and the small fraction is the point, not
// a hedge. The projection counts builds only, which is about a third of the real cost, so a budget set
// near the cap would pass the very file this exists to catch.
//
// The band it sits in is narrow and is stated here rather than discovered later. With the recorded build
// cost the projection is deterministic: the four files this coverage was split into project to 2.1-3.8 s,
// and the 206-test file they came from projects to 12.1 s. Everything the budget could be is between those
// two numbers, a factor of about three. At a sixteenth the old file fails at 161 % of budget and today's
// largest sits at about half of it — so the guard goes red when a covered file roughly doubles, which is
// the drift it is for, and NOT when one grows by a few tests.
const BUDGET_FRACTION = 1 / 16;

// One jsdom build of the panes harness, measured on the machine this was calibrated on, in a clean process
// before any test file was loaded — the median of nine, which discards the first build's module warm-up.
// Recorded rather than taken live: see the note in the test below. It is a number about a MACHINE, so on
// much slower hardware this guard fires early, which is the right direction — `--test-timeout` is absolute
// wall clock and does not scale with the box either.
const MEASURED_BUILD_MS = 24;
// …and the file the guard was written for, for the calibration check at the bottom.
const OFFENDER_TESTS = 206;

const HELPERS = path.join(root, 'test', 'helpers');

/** The projection itself, named so the calibration below drives this and not a copy of it. */
function projectMs(tests, buildMs) {
  return tests * buildMs * CONCURRENCY_PENALTY;
}

// A per-test jsdom harness: builds a `new JSDOM` and offers exactly one way in.
//
// A file that builds a jsdom world and does NOT have exactly one `setup*` is reported rather than skipped.
// Skipping was the first shape and it is the one that goes quiet: a harness dropping out takes every file
// it covers out of the projection with it, and the backstops below stay green because the other harness
// keeps their counts non-zero. `panes-dom.js` grew ten exports in this same change, so one of them named
// `setupTwoPanes` instead of `twoPanes` would have unhooked all four panes-view files without a word.
function jsdomHarnesses() {
  const skipped = [];
  const found = fs.readdirSync(HELPERS).filter((n) => n.endsWith('.js')).flatMap((name) => {
    const abs = path.join(HELPERS, name);
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    if (!/new\s+JSDOM\s*\(/.test(code)) return [];
    const setups = exportedNames(code).filter((n) => /^setup/.test(n));
    if (setups.length !== 1) { skipped.push(`${name} exports ${setups.length} setup* names (${setups.join(', ') || 'none'})`); return []; }
    return [{ name, abs, setup: setups[0] }];
  });
  return { found, skipped };
}

// How many tests a file registers, counted by loading it with `node:test` replaced. The module body runs,
// the test bodies do not — a `for` loop over ten surfaces registers its ten either way, which is the whole
// reason this is not a count of `test(` in the text.
function testsRegisteredBy(file) {
  const Module = require('node:module');
  const load = Module._load;
  const before = new Set(Object.keys(require.cache));
  let count = 0;
  const register = () => { count++; };
  const noop = () => {};
  const recorder = new Proxy(register, {
    // `test` and `it` are the same registrar under two names; `before`/`after`/`mock`/… register nothing.
    get: (target, key) => (key === 'test' || key === 'it' ? register
      : (typeof target[key] !== 'undefined' ? target[key] : noop)),
  });
  Module._load = function (request, ...rest) {
    if (request === 'node:test' || request === 'test') return recorder;
    return load.call(this, request, ...rest);
  };
  try {
    require(file);
  } finally {
    Module._load = load;
    for (const key of Object.keys(require.cache)) if (!before.has(key)) delete require.cache[key];
  }
  return count;
}

test('a file of jsdom tests stays well clear of the runner\'s file-level cap (#630)', () => {
  const cap = Number(/--test-timeout=(\d+)/.exec(script)[1]);
  const budgetMs = cap * BUDGET_FRACTION;

  const { found: harnesses, skipped } = jsdomHarnesses();
  assert.deepEqual(skipped, [],
    'a file under test/helpers/ builds a jsdom world but does not offer exactly one `setup*`, and it would '
    + 'otherwise take every test file that uses it out of this projection silently. With none: name its '
    + 'entry point `setup*` — the convention exists for this scan and nowhere else. With more than one: '
    + 'rename the others, or teach this scan which is the way in:\n' + skipped.join('\n'));
  assert.ok(harnesses.length, 'no jsdom harness found under test/helpers/ — the scan is broken, not clean');

  const testFiles = walkJs(path.join(root, 'test')).filter((f) => f.endsWith('.test.js'));
  for (const harness of harnesses) {
    harness.users = testFiles.filter((f) => {
      const rel = path.relative(path.dirname(f), harness.abs).replace(/\\/g, '/').replace(/\.js$/, '');
      const spec = rel.startsWith('.') ? rel : './' + rel;
      return stripComments(fs.readFileSync(f, 'utf8')).includes(spec);
    });
  }

  // The build cost is a RECORDED number, not a live one, and that is the whole difference between a guard
  // and a coin toss. The first version measured it here: nine builds, median, taken before any test file was
  // loaded — careful, and still wrong, because the only run that matters is the one inside `npm test`, where
  // twenty files are building jsdom worlds at once. It passed alone at 3.5 s and failed the suite on its
  // first full run. A guard that is red only under the load it was written to reason about is worse than
  // none: it teaches people to re-run until it is green.
  //
  // So the only variable input left is the TEST COUNT, which is deterministic. What that gives up is stated
  // in the limits below: a harness that gets slower is invisible here until somebody re-measures.
  for (const harness of harnesses.filter((h) => h.users.length)) harness.buildMs = MEASURED_BUILD_MS;

  const over = [];
  const seen = [];
  for (const harness of harnesses) {
    const { users, buildMs } = harness;
    if (!users.length) continue;

    for (const file of users) {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      assert.ok(!/\bdescribe\s*\(/.test(stripComments(fs.readFileSync(file, 'utf8'))),
        `${rel} uses describe(), and the recorder below counts a describe as no tests at all — it would `
        + 'undercount this file to nothing. Teach the recorder to walk a suite before writing one here');
      const tests = testsRegisteredBy(file);
      assert.ok(tests > 0, `${rel} requires a jsdom harness and registered no tests when loaded — the `
        + 'recorder did not see this file, so the projection for it means nothing');
      const projected = projectMs(tests, buildMs);
      seen.push(`${rel}: ${tests} tests x ${buildMs.toFixed(1)} ms x ${CONCURRENCY_PENALTY.toFixed(2)} `
        + `= ${(projected / 1000).toFixed(1)} s`);
      if (projected > budgetMs) {
        over.push(`${rel} projects to ${(projected / 1000).toFixed(1)} s of jsdom builds alone under the `
          + `suite's own concurrency (${tests} tests x ${buildMs.toFixed(1)} ms per `
          + `${harness.setup}() x ${CONCURRENCY_PENALTY.toFixed(2)}), against a budget of `
          + `${(budgetMs / 1000).toFixed(1)} s — a sixteenth of the ${cap} ms cap, and the build is only about `
          + 'a third of what one of these tests really costs. Split it by subject, the way #630 split '
          + 'panes-view.test.js into panes-view / -tabs / -views / -drag: node parallelises across FILES '
          + 'and not within one, so splitting is what moves the wall clock. Raising the cap instead is a '
          + 'decision for whoever owns the number in package.json');
      }
    }
  }

  assert.ok(seen.length, 'no test file uses a jsdom harness — this guard would pass whatever the tree '
    + 'looked like');
  assert.deepEqual(over, [], over.join('\n') + '\n\nmeasured: ' + seen.join('\n          '));
});

test('…and the budget is one the file this guard was written for would have failed (#630)', () => {
  // A budget only means something if something fails it, and a green tree proves nothing about that. The
  // real check was done by hand — the 206-test file was put back in the tree and the guard above ran on
  // it, projecting 12.1 s against this budget — and this is the half of it that can stay: the same
  // `projectMs` the guard calls, so a later edit to BUDGET_FRACTION or to the penalty that would have let
  // that file through fails here rather than going unnoticed.
  const cap = Number(/--test-timeout=(\d+)/.exec(script)[1]);
  const projected = projectMs(OFFENDER_TESTS, MEASURED_BUILD_MS);
  assert.ok(projected > cap * BUDGET_FRACTION,
    `${OFFENDER_TESTS} tests at ${MEASURED_BUILD_MS} ms project to ${(projected / 1000).toFixed(1)} s, `
    + `which this budget of ${(cap * BUDGET_FRACTION / 1000).toFixed(1)} s now passes — so the guard above `
    + 'no longer catches the file it was written for. Re-measure and re-calibrate rather than adjusting '
    + 'the fraction until the tree is green');
  // …and not so tight that the four files it was split into would fail it, which would make the guard
  // unshippable in the other direction. The largest of them registers 65 tests.
  assert.ok(projectMs(65, MEASURED_BUILD_MS) < cap * BUDGET_FRACTION * 0.75,
    'the budget leaves no room over the largest file that exists today — at that point it is a tripwire '
    + 'on normal growth rather than a guard on drift');
});

test('…and the counting the projection rests on sees a test written inside a loop (#630)', () => {
  // The whole reason the count comes from LOADING a file rather than from counting `test(` is that one of
  // the covered files generates its tests in two `for` loops — 45 spellings, 65 registrations. That is a
  // property of `panes-view-views.test.js` today, and a guard resting on a property of one file is a guard
  // that goes quiet when that file changes. So the recorder is driven over a written-down module instead.
  const probe = path.join(root, '.claude', 'scratchpad', `recorder-probe-${process.pid}.js`);
  fs.mkdirSync(path.dirname(probe), { recursive: true });
  // The `finally` below runs on a failed assertion but not on a kill, and killing a slow run is something
  // CLAUDE.md actively recommends. So the sweep is here rather than only there — gitignored either way,
  // but a scratchpad that fills up with one file per killed run is a thing somebody has to explain later.
  for (const left of fs.readdirSync(path.dirname(probe))) {
    if (/^recorder-probe-\d+\.js$/.test(left)) fs.rmSync(path.join(path.dirname(probe), left), { force: true });
  }
  fs.writeFileSync(probe, [
    "const test = require('node:test');",
    "test('a plain one', () => {});",
    "for (const n of ['a', 'b', 'c']) test(`generated ` + n, () => {});",
    "const { it } = require('node:test');",
    "it('registers under its other name too', () => {});",
    '',
  ].join('\n'), 'utf8');
  try {
    assert.equal(testsRegisteredBy(probe), 5,
      'the recorder miscounted a module whose tests it can see written down — one plain, three from a '
      + 'loop, one under `it`. Every projection above is built on this number');
  } finally { fs.rmSync(probe, { force: true }); }
});
