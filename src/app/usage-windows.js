// usage-windows.js — the window model, the projection and the in-memory sampler behind the Stats page's usage windows
// (#883, spec 48 V11). Pure: no Electron, no database, no IPC, names no backend. The clock arrives as an argument.
//
// What a window is: a usage bucket flagged `bar` (E5) that carries `resetsAt` and `windowMinutes`, taken from a reading whose
// backend says it reports windows (`reportsWindows`, stamped by `collectUsage`). The provider's percent covers the whole
// account, so the headline is a PERCENT projected to the reset (E1); this machine's tokens are a second line, built in stats.js.
//
// The projection, in order:
//   - percent >= 100                       -> 'reached'   (no projection, E8)
//   - the reset time has passed            -> 'expired'   (the reading belongs to a window that is over; no projection)
//   - >= 3 samples spanning >= 30 min in the CURRENT window -> 'samples': least-squares slope of the last 60 min of samples
//     (percent per hour, floored at 0), projected from the reading to the reset
//   - elapsed fraction below TOO_EARLY     -> 'too-early' (5 %: 15 min of a 5 h window, 8.4 h of a week; the ratio
//     percent / fraction is meaningless there, one point of percent is 20x noise)
//   - otherwise                            -> 'linear'    (percent / elapsed fraction)
'use strict';

const MIN_MS = 60000;
const HOUR_MS = 3600000;
const TOO_EARLY = 0.05;
const SAMPLE_SPAN_MS = 30 * MIN_MS;     // samples must span this much of the current window before the slope is used
const SLOPE_LOOKBACK_MS = 60 * MIN_MS;  // the slope looks at the last hour of samples
const MIN_SLOPE_POINTS = 3;
const MAX_SAMPLES = 120;                // per window: about two hours at the 60 s poll
const MAX_SAMPLE_AGE_MS = 3 * HOUR_MS;
// A reset time that moved by more than this means a new window even when the percent did not fall (the provider's reset
// time wobbles by seconds within one window).
// A live reading older than this (2 poll intervals of ~60 s, plus slack) is shown as of its own time.
const AS_OF_AFTER_MS = 150000;
const RESET_MOVED_MS = 5 * MIN_MS;

function msOf(iso) {
  if (typeof iso !== 'string' || !iso) return NaN;
  return new Date(iso).getTime();
}

/**
 * The windows of one usage reading: `[{ key, label, percent, resetsAt, startsAt, windowMinutes, elapsedFraction }]`.
 * Empty for a reading that does not report windows, an error reading, or a bucket without a usable reset or length.
 * `refMs` is the moment the reading is true at (now for a live one, `observedAt` or `_cachedAt` for a stale one).
 */
function windowsOf(reading, refMs) {
  if (!reading || reading.reportsWindows !== true || reading._error || reading._rateLimited) return [];
  const out = [];
  for (const b of Array.isArray(reading.buckets) ? reading.buckets : []) {
    if (!b || b.bar !== true) continue;
    const resetMs = msOf(b.resetsAt);
    const minutes = Number(b.windowMinutes);
    const percent = Number(b.percent);
    if (!Number.isFinite(resetMs) || !(minutes > 0) || !Number.isFinite(percent)) continue;
    const lengthMs = minutes * MIN_MS;
    const startMs = resetMs - lengthMs;
    const elapsedFraction = Math.min(1, Math.max(0, (refMs - startMs) / lengthMs));
    out.push({
      key: String(b.key), label: String(b.label || b.key), percent, resetsAt: new Date(resetMs).toISOString(),
      startsAt: new Date(startMs).toISOString(), windowMinutes: minutes, elapsedFraction,
    });
  }
  return out;
}

/** Least-squares slope of percent over time, in percent per hour. */
function slopePerHour(samples) {
  const n = samples.length;
  const t0 = samples[0].t;
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (const s of samples) {
    const x = (s.t - t0) / HOUR_MS;
    sx += x; sy += s.percent; sxx += x * x; sxy += x * s.percent;
  }
  const den = n * sxx - sx * sx;
  return den === 0 ? 0 : (n * sxy - sx * sy) / den;
}

/**
 * The projection of one window (from `windowsOf`) to its reset. `samples` is `[{ t, percent }]` for this window, oldest first.
 * `refMs` is when the percent was true; `asOf` an ISO string when the reading is stale (E8), else null.
 * `{ ratePerHour, projectedAtReset, reachesLimitAt, basis, asOf }`; `projectedAtReset` is the raw figure, never capped.
 */
