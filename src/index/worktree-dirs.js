// index/worktree-dirs.js — which worktrees a project HAS ON DISK (#594).
//
// A sidebar row comes from a registration or from a cached session, and a worktree has neither: it is
// not registered by design (it is a sub-unit of its project), and a freshly created one has no session
// yet. So it had no row, there was nowhere to click "new session", and the only way to get one was to
// start a session in it from outside the app and wait for the scan to notice. This is the third source.
//
// TWO decisions, both the owner's, both costed before they were built:
//
//   * **Only a REAL worktree gets a row.** `parseWorktreePath` answers about the SPELLING of a path, and
//     an ordinary folder somebody left under `.worktrees/` matches it. Offering "start a session here"
//     for that folder would be the app inventing a checkout. `isRealGitWorktree` asks the filesystem
//     instead — one `stat` and a first line per candidate. What it costs: a worktree whose `.git` file
//     is momentarily unreadable is missing until the next pass, which is the cheap direction to fail in.
//   * **Collected on the SWEEP, with a floor of its own** — never per `get-projects`. A directory
//     listing per project per refresh is the cost shape #521 and #590 each paid for once: individually
//     invisible, permanent in aggregate. `refresh()` is called from main's post-reconcile upkeep and
//     returns immediately when the floor has not elapsed, so the cost is bounded by the clock rather
//     than by how often anything asks. What it costs: a worktree created right now can take up to
//     MIN_INTERVAL_MS to appear.
//
// It is deliberately NOT in the Claude cold-scan worker, which was the first idea. That worker walks
// STORE folders rather than project paths, and its #589 gate skips almost all of them on a warm start —
// so a worktree listing hung off that loop would be blind exactly when it matters. A worktree also
// belongs to no backend, and a backend-neutral fact does not live in one backend's scan.
//
// Electron-free (fs + two pure leaves), so `node --test` can drive it.
'use strict';

const fs = require('fs');
const { worktreeDirsIn } = require('../shared/worktree-path');
const { isRealGitWorktree, normPath } = require('../session/derive-project-path');

// The floor. The same 30 s the repair sweep uses (`app/index-sweep.js`), and for the same reason: what
// bounds the cost has to be the clock, because the number of requests is not ours to bound.
const MIN_INTERVAL_MS = 30000;

// How far down to follow worktrees of worktrees. A second level happens in an agent-driven checkout (an
// agent runs in one and creates one there); a third has never been seen. Bounded rather than open,
// because this walks the filesystem and a link could otherwise make it walk forever.
const MAX_DEPTH = 3;

let log = { warn() {}, debug() {} };
let found = [];            // the worktree paths the last pass saw, newest answer wins outright
let lastRefreshAt = 0;

function init(ctx) {
  if (ctx && ctx.log) log = ctx.log;
}

/**
 * The worktrees found by the last pass. Cheap and synchronous — no filesystem, no promise: this is what
 * `buildProjectsFromCache` reads while it builds a payload somebody is waiting for.
 *
 * @returns {string[]}
 */
function list() {
  return found;
}

/** One directory's worth: the real worktrees directly inside it. */
function realWorktreesUnder(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];                      // not there, or not readable — the ordinary case, not an error
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const p = dir + '/' + entry.name;
    if (isRealGitWorktree(p)) out.push(p);
  }
  return out;
}

/**
 * Walk the conventional directories of every given project and remember what is really a worktree.
 *
 * @param {string[]} projectPaths  the projects to look under — the caller decides which (main passes the
 *                                 registered ones, because a worktree of a project nobody listed has
 *                                 nothing to be shown under either)
 * @param {{force?: boolean}} [opts]  `force` ignores the floor — for the first pass after launch and for
 *                                 a test that must not wait out a real interval
 * @returns {{ran: boolean, changed: boolean}}  `changed` is what the caller pushes on: a pass that found
 *          a new checkout has to reach the renderer, and the sweep it rides on does not notify when the
 *          index moved nothing. Reporting only "a pass ran" would push on every quiet pass instead.
 */
function refresh(projectPaths, { force = false, now = Date.now() } = {}) {
  if (!force && now - lastRefreshAt < MIN_INTERVAL_MS) return { ran: false, changed: false };
  lastRefreshAt = now;
  const before = found;

  // TWO sets, canonically keyed, and keeping them apart is the whole of it. Both halves were measured
  // wrong in turn on a live instance:
  //
  //   * ONE set, raw strings: 7 answers for 3 checkouts. The register holds a directory under several
  //     spellings — a cwd out of a transcript, a drive-letter case, a trailing separator — so a project
  //     arrives here more than once and each spelling composes a different candidate string for the same
  //     directory. That compounds with depth: once per spelling of the project, then again per spelling
  //     of every worktree above.
  //   * ONE set, canonical: 1 answer for 3. A database written before discovery stopped registering
  //     worktrees hands us worktrees AS PROJECTS, so a checkout was in the set as a starting point and
  //     its own discovery then read as a duplicate of itself.
  //
  // So `visited` bounds the WALK (never search one directory twice) and `foundKeys` bounds the ANSWER
  // (never report one checkout twice). A path can legitimately be in both.
  const visited = new Set();
  const foundKeys = new Set();
  const out = [];
  const visit = (list, p) => {
    const key = normPath(p);
    if (!key || visited.has(key)) return;
    visited.add(key);
    list.push(p);
  };
  // Breadth-first, so a project's own worktrees are found before anything nested inside them, and the
  // depth cap is a count of levels rather than of paths.
  let frontier = [];
  for (const p of (Array.isArray(projectPaths) ? projectPaths : [])) {
    if (p) visit(frontier, p);
  }
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const next = [];
    for (const base of frontier) {
      for (const dir of worktreeDirsIn(base)) {
        for (const wt of realWorktreesUnder(dir)) {
          const key = normPath(wt);
          if (key && !foundKeys.has(key)) { foundKeys.add(key); out.push(wt); }
          visit(next, wt);
        }
      }
    }
    frontier = next;
  }
  found = out;
  // Order is stable for a given tree (readdir order, walked breadth-first), so a positional compare is
  // the right one here — and it is the cheap one, at a handful of strings.
  const changed = before.length !== out.length || before.some((p, i) => p !== out[i]);
  const asked = Array.isArray(projectPaths) ? projectPaths.length : 0;
  try { log.debug(`[worktree-dirs] ${out.length} worktree(s) on disk under ${asked} project(s)${changed ? ' (changed)' : ''}`); } catch { /* best effort */ }
  return { ran: true, changed };
}

/** Test seam: forget the floor and the answer, so a test can drive two passes in one tick. */
function _reset() {
  found = [];
  lastRefreshAt = 0;
}

module.exports = {
  init,
  refresh,
  list,
  MIN_INTERVAL_MS,
  MAX_DEPTH,
  _reset,
};
