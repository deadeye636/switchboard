const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Unit tests for the FTS dirty-flag helpers (computeIndexSignature,
// shouldReindex, invalidateFtsSignature) introduced in perf/fts-dirty-flag.
//
// These helpers are pure / module-scoped — since #227 they live in src/app/plans-memory.js (moved out of
// main.js with the Plans handlers). They are exercised here via source-text extraction
// + vm.runInContext so we avoid pulling in Electron or db.js (which opens the app's own database when required).
// ---------------------------------------------------------------------------

const vm = require('vm');

const root = path.join(__dirname, '..');

function readSrc(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

// ---------------------------------------------------------------------------
// Extract the three helper functions from the plans-memory module source and run them in an isolated
// context so we get the live implementations without requiring the full Electron main-process graph.
// is verified against main.js below.
// ---------------------------------------------------------------------------

const pmSrc = readSrc('src/app/plans-memory.js');

// Locate computeIndexSignature, shouldReindex, invalidateFtsSignature by extracting the block that starts
// at the _ftsIndexSignature declaration and ends just before the "Plans" section comment.
const blockStart = pmSrc.indexOf('/** @type {Map<string, string>} type -> last-indexed signature */');
const blockEnd   = pmSrc.indexOf('// --- Plans ---');
assert.ok(blockStart !== -1, 'FTS dirty-flag block not found in plans-memory.js');
assert.ok(blockEnd   !== -1, '"// --- Plans ---" marker not found in plans-memory.js');
assert.ok(blockStart < blockEnd, 'Block markers are in wrong order');

const helpersSrc = pmSrc.slice(blockStart, blockEnd);

// Create a fresh context for each test suite so the Map starts empty.
function makeCtx() {
  const ctx = vm.createContext({});
  vm.runInContext(helpersSrc, ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// 1. computeIndexSignature
// ---------------------------------------------------------------------------

test('computeIndexSignature: empty array returns empty string', () => {
  const ctx = makeCtx();
  const sig = vm.runInContext('computeIndexSignature([])', ctx);
  assert.strictEqual(sig, '');
});

test('computeIndexSignature: single file encodes filePath NUL mtimeMs NUL size', () => {
  const ctx = makeCtx();
  const sig = vm.runInContext(
    'computeIndexSignature([{filePath: "/a/b.md", mtimeMs: 1000, size: 42}])',
    ctx
  );
  assert.strictEqual(sig, '/a/b.md\x001000\x0042');
});

test('computeIndexSignature: output is sorted by filePath (order-independent)', () => {
  const ctx = makeCtx();
  const sigA = vm.runInContext(
    'computeIndexSignature([{filePath:"/z.md",mtimeMs:1,size:0},{filePath:"/a.md",mtimeMs:2,size:0}])',
    ctx
  );
  const sigB = vm.runInContext(
    'computeIndexSignature([{filePath:"/a.md",mtimeMs:2,size:0},{filePath:"/z.md",mtimeMs:1,size:0}])',
    ctx
  );
  assert.strictEqual(sigA, sigB, 'signature must be order-independent');
  assert.ok(sigA.startsWith('/a.md\x00'), 'sorted output must start with /a.md NUL-delimited');
});

test('computeIndexSignature: different mtime produces different signature', () => {
  const ctx = makeCtx();
  const base = [{filePath: '/x.md', mtimeMs: 1000, size: 10}];
  const modified = [{filePath: '/x.md', mtimeMs: 2000, size: 10}];
  const sigBase  = vm.runInContext(`computeIndexSignature(${JSON.stringify(base)})`, ctx);
  const sigMod   = vm.runInContext(`computeIndexSignature(${JSON.stringify(modified)})`, ctx);
  assert.notStrictEqual(sigBase, sigMod, 'changed mtime must yield a different signature');
});

test('computeIndexSignature: different size produces different signature', () => {
  const ctx = makeCtx();
  const sigA = vm.runInContext(
    'computeIndexSignature([{filePath:"/x.md",mtimeMs:1000,size:10}])',
    ctx
  );
  const sigB = vm.runInContext(
    'computeIndexSignature([{filePath:"/x.md",mtimeMs:1000,size:99}])',
    ctx
  );
  assert.notStrictEqual(sigA, sigB, 'changed size must yield a different signature');
});

test('computeIndexSignature: added file produces different signature', () => {
  const ctx = makeCtx();
  const one = [{filePath: '/a.md', mtimeMs: 1, size: 0}];
  const two = [{filePath: '/a.md', mtimeMs: 1, size: 0}, {filePath: '/b.md', mtimeMs: 1, size: 0}];
  const sigOne = vm.runInContext(`computeIndexSignature(${JSON.stringify(one)})`, ctx);
  const sigTwo = vm.runInContext(`computeIndexSignature(${JSON.stringify(two)})`, ctx);
  assert.notStrictEqual(sigOne, sigTwo, 'adding a file must yield a different signature');
});

test('computeIndexSignature: removed file produces different signature', () => {
  const ctx = makeCtx();
  const two = [{filePath: '/a.md', mtimeMs: 1, size: 0}, {filePath: '/b.md', mtimeMs: 1, size: 0}];
  const one = [{filePath: '/a.md', mtimeMs: 1, size: 0}];
  const sigTwo = vm.runInContext(`computeIndexSignature(${JSON.stringify(two)})`, ctx);
  const sigOne = vm.runInContext(`computeIndexSignature(${JSON.stringify(one)})`, ctx);
  assert.notStrictEqual(sigTwo, sigOne, 'removing a file must yield a different signature');
});

// ---------------------------------------------------------------------------
// 2. shouldReindex
// ---------------------------------------------------------------------------

test('shouldReindex: returns true and stores signature on first call (never indexed)', () => {
  const ctx = makeCtx();
  const result = vm.runInContext('shouldReindex("plan", "sig-v1")', ctx);
  assert.strictEqual(result, true, 'first call must return true (no prior signature)');
});

test('shouldReindex: returns false on second call with same signature', () => {
  const ctx = makeCtx();
  vm.runInContext('shouldReindex("plan", "sig-v1")', ctx); // prime
  const second = vm.runInContext('shouldReindex("plan", "sig-v1")', ctx);
  assert.strictEqual(second, false, 'same signature → skip reindex');
});

test('shouldReindex: returns true when signature changes (mtime/file change)', () => {
  const ctx = makeCtx();
  vm.runInContext('shouldReindex("plan", "sig-v1")', ctx);
  const changed = vm.runInContext('shouldReindex("plan", "sig-v2")', ctx);
  assert.strictEqual(changed, true, 'changed signature → reindex');
});

test('shouldReindex: types are independent (plan vs other)', () => {
  const ctx = makeCtx();
  vm.runInContext('shouldReindex("plan", "sig-m")', ctx);   // prime plan
  const otherFirst = vm.runInContext('shouldReindex("other", "sig-m")', ctx);
  assert.strictEqual(otherFirst, true, 'another type starts unindexed even if plan is primed');
});

test('shouldReindex: after priming both types, same sig → both skip', () => {
  const ctx = makeCtx();
  vm.runInContext('shouldReindex("plan",  "sig-m")', ctx);
  vm.runInContext('shouldReindex("other", "sig-w")', ctx);
  const memSkip  = vm.runInContext('shouldReindex("plan",  "sig-m")', ctx);
  const wfSkip   = vm.runInContext('shouldReindex("other", "sig-w")', ctx);
  assert.strictEqual(memSkip, false);
  assert.strictEqual(wfSkip,  false);
});

// ---------------------------------------------------------------------------
// 3. invalidateFtsSignature
// ---------------------------------------------------------------------------

test('invalidateFtsSignature: forces reindex on next shouldReindex call', () => {
  const ctx = makeCtx();
  vm.runInContext('shouldReindex("plan", "sig-v1")', ctx);            // prime
  vm.runInContext('invalidateFtsSignature("plan")', ctx);              // invalidate
  const after = vm.runInContext('shouldReindex("plan", "sig-v1")', ctx); // same sig but invalidated
  assert.strictEqual(after, true, 'after invalidation, shouldReindex must return true even for same sig');
});

test('invalidateFtsSignature: only clears the targeted type', () => {
  const ctx = makeCtx();
  vm.runInContext('shouldReindex("plan",  "sig-m")', ctx);
  vm.runInContext('shouldReindex("other", "sig-w")', ctx);
  vm.runInContext('invalidateFtsSignature("plan")', ctx);
  const memAfter = vm.runInContext('shouldReindex("plan",  "sig-m")', ctx);
  const wfAfter  = vm.runInContext('shouldReindex("other", "sig-w")', ctx);
  assert.strictEqual(memAfter, true,  'invalidated type must reindex');
  assert.strictEqual(wfAfter,  false, 'untouched type must still skip');
});

test('invalidateFtsSignature: subsequent save with new sig re-primes correctly', () => {
  const ctx = makeCtx();
  vm.runInContext('shouldReindex("plan", "sig-v1")', ctx);
  vm.runInContext('invalidateFtsSignature("plan")', ctx);
  vm.runInContext('shouldReindex("plan", "sig-v2")', ctx); // re-prime with new sig
  const skipNew = vm.runInContext('shouldReindex("plan", "sig-v2")', ctx);
  assert.strictEqual(skipNew, false, 'after re-prime with new sig, same sig must skip');
});

// ---------------------------------------------------------------------------
// 4. Static-analysis: the dirty-flag is wired into the plans handlers
// ---------------------------------------------------------------------------

// Bound a function body in plans-memory.js: from `function <name>(` to the next top-level `function `.
function pmFnBody(name) {
  const start = pmSrc.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} not found in plans-memory.js`);
  const next = pmSrc.indexOf('\nfunction ', start + 1);
  return pmSrc.slice(start, next !== -1 ? next : start + 4000);
}

test('plans-memory getPlans uses shouldReindex("plan", ...)', () => {
  assert.match(pmFnBody('getPlans'), /shouldReindex\s*\(\s*['"]plan['"]/,
    "getPlans must call shouldReindex('plan', ...) to guard the FTS rebuild");
});

test('plans-memory savePlan calls invalidateFtsSignature("plan")', () => {
  assert.match(pmFnBody('savePlan'), /invalidateFtsSignature\s*\(\s*['"]plan['"]/,
    "savePlan must call invalidateFtsSignature('plan') after writing");
});

// The Agent Files tab's FTS types are retired (#823 T12): nothing indexes them, and rows an older version left
// are deleted at start. No migration - the delete is idempotent and the schema is untouched.
test('plans-memory indexes no memory or work-file type and drops their old rows at init', () => {
  assert.doesNotMatch(pmSrc, /shouldReindex\s*\(\s*['"](memory|work-file)['"]/);
  assert.doesNotMatch(pmSrc, /type:\s*['"](memory|work-file)['"]/);
  assert.match(pmFnBody('dropRetiredSearchTypes'), /\[\s*'memory',\s*'work-file'\s*\]/);
  assert.match(pmFnBody('init'), /dropRetiredSearchTypes\(\)/);
});

// ---------------------------------------------------------------------------
// 5. NUL-delimiter: paths with colon-digit-digit characters cannot collide
// ---------------------------------------------------------------------------

test('computeIndexSignature: NUL delimiter prevents collision from paths containing colon-digit sequences', () => {
  const ctx = makeCtx();
  // Under the old ':' + '|' scheme these two sets produced identical strings:
  //   setA: [{filePath: '/a.md:100:0|/b.md', mtimeMs: 200, size: 3}]
  //   setB: [{filePath: '/a.md', mtimeMs: 100, size: 0}, {filePath: '/b.md', mtimeMs: 200, size: 3}]
  // Both yielded "/a.md:100:0|/b.md:200:3".
  // With NUL/newline separators the two sets must produce distinct strings.
  const setA = [{filePath: '/a.md:100:0|/b.md', mtimeMs: 200, size: 3}];
  const setB = [{filePath: '/a.md', mtimeMs: 100, size: 0}, {filePath: '/b.md', mtimeMs: 200, size: 3}];
  const sigA = vm.runInContext(`computeIndexSignature(${JSON.stringify(setA)})`, ctx);
  const sigB = vm.runInContext(`computeIndexSignature(${JSON.stringify(setB)})`, ctx);
  assert.notStrictEqual(sigA, sigB, 'paths with colon-digit literals must not collide with separate-file entries');
});

// Behaviour of the retired-type cleanup: every init asks the db to drop both types, once each.
test('plans-memory init deletes the rows of the retired memory and work-file types, once per init', () => {
  const plansMemory = require('../src/app/plans-memory');
  const deleted = [];
  const ctx = {
    backends: { list: () => [] }, activeSessions: new Map(),
    log: { warn() {}, error() {}, info() {}, debug() {} },
    db: {
      getProjectStates: () => new Map(), getProjectDisplayNames: () => new Map(), getAllFolderMeta: () => new Map(),
      deleteSearchType: (type) => deleted.push(type), upsertSearchEntries() {},
    },
  };
  try {
    plansMemory.init(ctx);
    assert.deepStrictEqual(deleted.slice().sort(), ['memory', 'work-file']);
    plansMemory.init(ctx);
    assert.deepStrictEqual(deleted.slice().sort(), ['memory', 'memory', 'work-file', 'work-file']);
    // A db without the method (a partial test ctx) is tolerated.
    assert.doesNotThrow(() => plansMemory.init({ ...ctx, db: {} }));
  } finally { plansMemory.stopWatchingPlansDirs(); }
});
