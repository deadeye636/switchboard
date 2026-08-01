// timeline-store.js — the session timeline, the record behind the "while you were away" recap (#396).
//
// One history per SESSION, held by the main process. It used to be one per RENDERER, in memory: a reload,
// a window close or a restart emptied it, which is precisely the span the recap exists to describe, and a
// session moved between windows handed its past to a window that did not have it.
//
// The shape rules and both retention limits are in `timeline-record.js`, outside this file so they can be
// tested — this module requires `connection`, which opens the real database.
//
// Retention is applied ON WRITE, per session: the two DELETEs below cost one indexed lookup each on a path
// that already writes a row, and they keep the table bounded without a sweeper nobody would remember to run.
'use strict';

const { db } = require('./connection');
const { runWithBusyRetry } = require('./sqlite-busy-retry');
const {
  RETENTION,
  retentionCutoff,
  normalizeTimelineEvent,
  isDuplicateOf,
  splitTruncated,
} = require('./timeline-record');

const stmts = {
  insert: db.prepare(`INSERT INTO session_timeline (sessionId, kind, label, detail, at)
    VALUES (@sessionId, @kind, @label, @detail, @at)`),
  // The newest event of this session and kind — the only one a duplicate could be a copy of, because a
  // duplicate arrives within seconds of the original.
  newestOfKind: db.prepare(`SELECT sessionId, kind, at FROM session_timeline
    WHERE sessionId = ? AND kind = ? ORDER BY at DESC LIMIT 1`),
  listForSession: db.prepare(`SELECT id, sessionId, kind, label, detail, at FROM session_timeline
    WHERE sessionId = ? ORDER BY at DESC, id DESC LIMIT ?`),
  listSince: db.prepare(`SELECT id, sessionId, kind, label, detail, at FROM session_timeline
    WHERE at > ? ORDER BY at DESC, id DESC LIMIT ?`),
  deleteForSession: db.prepare('DELETE FROM session_timeline WHERE sessionId = ?'),
  rekey: db.prepare('UPDATE session_timeline SET sessionId = ? WHERE sessionId = ?'),
  deleteKind: db.prepare('DELETE FROM session_timeline WHERE sessionId = ? AND kind = ?'),
  // Every session of a PROJECT — the user deleted it, and this is the only delete that is a deletion.
  // Sub-selects on session_cache, so it runs while those rows still exist.
  deleteForProject: db.prepare(`DELETE FROM session_timeline WHERE sessionId IN
    (SELECT sessionId FROM session_cache WHERE projectPath = ?)`),
  pruneOld: db.prepare('DELETE FROM session_timeline WHERE sessionId = ? AND at < ?'),
  // Keep the newest N of this session; drop what falls out the bottom.
  pruneOverCap: db.prepare(`DELETE FROM session_timeline WHERE sessionId = ? AND id NOT IN (
    SELECT id FROM session_timeline WHERE sessionId = ? ORDER BY at DESC, id DESC LIMIT ?
  )`),
};

// A reader asking for "everything" still gets a bounded answer. The two bounds are NOT the same number,
// and treating them as one is a bug this file shipped once: `maxPerSession` is exactly what one session
// is promised, so as a per-session cap it can never hide a kept event — but as a cap ACROSS sessions it
// hides them the moment two sessions are busy. The cross-session reader gets its own, larger bound and
// is told when it bit.
const MAX_ROWS = RETENTION.maxPerSession;
const MAX_ROWS_ACROSS_SESSIONS = RETENTION.maxPerSession * 8;

// Kinds where only the LATEST one means anything — a marker, not an event stream.
//
// `viewed` is written every time the user looks at a session, which on a busy afternoon is hundreds of
// times. Kept as a stream it would push the events that matter out of the per-session cap: the history
// would fill with "you looked at this" and forget what happened. Only "when did you last look" is ever
// asked, so only the last one is kept.
const SINGLETON_KINDS = new Set(['viewed']);

/**
 * Record one event. Returns the stored event, or null when there was nothing to store — either the input
 * was not an event, or the same fact had just been recorded by a second producer.
 */
