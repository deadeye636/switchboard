// metrics-bucket.js — one clock for every backend's Stats metrics (#159).
//
// A metrics row is keyed on (date, hour). Which date, and which hour, depends on a choice that has to
// be the SAME for all four backends or the page lies:
//
//   Claude bucketed by `timestamp.slice(0, 10)` — the UTC date inside the ISO string.
//   Hermes bucketed with SQLite's `'localtime'` modifier — the local date.
//
// East of Greenwich after 00:00, or west of it before 00:00, those two disagree by a day. In a chart
// that stacks both backends, the same evening's work landed in two different columns. The user's day is
// the local day — that is when they were at the keyboard — so LOCAL wins, everywhere.
//
// The hour exists for the same reason: a day is too coarse to answer "when do I actually work", and a
// session that runs past midnight has to split at the real edge, not at the one UTC happens to draw.
//
// `hour = -1` means the backend genuinely cannot say when within the day (see NO_HOUR). It is not a
// guess and not midnight — the hour grid leaves those buckets out rather than invent a working habit.
'use strict';

const NO_HOUR = -1;

/** Local YYYY-MM-DD. NOT toISOString().slice(0,10), which would re-introduce the UTC skew above. */
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isValidDate(d) {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/**
 * A Date -> {date, hour} in local time. `fallbackDate` (YYYY-MM-DD) is used when the value is
 * unusable — the bucket still counts the message, it just cannot place it within the day.
 */
function bucketOf(value, fallbackDate) {
  const d = value instanceof Date ? value : null;
  if (!isValidDate(d)) return { date: fallbackDate || null, hour: NO_HOUR };
  return { date: localDateKey(d), hour: d.getHours() };
}

/** An ISO-8601 timestamp (Claude, Codex, Pi write these) -> {date, hour}. */
function bucketFromIso(iso, fallbackDate) {
  if (typeof iso !== 'string' || iso.length < 10) return { date: fallbackDate || null, hour: NO_HOUR };
  return bucketOf(new Date(iso), fallbackDate);
}

/** Unix epoch SECONDS (Hermes stores REAL seconds, not milliseconds) -> {date, hour}. */
function bucketFromEpochSeconds(seconds, fallbackDate) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return { date: fallbackDate || null, hour: NO_HOUR };
  return bucketOf(new Date(n * 1000), fallbackDate);
}

/** The map key a parser aggregates on. A bucket is emitted ONCE per key (db.js relies on it). */
function bucketKey(date, hour, model) {
  return `${date}|${hour}|${model || ''}`;
}

module.exports = { NO_HOUR, localDateKey, bucketOf, bucketFromIso, bucketFromEpochSeconds, bucketKey };
