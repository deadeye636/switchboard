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

  for (const file of files || []) {
    if (!file) continue;
    const resolved = path.resolve(file);
    if (guard && !resolved.startsWith(guard)) { failed.push(file); continue; }
    try {
      fs.rmSync(resolved, { force: true });
      removed++;
    } catch {
      failed.push(file);
    }
  }
  return { removed, failed };
}

module.exports = { deleteTranscripts };
