// backends/rewrite-cwd.js — move a session's transcript from one project path to another (#171).
//
// A remap used to rewrite `~/.claude/projects/**` and nothing else. So a project with Claude AND Codex
// sessions split in two: Claude's history followed the rename, Codex' stayed behind as a phantom project
// at the old path. A project with ONLY Codex sessions could not be remapped at all — the handler bailed
// with "No session data found", because it looked in Claude's store for them.
//
// Each backend knows where its own cwd lives, so each declares how to rewrite it. This is the shared
// machinery: read the JSONL, hand every line to the backend's rule, write it back atomically.
//
// A backend whose store is not files (Hermes: a read-only SQLite we may never write, #2914) declares
// nothing — and the caller reports honestly that those sessions keep the old path.
'use strict';

const fs = require('fs');
// "Is this the same directory" has one answer, and it is about the REAL path of both sides (#563).
const { pathKey } = require('../app/path-containment');

/**
 * Same directory? Windows spells it both ways in the same store (`d:\x` and `D:\X`).
 *
 * This was a string compare of its own, and it got the Windows half it was written for wrong as well
 * (#563). It trimmed a trailing separator and lowercased on `win32` — but it never folded `\` against
 * `/`, which its sibling key in `session/derive-project-path.js` did, so `d:/x` and `d:\x` were two
 * directories to the remap and one to everything else. Being lexical at all is the larger half: a project
 * reached through a junction, a symlink or a `subst` drive is spelled two ways, the compare said
 * "different", and the remap skipped exactly the lines it was called to rewrite — leaving a phantom
 * project at the old path, which is the bug #171 built this file to fix.
 *
 * (The issue that sent us here called the lowercase unconditional. It was not — it was already behind a
 * `process.platform === 'win32'` check, so the Linux direction, where two directories differing only in
 * case would have been merged and one transcript rewritten with the other's path, was never live here.)
 *
 * `pathKey` is the memoised form, and here that is not an optimisation but the difference between a
 * usable remap and an unusable one: `claudeLine` asks this on EVERY line of a transcript that can reach
 * hundreds of megabytes, and a filesystem round trip per line would be minutes. The paths asked about are
 * two — the old path and whatever the line names — so the memo answers all but the first few.
 */
function samePath(a, b) {
  if (!a || !b) return false;
  return pathKey(a) === pathKey(b);
}

/**
 * Rewrite one transcript in place.
 *
 * @param {string} filePath  the transcript
 * @param {function} rewriteLine  (parsedLine, oldPath, newPath) -> true when it changed the line
 * @returns {boolean} whether anything was written
 */
function rewriteTranscript(filePath, oldPath, newPath, rewriteLine) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return false; }

  let touched = false;
  const out = content.split('\n').map((line) => {
    if (!line) return line;
    let parsed;
    try { parsed = JSON.parse(line); } catch { return line; }   // a truncated line — leave it alone
    if (!rewriteLine(parsed, oldPath, newPath)) return line;
    touched = true;
    return JSON.stringify(parsed);
  });
  if (!touched) return false;

  // Atomic: this is a live session's file, and half of it is worse than none of it.
  const tmp = filePath + '.tmp';
  try {
    fs.writeFileSync(tmp, out.join('\n'));
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return false;
  }
}

// --- the per-backend rules ---

/** Claude writes `cwd` on EVERY line. */
function claudeLine(entry, oldPath, newPath) {
  if (!samePath(entry.cwd, oldPath)) return false;
  entry.cwd = newPath;
  return true;
}

/** Codex writes it once, in the `session_meta` header, under `payload`. */
function codexLine(entry, oldPath, newPath) {
  if (entry.type !== 'session_meta' || !entry.payload) return false;
  if (!samePath(entry.payload.cwd, oldPath)) return false;
  entry.payload.cwd = newPath;
  return true;
}

/** Pi writes it once, on the header line (`type: 'session'`). */
function piLine(entry, oldPath, newPath) {
  if (entry.type !== 'session') return false;
  if (!samePath(entry.cwd, oldPath)) return false;
  entry.cwd = newPath;
  return true;
}

module.exports = {
  rewriteTranscript, samePath,
  claudeLine, codexLine, piLine,
};
