// projects/register-lookup.js — WHICH ROW of the register is this project's? (#579)
//
// `project_meta` is keyed on the projectPath STRING, so every question about a project has to survive the
// fact that one directory is spelled several ways: a cwd out of a transcript, a project reached through a
// junction, a symlink or a `subst` drive, a different drive-letter case, a trailing separator. #563 made
// the COMPARE answer about the real path and #566 brought the register's WRITES under one resolver — but
// the resolver lived in `projects.js` beside the writers, so the READ side went on asking the raw string.
// Three readers did, and one of them offered a removed project back (#579).
//
// This is that resolver, on its own so both sides can hold it: `projects.js` for the acts, and
// `index/index-writes.js` for the one predicate the scan loop asks per session. It knows no database and
// no Electron — it is handed the register as a plain Map and answers about it.
//
// THE PRECEDENCE, and it is the write side's, because a read that resolves differently from the write is
// the same bug in the other direction:
//
//   1. a REGISTERED row for the same directory — the caller's own spelling first among those, so a
//      database that already carries two registered rows for one directory still answers about the row it
//      was asked about;
//   2. failing that, the exact spelling — there IS a row for it;
//   3. failing that, any row for the same directory;
//   4. and no row at all is `null`: a removal of a project that only exists in a backend's own config
//      still has to leave its tombstone somewhere, so the caller keeps its own path.
//
// `pathKey` is memoised, which is what keeps this affordable at the one call site that runs per session
// rather than per click — see the measurement in `app/path-containment.js`, and the note on
// `isRemovedProject` in `index/index-writes.js` for why that site does not reach here on every row.
'use strict';

const { pathKey } = require('../app/path-containment');

/**
 * Key a whole register ONCE, and answer about it many times.
 *
 * For a caller that resolves in a loop — `unlistedProjects` walks every admin row — because resolving
 * one path at a time would re-key the register per row.
 *
 * @param {Map<string, object>} states  projectPath -> its `project_meta` row (`db.getProjectStates()`)
 * @returns {(projectPath: string) => ({ path: string, state: object }|null)}
 */
function registerLookup(states) {
  const rows = states instanceof Map ? states : new Map(states || []);
  // directory identity -> { registered: the first registered spelling, any: the first spelling at all }
  const byKey = new Map();
  for (const [p, state] of rows) {
    const key = pathKey(p);
    if (!key) continue;                       // a row with no path lands nowhere, never in a bucket named after a bug
    let entry = byKey.get(key);
    if (!entry) { entry = { registered: null, any: p }; byKey.set(key, entry); }
    if (entry.registered === null && state && state.registered) entry.registered = p;
  }

  return function lookup(projectPath) {
    if (!projectPath) return null;
    const exact = rows.get(projectPath) || null;
    // Rule 1, the caller's own spelling: nothing below can outrank a registered row the caller named.
    if (exact && exact.registered) return { path: projectPath, state: exact };
    const entry = byKey.get(pathKey(projectPath));
    // Rule 1, another spelling of the same directory.
    if (entry && entry.registered !== null) {
      return { path: entry.registered, state: rows.get(entry.registered) || null };
    }
    if (exact) return { path: projectPath, state: exact };            // rule 2
    if (!entry) return null;                                          // rule 4
    return { path: entry.any, state: rows.get(entry.any) || null };   // rule 3
  };
}

/**
 * The same answer for a single path — what an ACT asks, once per click.
 *
 * @param {Map<string, object>} states
 * @param {string} projectPath
 * @returns {{ path: string, state: object }|null}
 */
function resolveRegisterRow(states, projectPath) {
  return registerLookup(states)(projectPath);
}

module.exports = { registerLookup, resolveRegisterRow };
