// Worktrees outside the layout (#757): recognised by their `.git` file while they exist, remembered in the
// database, and handed to `src/shared/worktree-path.js` so every question asked there answers for them.
//
// Why remembered: an agent creates a checkout, works in it and deletes it. Its sessions stay, and with the
// folder gone nothing on disk says it was a worktree — so it turned into a project of its own, offered in
// the "not on your list" notice. The `.git` file is read ONCE per path per run, the first time a build or a
// sweep hands that path in; a path that is not a worktree is remembered as such for the life of the process
// only, so a directory that becomes one later is seen after a restart.
//
// Which project it belongs to is decided here, not stored: the nearest project on the list whose directory
// holds the worktree's repository (owner's decision on #757). The register changes, the fact does not.
'use strict';

const fs = require('fs');
const { worktreeRepoAt } = require('../session/derive-project-path');
const { isAtOrInside } = require('../app/path-containment');
const { parseWorktreePath, setKnownWorktrees } = require('../shared/worktree-path');

let ctx = null;
const probed = new Set();       // paths whose `.git` was read this run, whatever it said
let facts = null;               // key → {worktreePath, repoPath}, from the database, loaded once
let listedSignature = null;     // the register the current answer was computed against
let current = [];               // [{path, parentPath, repoPath}] — what the shared module holds

function init(c) {
  ctx = c;
  probed.clear();
  facts = null;
  listedSignature = null;
  current = [];
  setKnownWorktrees([]);
}

// The spelling-insensitive key the shared module uses too: lexical on purpose, because this is asked for
// every session path on every payload build and a real-path key costs a stat per path.
const keyOf = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function loadFacts() {
  if (!facts) {
    let rows = [];
    try { rows = ctx.db.getKnownWorktrees() || []; } catch { rows = []; }
    facts = new Map();
    for (const f of rows) facts.set(keyOf(f.worktreePath), f);
  }
  return facts;
}

/**
 * Probe the paths not seen before, then recompute which project each remembered worktree belongs to when
 * a new one turned up or the register changed.
 *
 * Each path is read once per run. A remembered path whose folder still exists is read again on that first
 * sighting, so a directory that stopped being a worktree (or became one of another repository) is
 * corrected; one whose folder is gone keeps its fact, which is what the fact is for.
 *
 * @param {Iterable<string>} projectPaths  every path a session points at
 * @param {Map<string, object>} states    `getProjectStates()`, already read by the caller
 * @returns {{changed: boolean}}  whether the answer the shared module holds moved
 */
function refresh(projectPaths, states) {
  if (!ctx) return { changed: false };
  const known = loadFacts();
  let moved = false;
  for (const p of projectPaths || []) {
    const key = keyOf(p);
    if (!key || probed.has(key)) continue;
    probed.add(key);
    // A layout path is already a worktree by its spelling; asking its `.git` again adds nothing.
    if (parseWorktreePath(p) && !known.has(key)) continue;
    const had = known.get(key);
    const repoPath = worktreeRepoAt(p);
    if (repoPath) {
      if (had && keyOf(had.repoPath) === keyOf(repoPath)) continue;
      try { ctx.db.recordKnownWorktree(had ? had.worktreePath : p, repoPath); } catch { /* kept for this run */ }
      known.set(key, { worktreePath: had ? had.worktreePath : p, repoPath });
      moved = true;
      if (ctx.log) ctx.log.info(`[worktree] ${p} is a worktree of ${repoPath}`);
    } else if (had && fs.existsSync(p)) {
      // The folder is there and is no worktree any more: the fact is wrong now, not merely unconfirmed.
      try { ctx.db.forgetKnownWorktree(had.worktreePath); } catch { /* dropped for this run anyway */ }
      known.delete(key);
      moved = true;
    }
  }

  // A path somebody ACTED on keeps the behaviour it had (owner's decision on #757): one on the list stays
  // a project of its own however its `.git` reads (#147 — a long-lived checkout listed on purpose), and one
  // that was removed stays removed. This is only about checkouts that come and go by themselves.
  const listed = [];
  const actedOn = new Set();
  for (const [p, s] of states || []) {
    if (!s) continue;
    if (s.registered && !s.removedAt) listed.push(p);
    if (s.registered || s.removedAt) actedOn.add(keyOf(p));
  }
  const signature = [...actedOn].sort().join('\n') + '\n|\n' + listed.slice().sort().join('\n');
  if (!moved && signature === listedSignature) return { changed: false };
  listedSignature = signature;

  const next = [];
  for (const [key, f] of known) {
    if (actedOn.has(key)) continue;
    // The nearest listed project holding the repository: the longest path that contains it. A worktree
    // whose repository sits in no listed project has no project to belong to and stays what it was.
    let parentPath = null;
    for (const p of listed) {
      if ((!parentPath || p.length > parentPath.length) && isAtOrInside(f.repoPath, p)) parentPath = p;
    }
    if (parentPath) next.push({ path: f.worktreePath, parentPath, repoPath: f.repoPath });
  }
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  current = next;
  setKnownWorktrees(current);
  return { changed };
}

/**
 * Was this path seen to be a worktree (whether or not it has a project to belong to right now)? Discovery
 * asks it and never registers such a path: listed, it would be a project for good.
 */
function isWorktreeFact(p) {
  return !!(facts && facts.has(keyOf(p)));
}

/** Drop what was remembered about a path whose history was cleaned up — it is a stranger if it returns. */
function forget(p) {
  const key = keyOf(p);
  if (facts && facts.has(key)) {
    const f = facts.get(key);
    facts.delete(key);
    try { ctx.db.forgetKnownWorktree(f.worktreePath); } catch { /* gone for this run anyway */ }
  }
  probed.delete(key);
  listedSignature = null;
}

/** The remembered worktrees with their project, as the shared module holds them. */
function list() {
  return current;
}

module.exports = { init, refresh, list, isWorktreeFact, forget };
