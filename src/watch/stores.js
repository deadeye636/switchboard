// Live watch on the OTHER backends' session stores (T-4.8).
//
// Scan-generalization (T-4.2) is not watch-generalization. The projects watcher is Claude-shaped: it
// watches PROJECTS_DIR and speaks in folders + per-file refreshes. A backend with its own store needs
// its own watch, and it operates on STORE-level targets (a dir root, or a db file), not on the
// per-session handles discovery returns — hence the separate `watchTargets()` hook.
//
// Two things bite here:
//   - Codex's tree is DATE-BUCKETED (sessions/YYYY/MM/DD/). A naive watch on today's directory goes
//     stale at MIDNIGHT (tomorrow's dir does not exist yet) and misses the dir a fresh session
//     creates. A recursive watch on the sessions ROOT covers both.
//   - The root may not exist yet (no session ever run). Watching it would throw, so we retry.
//
// A db-kind target (Hermes' state.db, Phase 5) polls the file AND its `-wal` sibling: a plain
// state.db mtime misses WAL-buffered commits.
'use strict';

const fs = require('fs');
// Required directly, NOT taken through ctx, and that is deliberate: adopt.js is a sibling module, not a
// piece of main.js's mutable state. The ctx rule exists to stop a module capturing a `let` main.js
// reassigns; a module reference is not that. Both this file and main.js resolve the same path, so they
// hold the same instance and the same liveStoreRef/liveBusy.
const adopt = require('./adopt');

let ctx = null;
const backendWatchers = [];
let backendBusyTicker = null;   // slow re-check so a hung backend cannot stay BUSY forever
let backendWatcherRetry = null;

/**
 * @param {object} context
 * @param {object} context.backends  the registry
 * @param {() => boolean} context.getAppQuitting  a GETTER — it flips during quit
 * @param {object} context.indexWorker
 * @param {object} context.log
 */
function init(context) {
  ctx = context;
}

