// changes-store.js — what a session changed (#870, spec 47 section 3).
//
// Two kinds of rows, kept apart on purpose:
//   DERIVED  session_change_file / _event / _meta — what the scan read out of a transcript. `replaceSessionChanges` replaces
//            ONE session's rows whole in one transaction. A folder wipe (`deleteCachedFolder`, backend-scoped) and the
//            source-gone delete (`deleteCachedSession`, via `deleteDerivedForSession`) drop them with the cache rows.
//   USER     session_change_entry (the timeline of a lineage: its start, Clear, `/clear`) and session_meta.changesView
//            (the range and view picked for a session). Never touched by a folder wipe or a source-gone delete; they go with
//            a DELIBERATE delete, per session (`deleteChangesStateForSession`).
//
// THE WRITE CONTRACT, which the parsers (T4 to T6) keep: a full (non-incremental) parse of a reporting backend ALWAYS emits
// `changes`, empty included; an incremental parse emits the cumulative aggregate whenever it moved; `replaceSessionChanges`
// is whole-session; an ABSENT `changes` means "the parser did not report", and what is stored stays. That is why a wipe may
// delete the derived rows: the reparse that follows it is a full parse and writes them again.
//
// Everything keys on session id, never on a project path, so a project rename (`renameProjectRefs`) moves nothing here.
// Push entries of the timeline are not stored: a push is an event row with its snapshot (D4), read from there.
//
// The row shapes, caps and normalising are in `changes-record.js`, outside this file for the usual reason: this module
// requires `connection`, which opens the real database, and no test loads it.
'use strict';

const { db } = require('./connection');
const { runWithBusyRetry } = require('./sqlite-busy-retry');
const {
  normalizeChanges, normalizeSnapshot, makeEntry, pairsOf, cleanChangesView, MAX_TIMELINE_ENTRIES,
} = require('./changes-record');

const stmts = {
  fileInsert: db.prepare(`INSERT INTO session_change_file (sessionId, path, edits, firstPosition, lastPosition, lastAt)
    VALUES (?, ?, ?, ?, ?, ?)`),
  eventInsert: db.prepare(`INSERT INTO session_change_event
    (sessionId, kind, position, at, sha, subject, branch, amend, ok, moved, upToDate, force, summary, snapshot, snapshotTruncated)
    VALUES (@sessionId, @kind, @position, @at, @sha, @subject, @branch, @amend, @ok, @moved, @upToDate, @force, @summary, @snapshot, @snapshotTruncated)`),
  metaUpsert: db.prepare(`INSERT INTO session_change_meta (sessionId, truncated) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET truncated = excluded.truncated`),
  fileDelete: db.prepare('DELETE FROM session_change_file WHERE sessionId = ?'),
  eventDelete: db.prepare('DELETE FROM session_change_event WHERE sessionId = ?'),
  metaDelete: db.prepare('DELETE FROM session_change_meta WHERE sessionId = ?'),

  entryInsert: db.prepare(`INSERT INTO session_change_entry
    (lineageId, sessionId, kind, position, at, sha, fromSha, toSha, fromPosition, files, filesTruncated, repoRoot, how)
    VALUES (@lineageId, @sessionId, @kind, @position, @at, @sha, @fromSha, @toSha, @fromPosition, @files, @filesTruncated, @repoRoot, @how)`),
  entryCount: db.prepare('SELECT COUNT(*) AS n FROM session_change_entry WHERE lineageId = ?'),
  // The oldest entry that is not the lineage's start: what falls out when the cap is reached.
  entryOldestDroppable: db.prepare(`SELECT id FROM session_change_entry WHERE lineageId = ? AND kind != 'start'
    ORDER BY id ASC LIMIT 1`),
  entryDeleteId: db.prepare('DELETE FROM session_change_entry WHERE id = ?'),
  // Insertion order, not time: the chain is the order the entries were made in, and a clock step must not reorder it.
  entryList: db.prepare('SELECT * FROM session_change_entry WHERE lineageId = ? ORDER BY id ASC'),
  entryDeleteSession: db.prepare('DELETE FROM session_change_entry WHERE sessionId = ?'),
  // A start stored without a SHA (a fork first seen, no repository answered yet) gets its SHA once, never replaced.
  entrySetStartSha: db.prepare(`UPDATE session_change_entry SET sha = ?, repoRoot = COALESCE(repoRoot, ?)
    WHERE id = ? AND kind = 'start' AND sha IS NULL`),
  // No per-project statement: every deliberate delete drops a session's user state by id (`deleteChangesStateForSession`,
  // called from `deleteProjectSessions` and `removeProject` in projects.js and from the worktree delete in main.js).

  viewGet: db.prepare('SELECT changesView FROM session_meta WHERE sessionId = ?'),
  viewSet: db.prepare(`INSERT INTO session_meta (sessionId, changesView) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET changesView = excluded.changesView`),
  viewClear: db.prepare('UPDATE session_meta SET changesView = NULL WHERE sessionId = ?'),
};

