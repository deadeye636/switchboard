// A project's whole footprint, moved or dropped in one transaction (#217 step 9).
//
// Everything Switchboard keys by projectPath: project_meta (favourite, auto-hide), project_tags,
// project_handoffs, and the `project:<path>` settings blob (display name, permission mode, worktree
// prefs, AFK timeout). A remap moves the project to a new path; a hard delete removes it for good.
// Neither used to touch any of this, so a remap silently dropped the project's favourite, tags and
// settings and left the old path behind as a phantom.
//
// THIS MODULE IS CROSS-DOMAIN ON PURPOSE, and it is why the stores export their raw statements. A
// project's footprint spans four of them, and it has to move ATOMICALLY: half a rename is a project with
// its tags at the new path and its settings at the old one. So the transaction reaches into each store's
// statements directly.
//
// It cannot call the stores' FUNCTIONS instead. Those wrap themselves in runWithBusyRetry, and a retry
// inside an already-open transaction is not a tidier spelling of the same thing — it is different
// behaviour. The retry belongs around the whole transaction, which is exactly where it is.
//
// The composition is the reason this is its own file rather than a corner of one store: no single domain
// owns it, and putting it in any of them would make that store import its three siblings.
'use strict';

const { db } = require('./connection');
const { runWithBusyRetry } = require('./sqlite-busy-retry');
const metaStore = require('./meta-store');
const tagsStore = require('./tags-store');
const tasksStore = require('./tasks-store');
const settingsStore = require('./settings-store');


// Move every reference from oldPath to newPath. Where the destination already
// carries data of its own, the destination wins and the source row is dropped —
// remapping onto a folder that is already a known project must never clobber it.
const renameProjectRefsTx = db.transaction((oldPath, newPath) => {
  const destMeta = metaStore.stmts.projectMetaGet.get(newPath);
  if (destMeta) metaStore.stmts.projectMetaDelete.run(oldPath);
  else metaStore.stmts.projectMetaRename.run(newPath, oldPath);

  // Tags merge: a tag the destination already has keeps its own colour.
  tagsStore.stmts.projectTagsMerge.run(newPath, oldPath);
  tagsStore.stmts.projectTagDeleteAll.run(oldPath);

  // Handoffs are a list, so they simply accrue to the destination.
  tasksStore.stmts.projectHandoffsRename.run(newPath, oldPath);

  const destSettings = settingsStore.stmts.settingsGet.get('project:' + newPath);
  if (destSettings) settingsStore.stmts.settingsDelete.run('project:' + oldPath);
  else settingsStore.stmts.settingsRename.run('project:' + newPath, 'project:' + oldPath);
});

function renameProjectRefs(oldPath, newPath) {
  if (!oldPath || !newPath || oldPath === newPath) return;
  runWithBusyRetry(() => renameProjectRefsTx(oldPath, newPath));
}

// Drop every trace of a project. Only for a hard delete — a plain "hide" must
// keep this data so unhiding restores the project intact.
const deleteProjectRefsTx = db.transaction((projectPath) => {
  metaStore.stmts.projectMetaDelete.run(projectPath);
  tagsStore.stmts.projectTagDeleteAll.run(projectPath);
  tasksStore.stmts.projectHandoffsDeleteAll.run(projectPath);
  settingsStore.stmts.settingsDelete.run('project:' + projectPath);
});

function deleteProjectRefs(projectPath) {
  if (!projectPath) return;
  runWithBusyRetry(() => deleteProjectRefsTx(projectPath));
}

module.exports = { renameProjectRefs, deleteProjectRefs };
