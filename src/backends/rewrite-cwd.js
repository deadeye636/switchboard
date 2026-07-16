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

/** Same directory? Windows spells it both ways in the same store (`d:\x` and `D:\X`). */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    const t = String(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? t.toLowerCase() : t;
  };
  return norm(a) === norm(b);
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
