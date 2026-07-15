// Session cache — FAÇADE (#199 step 4).
//
// This file used to be 1381 lines mixing four jobs. It is now a thin façade over the modules the jobs
// were split into, re-exporting the SAME names with function identity preserved so main.js and the tests
// need not change a single require. Nothing here has behaviour of its own except `init`, which fans the
// shared context out to every sub-module.
//
//   index-writes.js            — the ONE backend-neutral write sink + buildSearchEntry + claudeStoreScope
//                                 + the cross-sweep scan-state + the renderer-push helpers (the LEAF).
//   backends/claude/store-indexer.js — Claude's folder-driven store walk (refreshFolder/refreshFile/
//                                 reconcile/cold-scan + the Claude `prepare`, stampClaudeProvenance).
//   backend-scan.js            — the generic Axis-B store scanner (refreshBackendSessions et al.).
//   projects-view.js           — the sidebar/admin view builders + the auto-hide predicate.
//
// `init` must keep tolerating a PARTIAL ctx (tests init with subsets — every ctx.db.* read is guarded at
// its call site), and the `db: {…}` literal check in test/main-ctx-db-wiring.test.js now scans the
// sub-modules too, so a missing db function is still caught statically.

const backends = require('./backends');
const indexWrites = require('./index-writes');
const storeIndexer = require('./backends/claude/store-indexer');
const backendScan = require('./backend-scan');
const projectsView = require('./projects-view');

// Claude's readers come off its descriptor, shared with the scan worker via the same module.
const claude = backends.get('claude');

/**
 * Call init(ctx) once with the shared context object. Fans the ctx out to every sub-module; each picks
 * the fields it needs and tolerates the rest being absent.
 */
function init(ctx) {
  // index-writes first (the leaf every other module's writes funnel through), then the rest.
  indexWrites.init(ctx);
  storeIndexer.init(ctx);
  backendScan.init(ctx);
  projectsView.init(ctx);
}

module.exports = {
  init,
  // --- Claude store (store-indexer.js) ---
  readSessionFile: claude.readSessionFile,
  readFolderFromFilesystem: storeIndexer.readFolderFromFilesystem,
  refreshFolder: storeIndexer.refreshFolder,
  refreshFile: storeIndexer.refreshFile,
  resolveRowFilePath: storeIndexer.resolveRowFilePath,
  reconcileCacheFromFilesystem: storeIndexer.reconcileCacheFromFilesystem,
  flushPendingReindex: storeIndexer.flushPendingReindex,
  populateCacheViaWorker: storeIndexer.populateCacheViaWorker,
  terminateScanWorker: storeIndexer.terminateScanWorker,
  // --- generic Axis-B store scan (backend-scan.js) ---
  refreshBackendSessions: backendScan.refreshBackendSessions,
  refreshAllBackendSessions: backendScan.refreshAllBackendSessions,
  // --- neutral write sink + shared scan-state (index-writes.js) ---
  // Exposed so the IPC handlers that delete a folder's rows (remove-project, delete-project-sessions,
  // delete-worktree) can scope the delete exactly like the scanner does — a project folder key is shared
  // across backends, so an unscoped delete takes another backend's rows with it.
  claudeStoreScope: indexWrites.claudeStoreScope,
  getStoreProjectPaths: indexWrites.getStoreProjectPaths,
  notifyRendererProjectsChanged: indexWrites.notifyRendererProjectsChanged,
  sendStatus: indexWrites.sendStatus,
  // --- projects view (projects-view.js) ---
  buildProjectsFromCache: projectsView.buildProjectsFromCache,
  buildProjectsAdmin: projectsView.buildProjectsAdmin,
  shouldAutoHide: projectsView.shouldAutoHide,
};
