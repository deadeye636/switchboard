// The upkeep POLICY (#430): when the database is compacted, how much of it, and what is written down.
//
// WHY THIS EXISTS:
//   The SQL half (src/db/compact.js) cannot be tested here — better-sqlite3 is built against Electron's
//   ABI and no test loads db.js — so scripts/db-probe.js is what proves those statements run. What IS
//   testable is every decision around them, and that is where this issue's rules live: merge before
//   measuring, never take an exclusive lock under a running session, and say in one line what happened.
//   All of it reaches the module through ctx, so none of it needs a database.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const upkeep = require('../src/app/db-upkeep');

const PAGE = 4096;

// A fake database whose freeSpace answer CHANGES after the merge, the way a real one does — that change
// is the behaviour the ordering rule is about, so it cannot be a constant.
function makeCtx(opts = {}) {
  const {
    freeBefore = 0, freeAfterMerge = freeBefore, pages = 25000,
    autoVacuum = 2, sessions = 0, quitting = false, mergeOk = true, vacuumOk = true,
  } = opts;
  const calls = [];
  const logs = [];
  let merged = false;
  let reclaimed = 0;
  const space = (freelist) => ({
    pageSize: PAGE, pageCount: pages - reclaimed, freelist,
    freeBytes: freelist * PAGE, totalBytes: (pages - reclaimed) * PAGE,
    ratio: pages ? freelist / pages : 0,
  });
  let vacuumed = false;
  const db = {
    // After a vacuum the freelist really is empty — the fake says so too, or the log line it produces
    // would report waste that is no longer there.
    freeSpace: () => space(vacuumed ? 0 : (merged ? freeAfterMerge : freeBefore)),
    optimizeSearchIndex: () => {
      calls.push('optimize');
      merged = true;
      return mergeOk ? { ok: true, ms: 900 } : { ok: false, ms: 5, error: 'no such table: search_fts' };
    },
    // The real predicate, not a stub of it — the thresholds are part of what this pins.
    needsFullVacuum: (s) => s.freeBytes >= 32 * 1024 * 1024 || s.ratio >= 0.2,
    // A failing vacuum still reports a duration — compact.js times its catch path too, which is exactly
    // why the log must look at `ok` and not at `ms`.
    incrementalVacuum: () => {
      calls.push('incremental');
      if (!vacuumOk) return { ok: false, ms: 12, reclaimedBytes: 0, error: 'database is locked' };
      reclaimed = freeAfterMerge; vacuumed = true;
      return { ok: true, ms: 40, reclaimedBytes: freeAfterMerge * PAGE };
    },
    fullVacuum: () => {
      calls.push('full');
      if (!vacuumOk) return { ok: false, ms: 12, reclaimedBytes: 0, error: 'database is locked' };
      reclaimed = freeAfterMerge; vacuumed = true;
      return { ok: true, ms: 180, reclaimedBytes: freeAfterMerge * PAGE };
    },
    autoVacuumMode: () => autoVacuum,
  };
  const activeSessions = new Map();
  for (let i = 0; i < sessions; i++) activeSessions.set('s' + i, {});
  upkeep.init({
    db, activeSessions,
    getAppQuitting: () => quitting,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m), error: (m) => logs.push('ERR ' + m) },
  });
  return { calls, logs };
}

// --- The ordering rule ---

test('the freelist is read AFTER the merge, which is what makes the reclaim worth doing', () => {
  // Nothing free before the merge, 20 000 pages (78 MB) free after it — exactly the shape a real
  // database has, and the reason a decision taken before the merge would skip the reclaim entirely.
  const { calls } = makeCtx({ freeBefore: 0, freeAfterMerge: 20000, sessions: 0 });
  const res = upkeep.runUpkeep({ force: true });
  assert.deepEqual(calls, ['optimize', 'full']);
  assert.equal(res.form, 'full');
});

test('the merge runs even when there is nothing to reclaim', () => {
  const { calls } = makeCtx({ freeBefore: 0, freeAfterMerge: 0 });
  const res = upkeep.runUpkeep({ force: true });
  assert.deepEqual(calls, ['optimize'], 'cheap when already merged, so it is unconditional');
  assert.equal(res.form, 'none');
});

// --- The exclusive lock ---

test('a running session gets no full vacuum', () => {
  const { calls } = makeCtx({ freeBefore: 0, freeAfterMerge: 20000, sessions: 1 });
  const res = upkeep.runUpkeep({ force: true });
  assert.deepEqual(calls, ['optimize', 'incremental'], 'the cheap form still runs — only the rewrite waits');
  assert.equal(res.form, 'incremental');
  assert.equal(res.sessionsRunning, 1);
});

test('with a session running and no incremental mode, the pass defers rather than pretending', () => {
  const { calls, logs } = makeCtx({ freeBefore: 0, freeAfterMerge: 20000, sessions: 2, autoVacuum: 0 });
  const res = upkeep.runUpkeep({ force: true });
  assert.deepEqual(calls, ['optimize'], 'no vacuum of either form');
  assert.equal(res.form, 'deferred');
  assert.match(logs[0], /a session is running/);
});

test('small waste is left to the incremental pass even with nothing running', () => {
  // 2 000 pages of 25 000 = 8%, 7.8 MB — under both thresholds.
  const { calls } = makeCtx({ freeBefore: 0, freeAfterMerge: 2000, sessions: 0 });
  const res = upkeep.runUpkeep({ force: true });
  assert.deepEqual(calls, ['optimize', 'incremental']);
  assert.equal(res.form, 'incremental');
});

