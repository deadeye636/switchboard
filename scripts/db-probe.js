// Characterization probe for #217: run the REAL db.js against a REAL database and print everything a
// split could break. No test loads db.js (better-sqlite3 is built against Electron's ABI), so `npm test`
// green says nothing about this file. Run under: ELECTRON_RUN_AS_NODE=1 electron db-probe.js <dataDir>
//
// Prints a stable, diffable JSON snapshot: the export surface, the schema version, the table/index list,
// and the result of representative reads. Capture before the split, compare after every step.
const dataDir = process.argv[2];
if (!dataDir) { console.error('usage: ELECTRON_RUN_AS_NODE=1 electron scripts/db-probe.js <dataDir>'); process.exit(2); }
process.env.SWITCHBOARD_DATA_DIR = dataDir;

const path = require('path');
const repo = path.join(__dirname, '..');
const db = require(path.join(repo, 'src', 'db', 'db.js'));

const out = {};

// 1. The export surface. The façade must re-export the SAME names with the same kinds.
out.exports = Object.keys(db).sort().map(k => `${k}:${typeof db[k]}`);

// 2. The schema version — the line that corrupts a user DB if it moves.
out.dbVersion = db.getSetting('db_version');

// 3. searchFtsRecreated is a VALUE snapshot taken after migrations ran, not a function.
out.searchFtsRecreated = db.searchFtsRecreated;
out.searchFtsRecreatedType = typeof db.searchFtsRecreated;

// 4. The physical schema. A split must not add, drop or reorder a table or index.
const Database = require('better-sqlite3');
const raw = new Database(db.DB_PATH, { readonly: true });
out.schema = raw.prepare(
  "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
).all().map(r => `${r.type}:${r.name}`);
out.sessionCacheCols = raw.prepare('PRAGMA table_info(session_cache)').all().map(c => c.name).sort();
raw.close();

// 5. Representative reads across every block that is about to move. Shape, not contents — the point is
// that each function still resolves, still hits the right table, and still answers the same way.
function probe(name, fn) {
  try {
    const v = fn();
    out[name] = Array.isArray(v) ? `array(${v.length})` : v === undefined ? 'undefined' : typeof v === 'object' && v ? `object(${Object.keys(v).sort().join('|')})` : JSON.stringify(v);
  } catch (e) {
    out[name] = `THREW: ${e.message}`;
  }
}

probe('getAllMeta', () => db.getAllMeta());
probe('isCachePopulated', () => db.isCachePopulated());
probe('getAllCached', () => db.getAllCached());
probe('getFavoritedProjects', () => db.getFavoritedProjects());
probe('getProjectStates', () => db.getProjectStates());
probe('getAutoHiddenProjects', () => db.getAutoHiddenProjects());
probe('listSettings', () => db.listSettings());
probe('listAllTags', () => db.listAllTags());
probe('listAllProjectTags', () => db.listAllProjectTags());
probe('listTagDefs', () => db.listTagDefs('session'));
probe('listTasks', () => db.listTasks({}));
probe('openTaskCountsBySession', () => db.openTaskCountsBySession());
probe('listBookmarks', () => db.listBookmarks());
probe('listSavedVariables', () => db.listSavedVariables());
probe('listAllSavedVariables', () => db.listAllSavedVariables());
probe('getDailyActivity', () => db.getDailyActivity());
probe('getTotalCounts', () => db.getTotalCounts());
probe('getModelUsage', () => db.getModelUsage());
probe('getDailyCost', () => db.getDailyCost());
probe('getHourlyActivity', () => db.getHourlyActivity());
probe('getDailyMetrics', () => db.getDailyMetrics());
probe('getDailyModelTokens', () => db.getDailyModelTokens());
probe('getDailyBackendTokens', () => db.getDailyBackendTokens());
probe('isSearchIndexPopulated', () => db.isSearchIndexPopulated());
// The third argument is `limit`, not `titleOnly`. Passing a boolean bound `false` as the limit,
// better-sqlite3 rejected it, searchByType's own catch returned [] — so this line reported "array(0)"
// forever and verified nothing. It was wrong in the pre-split code too, which is why the old/new
// comparison never noticed.
probe('searchByType', () => db.searchByType('session', 'the', 50, false));
probe('getAllFolderMeta', () => db.getAllFolderMeta());
probe('getProjectTombstones', () => db.getProjectTombstones());
probe('getProjectDisplayNames', () => db.getProjectDisplayNames());
probe('listProjectHandoffs', () => db.listProjectHandoffs('/nope'));
probe('getSessionTags', () => db.getSessionTags('nope'));
probe('getCachedByFolder', () => db.getCachedByFolder('nope'));
probe('getBackendsByProjectPath', () => db.getBackendsByProjectPath('/nope'));

// 6. A write + read-back, proving the single writer path still works end to end.
try {
  db.setSetting('__probe_key', { hello: 'world' });
  out.writeReadBack = JSON.stringify(db.getSetting('__probe_key'));
  db.deleteSetting('__probe_key');
  out.writeDeleted = JSON.stringify(db.getSetting('__probe_key') ?? null);
} catch (e) { out.writeReadBack = `THREW: ${e.message}`; }

