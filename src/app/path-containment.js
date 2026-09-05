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

/**
 * Are `a` and `b` two names for the same real path?
 *
 * The equality half of the same question, for a caller whose answer is not "inside" but "this one" — a
 * plugin's install record naming the project it belongs to (#545). Same two rules as the checks above:
 * the REAL path of both sides, so a project reached through a junction is still that project, and case
 * ignored only where the filesystem ignores it. An unconditional `toLowerCase()` answers "yes" about two
 * different directories on Linux and macOS.
 */
function samePath(a, b) {
  if (blank(a) || blank(b)) return false;
  return comparable(realPathish(a)) === comparable(realPathish(b));
}

// --- the same answer, as a KEY (#563) ---
//
// `samePath` answers about two paths. Grouping asks about hundreds, over and over: every session row
// hands its project path to a bucket, and the sidebar rebuilds on every scan. A predicate cannot be a
// bucket, so those callers need the canonical form itself rather than a yes/no about it.
//
// Resolving a path through the filesystem is NOT free, and the issue that brought these callers here said
// to measure rather than assume. Measured on this machine, 20 000 calls over 200 existing directories:
// 0.74 us per call for the string compare this replaces, 91.6 us through `realPathish` — 124x — and
// 212 us for a path whose last two segments do not exist, because that one walks up looking for an
// ancestor that does. One sidebar rebuild (`projects-view.buildProjectsFromCache`, 2 000 session rows
// over 200 real directories) went from 16 ms to 311 ms with that cost paid per call. So the answer is
// remembered: the same 20 000 calls cost 1.07 us each through the memo, the rebuild is back at 16 ms, and
// one that starts with nothing remembered — what a 15-second scan actually pays — costs about 28 ms.
//
// The memory is deliberately short and deliberately NOT shared with the guards above. `isInside`,
// `isAtOrInside` and `samePath` decide whether the app may read, write or delete somewhere; they ask the
// disk every time, and nothing here changes that. `pathKey` answers a question about identity — which
// bucket, which project, which line of a transcript — where a stale answer costs a regrouping and not an
// escape. One window covers one pass over a store or one transcript rewrite; a directory that was moved
// or re-linked is noticed well inside the 15-second scan interval.
const KEY_MEMO_MS = 2000;
const KEY_MEMO_MAX = 4096;
let _keyMemo = new Map();
let _keyMemoAt = 0;

/**
 * The canonical identity of `p`, as a comparison KEY: the real path, spelled the way the filesystem
 * spells it, lowercased only where the filesystem ignores case.
 *
 * Blank comes back as `''` — never as the working directory (`path.resolve('')`), and never as the
 * four-character string `"null"`. This value is used as a MAP KEY, so a row with no project path has to
 * land nowhere rather than in a bucket named after a bug.
 *
 * Two keys being equal is exactly what `samePath` answers; `test/path-containment.test.js` pins that.
 */
function pathKey(p) {
  if (blank(p)) return '';
  const input = String(p);
  const now = Date.now();
  if (now - _keyMemoAt > KEY_MEMO_MS || _keyMemo.size >= KEY_MEMO_MAX) {
    _keyMemo.clear();
    _keyMemoAt = now;
  }
  let hit = _keyMemo.get(input);
  if (hit === undefined) {
    hit = comparable(realPathish(input));
    _keyMemo.set(input, hit);
  }
  return hit;
}

module.exports = {
  realPathish, isAtOrInside, isInside, samePath, pathKey,
  // For a test that creates a link between two questions about the same path. Nothing in the app calls it.
  _resetPathKeyMemo: () => { _keyMemo = new Map(); _keyMemoAt = 0; },
};
