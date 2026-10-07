// Worktrees outside the layout (#757) — a directory that was seen to be a `git worktree add` checkout by its
// `.git` file, and the repository that file named.
//
// A fact the app OBSERVED, kept apart from meta-store.js, which holds what the user decided. It is written
// once per directory, the first time a sweep sees the path while its folder still exists, and read back for
// as long as sessions name it — the folder may be gone by then, which is the whole reason it is stored.
'use strict';

const { db } = require('./connection');

const stmts = {
  all: db.prepare('SELECT worktreePath, repoPath FROM worktree_repo'),
  upsert: db.prepare(`
    INSERT INTO worktree_repo (worktreePath, repoPath, seenAt) VALUES (?, ?, ?)
    ON CONFLICT(worktreePath) DO UPDATE SET repoPath = excluded.repoPath, seenAt = excluded.seenAt
  `),
  remove: db.prepare('DELETE FROM worktree_repo WHERE worktreePath = ?'),
};

/** @returns {Array<{worktreePath: string, repoPath: string}>} */
function getKnownWorktrees() {
  return stmts.all.all();
}

/** Remember that `worktreePath` is a worktree of `repoPath`. */
function recordKnownWorktree(worktreePath, repoPath, now = Date.now()) {
  stmts.upsert.run(String(worktreePath), String(repoPath), now);
}

/** Forget a path: its folder is no worktree any more, or its history was cleaned up. */
function forgetKnownWorktree(worktreePath) {
  stmts.remove.run(String(worktreePath));
}

module.exports = { getKnownWorktrees, recordKnownWorktree, forgetKnownWorktree };
