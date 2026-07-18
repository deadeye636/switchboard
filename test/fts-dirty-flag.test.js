const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Unit tests for the FTS dirty-flag helpers (computeIndexSignature,
// shouldReindex, invalidateFtsSignature) introduced in perf/fts-dirty-flag.
//
// These helpers are pure / module-scoped — since #227 they live in src/app/plans-memory.js (moved out of
// main.js with the Plans/Memory/Work-Files handlers). They are exercised here via source-text extraction
// + vm.runInContext so we avoid pulling in Electron or better-sqlite3 (both compiled against Electron ABI).
// ---------------------------------------------------------------------------

const vm = require('vm');

const root = path.join(__dirname, '..');

function readSrc(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

// ---------------------------------------------------------------------------
// Extract the three helper functions from the plans-memory module source and run them in an isolated
// context so we get the live implementations without requiring the full Electron main-process graph.
// save-file-for-panel still lives in main.js and calls the module's invalidateFtsSignature — its wiring
// is verified against main.js below.
// ---------------------------------------------------------------------------

const mainSrc = readSrc('src/main.js');
const pmSrc = readSrc('src/app/plans-memory.js');

// Locate computeIndexSignature, shouldReindex, invalidateFtsSignature by extracting the block that starts
// at the _ftsIndexSignature declaration and ends just before the shared-scanning-helpers comment.
const blockStart = pmSrc.indexOf('/** @type {Map<string, string>} type -> last-indexed signature */');
const blockEnd   = pmSrc.indexOf('// --- shared scanning helpers ---');
assert.ok(blockStart !== -1, 'FTS dirty-flag block not found in plans-memory.js');
assert.ok(blockEnd   !== -1, '"// --- shared scanning helpers ---" marker not found in plans-memory.js');
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
  const result = vm.runInContext('shouldReindex("memory", "sig-v1")', ctx);
  assert.strictEqual(result, true, 'first call must return true (no prior signature)');
});

test('shouldReindex: returns false on second call with same signature', () => {
  const ctx = makeCtx();
  vm.runInContext('shouldReindex("memory", "sig-v1")', ctx); // prime
  const second = vm.runInContext('shouldReindex("memory", "sig-v1")', ctx);
  assert.strictEqual(second, false, 'same signature → skip reindex');
});

test('shouldReindex: returns true when signature changes (mtime/file change)', () => {
  const ctx = makeCtx();
  vm.runInContext('shouldReindex("memory", "sig-v1")', ctx);
  const changed = vm.runInContext('shouldReindex("memory", "sig-v2")', ctx);
  assert.strictEqual(changed, true, 'changed signature → reindex');
});

test('shouldReindex: types are independent (memory vs work-file)', () => {
  const ctx = makeCtx();
  vm.runInContext('shouldReindex("memory", "sig-m")', ctx);   // prime memory
  const workFileFirst = vm.runInContext('shouldReindex("work-file", "sig-m")', ctx);
  assert.strictEqual(workFileFirst, true, 'work-file type starts unindexed even if memory is primed');
});

test('shouldReindex: after priming both types, same sig → both skip', () => {
  const ctx = makeCtx();
  vm.runInContext('shouldReindex("memory",    "sig-m")', ctx);
  vm.runInContext('shouldReindex("work-file", "sig-w")', ctx);
  const memSkip  = vm.runInContext('shouldReindex("memory",    "sig-m")', ctx);
  const wfSkip   = vm.runInContext('shouldReindex("work-file", "sig-w")', ctx);
  assert.strictEqual(memSkip, false);
  assert.strictEqual(wfSkip,  false);
});

// ---------------------------------------------------------------------------
// 3. invalidateFtsSignature
// ---------------------------------------------------------------------------

test('invalidateFtsSignature: forces reindex on next shouldReindex call', () => {
  const ctx = makeCtx();
  vm.runInContext('shouldReindex("memory", "sig-v1")', ctx);            // prime
  vm.runInContext('invalidateFtsSignature("memory")', ctx);              // invalidate
  const after = vm.runInContext('shouldReindex("memory", "sig-v1")', ctx); // same sig but invalidated
  assert.strictEqual(after, true, 'after invalidation, shouldReindex must return true even for same sig');
});

test('invalidateFtsSignature: only clears the targeted type', () => {
  const ctx = makeCtx();
  vm.runInContext('shouldReindex("memory",    "sig-m")', ctx);
  vm.runInContext('shouldReindex("work-file", "sig-w")', ctx);
  vm.runInContext('invalidateFtsSignature("memory")', ctx);
  const memAfter = vm.runInContext('shouldReindex("memory",    "sig-m")', ctx);
  const wfAfter  = vm.runInContext('shouldReindex("work-file", "sig-w")', ctx);
  assert.strictEqual(memAfter, true,  'invalidated memory type must reindex');
  assert.strictEqual(wfAfter,  false, 'untouched work-file type must still skip');
});