test('a high SHARE of waste earns the full form even when the absolute size is small', () => {
  // 600 of 2 000 pages = 30%, but only 2.3 MB — the ratio threshold is what catches a small database.
  const { calls } = makeCtx({ freeBefore: 0, freeAfterMerge: 600, pages: 2000, sessions: 0 });
  assert.equal(upkeep.runUpkeep({ force: true }).form, 'full');
  assert.deepEqual(calls, ['optimize', 'full']);
});

// --- Not doing damage ---

test('a quit that beat the timer starts nothing', () => {
  const { calls } = makeCtx({ freeBefore: 0, freeAfterMerge: 20000, quitting: true });
  const res = upkeep.runUpkeep({ force: true });
  assert.deepEqual(calls, [], 'no VACUUM against a database that is about to close');
  assert.equal(res.skipped, 'quitting');
});

test('the pass runs once per launch unless forced', () => {
  const { calls } = makeCtx({ freeBefore: 0, freeAfterMerge: 0 });
  upkeep.runUpkeep();
  const second = upkeep.runUpkeep();
  assert.deepEqual(calls, ['optimize']);
  assert.equal(second.skipped, 'already ran this launch');
});

test('a failed merge is reported and does not stop the reclaim', () => {
  const { calls, logs } = makeCtx({ freeBefore: 20000, freeAfterMerge: 20000, mergeOk: false, sessions: 0 });
  const res = upkeep.runUpkeep({ force: true });
  assert.deepEqual(calls, ['optimize', 'full'], 'pages that are already free are still worth giving back');
  assert.equal(res.ok, false);
  assert.match(logs[0], /FAILED: no such table/);
});

// --- What it writes down ---

test('one info line per launch, carrying what ran, what it cost and what it bought', () => {
  const { logs } = makeCtx({ freeBefore: 0, freeAfterMerge: 20000, sessions: 0 });
  upkeep.runUpkeep({ force: true });
  assert.equal(logs.length, 1, 'a lifecycle event, not a running commentary');
  assert.match(logs[0], /^\[db-upkeep\] merge 900 ms · reclaim full 180 ms · 97\.7 MB -> 19\.5 MB, 0\.0 MB free$/);
});

// --- The timer ---

test('start() arms an unref\'d timer and does not run the pass itself', () => {
  const { calls } = makeCtx({ freeBefore: 0, freeAfterMerge: 0 });
  const timer = upkeep.start({ delayMs: 60_000 });
  try {
    assert.deepEqual(calls, [], 'nothing on the startup path');
    assert.equal(typeof timer.unref, 'function', 'an upkeep pass must never hold the app open at quit');
  } finally { upkeep.stop(); }
});

test('the scheduled pass is what eventually runs it', async () => {
  const { calls } = makeCtx({ freeBefore: 0, freeAfterMerge: 0 });
  upkeep.start({ delayMs: 1 });
  await new Promise(r => setTimeout(r, 25));
  assert.deepEqual(calls, ['optimize']);
});

// --- Saying what actually happened ---
//
// A verifier found the log reporting a reclaim that threw as one that worked: compact.js times its own
// catch path, so `ms` is set either way, and printing it alone read as success. These pin the four
// outcomes as four distinct words, and the failure as a failure.

test('a vacuum that threw is reported as failed, not as a duration', () => {
  const { logs } = makeCtx({ freeBefore: 0, freeAfterMerge: 20000, sessions: 0, vacuumOk: false });
  const res = upkeep.runUpkeep({ force: true });
  assert.match(logs[0], /reclaim full FAILED: database is locked/);
  assert.doesNotMatch(logs[0], /full 12 ms/, 'the duration of a failure must not stand in for success');
  assert.equal(res.ok, false);
});

test('nothing worth doing is "none", not "deferred" — there is no later pass waiting', () => {
  // Small waste and no incremental mode: the steady state of every database created before #430, so
  // this is the line its owner reads at every launch. "deferred" promised something that never comes.
  const { logs } = makeCtx({ freeBefore: 0, freeAfterMerge: 1000, autoVacuum: 0, sessions: 0 });
  const res = upkeep.runUpkeep({ force: true });
  assert.equal(res.form, 'none');
  assert.match(logs[0], /reclaim none \(waste is below the threshold\)/);
});

test('"deferred" is only used where something IS worth doing and cannot be', () => {
  // It takes BOTH: a live session (so the exclusive form waits) and a database with no incremental mode
  // (so there is no cheap form to fall back on). With nothing running, the full form runs whatever the
  // mode is — a VACUUM needs no auto_vacuum — so there is no reachable state where the reason is a guess.
  const both = makeCtx({ freeBefore: 0, freeAfterMerge: 20000, autoVacuum: 0, sessions: 1 });
  assert.equal(upkeep.runUpkeep({ force: true }).form, 'deferred');
  assert.match(both.logs[0], /a session is running, and this database has no incremental mode/);

  const nothingRunning = makeCtx({ freeBefore: 0, freeAfterMerge: 20000, autoVacuum: 0, sessions: 0 });
  assert.equal(upkeep.runUpkeep({ force: true }).form, 'full', 'no mode needed for the full form');
  assert.doesNotMatch(nothingRunning.logs[0], /deferred/);
});

test('an incremental pass under a running session says what is still owed', () => {
  const { logs } = makeCtx({ freeBefore: 0, freeAfterMerge: 20000, autoVacuum: 2, sessions: 1 });
  assert.equal(upkeep.runUpkeep({ force: true }).form, 'incremental');
  assert.match(logs[0], /full vacuum deferred — a session is running/);
});
