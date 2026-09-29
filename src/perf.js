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

// A stall line names every piece of work that STARTED in its window, and in practice a window holds four or
// five of them (the renderer asks for the project list, the live sessions and the active sessions together),
// so the line says what was around, not what held the loop. The breadcrumb therefore also measures: the
// `done` it hands back logs the work that ran at least `slowMs` synchronously, by name. Only a caller that
// can say where its work ENDS calls it — an async handler's continuation after its first `await` is not in
// the measurement, and a stall that no `[slow-work]` line explains points there.
const slowWork = { log: null, slowMs: 200 };

/** Where `[slow-work]` lines go, and from how many milliseconds. `null` silences them. */
function setSlowWorkLog(log, slowMs) {
  slowWork.log = log || null;
  if (typeof slowMs === 'number' && slowMs >= 0) slowWork.slowMs = slowMs;
}

/**
 * Record that `label` is about to run on this thread. Cheap enough for every IPC call. Returns `done()`,
 * which measures the span since this call and logs it at info when it reached `slowMs`; calling it is
 * optional, and it logs nothing until `startLoopLagMonitor` has been handed a logger.
 */
function noteWork(label) {
  const at = performance.now();
  _notes.push({ label, at });
  if (_notes.length > NOTE_RING_SIZE) _notes.shift();
  return () => {
    const ms = performance.now() - at;
    if (slowWork.log && ms >= slowWork.slowMs) slowWork.log.info(`[slow-work] ${label} held the main thread ${Math.round(ms)}ms`);
    return ms;
  };
}

/**
 * Leave a breadcrumb for every IPC message the renderer sends, both kinds: `handle` (invoke) and `on`
 * (send). Wraps the REGISTRATION, like `guardIpcHandlers`, so a handler registered later is covered too —
 * which means it must run before the first one is registered. Idempotent. The listener Electron holds is
 * the wrapper, so `removeListener(channel, original)` would find nothing; no caller removes one today.
 * The listener's SYNCHRONOUS part is measured: for an async handler that is everything up to its first
 * `await`, which is the part that holds the loop when it does not await at all.
 */
function noteIpcCalls(ipc) {
  if (!ipc || ipc.__sbIpcNoted) return ipc;
  for (const method of ['handle', 'on']) {
    if (typeof ipc[method] !== 'function') continue;
    const raw = ipc[method].bind(ipc);
    ipc[method] = (channel, listener) => raw(channel, (...args) => {
      const done = noteWork(`ipc:${channel}`);
      try {
        return listener(...args);
      } finally {
        done();
      }
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

/**
 * Start watching this thread's event loop. The timer is unref'd, so it never holds the process open. The
 * logger it is handed is also where `noteWork`'s `[slow-work]` lines go (`slowWorkMs`, default 200).
 */
function startLoopLagMonitor(opts = {}) {
  setSlowWorkLog(opts.log, opts.slowWorkMs);
  const intervalMs = opts.intervalMs || 250;
  const check = createLoopLagCheck({ ...opts, intervalMs });
  const timer = setInterval(() => check.tick(), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startTimer, timed, timedAsync, noteWork, noteIpcCalls, setSlowWorkLog, createLoopLagCheck, startLoopLagMonitor };