function startBackendWatchers() {
  stopBackendWatchers();

  const DEBOUNCE_MS = 600;
  const pending = new Set();       // backendIds with unflushed changes
  let debounceTimer = null;
  let missingRoot = false;

  function flush() {
    debounceTimer = null;
    if (ctx.getAppQuitting()) return;
    pending.clear();
    // #208: the per-backend parse moved OFF the main thread. A store change posts a reconcile to the index
    // worker (it scans the whole ready+enabled Axis-B roster — the sweep is coalesced with the get-projects
    // sweeps through the same gate). The worker parses; main applies the reply and pushes projects-changed
    // CONDITIONALLY via afterReconcile. `pending` (which backend changed) is no longer needed to target the
    // scan — the worker rescans the roster — so it is just reset here.
    try { ctx.indexWorker.postReconcile(); } catch (err) { ctx.log.warn(`[watch] backend reconcile post failed: ${err?.message || err}`); }
    // The store that just changed is also the busy/idle signal — and the place a freshly launched session's
    // real id first appears (T-4.5 / T-5.3). This reads the live PTY set, NOT a transcript, so it stays
    // synchronous on main: the spinner must update at once, not after a worker round-trip.
    try { adopt.updateBackendLiveStates(); } catch (err) { ctx.log.warn(`[backends] live-state update failed: ${err?.message || err}`); }
  }

  function schedule(backendId) {
    pending.add(backendId);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  for (const backend of ctx.backends.launchable()) {
    // Claude (and every Axis-A profile, which shares Claude's store) is already covered by
    // startProjectsWatcher — watching it twice would double every refresh.
    if (backend.axis !== 'B' || typeof backend.watchTargets !== 'function') continue;

    let targets = [];
    try { targets = backend.watchTargets() || []; } catch { continue; }

    for (const target of targets) {
      if (!target || !target.path) continue;

      if (target.kind === 'db') {
        // Poll the DB and its write-ahead log: a commit can land in the -wal without touching the
        // main file's mtime, so watching state.db alone would miss live sessions.
        for (const file of [target.path, target.path + '-wal']) {
          try {
            fs.watchFile(file, { interval: 2000, persistent: false }, (cur, prev) => {
              if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) schedule(backend.id);
            });
            backendWatchers.push({ kind: 'poll', file });
          } catch { /* best effort */ }
        }
        continue;
      }

      // dir-kind (Codex, later Pi).
      if (!fs.existsSync(target.path)) {
        // No session has ever been run for this backend — nothing to watch yet. Re-arm later so the
        // very first session still shows up live rather than only after a restart.
        missingRoot = true;
        continue;
      }
      // Which filenames are this backend's transcripts. The target declares it (file-store's `match`,
      // which also accepts a `-wal`/`-shm` sibling for a WAL-buffered store like agy); the `.jsonl`
      // fallback keeps any target that declares none behaving as before. A hardcoded `.jsonl` here made
      // agy's `.db` store invisible to the watcher, so its busy edge only ever surfaced on the slow tick
      // below, never during the turn.
      const matchFile = typeof target.match === 'function'
        ? target.match
        : (filename) => String(filename).endsWith('.jsonl');
      try {
        const w = fs.watch(target.path, { recursive: target.recursive !== false }, (_evt, filename) => {
          if (!filename) return;
          // Only session files matter; ignore the dir churn of the date buckets themselves.
          if (!matchFile(filename)) return;
          schedule(backend.id);
        });
        w.on('error', (err) => ctx.log.warn(`[watch] backend ${backend.id} watcher error: ${err?.message || err}`));
        backendWatchers.push({ kind: 'watch', watcher: w });
        ctx.log.info(`[watch] backend=${backend.id} watching ${target.path}`);
      } catch (err) {
        ctx.log.warn(`[watch] backend ${backend.id} watch failed: ${err?.message || err}`);
      }
    }
  }

  // A store root that doesn't exist yet (or a backend the user just enabled) — re-arm periodically so
  // it starts being watched without a restart.
  if (missingRoot && !backendWatcherRetry) {
    backendWatcherRetry = setTimeout(() => {
      backendWatcherRetry = null;
      if (!ctx.getAppQuitting()) startBackendWatchers();
    }, 60000);
    if (backendWatcherRetry.unref) backendWatcherRetry.unref();
  }

  // Busy/idle for these backends is derived from their STORE, and the store only tells us something
  // when it changes. A backend that hangs mid-turn writes nothing more — so the last edge we pushed
  // (BUSY) would stand forever, and every backend's state logic has a staleness rule that never gets a
  // chance to run. This slow tick gives it one.
  //
  // It also has to run for a session we have NOT paired with a record yet, and that is not a nicety: the
  // store-changed watcher cannot fire when the store does not exist. Hermes in degraded mode (it writes
  // JSON because it could not open its own database) never touches state.db, so nothing changes, so
  // nothing ticks — and gating this on "something is busy" made it worse, because an unpaired session can
  // never BE busy. One Hermes session on a broken store would then sit there in silence, which is exactly
  // the condition #151 exists to speak up about. So: tick while anything is busy, OR while anything is
  // still unpaired. An app with no live backend session does no work either way.
  if (!backendBusyTicker) {
    backendBusyTicker = setInterval(() => {
      if (ctx.getAppQuitting()) return;
      let anyBusy = false;
      for (const busy of adopt.liveBusy.values()) if (busy) { anyBusy = true; break; }
      if (!anyBusy && !adopt.hasUnclaimedStoreSession()) return;
      try { adopt.updateBackendLiveStates(); } catch (err) {
        ctx.log.warn(`[backends] busy re-check failed: ${err?.message || err}`);
      }
    }, 30000);
    if (backendBusyTicker.unref) backendBusyTicker.unref();
  }
}

function stopBackendWatchers() {
  for (const entry of backendWatchers) {
    try {
      if (entry.kind === 'watch') entry.watcher.close();
      else if (entry.kind === 'poll') fs.unwatchFile(entry.file);
    } catch { /* best effort */ }
  }
  backendWatchers.length = 0;
  if (backendWatcherRetry) { clearTimeout(backendWatcherRetry); backendWatcherRetry = null; }
  if (backendBusyTicker) { clearInterval(backendBusyTicker); backendBusyTicker = null; }
}

module.exports = { init, startBackendWatchers, stopBackendWatchers };