test('invalidateFtsSignature: subsequent save with new sig re-primes correctly', () => {
  const ctx = makeCtx();
  vm.runInContext('shouldReindex("memory", "sig-v1")', ctx);
  vm.runInContext('invalidateFtsSignature("memory")', ctx);
  vm.runInContext('shouldReindex("memory", "sig-v2")', ctx); // re-prime with new sig
  const skipNew = vm.runInContext('shouldReindex("memory", "sig-v2")', ctx);
  assert.strictEqual(skipNew, false, 'after re-prime with new sig, same sig must skip');
});

// ---------------------------------------------------------------------------
// 4. Static-analysis: verify the dirty-flag is wired into both handlers in main.js
// ---------------------------------------------------------------------------

// Bound a function body in plans-memory.js: from `function <name>(` to the next top-level `function `.
function pmFnBody(name) {
  const start = pmSrc.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} not found in plans-memory.js`);
  const next = pmSrc.indexOf('\nfunction ', start + 1);
  return pmSrc.slice(start, next !== -1 ? next : start + 4000);
}

test('plans-memory getMemories uses shouldReindex("memory", ...)', () => {
  assert.match(pmFnBody('getMemories'), /shouldReindex\s*\(\s*['"]memory['"]/,
    "getMemories must call shouldReindex('memory', ...) to guard the FTS rebuild");
});

test('plans-memory getWorkFiles uses shouldReindex("work-file", ...)', () => {
  assert.match(pmFnBody('getWorkFiles'), /shouldReindex\s*\(\s*['"]work-file['"]/,
    "getWorkFiles must call shouldReindex('work-file', ...) to guard the FTS rebuild");
});

test('plans-memory saveMemory calls invalidateFtsSignature("memory")', () => {
  assert.match(pmFnBody('saveMemory'), /invalidateFtsSignature\s*\(\s*['"]memory['"]/,
    "saveMemory must call invalidateFtsSignature('memory') after writing");
});

test('plans-memory deleteWorkFile calls invalidateFtsSignature("work-file")', () => {
  assert.match(pmFnBody('deleteWorkFile'), /invalidateFtsSignature\s*\(\s*['"]work-file['"]/,
    "deleteWorkFile must call invalidateFtsSignature('work-file') after deletion");
});

test('plans-memory getMemories result is built BEFORE the shouldReindex guard (always returned)', () => {
  const body = pmFnBody('getMemories');
  const resultPos  = body.indexOf('const result = {');
  const reindexPos = body.indexOf("shouldReindex('memory'");
  assert.ok(resultPos  !== -1, 'const result = { not found in getMemories');
  assert.ok(reindexPos !== -1, "shouldReindex('memory' call not found in getMemories");
  assert.ok(resultPos < reindexPos,
    'result payload must be built BEFORE the shouldReindex guard (always-return invariant)');
});

test('plans-memory getWorkFiles result is returned AFTER the shouldReindex guard', () => {
  const body = pmFnBody('getWorkFiles');
  const reindexPos = body.indexOf("shouldReindex('work-file'");
  const returnPos  = body.lastIndexOf('return { projects }');
  assert.ok(reindexPos !== -1, "shouldReindex('work-file' call not found in getWorkFiles");
  assert.ok(returnPos  !== -1, 'return { projects } not found in getWorkFiles');
  assert.ok(reindexPos < returnPos,
    'shouldReindex guard must come BEFORE the final return { projects } (always-return invariant)');
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

// ---------------------------------------------------------------------------
// 6. Static-analysis: save-file-for-panel calls invalidateFtsSignature for
//    both tracked types (MAJOR-1 fix)
// ---------------------------------------------------------------------------

test('main.js save-file-for-panel calls invalidateFtsSignature("work-file") for .work-files/ paths', () => {
  const sfpStart = mainSrc.indexOf("ipcMain.handle('save-file-for-panel'");
  assert.ok(sfpStart !== -1, "save-file-for-panel handler not found in main.js");
  const nextHandler = mainSrc.indexOf('ipcMain.handle(', sfpStart + 1);
  const handlerBody = mainSrc.slice(sfpStart, nextHandler !== -1 ? nextHandler : sfpStart + 2000);
  assert.match(
    handlerBody,
    /invalidateFtsSignature\s*\(\s*['"]work-file['"]/,
    "save-file-for-panel must call invalidateFtsSignature('work-file') for .work-files/ paths"
  );
});

test('main.js save-file-for-panel calls invalidateFtsSignature("memory") for .md paths', () => {
  const sfpStart = mainSrc.indexOf("ipcMain.handle('save-file-for-panel'");
  assert.ok(sfpStart !== -1, "save-file-for-panel handler not found in main.js");
  const nextHandler = mainSrc.indexOf('ipcMain.handle(', sfpStart + 1);
  const handlerBody = mainSrc.slice(sfpStart, nextHandler !== -1 ? nextHandler : sfpStart + 2000);
  assert.match(
    handlerBody,
    /invalidateFtsSignature\s*\(\s*['"]memory['"]/,
    "save-file-for-panel must call invalidateFtsSignature('memory') for .md paths"
  );
});
