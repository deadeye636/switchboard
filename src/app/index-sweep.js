// The index-repair sweep a `get-projects` queues (#199 step 3, #590).
//
// `get-projects` returns the cached view immediately and asks for a repair sweep just after — the
// reconcile + backend scan that used to run inline and block the sidebar paint. This module owns WHEN
// that sweep runs. It moved out of main.js with #590 so the decision is testable in `node --test`;
// main.js keeps only the wiring.
//
// THE LOOP THIS EXISTS TO BREAK. A transcript append closes a circle the app draws itself:
//
//   append -> postFile -> applyFileReply -> onFileApplied -> notifyRendererProjectsChanged
//          -> the renderer's loadProjects() -> get-projects -> the sweep -> postReconcile
//
// Measured in an ordinary dev instance with two sessions writing: 28 reconcile posts in 93 s, each
// carrying every cached row of every folder (`clone~35f/1177rows`), 1467 posts in 36 minutes. And the
// punchline is that those sweeps found NOTHING: `refreshFilePrepare` stamps the folder before it posts
// the parse, so the reconcile that the apply's own push provokes sees zero tripped folders. Measured
// cost of one such post on main: 1.48 ms to gather and clone 1177 rows, so ~69 ms a minute and ~54 000
// row copies a minute, paid continuously for as long as anything is writing.
//
// So the answer is not a smaller payload, it is not asking. Two rules, and the second is why the first
// is safe:
//
//   1. A sweep queued by a `get-projects` that arrived within ECHO_WINDOW_MS of this app's own
//      `projects-changed` push is an ECHO and is dropped. Whatever wrote the rows that push announces
//      has already written them.
//   2. …but the sweep is also the drift safety net, and a busy session pushes about once a second, so
//      rule 1 alone would switch the net off for as long as anyone is working. MIN_INTERVAL_MS is the
//      floor: an echo that arrives with no sweep in that long runs anyway, and one that does not is
//      REMEMBERED — a timer runs it when the floor elapses. Nothing is dropped outright; a sweep that
//      was owed is only delayed.
//
// What is NOT throttled, and must not be: every caller that posts a reconcile directly.
// `watch/projects.js` (a folder appeared or vanished), `watch/stores.js` (an Axis-B store moved),
// `app/settings.js` (a backend was enabled or disabled) and `rebuild-cache` (force) all reach
// `indexWorker.postReconcile` themselves and are untouched. That is what makes the floor affordable:
// every change the app can actually observe already has a direct path, and this sweep is the net under
// the drift nobody observed.
//
// What it takes away: a repair sweep can now be up to MIN_INTERVAL_MS late. Nothing the user SEES is
// delayed — `get-projects` answers from the cache and never waited on this — but a row that drifted
// (a transcript deleted inside a folder whose newest file did not move, an FTS orphan) is corrected up
// to half a minute later than before. The alternative was correcting it 46 times a minute while
// finding nothing 45 of those times.
'use strict';

// How long after one of our own `projects-changed` pushes a `get-projects` still reads as its echo.
// The renderer debounces that push by 300 ms before calling `loadProjects()`, so the echo lands about a
// third of a second later; the rest is slack for a busy main thread and for the view windows, which
// refetch on the same push.
const ECHO_WINDOW_MS = 1500;
// The floor under rule 1 — the longest an echo-suppressed sweep is made to wait. Half a minute is
// chosen against what the sweep is FOR: every observable change has a direct path (see the header), so
// this bounds the staleness of drift repair, not of anything a user is looking at.
const MIN_INTERVAL_MS = 30000;

let isAppQuitting = () => false;
let lastProjectsPushAt = () => 0;
let postReconcile = () => {};

let queued = false;        // a sweep is already scheduled for the next tick — the old `indexSweepQueued`
let lastSweepAt = 0;       // when one last actually ran
let floorTimer = null;     // an echo-suppressed sweep waiting out the floor

function init(ctx) {
  if (typeof ctx.isAppQuitting === 'function') isAppQuitting = ctx.isAppQuitting;
  if (typeof ctx.lastProjectsPushAt === 'function') lastProjectsPushAt = ctx.lastProjectsPushAt;
  if (typeof ctx.postReconcile === 'function') postReconcile = ctx.postReconcile;
}

function run(now) {
  clearFloor();
  lastSweepAt = now;
  // The whole reconcile + backend sweep runs off-thread. index-worker-client applies the reply on main
  // and then runs syncRegistry + applyAutoHide + the projects-changed push itself (the `afterReconcile`
  // hook wired at init), so there is nothing to fold in here. It also coalesces a burst into one
  // in-flight + one trailing sweep of its own — this module decides whether to ask at all.
  postReconcile();
}

function clearFloor() {
  if (floorTimer) { clearTimeout(floorTimer); floorTimer = null; }
}

function armFloor(now) {
  if (floorTimer) return;   // one is already owed; a second request does not make it more owed
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastSweepAt));
  floorTimer = setTimeout(() => {
    floorTimer = null;
    if (isAppQuitting()) return;
    run(Date.now());
  }, wait);
  // Never hold the process open for a repair sweep.
  if (typeof floorTimer.unref === 'function') floorTimer.unref();
}

/**
 * Ask for a repair sweep. Called by `get-projects` after it has answered from the cache.
 *
 * Duplicate requests inside one tick collapse, exactly as they did before this module existed.
 */
function queue() {
  if (queued) return;
  queued = true;
  setImmediate(() => {
    queued = false;
    if (isAppQuitting()) return;
    const now = Date.now();
    const isEcho = (now - lastProjectsPushAt()) < ECHO_WINDOW_MS;
    if (!isEcho) { run(now); return; }
    if (now - lastSweepAt >= MIN_INTERVAL_MS) { run(now); return; }
    armFloor(now);
  });
}

// No teardown entry point on purpose: the floor timer is unref'd, its callback checks `isAppQuitting`,
// and `postReconcile` checks it again. A quit that lands between the two is already covered twice, and a
// third guard would be a ctx entry and a lifecycle step for a timer that cannot write anything.

module.exports = {
  init,
  queue,
  ECHO_WINDOW_MS,
  MIN_INTERVAL_MS,
  // exposed for tests: drive the decision without waiting out real intervals. `lastSweepAt = 0` is also
  // the real starting state, and it means the FIRST request after launch always sweeps, echo or not —
  // there is nothing to be an echo of yet, and the first convergence should not wait out the floor.
  _reset: () => { clearFloor(); queued = false; lastSweepAt = 0; },
  _setLastSweepAt: (ms) => { lastSweepAt = ms; },
  _floorArmed: () => floorTimer !== null,
};
