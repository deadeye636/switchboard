function isSqliteBusy(err) {
  return err && (
    err.code === 'SQLITE_BUSY' ||
    err.code === 'SQLITE_LOCKED' ||
    /database is locked/i.test(err.message || '')
  );
}

function runWithBusyRetry(fn, attempts = 4) {
  // The last attempt rethrows inside the catch, so the loop can only be left
  // via return or throw.
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusy(err) || i === attempts - 1) throw err;
      // better-sqlite3 is synchronous; give SQLite a tiny extra window after
      // busy_timeout when concurrent watcher/index writes briefly overlap.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
    }
  }
}

module.exports = { isSqliteBusy, runWithBusyRetry };
