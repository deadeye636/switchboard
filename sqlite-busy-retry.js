function isSqliteBusy(err) {
  return err && (
    err.code === 'SQLITE_BUSY' ||
    err.code === 'SQLITE_LOCKED' ||
    /database is locked/i.test(err.message || '')
  );
}

function runWithBusyRetry(fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusy(err) || i === attempts - 1) throw err;
      lastErr = err;
      // better-sqlite3 is synchronous; give SQLite a tiny extra window after
      // busy_timeout when concurrent watcher/index writes briefly overlap.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
    }
  }
  throw lastErr;
}

module.exports = { isSqliteBusy, runWithBusyRetry };
