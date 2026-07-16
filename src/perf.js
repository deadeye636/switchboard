const { performance } = require('perf_hooks');

/**
 * One place for timing.
 *
 * Kept logger-agnostic on purpose: some modules require electron-log directly
 * (main.js), others take an injected logger (session-cache via ctx.log). So perf.js
 * only measures and hands the number back — the caller owns where and at what level
 * it is logged. That is also why the old `Date.now()`-delta timings live here now:
 * one primitive, one `[perf]` line shape, instead of ad-hoc deltas scattered around.
 */

/**
 * Monotonic elapsed-ms probe. Prefer this over `Date.now()` deltas: it does not
 * jump when the wall clock is adjusted, and it reads as one thing.
 *
 *   const done = startTimer();
 *   ...work...
 *   const ms = done();   // fractional milliseconds since startTimer()
 */
function startTimer() {
  const t0 = performance.now();
  return () => performance.now() - t0;
}

/**
 * Measure `fn` and, when it ran at least `slowMs`, emit one debug line via the
 * passed logger — silent otherwise, so a hot path can be instrumented without a
 * line per call. `log` is any object with a `.debug` method (electron-log or the
 * injected ctx.log); omit it to measure without logging. Returns whatever `fn`
 * returns; the timing runs even if `fn` throws.
 *
 *   timed('refreshFile.fts', () => { ... }, { log, slowMs: 50 });
 */
function timed(label, fn, { slowMs = 50, log } = {}) {
  const done = startTimer();
  try {
    return fn();
  } finally {
    const ms = done();
    if (log && ms >= slowMs) log.debug(`[perf] ${label} ${ms.toFixed(1)}ms`);
  }
}

/** Same as `timed`, for an async `fn` — awaits it inside the span. */
async function timedAsync(label, fn, { slowMs = 50, log } = {}) {
  const done = startTimer();
  try {
    return await fn();
  } finally {
    const ms = done();
    if (log && ms >= slowMs) log.debug(`[perf] ${label} ${ms.toFixed(1)}ms`);
  }
}

module.exports = { startTimer, timed, timedAsync };
