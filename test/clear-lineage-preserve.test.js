'use strict';
// #272: a cold-scan folder wipe must not drop a SOFT /clear lineage.
//
// The wipe deletes a folder's rows and re-inserts them, turning cacheUpsert's lineage COALESCE into an
// INSERT. resolveLineage can rebuild a fork link from the jsonl (forkedFrom) but NOT a /clear link
// (no on-disk parent), so without a re-merge the /clear grouping is lost on every restart. This pins
// that applyIndexResults reads the lineage before the wipe and re-applies it to the re-inserted rows.
//
// index-writes.js is the electron-free leaf (see worker-leaf-electron-free.test.js) — loadable under
// plain node with a mocked ctx.db.
const { test } = require('node:test');
const assert = require('node:assert');
const iw = require('../src/index/index-writes');

function makeCtx(folderLineage) {
  const calls = { upserted: [], wiped: [] };
  iw.init({
    getMainWindow: () => null,
    log: { info() {} },
    db: {
      getFolderLineage: (folder) => folderLineage[folder] || [],
      deleteCachedFolder: (f) => calls.wiped.push(f),
      deleteSearchFolder: () => {},
      upsertCachedSessions: (rows) => calls.upserted.push(...rows),
      deleteSearchSession: () => {},
      upsertSearchEntries: () => {},
      replaceSessionMetrics: () => {},
      deleteCachedSession: () => {},
      getMeta: () => null,
      setName: () => {},
      getProjectMeta: () => null,
    },
  });
  return calls;
}

// backendId with no registered descriptor → resolveLineage is never called → lin is null, exactly the
// /clear case (the scan cannot rebuild the link). Keeps the test independent of any real backend format.
const S = (extra) => ({ sessionId: 'child', folder: 'f1', backendId: 'no-such-backend-xyz', summary: '', textContent: '', ...extra });

test('#272: a folder wipe re-merges the soft /clear lineage onto the re-inserted row', () => {
  const calls = makeCtx({ f1: [{ sessionId: 'child', lineageParentId: 'parent', lineageKind: 'clear' }] });
  iw.applyIndexResults({ sessions: [S()], wipeFolders: [{ folder: 'f1', scope: {} }] });
  assert.deepEqual(calls.wiped, ['f1'], 'the folder was wiped');
  assert.equal(calls.upserted[0].lineageParentId, 'parent', 'the /clear parent survived the wipe');
  assert.equal(calls.upserted[0].lineageKind, 'clear', 'and its kind');
});

test('#272: a row with no recorded lineage stays blank — no phantom link invented', () => {
  const calls = makeCtx({ f1: [] });
  iw.applyIndexResults({ sessions: [S()], wipeFolders: [{ folder: 'f1', scope: {} }] });
  assert.ok(!calls.upserted[0].lineageParentId, 'no parent conjured');
  assert.ok(!calls.upserted[0].lineageKind);
});

test('#272: preserved lineage for an absent session is not resurrected', () => {
  // The old row had a /clear link but its session is gone this scan (not in `sessions`): it stays wiped.
  const calls = makeCtx({ f1: [{ sessionId: 'gone', lineageParentId: 'parent', lineageKind: 'clear' }] });
  iw.applyIndexResults({ sessions: [S({ sessionId: 'other' })], wipeFolders: [{ folder: 'f1', scope: {} }] });
  assert.equal(calls.upserted.length, 1);
  assert.equal(calls.upserted[0].sessionId, 'other');
  assert.ok(!calls.upserted[0].lineageParentId, 'the absent session did not leak its lineage onto another row');
});

test('#272: no wipe → no preserve pass (incremental upsert keeps its own COALESCE path)', () => {
  const calls = makeCtx({ f1: [{ sessionId: 'child', lineageParentId: 'parent', lineageKind: 'clear' }] });
  iw.applyIndexResults({ sessions: [S()], wipeFolders: [] }); // incremental, no wipe
  assert.deepEqual(calls.wiped, []);
  // Without a wipe the row is not re-merged here — the DB-level COALESCE (cacheUpsert) protects it.
  assert.ok(!calls.upserted[0].lineageParentId);
});

test('#272: a fresh fork link (resolveLineage) wins over a stale preserved clear link', () => {
  // The DB still holds a stale /clear link for this session, but the scan re-derives a HARD fork link
  // from the jsonl (Claude's forkedFrom). The fork must win — the preserved clear must not leak through.
  const calls = makeCtx({ f1: [{ sessionId: 'child', lineageParentId: 'stale-clear-parent', lineageKind: 'clear' }] });
  iw.applyIndexResults({
    // backendId 'claude' + forkedFrom → the real claude descriptor's resolveLineage returns a fork link.
    sessions: [{ sessionId: 'child', folder: 'f1', backendId: 'claude', forkedFrom: 'fork-parent', summary: '', textContent: '' }],
    wipeFolders: [{ folder: 'f1', scope: {} }],
  });
  assert.equal(calls.upserted[0].lineageParentId, 'fork-parent', 'the fork link won over the preserved clear');
  assert.equal(calls.upserted[0].lineageKind, 'fork');
});

test('#272: preserved clear lineage is kept per folder across multiple wipeFolders', () => {
  const calls = makeCtx({
    f1: [{ sessionId: 'a', lineageParentId: 'pa', lineageKind: 'clear' }],
    f2: [{ sessionId: 'b', lineageParentId: 'pb', lineageKind: 'clear' }],
  });
  iw.applyIndexResults({
    sessions: [S({ sessionId: 'a', folder: 'f1' }), S({ sessionId: 'b', folder: 'f2' })],
    wipeFolders: [{ folder: 'f1', scope: {} }, { folder: 'f2', scope: {} }],
  });
  const byId = Object.fromEntries(calls.upserted.map((r) => [r.sessionId, r]));
  assert.equal(byId.a.lineageParentId, 'pa', 'folder f1 kept its clear link');
  assert.equal(byId.b.lineageParentId, 'pb', 'folder f2 kept its clear link');
});