function recordTimelineEvent(input, now = Date.now()) {
  const event = normalizeTimelineEvent(input, now);
  if (!event) return null;

  // Older than the retention window on arrival: storing it would mean writing a row and deleting it in the
  // same call, and reporting it as recorded either way.
  if (event.at < retentionCutoff(now)) return null;

  const previous = stmts.newestOfKind.get(event.sessionId, event.kind);
  if (!SINGLETON_KINDS.has(event.kind) && isDuplicateOf(event, previous)) return null;

  // The age cutoff is measured from NOW, never from the event being written. Measured from the event, a
  // late or backdated one moves the cutoff back with it and prunes nothing — including itself, which is
  // how an event older than the retention window survived the write that was supposed to reject it.
  const cutoff = retentionCutoff(now);
  runWithBusyRetry(() => {
    // A marker replaces itself rather than accumulating — see SINGLETON_KINDS.
    if (SINGLETON_KINDS.has(event.kind)) stmts.deleteKind.run(event.sessionId, event.kind);
    stmts.insert.run(event);
    stmts.pruneOld.run(event.sessionId, cutoff);
    stmts.pruneOverCap.run(event.sessionId, event.sessionId, RETENTION.maxPerSession);
  });
  return event;
}

/** A session's history, newest first — what the timeline viewer and the recap both read. */
function getTimelineEvents(sessionId, limit = MAX_ROWS) {
  if (!sessionId) return [];
  const capped = Math.max(1, Math.min(Number(limit) || MAX_ROWS, MAX_ROWS));
  return stmts.listForSession.all(sessionId, capped);
}

/**
 * Everything that happened after `sinceMs`, across every session — the recap overview's one query.
 *
 * Across sessions rather than per session on purpose: the overview answers "what changed while I was
 * away" for the whole app, and asking per session would mean knowing the answer before asking.
 *
 * Returns `{ events, truncated }`, not a bare array. A recap that quietly drops a third of an absence is
 * worse than one that says it is showing the most recent N — and only this function can know, because it
 * is the one that hit the limit.
 */
function getTimelineEventsSince(sinceMs, limit = MAX_ROWS_ACROSS_SESSIONS) {
  if (!Number.isFinite(sinceMs)) return { events: [], truncated: false };
  const capped = Math.max(1, Math.min(Number(limit) || MAX_ROWS_ACROSS_SESSIONS, MAX_ROWS_ACROSS_SESSIONS));
  // One past the cap, so "exactly full" and "there was more" stay distinguishable.
  return splitTruncated(stmts.listSince.all(sinceMs, capped + 1), capped);
}

/**
 * A session is gone — so is its history.
 *
 * NOT called from `deleteCachedSession`, and that is deliberate: the cache deletes are the INDEX
 * rebuilding itself, and hanging the history off them threw it away on an ordinary scan (measured — a
 * turn's events survived less than a minute). A history outlives its cache row; only a user deleting
 * what it belongs to may drop it, which is `project-refs.js`.
 */
function deleteTimelineForSession(sessionId) {
  if (!sessionId) return;
  runWithBusyRetry(() => stmts.deleteForSession.run(sessionId));
}

/**
 * A session changed its id — its past comes with it.
 *
 * Without this the history splits in two at every `/clear` and every fork: the events before the move
 * stay under an id nothing will ever ask about again, and the session appears to have begun at the
 * moment it was re-keyed. "One history per session" has to mean the session, not the id it happened to
 * carry at the time.
 */
function rekeyTimeline(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  runWithBusyRetry(() => stmts.rekey.run(toId, fromId));
}

/**
 * Every history belonging to a project the user deleted.
 *
 * ORDER MATTERS at the call site: this reads `session_cache` to find out which sessions those are, so it
 * has to run while those rows still exist. Run it after and it matches nothing and reports success.
 */
function deleteTimelineForProject(projectPath) {
  if (!projectPath) return;
  runWithBusyRetry(() => stmts.deleteForProject.run(projectPath));
}

module.exports = {
  recordTimelineEvent,
  getTimelineEvents,
  getTimelineEventsSince,
  deleteTimelineForSession,
  deleteTimelineForProject,
  rekeyTimeline,
  // For project-refs.js's cross-domain transactions — same reason tasks-store exports its own.
  stmts,
};
