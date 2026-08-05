// Keeping the database from drifting upward for ever (#430).
//
// WHAT GROWS, AND WHY IT NEVER CAME BACK DOWN. Two things, measured on a real 102 MB install:
//   - `search_fts_data` held 86.9 MB — 85% of the whole file — for 4.3 MB of indexed text, spread over
//     22 407 segment rows. Every scan APPENDS FTS5 segments and nothing ever merged them.
//   - Nothing returned free pages either: `auto_vacuum` was `none` and the only VACUUM in the repo
//     belongs to a one-off migration, so pages freed by a reindex were recycled inside the file and the
//     file itself never shrank.
// Merging first and vacuuming second took that database to 17.5 MB — 83% smaller — with an unchanged
// search result and `integrity_check` = ok.
//
// THE ORDER IS THE POINT. `optimize` reclaims nothing on disk: it merges the segments and hands the
// pages it frees to the freelist. The vacuum is what gives them back to the OS. Running only the second
// one is what the app effectively did for a whole migration, and it bought 9% instead of 83%.
//
// Nothing here prepares a statement at load, so this module is free of the "require me below
// runMigrations" rule the stores carry — there is no table it needs to exist yet.
//
// Everything is wrapped: an upkeep pass is never worth taking the app down for, and every call here can
// legitimately lose a race with the search worker's reader connection (SQLITE_BUSY).
'use strict';

const { db } = require('./connection');

// A full VACUUM below this much waste is not worth an exclusive lock — the incremental pass covers it.
const FULL_VACUUM_MIN_BYTES = 32 * 1024 * 1024;
const FULL_VACUUM_MIN_RATIO = 0.2;
// One incremental pass hands back at most this many pages, so it stays a short interruption whatever
// the freelist looks like. At 4 KiB pages that is 32 MiB.
const INCREMENTAL_MAX_PAGES = 8192;

function pragmaNumber(name) {
  try {
    const value = db.pragma(name, { simple: true });
    return typeof value === 'number' ? value : Number(value) || 0;
  } catch { return 0; }
}

// What the file is made of right now: its size in pages, and how much of that is already free.
function freeSpace() {
  const pageSize = pragmaNumber('page_size') || 4096;
  const pageCount = pragmaNumber('page_count');
  const freelist = pragmaNumber('freelist_count');
  return {
    pageSize,
    pageCount,
    freelist,
    freeBytes: freelist * pageSize,
    totalBytes: pageCount * pageSize,
    ratio: pageCount ? freelist / pageCount : 0,
  };
}

// Merge the FTS index. Cheap when it is already merged — that is what makes it safe to run every
// launch without asking whether it is needed.
function optimizeSearchIndex() {
  const started = Date.now();
  try {
    db.exec("INSERT INTO search_fts(search_fts) VALUES('optimize')");
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: err && err.message };
  }
}

// Is the waste worth an exclusive lock? Decided on both the share and the absolute size: 20% of a small
// database is not worth stalling for, and 32 MB of a big one is worth it even at a lower share.
function needsFullVacuum(space = freeSpace()) {
  return space.freeBytes >= FULL_VACUUM_MIN_BYTES || space.ratio >= FULL_VACUUM_MIN_RATIO;
}

// Give the pages back. Only reachable on a database whose auto_vacuum is INCREMENTAL — on any other it
// is a no-op that reports zero, which is why the caller falls back to the full form.
function incrementalVacuum(pages = INCREMENTAL_MAX_PAGES) {
  const started = Date.now();
  const before = freeSpace();
  try {
    db.pragma(`incremental_vacuum(${Math.max(1, Math.floor(pages))})`);
    const after = freeSpace();
    return { ok: true, ms: Date.now() - started, reclaimedBytes: Math.max(0, before.totalBytes - after.totalBytes) };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, reclaimedBytes: 0, error: err && err.message };
  }
}

// The expensive form: rewrites the file. Takes an exclusive lock for its whole duration (182 ms on the
// measured 102 MB database), which is why the caller keeps it away from a running session.
function fullVacuum() {
  const started = Date.now();
  const before = freeSpace();
  try {
    db.exec('VACUUM');
    const after = freeSpace();
    return { ok: true, ms: Date.now() - started, reclaimedBytes: Math.max(0, before.totalBytes - after.totalBytes) };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, reclaimedBytes: 0, error: err && err.message };
  }
}

// Is this database set up to hand pages back incrementally? `auto_vacuum` can only be turned on before
// the first table exists (connection.js does that for a new file), so an existing install answers 0 here
// for ever and only the full form can reclaim anything.
function autoVacuumMode() {
  return pragmaNumber('auto_vacuum');
}

module.exports = {
  freeSpace, optimizeSearchIndex, needsFullVacuum, incrementalVacuum, fullVacuum, autoVacuumMode,
  FULL_VACUUM_MIN_BYTES, FULL_VACUUM_MIN_RATIO, INCREMENTAL_MAX_PAGES,
};
