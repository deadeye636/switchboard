// timeline-record.js — the shape and the retention of a session timeline event (#396).
//
// Outside timeline-store.js for the same reason stats-queries.js is outside db.js: that file opens the
// real database and cannot be loaded from a unit test, and the rules here are the part worth testing.
// Nothing in this file touches SQLite or Electron.
//
// The record this replaces lived in renderer memory (`session/session-timeline.js`) with an 80-event cap
// nobody chose. Both limits below ARE chosen, and a session that runs for weeks has to stay bounded by
// them rather than by whichever of the two happens to bite first:
//
//   - `maxPerSession` bounds a busy session. 500 events is roughly a fortnight of ordinary use for one
//     session — a turn produces two or three, not hundreds.
//   - `maxAgeDays` bounds a QUIET one. Without it, a session touched twice a year keeps its first event
//     forever, and the table grows with the number of sessions ever seen rather than with use.
//
// Both are applied on write, per session, so the cost is paid where the growth happens.
'use strict';

const RETENTION = Object.freeze({
  maxPerSession: 500,
  maxAgeDays: 30,
});

/** Epoch ms before which an event of this age is no longer kept. */
function retentionCutoff(now, { maxAgeDays } = RETENTION) {
  const base = Number.isFinite(now) ? now : Date.now();
  return base - maxAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * Coerce whatever a caller passes into the row the table takes, or null when it is not an event.
 *
 * `at` accepts what the renderer's store used to produce (an ISO string) as well as epoch ms and a
 * Date, because the callers being ported over send all three — and an unparseable one becomes `now`
 * rather than NaN, since an event with no time is worse than an event timed a moment late.
 */
function normalizeTimelineEvent(input, now = Date.now()) {
  if (!input || typeof input !== 'object') return null;
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
  if (!sessionId || !kind) return null;

  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim() : kind;
  const detail = typeof input.detail === 'string' ? input.detail : '';

  // Does that detail NAME the thing the event is about, or only describe it? Only the producer can
  // answer, so only the producer says — `isDuplicateOf` is the one reader (#423).
  const detailIsSubject = input.detailIsSubject === true;

  return { sessionId, kind, label, detail, detailIsSubject, at: toEpochMs(input.at, now) };
}

function toEpochMs(value, fallback) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : fallback;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value) {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : fallback;
  }
  return fallback;
}

/**
 * Two events that say the same thing about the same session at nearly the same moment.
 *
 * Needed because more than one producer can report one fact: `process-exited` reaches the window that
 * owns a session AND the main window, and a session moving between windows can have both report the
 * edge that moved with it. The record is meant to hold one history per session, so the duplicate has to
 * be refused at the door rather than filtered out at every reader.
 *
 * Deliberately NOT keyed on `detail` by default: the same event reported twice can carry a differently
 * worded reason, and treating those as distinct is exactly the duplicate this exists to catch.
 *
 * An event whose detail NAMES what it is about says so, and then that detail decides (#423).
 * `file-touched` carries a path there, and an agent that touches two files in one beat writes two events
 * that share a session, a kind and a millisecond — dropping the second loses a file no reader downstream
 * can recover. The declaration rides on the EVENT rather than on a list of kinds kept beside this rule,
 * so a kind added later is covered by whoever writes it instead of by remembering to come back here.
 *
 * Only the CANDIDATE's declaration is read, and that is enough: a kind has one producer, so the stored
 * event it is compared against was written under the same convention. Which is what keeps the flag a
 * rule about the event rather than a column of the table.
 *
 * The window is short because it is not a rate limit. Two producers reporting one fact do it in the same
 * tick, give or take the IPC hop; a window wide enough to be comfortable starts swallowing events that
 * genuinely happened twice in quick succession, which is a worse failure — a lost event cannot be
 * recovered, while a duplicate is visible and fixable.
 */
function isDuplicateOf(candidate, previous, windowMs = 400) {
  if (!candidate || !previous) return false;
  if (candidate.sessionId !== previous.sessionId) return false;
  if (candidate.kind !== previous.kind) return false;
  if (candidate.detailIsSubject && candidate.detail !== (previous.detail || '')) return false;
  return Math.abs(candidate.at - previous.at) <= windowMs;
}

/**
 * Split a deliberately over-fetched row set into the answer and whether there was more.
 *
 * A query that asks for exactly `limit` rows cannot tell "there were this many" from "there were more
 * and you got a prefix". Asking for one row past the limit can, and the extra row costs nothing. The
 * caller then has the choice this exists to give it: say "and 12 more" rather than quietly under-report.
 */
function splitTruncated(rows, limit) {
  const list = Array.isArray(rows) ? rows : [];
  const cap = Math.max(0, Number(limit) || 0);
  if (list.length > cap) return { events: list.slice(0, cap), truncated: true };
  return { events: list, truncated: false };
}

module.exports = {
  RETENTION,
  retentionCutoff,
  normalizeTimelineEvent,
  isDuplicateOf,
  splitTruncated,
};
