// backends/delete-sessions.js — deleting a project's transcripts, per backend (#171/#167).
//
// "Delete session history" used to mean `~/.claude/projects/<folder>` and nothing else. A project's
// Codex rollouts and Pi transcripts survived it untouched — the user just stopped seeing them, because
// the project got hidden in the same breath. They came back the day it was unhidden.
//
// Each FILE backend can hand over its own transcripts. Hermes cannot: its sessions are rows in a SQLite
// database we open read-only and may never write (upstream #2914 — a reader must never block Hermes
// writing). It says so instead of offering a switch that does nothing.
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Delete a list of transcript files.
 *
 * @param {string[]} files
 * @param {string} [root]  when given, a file outside it is refused — the paths come from a cache row,
 *                         and a delete must never be talked into leaving the store it belongs to.
 * @returns {{removed: number, failed: string[]}}
 */
function deleteTranscripts(files, root) {
  let removed = 0;
  const failed = [];
  const guard = root ? path.resolve(root) + path.sep : null;

  const touched = new Set();
  for (const file of files || []) {
    if (!file) continue;
    const resolved = path.resolve(file);
    if (guard && !resolved.startsWith(guard)) { failed.push(file); continue; }
    // Count only what was really there (#198): `force:true` swallows ENOENT, so an already-gone file — a
    // subagent listed on its own row that went with its parent — must not inflate the "Removed N" the
    // dialog reports. Claude's own deleteSessions checks existence first; match it.
    const existed = fs.existsSync(resolved);
    try {
      fs.rmSync(resolved, { force: true });
      if (existed) removed++;
      touched.add(path.dirname(resolved));
    } catch {
      failed.push(file);
    }
  }

  // Prune directories left empty by the deletes, up to (never including) the store root — an emptied
  // date-bucket dir (Codex `sessions/YYYY/MM/DD`) should not linger as a shell, the way Claude's own
  // delete already prunes. `guard` carries a trailing separator, so the store root never satisfies
  // `startsWith` and is never removed.
  if (guard) {
    for (let dir of touched) {
      while (path.resolve(dir).startsWith(guard)) {
        let entries;
        try { entries = fs.readdirSync(dir); } catch { break; }
        if (entries.length) break;
        try { fs.rmdirSync(dir); } catch { break; }
        dir = path.dirname(dir);
      }
    }
  }
  return { removed, failed };
}

module.exports = { deleteTranscripts };