// 7. THE PATHS A READ-ONLY PROBE CANNOT SEE, and they are here because it did not see them.
//
// The #217 split severed three closures — code moved into a module without the identifiers it used to
// capture from db.js's single file scope. Every one of them parsed, loaded, passed 1465 tests and was
// byte-identical in everything above, because everything above only READS. What broke was a scoped
// DELETE and a write that resolves its own arguments:
//   - deleteSearchFolder/deleteCachedFolder with a scope: the cold scan (a fresh install's first index),
//     "Rebuild session cache" and the post-FTS-migration repopulate all take this path on their FIRST
//     folder. It threw ReferenceError: backendScopeClause is not defined.
//   - createTask WITHOUT a projectPath: the live shape of "create task from this message", which resolves
//     the project from the session. It threw ReferenceError: getCachedSession is not defined.
// Scoping matters on its own terms too: a project bucket is keyed on cwd and shared between backends, so
// an unscoped delete takes another backend's rows with it.
probe('deleteSearchFolder(folder, scope)', () => {
  db.deleteSearchFolder('__probe_no_such_folder__', { only: ['claude'] });
  return 'ok';
});
probe('deleteCachedFolder(folder, scope)', () => {
  db.deleteCachedFolder('__probe_no_such_folder__', { only: ['claude'] });
  return 'ok';
});
probe('createTask({sessionId}) resolving its own projectPath', () => {
  const t = db.createTask({ sessionId: '__probe__', entryIndex: 1, title: 'probe', note: '', quote: '' });
  const id = t && (t.id ?? t);
  if (id) db.removeTask(id);
  return 'ok';
});

// 8. THE SESSION TIMELINE'S OWN SQL (#396), which nothing else in this repo has ever run.
//
// `npm test` covers the shape rules (timeline-record.js) and the writer's decisions (timeline.js with a
// stubbed store) — neither loads better-sqlite3, so the four statements that keep the record bounded and
// keyed have only ever been read, never executed. Every one of them is a write path on the ordinary
// quit/turn cycle, and all four fail QUIETLY: a broken prune grows the table, a broken rekey splits a
// history at the next /clear, and both look exactly like nothing happening.
//
// Written under a probe-only session id and deleted again below, so this leaves no rows behind.
const timelineStore = require(path.join(repo, 'src', 'db', 'timeline-store.js'));
const PROBE_SESSION = '__probe_timeline__';
const PROBE_SESSION_2 = '__probe_timeline_moved__';
const DAY_MS = 24 * 60 * 60 * 1000;

probe('timeline: write + read back', () => {
  timelineStore.deleteTimelineForSession(PROBE_SESSION);
  db.recordTimelineEvent({ sessionId: PROBE_SESSION, kind: 'started', label: 'Session started' });
  return `rows=${db.getTimelineEvents(PROBE_SESSION).length}`;
});

// The duplicate rule reads the newest row of the same kind — SQL, not logic, and the one thing that
// stops two producers reporting one fact from writing it twice.
probe('timeline: a second producer is not a second event', () => {
  const before = db.getTimelineEvents(PROBE_SESSION).length;
  db.recordTimelineEvent({ sessionId: PROBE_SESSION, kind: 'started', label: 'Session started' });
  return `rows ${before} -> ${db.getTimelineEvents(PROBE_SESSION).length}`;
});

// The per-session cap. Distinct `detail` with `detailIsSubject`, or the duplicate rule above would
// collapse the whole run into one row and the cap would never be reached.
probe('timeline: the per-session cap holds (500)', () => {
  for (let i = 0; i < 520; i++) {
    db.recordTimelineEvent({
      sessionId: PROBE_SESSION, kind: 'file-touched', label: 'File touched',
      detail: `probe-${i}.txt`, detailIsSubject: true,
    });
  }
  const raw2 = new Database(db.DB_PATH, { readonly: true });
  const n = raw2.prepare('SELECT COUNT(*) AS n FROM session_timeline WHERE sessionId = ?').get(PROBE_SESSION).n;
  raw2.close();
  return `rows=${n} (cap 500)`;
});

// The age bound, which no read-only check can see: a row is planted with an old `at` through the store's
// own statement — recordTimelineEvent would refuse it on arrival — and the next ordinary write must take
// it away.
probe('timeline: an old row is pruned by the next write', () => {
  timelineStore.stmts.insert.run({
    sessionId: PROBE_SESSION, kind: 'exited', label: 'Old', detail: '', at: Date.now() - 40 * DAY_MS,
  });
  db.recordTimelineEvent({ sessionId: PROBE_SESSION, kind: 'stopped', label: 'Stopped' });
  const raw3 = new Database(db.DB_PATH, { readonly: true });
  const old = raw3.prepare('SELECT COUNT(*) AS n FROM session_timeline WHERE sessionId = ? AND at < ?')
    .get(PROBE_SESSION, Date.now() - 31 * DAY_MS).n;
  raw3.close();
  return `rows older than the window=${old}`;
});

// A rekey is the ordinary case, not an edge — every /clear and every fork moves a session's id.
probe('timeline: a rekey moves the whole history', () => {
  const before = db.getTimelineEvents(PROBE_SESSION).length;
  db.rekeyTimeline(PROBE_SESSION, PROBE_SESSION_2);
  return `${before} rows -> old=${db.getTimelineEvents(PROBE_SESSION).length} new=${db.getTimelineEvents(PROBE_SESSION_2).length}`;
});

// The recap's one read, including the flag that keeps "exactly full" and "there was more" apart.
probe('timeline: the cross-session read answers bounded', () => {
  const r = db.getTimelineEventsSince(Date.now() - DAY_MS);
  return `events=${r.events.length} truncated=${r.truncated}`;
});

probe('timeline: a history can be deleted again', () => {
  db.deleteTimelineForSession(PROBE_SESSION);
  db.deleteTimelineForSession(PROBE_SESSION_2);
  return `left=${db.getTimelineEvents(PROBE_SESSION).length + db.getTimelineEvents(PROBE_SESSION_2).length}`;
});

db.closeDb();
console.log(JSON.stringify(out, null, 2));
