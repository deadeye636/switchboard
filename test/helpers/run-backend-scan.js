'use strict';

// The RUNTIME Axis-B scan path, driven in one call for the tests (#208). Since #199/#208 there is no on-main
// `refreshBackendSessions` any more: the index worker discovers + parses a backend's store
// (`workers/index-worker.runBackendReconcile`) and main replays the reply through `backend-scan.applyBackendReply`
// (exactly what `index-worker-client.applyReconcileReply` does per backend). This helper composes those two
// REAL production functions against the same fake db the test already `sessionCache.init`'d — so a test asserts
// the code that actually ships, not a re-implementation of the deleted function.
//
// It does NOT apply the §5.8 ready+enabled/claude/profile gate: that gate now lives in `axisBRoster()` (main
// filters the roster before the worker ever sees a backend), so the "disabled / claude / profile is never
// scanned" tests assert `backendScan.axisBRoster()` directly instead of calling this. The delete-epoch /
// removed-race guards that only the client applies are covered in test/index-worker.test.js via its transport
// seam — not here.

const backendScan = require('../../src/backends/scan');
const indexWorker = require('../../src/workers/index-worker');

// Returns { scanned, upserted, skipped, deleted } — the same shape the old refreshBackendSessions did, so a
// test can read stats.upserted / stats.deleted unchanged.
function runBackendScan(id, { force = false } = {}) {
  const cached = backendScan.cachedRowsOfBackend(id);
  const out = indexWorker.runBackendReconcile(id, { snapshot: { backends: { [id]: cached } }, force });
  const stats = { scanned: 0, upserted: 0, skipped: 0, deleted: 0 };
  // storeMissing → main keeps the cached rows untouched (mirrors index-worker-client: `if (storeMissing) continue`).
  if (!out.storeMissing) backendScan.applyBackendReply(id, out.reply, { cached, stats });
  return stats;
}

module.exports = { runBackendScan };
