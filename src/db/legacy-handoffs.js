// The handoff library's old home (#468).
//
// A handoff used to be a row in `project_handoffs`. It is a file in its project now, so this module exists
// for exactly one job: getting the rows OUT, and dropping the table once every one of them has been
// written to disk. `src/app/handoffs.js` runs it at startup and decides what "written" means.
//
// Its statements are prepared INSIDE the functions rather than at module load, which is the opposite of
// every store beside it — and deliberately. After the first successful pass there is no table to prepare
// against, and a fresh database never had one; a `db.prepare` up top would throw in both of those cases,
// on a file whose whole purpose is to cope with the table being gone.
'use strict';

const { db } = require('./connection');
const { runWithBusyRetry } = require('./sqlite-busy-retry');

function tableExists() {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_handoffs'").get();
  } catch { return false; }
}

/** Every saved packet still in the database, oldest first. */
function readLegacyHandoffs() {
  if (!tableExists()) return [];
  try {
    return db.prepare(
      'SELECT id, projectPath, label, content, createdAt, backendId FROM project_handoffs ORDER BY createdAt',
    ).all();
  } catch {
    return [];
  }
}

/** Drop it. Only ever called once every row has become a file — the caller owns that rule. */
function dropLegacyHandoffTable() {
  if (!tableExists()) return false;
  runWithBusyRetry(() => db.exec('DROP TABLE IF EXISTS project_handoffs'));
  return true;
}

module.exports = { readLegacyHandoffs, dropLegacyHandoffTable, _tableExists: tableExists };
