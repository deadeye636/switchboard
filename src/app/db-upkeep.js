// When the database is compacted, and how much of it (#430).
//
// The SQL is in `src/db/compact.js`; what is decided HERE is the part that needs to know about the app:
// how long after boot, whether a session is running, and what to write in the log.
//
// THREE RULES, EACH PAID FOR BY SOMETHING THAT WOULD BE WORSE:
//
//   - **Not on the startup path.** The first render must not wait on upkeep, and the cold-start scan
//     (populateCacheViaWorker) is writing to the very tables this touches. So it runs on a timer, well
//     after boot, and the timer is unref'd — an upkeep pass never keeps the app alive at quit.
//   - **No full vacuum while a session is running.** VACUUM holds an exclusive lock for its whole
//     duration, and the PTY side of a live CLI is doing DB work between keystrokes. Defer costs nothing:
//     the next launch asks again, and a machine where a session is ALWAYS running still gets the
//     incremental pass, which hands pages back without the exclusive rewrite.
//   - **Merge first, reclaim second.** `optimize` frees pages into the freelist without shrinking the
//     file; the vacuum is what gives them back. Deciding on the freelist BEFORE the merge would read
//     the waste the merge is about to create as absent, and skip the reclaim that pays for the pass.
//
// The whole thing is one `log.info` line per launch, because it is a lifecycle event: what ran, what it
// cost, what it bought. Anything finer belongs at debug — this fires once.
'use strict';

// Long enough that the cold-start scan is done on any realistic machine, and far enough from boot that
// the first render never shares a disk with it.
const DEFAULT_DELAY_MS = 90_000;

let ctx = null;
let timer = null;
let ran = false;

/**
 * @param {object} context
 * @param {object} context.db  freeSpace / optimizeSearchIndex / needsFullVacuum / incrementalVacuum /
 *   fullVacuum / autoVacuumMode — the compact.js surface, through the db.js façade
 * @param {Map} context.activeSessions  live sessions; a non-empty map defers the expensive form
 * @param {() => boolean} context.getAppQuitting  a quit that beat the timer must not start a VACUUM
 * @param {object} context.log
 */
function init(context) {
  ctx = context;
  ran = false;
}

const mb = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';

// The pass itself. Exported for the probe and for a test — calling it twice is harmless, but `ran`
// keeps the scheduled one from doubling up with a manual call.
function runUpkeep({ force = false } = {}) {
  if (!ctx) return { ok: false, skipped: 'not initialised' };
  if (ran && !force) return { ok: true, skipped: 'already ran this launch' };
  ran = true;
  if (ctx.getAppQuitting && ctx.getAppQuitting()) return { ok: true, skipped: 'quitting' };

  const before = ctx.db.freeSpace();
  const merge = ctx.db.optimizeSearchIndex();

  // Now — and only now — is the freelist the truth about what can be handed back.
  const afterMerge = ctx.db.freeSpace();
  const sessionsRunning = ctx.activeSessions ? ctx.activeSessions.size : 0;
  const wantsFull = ctx.db.needsFullVacuum(afterMerge);

  let reclaim = { ok: true, ms: 0, reclaimedBytes: 0 };
  let form = 'none';
  if (wantsFull && sessionsRunning === 0) {
    form = 'full';
    reclaim = ctx.db.fullVacuum();
  } else if (afterMerge.freelist > 0) {
    // Either the waste is small, or a session is live and the exclusive form is deferred to the next
    // launch. The incremental pass needs auto_vacuum=INCREMENTAL, which only a database created since
    // #430 has — on an older one it reclaims nothing and says so, rather than pretending.
    form = ctx.db.autoVacuumMode() === 2 ? 'incremental' : 'deferred';
    if (form === 'incremental') reclaim = ctx.db.incrementalVacuum();
  }

  const after = ctx.db.freeSpace();
  const deferredWhy = form === 'deferred'
    ? (wantsFull ? (sessionsRunning ? ' (a session is running)' : ' (no incremental mode on this database)') : '')
    : (wantsFull && sessionsRunning ? ' (full vacuum deferred — a session is running)' : '');
  ctx.log.info(
    `[db-upkeep] merge ${merge.ok ? merge.ms + ' ms' : 'FAILED: ' + merge.error} · ` +
    `reclaim ${form}${reclaim.ms ? ' ' + reclaim.ms + ' ms' : ''}${deferredWhy} · ` +
    `${mb(before.totalBytes)} -> ${mb(after.totalBytes)}, ${mb(after.freeBytes)} free`,
  );

  return {
    ok: merge.ok && reclaim.ok,
    form,
    sessionsRunning,
    beforeBytes: before.totalBytes,
    afterBytes: after.totalBytes,
    mergeMs: merge.ms,
    reclaimMs: reclaim.ms,
  };
}

// Called from the boot sequence. Returns the timer so a caller can reason about it; the timer is
// unref'd, so it never holds the process open.
function start({ delayMs = DEFAULT_DELAY_MS } = {}) {
  if (timer) return timer;
  timer = setTimeout(() => {
    timer = null;
    try { runUpkeep(); } catch (err) {
      ctx.log.warn('[db-upkeep] pass failed:', err && err.message ? err.message : err);
    }
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function stop() {
  if (timer) { clearTimeout(timer); timer = null; }
}

module.exports = { init, start, stop, runUpkeep, DEFAULT_DELAY_MS };
