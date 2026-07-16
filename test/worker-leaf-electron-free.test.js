'use strict';
// #199 step 5.2a / F5 — LOCK the Electron-free precondition the step-5 index worker rests on.
//
// The pure parse-loops were lifted into Electron-free LEAVES (backends/claude/folder-parse.js,
// backend-parse.js) so the future worker can require ONLY the leaf + the backends registry, never
// index-writes (→ backends + a Worker spawn) or electron. A worker_threads Worker has no electron `app`,
// no `BrowserWindow` — if any of these modules pull electron at LOAD, requiring them off the main thread
// throws, and the whole off-thread move regresses silently. These tests spawn a trivial Worker that
// requires each target and posts ok; a descriptor that later drags in electron turns this red.
//
// Two guards:
//   1. the backends REGISTRY (backends/index.js) — a future descriptor must not regress it (plan F5).
//   2. the two new LEAVES require cleanly in a worker context.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Worker } = require('worker_threads');

// Require `modAbsPath` inside a bare worker_threads Worker; resolve { ok, error } with what happened.
function requireInWorker(modAbsPath) {
  return new Promise((resolve) => {
    const code = `
      const { parentPort, workerData } = require('worker_threads');
      try { require(workerData.mod); parentPort.postMessage({ ok: true }); }
      catch (e) { parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) }); }
    `;
    const w = new Worker(code, { eval: true, workerData: { mod: modAbsPath } });
    let settled = false;
    const done = (msg) => { if (settled) return; settled = true; try { w.terminate(); } catch {} resolve(msg); };
    w.on('message', done);
    w.on('error', (e) => done({ ok: false, error: (e && e.message) || String(e) }));
    w.on('exit', (exitCode) => { if (!settled) done({ ok: false, error: 'worker exited ' + exitCode }); });
  });
}

const abs = (rel) => path.resolve(__dirname, '..', rel);

test('the backends registry requires without throwing in a bare worker_threads Worker (F5 precondition)', async () => {
  const r = await requireInWorker(abs('src/backends/index.js'));
  assert.equal(r.ok, true, `require('backends') threw in a worker: ${r.error}`);
});

test('backends/claude/folder-parse (the Claude parse leaf) requires cleanly in a worker context', async () => {
  const r = await requireInWorker(abs('src/backends/claude/folder-parse.js'));
  assert.equal(r.ok, true, `require('backends/claude/folder-parse') threw in a worker: ${r.error}`);
});

test('backend-parse (the Axis-B parse leaf) requires cleanly in a worker context', async () => {
  const r = await requireInWorker(abs('src/backends/parse.js'));
  assert.equal(r.ok, true, `require('backend-parse') threw in a worker: ${r.error}`);
});

// #199 step 5.2b — the persistent index worker itself must require cleanly off-thread: it pulls the two
// leaves + the backends registry + the fs-only gate/derive helpers, and NONE may drag in electron. This is
// the module that actually runs in the Worker, so it is the real precondition; the leaf tests above guard
// its pieces, this guards the assembled whole.
test('workers/index-worker (the persistent index worker) requires cleanly in a worker context', async () => {
  const r = await requireInWorker(abs('src/workers/index-worker.js'));
  assert.equal(r.ok, true, `require('workers/index-worker') threw in a worker: ${r.error}`);
});

// Belt-and-braces: the leaves must NOT drag electron / index-writes / the backends registry into their
// transitive require graph (the thing that would make the worker require throw once a descriptor regresses).
// Loaded here in a fresh child require-cache so the main-thread suite's already-warm modules don't mask it.
test('the parse leaves pull no electron / index-writes / backends-registry into their require graph', () => {
  const { execFileSync } = require('child_process');
  const script = `
    const path = require('path');
    const FORBIDDEN = [/node_modules[\\\\/]electron[\\\\/]/i, /(^|[\\\\/])index-writes\\.js$/, /backends[\\\\/]index\\.js$/];
    function graph(entry) {
      for (const k of Object.keys(require.cache)) delete require.cache[k];
      require(entry);
      return Object.keys(require.cache);
    }
    let bad = [];
    for (const e of [process.argv[1], process.argv[2]]) {
      for (const f of graph(e)) if (FORBIDDEN.some(re => re.test(f))) bad.push(f);
    }
    if (bad.length) { console.error('FORBIDDEN: ' + bad.join(',')); process.exit(1); }
    process.exit(0);
  `;
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['-e', script, abs('src/backends/claude/folder-parse.js'), abs('src/backends/parse.js')], { stdio: 'pipe' });
  }, 'a parse leaf dragged electron / index-writes / the backends registry into its require graph');
});
