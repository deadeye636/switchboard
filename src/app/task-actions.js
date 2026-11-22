// task-actions.js — what the user can do with a task's row (#804 T8, spec 41): remove the worktree a task worked in.
//
// The renderer names a SESSION, never a path. The worktree is the session's own folder, and only one the app made for a
// task (an `app_worktree` row is the owner marker, checked again by `task-worktree.js` itself) is ever removed. A
// session still running there is refused first: its process holds the folder, and its work is not over. A worktree
// with uncommitted changes answers `dirty`, and only a second call with `force` — the user's confirmed choice — removes
// it anyway. The branch always stays: it is the task's result (E5).
//
// Electron-free and db-free: the worktree service, the session lookup and the live-session count arrive through `init`.
'use strict';

const { samePath } = require('./path-containment');

const SENTENCES = {
  notReady: 'The task actions are not ready yet.',
  noSession: 'That session is not known.',
  notATask: 'This session does not work in a worktree the app made for a task.',
  running: 'The task session is still running in this worktree. Stop it first.',
  failed: 'The worktree could not be removed.',
};

let ctx = null;

function init(context) {
  ctx = context || null;
}

/** The app-owned worktree a session works in, or null. */
function worktreeOf(sessionId) {
  const row = ctx.getCachedSession ? ctx.getCachedSession(sessionId) : null;
  const live = ctx.activeSessions ? ctx.activeSessions.get(sessionId) : null;
  const folder = (row && row.projectPath) || (live && live.projectPath) || null;
  if (!folder) return { error: SENTENCES.noSession };
  const owned = (ctx.checkouts.list() || []).find((r) => r && samePath(r.worktreePath, folder));
  return owned ? { worktreePath: owned.worktreePath, branch: owned.branch } : { error: SENTENCES.notATask };
}

// Any live session of the app in that folder, not only the task's own: a resumed row, a terminal opened there. Asked of
// `liveSessionsIn` (src/projects/projects.js), the one reading of that question (#578), handed in through ctx.
function runningIn(worktreePath) {
  try { return typeof ctx.liveSessionsIn === 'function' ? ctx.liveSessionsIn(worktreePath) > 0 : true; } catch { return true; }
}

/**
 * `task-remove-worktree` (sessionId, { force }) -> { ok: true, removed, branch } | { ok: false, dirty?, error }.
 * `dirty: true` says the worktree has changes that are not committed, and that `force` would lose them.
 */
async function removeWorktree(sessionId, opts) {
  if (!ctx || !ctx.checkouts) return { ok: false, error: SENTENCES.notReady };
  if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: SENTENCES.noSession };
  const found = worktreeOf(sessionId);
  if (found.error) return { ok: false, error: found.error };
  if (runningIn(found.worktreePath)) return { ok: false, error: SENTENCES.running };
  const force = !!(opts && opts.force === true);
  let res = null;
  try { res = await ctx.checkouts.remove({ worktreePath: found.worktreePath, force }); } catch (err) {
    if (ctx.log) ctx.log.warn(`[task-actions] removing a task worktree threw: ${err && (err.code || err.name)}`);
    res = null;
  }
  if (!res) return { ok: false, error: SENTENCES.failed };
  if (res.ok !== true) return { ok: false, dirty: res.reason === 'dirty', error: res.message || SENTENCES.failed };
  if (typeof ctx.notifyProjectsChanged === 'function') {
    try { ctx.notifyProjectsChanged(); } catch { /* the window may be gone */ }
  }
  return { ok: true, removed: res.removed === true, branch: res.branch || found.branch || null };
}

function registerIpc(ipc) {
  ipc.handle('task-remove-worktree', (_event, sessionId, opts) => removeWorktree(sessionId, opts));
}

module.exports = { init, registerIpc, removeWorktree, SENTENCES };
