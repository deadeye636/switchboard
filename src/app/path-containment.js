// app/path-containment.js — "is this path inside that one?", asked before the app reads, writes or deletes.
//
// Every caller used to answer it by comparing strings: resolve both sides, then check that one starts with
// the other. That is the right answer to a different question — it says whether a path is SPELLED inside
// the project, and a directory that is itself a junction or a symbolic link is spelled inside while its
// contents live somewhere else entirely (#474).
//
// On Windows this is not an exotic setup. A project on a `subst` drive, a folder redirected through a
// junction, a `node_modules` link — all of them pass a string compare and none of them are inside. The
// paths this guards are ones the app reads from, writes into and deletes from, so the answer has to be
// about the real path.
//
// BOTH sides are resolved, which is what keeps a legitimate layout working: a project reached through a
// link is still that project, because its root resolves to the same real directory its contents do. Only
// a path whose target genuinely sits elsewhere is refused.
//
// A path that does NOT exist is normal here — a write target is created by the write that follows — so it
// is resolved as far as it goes and the rest is kept as spelled. That is the honest answer: a link cannot
// hide in a directory that is not there yet, and the ancestors it does have are checked for real.
'use strict';

const fs = require('fs');
const path = require('path');

// Windows compares paths without regard to case, and the two sides of this check reach it from different
// places — a settings string, a dialog, a descriptor. `realpathSync.native` already returns the on-disk
// spelling for the part that exists; this covers the part that does not.
const IGNORE_CASE = process.platform === 'win32';

/**
 * The real path of `p`, as far as the filesystem can answer.
 *
 * Resolves the longest existing prefix through links and junctions, then re-attaches whatever did not
 * exist. Never throws and never returns an empty string: a path nothing can be resolved about comes back
 * as its own absolute form, which is exactly what the old string compare used.
 */
function realPathish(p) {
  const absolute = path.resolve(String(p == null ? '' : p));
  const missing = [];
  let current = absolute;
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return missing.length ? path.join(real, ...missing.slice().reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      // The root of the volume, and it did not resolve — there is nothing left to walk up to.
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

// Nothing to ask about. Said here rather than left to `path.resolve`, which turns an empty string into
// the process's working directory — so "is this inside nothing" would quietly become "is this inside
// wherever the app happens to be running from", and answer yes for half the filesystem.
function blank(p) {
  return p == null || String(p).trim() === '';
}

/** One spelling for the compare. Trailing separators are noise; case is noise on Windows only. */
function comparable(p) {
  const trimmed = p.length > 1 ? p.replace(/[\\/]+$/, '') : p;
  return IGNORE_CASE ? trimmed.toLowerCase() : trimmed;
}

/**
 * Is `child` the same real path as `parent`, or inside it?
 *
 * The answer most callers want: a project's own root counts as inside itself, because "the handoff
 * directory is the project directory" is a configuration, not an escape.
 */
function isAtOrInside(child, parent) {
  if (blank(child) || blank(parent)) return false;
  const a = comparable(realPathish(child));
  const b = comparable(realPathish(parent));
  if (a === b) return true;
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * Is `child` strictly inside `parent` — a descendant, never the directory itself?
 *
 * What a check about a FILE wants, and what the "pick another folder" dialog wants: a path that turns out
 * to be the directory it should sit in is not a file in it.
 */
function isInside(child, parent) {
  if (blank(child) || blank(parent)) return false;
  const a = comparable(realPathish(child));
  const b = comparable(realPathish(parent));
  if (a === b) return false;
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

module.exports = { realPathish, isAtOrInside, isInside };
