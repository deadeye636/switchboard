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
probe('searchByType', () => db.searchByType('session', 'the', false));
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

db.closeDb();
console.log(JSON.stringify(out, null, 2));