const flag = (b) => (b ? 1 : 0);
const snapshotJson = (files) => (Array.isArray(files) ? JSON.stringify(files) : null);

const replaceBatch = db.transaction((sessionId, changes) => {
  stmts.fileDelete.run(sessionId);
  stmts.eventDelete.run(sessionId);
  for (const f of changes.files) stmts.fileInsert.run(sessionId, f.path, f.count, f.first, f.last, f.at);
  for (const c of changes.commits) {
    stmts.eventInsert.run({
      sessionId, kind: 'commit', position: c.position, at: c.at, sha: c.sha, subject: c.subject, branch: c.branch,
      amend: flag(c.amend), ok: 0, moved: 0, upToDate: 0, force: 0, summary: null, snapshot: null, snapshotTruncated: 0,
    });
  }
  for (const p of changes.pushes) {
    stmts.eventInsert.run({
      sessionId, kind: 'push', position: p.position, at: p.at, sha: null, subject: null, branch: null,
      amend: 0, ok: flag(p.ok), moved: flag(p.moved), upToDate: flag(p.upToDate), force: flag(p.force),
      summary: p.summary, snapshot: snapshotJson(p.files), snapshotTruncated: flag(p.truncated),
    });
  }
  stmts.metaUpsert.run(sessionId, flag(changes.truncated));
});

/**
 * Replace the derived rows of ONE session from a parsed row's `changes` (normalised here), in one transaction. The caller
 * calls it only when the row carries `changes`: absent means "the parser did not report", and that keeps what is stored.
 * An empty `changes` (nothing found) clears the session's rows. Returns false for a value that is not an object.
 */
function replaceSessionChanges(sessionId, changes) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const clean = normalizeChanges(changes);
  if (!clean) return false;
  runWithBusyRetry(() => replaceBatch(sessionId, clean));
  return true;
}

const CHUNK = 400; // well below SQLite's variable limit

/**
 * The derived rows of several sessions: `Map<sessionId, { files, commits, pushes, truncated }>` in the shape
 * `normalizeChanges` returns, so the model's helpers read it as it is. A session with no row is absent from the map.
 */