function projectWindow(win, samples, refMs, asOf = null) {
  const none = { ratePerHour: null, projectedAtReset: null, reachesLimitAt: null, asOf };
  const resetMs = msOf(win.resetsAt);
  const startMs = msOf(win.startsAt);
  if (win.percent >= 100) return { ...none, basis: 'reached' };
  if (refMs >= resetMs) return { ...none, basis: 'expired' };

  const inWindow = (samples || []).filter(s => s.t >= startMs && s.t <= resetMs);
  const last = inWindow.length ? inWindow[inWindow.length - 1] : null;
  let rate = null;
  let basis = null;
  if (last && last.t - inWindow[0].t >= SAMPLE_SPAN_MS) {
    const recent = inWindow.filter(s => s.t >= last.t - SLOPE_LOOKBACK_MS);
    if (recent.length >= MIN_SLOPE_POINTS) {
      rate = Math.max(0, slopePerHour(recent));
      basis = 'samples';
    }
  }
  if (basis === null) {
    if (win.elapsedFraction < TOO_EARLY) return { ...none, basis: 'too-early' };
    rate = win.percent / (((refMs - startMs)) / HOUR_MS);
    basis = 'linear';
  }
  const hoursLeft = (resetMs - refMs) / HOUR_MS;
  const projected = win.percent + rate * hoursLeft;
  let reachesLimitAt = null;
  if (rate > 0 && projected > 100) reachesLimitAt = new Date(refMs + ((100 - win.percent) / rate) * HOUR_MS).toISOString();
  return { ratePerHour: rate, projectedAtReset: projected, reachesLimitAt, basis, asOf };
}

/**
 * When a reading was true, and whether it says so: `{ refMs, asOf, stale }`. A stale reading is true at `_cachedAt`, a non-live
 * one at `observedAt`. A live reading is true when the poll RECORDED it (`recordedAtMs`, default now): after a sleep or a paused
 * poll that is hours ago, and it is then `asOf` that moment once it is older than 2 poll intervals plus slack (AS_OF_AFTER_MS).
 */
function referenceOf(reading, nowMs, recordedAtMs = nowMs) {
  if (reading && reading._stale) {
    const at = msOf(reading._cachedAt);
    return { refMs: Number.isFinite(at) ? at : nowMs, asOf: Number.isFinite(at) ? new Date(at).toISOString() : null, stale: true };
  }
  if (reading && reading.live === false && reading.observedAt) {
    const at = msOf(reading.observedAt);
    if (Number.isFinite(at)) return { refMs: at, asOf: new Date(at).toISOString(), stale: false };
  }
  const old = nowMs - recordedAtMs > AS_OF_AFTER_MS;
  return { refMs: recordedAtMs, asOf: old ? new Date(recordedAtMs).toISOString() : null, stale: false };
}

/**
 * The in-memory sampler (E3): fed by the usage poll after each reading, nothing persisted. Per backend id and bucket key it
 * keeps the last MAX_SAMPLES samples within MAX_SAMPLE_AGE_MS of the newest, and the latest reading per backend.
 * A percent that fell, or a reset time that moved, starts the series again (a new window).
 */
function createSampler({ maxSamples = MAX_SAMPLES, maxAgeMs = MAX_SAMPLE_AGE_MS } = {}) {
  const series = new Map();   // `${backendId}|${key}` -> { resetMs, samples: [{ t, percent }] }
  const latest = new Map();   // backendId -> { reading, recordedAt }

  function record(reading, nowMs) {
    if (!reading || !reading.backendId || reading._error || reading._rateLimited) return;
    latest.set(reading.backendId, { reading, recordedAt: nowMs });
    const { refMs, stale } = referenceOf(reading, nowMs);
    // A stale reading is an old measurement served again: it changes the latest figure, never the samples.
    if (stale) return;
    for (const w of windowsOf(reading, refMs)) {
      const id = `${reading.backendId}|${w.key}`;
      const resetMs = msOf(w.resetsAt);
      let s = series.get(id);
      const prev = s && s.samples.length ? s.samples[s.samples.length - 1] : null;
      if (!s || (prev && (w.percent < prev.percent || Math.abs(resetMs - s.resetMs) > RESET_MOVED_MS))) {
        s = { resetMs, samples: [] };
        series.set(id, s);
      }
      s.resetMs = resetMs;
      // A non-live reading repeats the same observation on every poll: one sample per observation time.
      if (prev && prev.t >= refMs) continue;
      s.samples.push({ t: refMs, percent: w.percent });
      while (s.samples.length > maxSamples || (s.samples.length > 1 && refMs - s.samples[0].t > maxAgeMs)) s.samples.shift();
    }
  }

  return {
    record,
    samplesOf: (backendId, key) => {
      const s = series.get(`${backendId}|${key}`);
      return s ? s.samples.slice() : [];
    },
    latest: () => [...latest.values()].map(v => v.reading),
    latestEntries: () => [...latest.values()],
    clear: () => { series.clear(); latest.clear(); },
  };
}

/** The windows of every latest reading with their projection: `[{ backendId, reading, window, projection }]`. */
function describeAll(sampler, nowMs) {
  const out = [];
  for (const { reading, recordedAt } of sampler.latestEntries()) {
    const { refMs, asOf } = referenceOf(reading, nowMs, recordedAt);
    for (const window of windowsOf(reading, refMs)) {
      const projection = projectWindow(window, sampler.samplesOf(reading.backendId, window.key), refMs, asOf);
      out.push({ backendId: reading.backendId, window, projection });
    }
  }
  return out;
}

module.exports = {
  TOO_EARLY, AS_OF_AFTER_MS, SAMPLE_SPAN_MS, SLOPE_LOOKBACK_MS, MAX_SAMPLES, MAX_SAMPLE_AGE_MS,
  windowsOf, projectWindow, referenceOf, slopePerHour, createSampler, describeAll,
};
