// app/vcs-ignore.js — "is this directory going to be committed?", asked before the app suggests one.
//
// Two questions, both cheap and both answered from the project itself rather than from a VCS provider:
// does this project have version control at all, and does its ignore file already name this directory.
//
// They were written for the plans convention (#450) and stayed inside `plans-memory.js` until #468 needed
// the same answer for handoff directories. Copying fifteen lines would have been the cheaper edit and the
// worse one: a packet and a plan are both written by a tool that knows nothing about what may not be
// published, and the day the check improves it has to improve for both.
//
// The scope is deliberately small. This is not "is this path ignored by git" — that needs git, negations,
// nested ignore files and the index. It is "did somebody put this directory in `.gitignore`", which is
// what a hint before a write can honestly claim, and a wrong `false` costs a note nobody needed rather
// than a leak nobody was warned about.
'use strict';

const fs = require('fs');
const path = require('path');

/** Does this project have version control? Git only — the one whose ignore file is read below. */
function isVersioned(projectPath) {
  try { return fs.existsSync(path.join(projectPath, '.git')); } catch { return false; }
}

/**
 * One spelling for both sides of the compare: `./x`, `/x` and `x/` all mean `x`, and a backslash is a
 * separator. A LEADING DOT is part of the name and stays.
 */
function normalizeIgnoreEntry(value) {
  return String(value)
    .trim()
    .replace(/^\.[/\\]/, '')
    .replace(/^[/\\]+/, '')
    .replace(/[/\\]+$/, '')
    .split('\\').join('/');
}

/**
 * Does the project's `.gitignore` name `dir`?
 *
 * Both sides go through the same normalisation, and that is the fix this move paid for. The version
 * that lived inside `plans-memory.js` stripped a leading dot from the directory it was asked about but
 * not from the lines it compared against — so `.plans` became `plans`, the ignore file's own `.plans`
 * stayed `.plans`, and the two could never match. It therefore answered "not ignored" about every
 * dot-directory, which is every default this app has. Nothing caught it because the only thing it
 * produces is a note.
 *
 * Comments are skipped, and anything else — a glob, a negation, a nested ignore file — reads as "not
 * ignored", which errs toward warning rather than toward silence.
 */
function isIgnored(projectPath, dir) {
  try {
    const file = path.join(projectPath, '.gitignore');
    if (!fs.existsSync(file)) return false;
    const needle = normalizeIgnoreEntry(dir);
    if (!needle) return false;
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).some(raw => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return false;
      return normalizeIgnoreEntry(line) === needle;
    });
  } catch { return false; }
}

/**
 * The sentence to show when a directory this app is about to write into would be committed.
 *
 * `null` when there is nothing to say — no version control, or the directory is already ignored — so a
 * caller can add it to an answer without a branch of its own.
 */
function ignoreWarning(projectPath, dir, what) {
  if (!projectPath || !dir) return null;
  if (!isVersioned(projectPath) || isIgnored(projectPath, dir)) return null;
  return `"${dir}" is not ignored by version control. ${what}`;
}

module.exports = { isVersioned, isIgnored, ignoreWarning, _normalizeIgnoreEntry: normalizeIgnoreEntry };
