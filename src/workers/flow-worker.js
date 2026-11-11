'use strict';
// The session-flow worker (spec 46, #826, plan T6): one short-lived worker per Refresh, started and terminated by
// `src/app/session-flow.js`. Terminating it IS the cancel, so it does not look at a signal.
//
// It loads the backend registry and nothing else of the app. That is checked, not assumed: `src/backends/index.js`
// pulls in `perf_hooks`, `fs`, `path`, `os`, `crypto`, `child_process`, `smol-toml` and the descriptors, which
// are Electron-free, log-free and db-free (the index worker requires the same registry). The reader behind the
// descriptor's `readSessionFlow` is loaded lazily, so only the one backend's reader is read in. A profile never
// reaches here by its own id: main sends the BASE backend's id, because the registry in a worker holds the
// built-ins only.
//
// workerData: { backendId, sources, windowHint }. The reply is ONE message, structured-cloned:
//   { type: 'result', snapshot, loadMs, readMs, replyBytes }  or  { type: 'failed', reason }
// `sources` carries absolute paths and stays in main and this worker; the snapshot has none.

const { parentPort, workerData } = require('worker_threads');
const { performance } = require('perf_hooks');

async function run() {
  const t0 = performance.now();
  const backends = require('../backends');
  const backend = backends.get(workerData.backendId);
  if (!backend || typeof backend.readSessionFlow !== 'function') {
    parentPort.postMessage({ type: 'failed', reason: 'no-reader' });
    return;
  }
  const loadMs = performance.now() - t0;
  const t1 = performance.now();
  // A reader that reads more files than `sources` names (Codex's subagent rollouts) reports them here, so main can poll them
  // for growth; the paths stay out of the snapshot.
  let files = [];
  const snapshot = await backend.readSessionFlow(workerData.sources, { windowHint: workerData.windowHint || null, onFiles: (list) => { if (Array.isArray(list)) files = list.slice(0, 200); } });
  const readMs = performance.now() - t1;
  // Measured here, off the main thread, so the debug line can say how big the reply is.
  let replyBytes = 0;
  try { replyBytes = Buffer.byteLength(JSON.stringify(snapshot)); } catch { /* not measurable: 0 */ }
  parentPort.postMessage({ type: 'result', snapshot, files, loadMs, readMs, replyBytes });
}

run().catch(() => {
  // The message of a raw error may carry a path; the reason is a fixed word and main logs nothing more.
  parentPort.postMessage({ type: 'failed', reason: 'read-failed' });
});
