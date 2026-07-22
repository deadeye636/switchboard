// backends/livestate-cache.js — the cheap change-signal that gates a live-state store read (#282 lever 1).
//
// adopt.updateBackendLiveStates() re-reads busy/idle for EVERY live Axis-B session on EVERY watcher flush,
// and a flush fires on any backend's store change (600 ms debounce). For the two SQLite backends (agy,
// Hermes) each read re-OPENED the database — mmap + WAL-lock churn — several times a second, even when the
// session's own store had not moved and even when the flush came from a different backend entirely. That
// re-open was ~85 % of the measured disk read.
//
// The fix is to open only when the store file actually changed. A stat is metadata (no open, no lock, no
// content read); comparing (mtime, size) of the db file AND its `-wal` sibling tells us whether to re-read.
// The `-wal` matters: SQLite in journal_mode=wal (both backends run WAL) can land a commit in `<db>-wal`
// without touching the main file's mtime, so gating on the main file alone would miss live writes — the
// exact trap hermes/reader.js and file-store.js already call out.
'use strict';

const fs = require('fs');

/** (mtime, size) of one file as an opaque string. Missing/unreadable -> a stable sentinel. */
function fileSig(p) {
  try {
    const s = fs.statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '0:0';
  }
}

/** Signature of a SQLite db that also moves on a WAL commit (folds in the `-wal` sibling). */
function dbSignature(dbPath) {
  return `${fileSig(dbPath)}|${fileSig(String(dbPath) + '-wal')}`;
}

module.exports = { fileSig, dbSignature };