function getSessionChanges(sessionIds) {
  const ids = Array.from(new Set((Array.isArray(sessionIds) ? sessionIds : []).filter((s) => typeof s === 'string' && s)));
  const out = new Map();
  const bucket = (id) => {
    let b = out.get(id);
    if (!b) { b = { files: [], commits: [], pushes: [], truncated: false }; out.set(id, b); }
    return b;
  };
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const marks = part.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT sessionId, truncated FROM session_change_meta WHERE sessionId IN (${marks})`).all(...part)) {
      bucket(r.sessionId).truncated = r.truncated === 1;
    }
    for (const r of db.prepare(`SELECT sessionId, path, edits, firstPosition, lastPosition, lastAt FROM session_change_file
        WHERE sessionId IN (${marks}) ORDER BY sessionId, path`).all(...part)) {
      bucket(r.sessionId).files.push({ path: r.path, count: r.edits, first: r.firstPosition, last: r.lastPosition, at: r.lastAt });
    }
    for (const r of db.prepare(`SELECT * FROM session_change_event WHERE sessionId IN (${marks}) ORDER BY sessionId, id`).all(...part)) {
      const b = bucket(r.sessionId);
      if (r.kind === 'commit') {
        const ev = { sha: r.sha, subject: r.subject || '', branch: r.branch || '', position: r.position, at: r.at };
        if (r.amend === 1) ev.amend = true;
        b.commits.push(ev);
      } else if (r.kind === 'push') {
        const ev = { ok: r.ok === 1, summary: r.summary || '', position: r.position, at: r.at };
        if (r.upToDate === 1) ev.upToDate = true;
        if (r.force === 1) ev.force = true;
        if (r.moved === 1) ev.moved = true;
        if (r.snapshot) {
          try { ev.files = pairsOf(JSON.parse(r.snapshot)); } catch { ev.files = []; }
          if (r.snapshotTruncated === 1) ev.truncated = true;
        }
        b.pushes.push(ev);
      }
    }
  }
  return out;
}

// --- the timeline of a lineage (user state) ---

function entryRow(e, extra) {
  const x = extra || {};
  return {
    lineageId: e.lineageId, sessionId: e.sessionId, kind: e.kind, position: e.position, at: e.at, sha: e.sha,
    fromSha: e.fromSha, toSha: e.toSha, fromPosition: e.fromPosition,
    files: e.files.length || x.hasFiles ? JSON.stringify(e.files) : null,
    filesTruncated: flag(e.truncated),
    repoRoot: typeof x.repoRoot === 'string' ? x.repoRoot.slice(0, 1024) : null,
    how: typeof x.how === 'string' ? x.how.slice(0, 32) : null,
  };
}

const addEntryTx = db.transaction((row, lineageId) => {
  if (stmts.entryCount.get(lineageId).n >= MAX_TIMELINE_ENTRIES) {
    const old = stmts.entryOldestDroppable.get(lineageId);
    if (old) stmts.entryDeleteId.run(old.id);
  }
  return stmts.entryInsert.run(row).lastInsertRowid;
});

/**
 * Fill the SHA of a `start` entry that was stored without one (a fork's start is stored the first time the fork is seen,
 * from the database alone; its baseline commit is found later, when a repository answers). Never replaces a SHA.
 * Returns true when a row changed.
 */
function setStartSha(id, sha, repoRoot) {
  if (!Number.isInteger(id) || typeof sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(sha)) return false;
  const root = typeof repoRoot === 'string' ? repoRoot.slice(0, 1024) : null;
  return runWithBusyRetry(() => stmts.entrySetStartSha.run(sha, root, id)).changes === 1;
}

/**
 * Add one entry (`start`, `clear` or `cli-clear`; a push is an event and is refused here) to a lineage's timeline.
 * `fields` are `makeEntry`'s; `extra` carries what only a `start` baseline has: `{ repoRoot, how }`. At the cap the oldest
 * entry that is not the start falls out. Returns the stored entry (with its `id`) or null.
 */
function addEntry(kind, fields, extra) {
  if (kind === 'push') return null;
  const e = makeEntry(kind, fields);
  if (!e) return null;
  const row = entryRow(e, { ...(extra || {}), hasFiles: fields && fields.files !== undefined });
  const id = runWithBusyRetry(() => addEntryTx(row, e.lineageId));
  return { id: Number(id), ...e, repoRoot: row.repoRoot, how: row.how };
}

/**
 * A lineage's entries in insertion order (the chain). A Clear's range STARTS at the PREVIOUS entry's `sessionId` +
 * `position` (D6: a position is comparable only inside one session, and the model reads the boundary pair from the two
 * neighbouring entries). `fromPosition` is informational only (where the review began, for display) and decides nothing.
 *`files` is `{ files, truncated }` (a snapshot object `diffCounts` takes) or null. */
function listEntries(lineageId) {
  if (typeof lineageId !== 'string' || !lineageId) return [];
  return stmts.entryList.all(lineageId).map((r) => {
    let files = null;
    if (r.files) {
      try { const s = normalizeSnapshot(JSON.parse(r.files)); files = { files: s.files, truncated: s.truncated || r.filesTruncated === 1 }; } catch { files = null; }
    }
    return {
      id: r.id, kind: r.kind, lineageId: r.lineageId, sessionId: r.sessionId, position: r.position, at: r.at, sha: r.sha,
      fromSha: r.fromSha, toSha: r.toSha, fromPosition: r.fromPosition, files, repoRoot: r.repoRoot, how: r.how,
    };
  });
}

// --- the range and view picked per session (user state, in session_meta) ---

// The cleaning is `cleanChangesView` in changes-record.js (pure, so a test reaches it): a pick end is an entry id or a
// push tick's key.
const cleanView = cleanChangesView;

/** `{ range, view, pickFrom, pickTo }` or null (= the default: "Since last review", "All"). A pick end is an entry id or a push tick key. */
function getChangesView(sessionId) {
  const r = stmts.viewGet.get(sessionId);
  if (!r || !r.changesView) return null;
  try { return cleanView(JSON.parse(r.changesView)); } catch { return null; }
}

/** Store the picked range and view; `null` clears it back to the default. */
function setChangesView(sessionId, value) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  const v = value === null ? null : cleanView(value);
  if (value !== null && !v) return;
  runWithBusyRetry(() => (v ? stmts.viewSet.run(sessionId, JSON.stringify(v)) : stmts.viewClear.run(sessionId)));
}

// --- deletes ---

/** The derived rows of one session (its source is gone). Raw statements, for a caller already inside a retry. */
function deleteDerivedForSession(sessionId) {
  stmts.fileDelete.run(sessionId);
  stmts.eventDelete.run(sessionId);
  stmts.metaDelete.run(sessionId);
}

/** The USER-STATE rows of one session: its timeline entries and its picked view. For a DELIBERATE delete only. */
function deleteChangesStateForSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  runWithBusyRetry(() => {
    stmts.entryDeleteSession.run(sessionId);
    stmts.viewClear.run(sessionId);
  });
}

module.exports = {
  stmts,
  replaceSessionChanges, getSessionChanges, deleteDerivedForSession,
  addEntry, setStartSha, listEntries, getChangesView, setChangesView, deleteChangesStateForSession,
};
