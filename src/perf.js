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

// --- main event-loop stalls ---------------------------------------------------------------------------
//
// The installed app froze for seconds at a time with every process at 0% CPU and nothing in the log: the
// main thread was WAITING synchronously (a better-sqlite3 busy wait, a `spawnSync`), not computing. The
// only outside sign was Claude Code's attention hook timing out after 1 s. A stall leaves no line of its
// own, so this watches for one: a timer that should fire every `intervalMs` measures how late it ran.
//
// Late tells THAT the loop was blocked, never by what — the work that blocked it has already returned by
// the time the timer runs. So the likely entry points leave a breadcrumb (`noteWork`) when they start, and
// the stall line names every breadcrumb dropped since the previous tick. One of them held the loop. A stall
// that names none came from somewhere not yet instrumented, and that is itself the next thing to know.

const NOTE_RING_SIZE = 64;
const _notes = [];

/** Record that `label` is about to run on this thread. Cheap enough for every IPC call. */
function noteWork(label) {
  _notes.push({ label, at: performance.now() });
  if (_notes.length > NOTE_RING_SIZE) _notes.shift();
}

/**
 * Leave a breadcrumb for every IPC message the renderer sends, both kinds: `handle` (invoke) and `on`
 * (send). Wraps the REGISTRATION, like `guardIpcHandlers`, so a handler registered later is covered too —
 * which means it must run before the first one is registered. Idempotent. The listener Electron holds is
 * the wrapper, so `removeListener(channel, original)` would find nothing; no caller removes one today.
 */
function noteIpcCalls(ipc) {
  if (!ipc || ipc.__sbIpcNoted) return ipc;
  for (const method of ['handle', 'on']) {
    if (typeof ipc[method] !== 'function') continue;
    const raw = ipc[method].bind(ipc);
    ipc[method] = (channel, listener) => raw(channel, (...args) => {
      noteWork(`ipc:${channel}`);
      return listener(...args);
    });
  }
  ipc.__sbIpcNoted = true;
  return ipc;
}

/**
 * The stall check, apart from the timer so a test can drive it with its own clock. `tick(now)` returns
 * the logged line, or null when the loop was on time.
 */
function createLoopLagCheck({ log, intervalMs = 250, thresholdMs = 1000, now = () => performance.now() } = {}) {
  let last = now();
  return {
    tick(at = now()) {
      const lagMs = at - last - intervalMs;
      const since = last;
      last = at;
      if (lagMs < thresholdMs) return null;
      const seen = [];
      for (const n of _notes) {
        if (n.at >= since && !seen.includes(n.label)) seen.push(n.label);
      }
      const work = seen.length ? seen.slice(-8).join(', ') : 'nothing noted';
      const line = `[loop-lag] main event loop blocked ~${Math.round(lagMs)}ms; work started in that window: ${work}`;
      if (log) log.info(line);
      return line;
    },
  };
}

/** Start watching this thread's event loop. The timer is unref'd, so it never holds the process open. */
function startLoopLagMonitor(opts = {}) {
  const intervalMs = opts.intervalMs || 250;
  const check = createLoopLagCheck({ ...opts, intervalMs });
  const timer = setInterval(() => check.tick(), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startTimer, timed, timedAsync, noteWork, noteIpcCalls, createLoopLagCheck, startLoopLagMonitor };
