// The worktrees the app creates for a writing task (#805, spec 41 E5 and E6, measured cases in M6).
//
// A writing task works in a checkout of its own, outside the project tree, under the app's data folder and named
// by the task. Nothing is merged back: the caller is told the branch and decides. The app removes only a checkout
// it created itself — a row in `app_worktree` is the owner marker — and never one with changes unless told to.
//
// VCS-blind like `src/app/vcs.js`: the provider registry answers which VCS owns a folder, and the provider's
// `worktree` hooks spell every argv and read every output (`src/vcs/git.js`). A folder whose provider has no
// such hooks, or no provider at all, refuses a writing task with a sentence.
//
// What the measurements put here, each a case a plain `git worktree add` gets wrong:
//   - a worktree path of about 220 characters fails on Windows (`'$GIT_DIR' too big`), so the root is short and a
//     longer path is refused BEFORE git runs;
//   - a taken branch name makes `add -b` exit 255, not 128, so the name is checked first and a free one picked;
//   - a failed `add -b` leaves its branch behind, so this call deletes it — only while it still points at the
//     commit it was made from, so a branch somebody else made under that name in the meantime survives;
//   - `remove` refuses a worktree with submodules always, so the service checks for changes itself and then
//     passes `--force`; one with changes is refused unless the caller says so, and a locked one is the user's;
//   - a folder deleted by hand leaves a `prunable` entry. `create` and `remove` prune the repository first;
//     `status` only reads, and answers a prunable entry as gone. There is no prune at start: a checkout deleted by
//     hand stays `prunable` in the user's own `git worktree list` until the next create or remove in that
//     repository (spec 41 "Built", open point).
//
// Every git call is an `execFile` argument vector with standard input closed (CLAUDE.md reflex 10), off the main
// thread (about 0.3 s per `add`), and the calls for one repository run one after another: two `add`s into one
// repository at once contend for its `.git/worktrees` lock. The path checks are asked again inside that queue,
// right before git creates or removes anything, because an operation may wait there behind others. git's own text,
// and any thrown error's, goes to the log, never into a result.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { closeProbeStdin } = require('./terminal/shell-profiles');
const { isInside, isAtOrInside, samePath, pathKey } = require('./path-containment');

// Under the data folder, kept short on purpose: the whole worktree path is the budget git has on Windows.
const ROOT_DIR_NAME = 'wt';
// Measured: 210 characters work, about 220 fail. The margin is for git's own paths below the checkout.
const MAX_WORKTREE_PATH = 200;
const GIT_TIMEOUT_MS = 60 * 1000;
// A task id names a directory and a branch, so it is spelled for both.
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
const BRANCH_PREFIX = 'switchboard/task-';
const BRANCH_TRIES = 5;

const SENTENCES = {
  'not-ready': 'The worktree service has not started yet.',
  'quitting': 'The app is quitting.',
  'invalid-task': 'A task id may hold only letters, digits and hyphens, up to 40 of them.',
  'not-a-repository': 'This folder is not a repository a worktree can be made of, so a writing task cannot run here.',
  'inside-project': 'The app\'s worktree folder lies inside this repository, so a worktree for it cannot be made there.',
  'path-too-long': 'The worktree path would be too long for git on this system.',
  'exists': 'A worktree for this task already exists.',
  'no-branch': 'No free branch name was found for this task.',
  'git-failed': 'git could not finish this — see the log for what it said.',
  'internal': 'The worktree could not be handled — see the log for details.',
  'not-owned': 'This worktree was not created by the app, so the app does not remove it.',
  'outside-root': 'This worktree does not lie in the app\'s worktree folder, so the app does not remove it.',
  'repository-missing': 'The repository this worktree belongs to is gone.',
  'not-a-worktree': 'git does not know this folder as a worktree, so the app leaves it alone.',
  'locked': 'This worktree is locked. Unlock it in git first if it should go.',
  'dirty': 'This worktree has changes that are not committed. Remove it anyway only if they may be lost.',
};

let ctx = null;
const queues = new Map();   // repository key → the tail of its chain of git operations

function init(context) {
  ctx = context;
  queues.clear();
}

function refuse(reason) {
  return { ok: false, reason, message: SENTENCES[reason] };
}

function quitting() {
  return !!(ctx && typeof ctx.getAppQuitting === 'function' && ctx.getAppQuitting());
}

function warn(message) {
  if (ctx && ctx.log) ctx.log.warn(`[task-worktree] ${message}`);
}

function rootDir() {
  return path.join(ctx.dataDir, ROOT_DIR_NAME);
}

function runGitReal(bin, args, cwd) {
  return new Promise((resolve) => {
    closeProbeStdin(execFile(bin, args, {
      cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const code = !err ? 0 : (typeof err.code === 'number' ? err.code : -1);
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '') });
    }));
  });
}

function git(provider, args, cwd) {
  const run = (ctx && ctx.runGit) || runGitReal;
  return run(provider.bin, args, cwd);
}

function logFailure(what, result) {
  warn(`${what} failed (exit ${result.code}): ${String(result.stderr).trim()}`);
}

// One repository's operations in order; a failure in one does not stall the next. A throw inside one — a database
// write, a filesystem call — is logged and answered with a sentence, so its text never reaches a caller.
function queued(repoPath, fn) {
  const key = pathKey(repoPath);
  const guarded = async () => {
    try { return await fn(); } catch (err) {
      warn(`unexpected failure: ${(err && (err.code || err.message)) || err}`);
      return refuse('internal');
    }
  };
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(guarded, guarded);
  queues.set(key, next);
  next.then(() => { if (queues.get(key) === next) queues.delete(key); });
  return next;
}

function worktreeHooks(folder) {
  const provider = ctx.vcs.detect(folder);
  return provider && provider.worktree ? { provider, wt: provider.worktree } : null;
}

async function rollbackBranch(provider, wt, repoPath, branch, commit) {
  const undo = await git(provider, wt.branchRollbackArgs(branch, commit), repoPath);
  if (undo.code !== 0) logFailure(`rolling back branch ${branch}`, undo);
}

async function listEntries(provider, wt, repoPath) {
  const listed = await git(provider, wt.listArgs(), repoPath);
  if (listed.code !== 0) { logFailure('worktree list', listed); return null; }
  return wt.parseList(listed.stdout).filter(e => !e.bare);
}

/**
 * Create a worktree and a branch for a writing task.
 *
 * The caller decides first whether the folder may be touched at all: this stats `projectPath` and runs git in it,
 * so a network path has to pass the app's network gate (`src/app/network-path.js`) before it gets here.
 *
 * @param {{projectPath: string, taskId: string}} opts  the caller's folder, and the task the checkout is for
 * @returns {Promise<{ok: true, worktreePath: string, repoPath: string, branch: string, baseCommit: string,
 *   baseDirty: boolean, hasSubmodules: boolean} | {ok: false, reason: string, message: string}>}
 *   `baseDirty`: the caller's checkout has changes the new worktree does not see (git gives no warning).
 *   `hasSubmodules`: they are not initialised in the new worktree.
 */
async function create({ projectPath, taskId } = {}) {
  if (!ctx) return refuse('not-ready');
  if (quitting()) return refuse('quitting');
  if (!TASK_ID_RE.test(String(taskId || ''))) return refuse('invalid-task');
  const root = rootDir();
  const worktreePath = path.join(root, String(taskId));
  if (worktreePath.length > MAX_WORKTREE_PATH) return refuse('path-too-long');
  if (!projectPath || !fs.existsSync(projectPath)) return refuse('not-a-repository');
  const hooks = worktreeHooks(projectPath);
  if (!hooks) return refuse('not-a-repository');
  const { provider, wt } = hooks;

  const headResult = await git(provider, wt.headArgs(), projectPath);
  const head = headResult.code === 0 ? wt.parseHead(headResult.stdout) : null;
  if (!head) { logFailure('reading the repository head', headResult); return refuse('not-a-repository'); }
  const repoPath = path.resolve(head.root);

  return queued(repoPath, async () => {
    if (quitting()) return refuse('quitting');
    try { fs.mkdirSync(root, { recursive: true }); } catch (err) {
      warn(`cannot create the worktree folder: ${err.code || err.message}`);
      return refuse('internal');
    }
    if (isAtOrInside(root, repoPath)) return refuse('inside-project');
    if (fs.existsSync(worktreePath)) return refuse('exists');

    const prune = await git(provider, wt.pruneArgs(), repoPath);
    if (prune.code !== 0) logFailure('prune', prune);

    // A row left by an earlier task of the same id whose folder was deleted by hand. git has forgotten the checkout
    // (the prune above), so the row describes nothing any more; dropped, or the record below would collide with it.
    const stale = ownedRow(worktreePath);
    if (stale) {
      const entries = await listEntries(provider, wt, repoPath);
      if (!entries) return refuse('git-failed');
      if (entries.some(e => samePath(e.path, worktreePath))) return refuse('exists');
      if (quitting()) return refuse('quitting');
      ctx.db.forgetAppWorktree(stale.worktreePath);
    }

    let branch = null;
    for (let i = 0; i < BRANCH_TRIES && !branch; i++) {
      const name = BRANCH_PREFIX + taskId + (i ? '-' + (i + 1) : '');
      const exists = await git(provider, wt.branchExistsArgs(name), repoPath);
      if (exists.code === 1) branch = name;
      else if (exists.code !== 0) { logFailure('checking a branch name', exists); return refuse('git-failed'); }
    }
    if (!branch) return refuse('no-branch');

    const dirty = await git(provider, wt.dirtyArgs(), repoPath);
    const baseDirty = dirty.code === 0 && dirty.stdout.length > 0;

    // Asked again with nothing awaited between here and `add`, on real paths: a junction planted at the root or at
    // the checkout's place while the calls above ran would otherwise send the checkout somewhere else.
    if (quitting()) return refuse('quitting');
    if (isAtOrInside(root, repoPath)) return refuse('inside-project');
    if (!isInside(worktreePath, root)) return refuse('outside-root');
    if (fs.existsSync(worktreePath)) return refuse('exists');
    const add =await git(provider, wt.addArgs({ path: worktreePath, branch, base: head.head }), repoPath);
    if (add.code !== 0) {
      logFailure('worktree add', add);
      await rollbackBranch(provider, wt, repoPath, branch, head.head);
      try {
        if (fs.readdirSync(worktreePath).length === 0) fs.rmdirSync(worktreePath);
        else warn(`a failed add left ${worktreePath} with files in it; that task id is taken until it is cleared`);
      } catch { /* nothing was made */ }
      return refuse('git-failed');
    }
    // The checkout exists now; without its row it would be one the app may never remove. After `closeDb()`
    // nothing may write, so a quit in between leaves it unowned and says so in the log.
    if (quitting()) {
      warn(`created ${worktreePath} while quitting; it is not recorded`);
      return refuse('quitting');
    }
    try {
      ctx.db.recordAppWorktree({ worktreePath, repoPath, branch, baseCommit: head.head, taskId: String(taskId) });
    } catch (err) {
      // Unrecorded, the checkout would be one the app never removes: take it back while it is still known clean.
      warn(`recording ${worktreePath} failed (${err && (err.code || err.message)}); rolling it back`);
      const undo = await git(provider, wt.removeArgs({ path: worktreePath, force: true }), repoPath);
      if (undo.code !== 0) logFailure('rolling back the worktree', undo);
      else await rollbackBranch(provider, wt, repoPath, branch, head.head);
      return refuse('internal');
    }
    // The app's settings cascade from the project a worktree belongs to (`settingsOwnerPath`), and a worktree
    // outside the layout belongs to one only once its `.git` file was read (#757). A sweep reads it when the first
    // session there is indexed — after the task's spawn has already resolved its settings. So it is read now. A
    // backend's own folder trust is keyed by path in that CLI's config and does not follow (spec 41 O16).
    if (typeof ctx.noteWorktree === 'function') {
      try { ctx.noteWorktree(worktreePath); } catch (err) { warn(`noting ${worktreePath} failed: ${err && (err.code || err.message)}`); }
    }
    const hasSubmodules = fs.existsSync(path.join(worktreePath, wt.submoduleMarker));
    if (ctx.log) ctx.log.info(`[task-worktree] created ${worktreePath} on ${branch} for task ${taskId}`);
    return { ok: true, worktreePath, repoPath, branch, baseCommit: head.head, baseDirty, hasSubmodules };
  });
}

/** The app-owned worktrees, as recorded. Synchronous: a read of the owner markers, nothing asks git. */
function list() {
  if (!ctx) return [];
  try { return ctx.db.getAppWorktrees() || []; } catch { return []; }
}

function ownedRow(worktreePath) {
  return list().find(r => samePath(r.worktreePath, worktreePath)) || null;
}

// The checks `status` and `remove` share: owned, inside the root on real paths (a junction planted at the
// worktree's place resolves elsewhere), a repository that still answers.
function resolveOwned(worktreePath) {
  if (!ctx) return { refused: refuse('not-ready') };
  const row = ownedRow(worktreePath);
  if (!row) return { refused: refuse('not-owned') };
  if (!isInside(row.worktreePath, rootDir())) return { refused: refuse('outside-root') };
  if (!fs.existsSync(row.repoPath)) return { refused: refuse('repository-missing') };
  const hooks = worktreeHooks(row.repoPath);
  if (!hooks) return { refused: refuse('repository-missing') };
  return { row, ...hooks };
}

// `prune` for the operations that change the repository anyway; a read leaves the user's list as it is and takes a
// prunable entry for what it is, a checkout whose folder is gone.
async function readState(row, provider, wt, { prune }) {
  if (prune) {
    const pruned = await git(provider, wt.pruneArgs(), row.repoPath);
    if (pruned.code !== 0) logFailure('prune', pruned);
  }
  const entries = await listEntries(provider, wt, row.repoPath);
  if (!entries) return { failed: true };
  const entry = entries.find(e => !e.prunable && samePath(e.path, row.worktreePath)) || null;
  if (!entry) return { entry: null };
  const dirty = await git(provider, wt.dirtyArgs(), row.worktreePath);
  if (dirty.code !== 0) { logFailure('status', dirty); return { failed: true }; }
  return { entry, dirty: dirty.stdout.length > 0 };
}

/**
 * What an app-owned worktree looks like now. Reads only: no prune, no write.
 *
 * @returns {Promise<{ok: true, exists: boolean, dirty: boolean, locked: boolean, branch: string} |
 *   {ok: false, reason: string, message: string}>}  `exists: false` once its folder is gone
 */
async function status(worktreePath) {
  const owned = resolveOwned(worktreePath);
  if (owned.refused) return owned.refused;
  const { row, provider, wt } = owned;
  return queued(row.repoPath, async () => {
    const state = await readState(row, provider, wt, { prune: false });
    if (state.failed) return refuse('git-failed');
    if (!state.entry) return { ok: true, exists: false, dirty: false, locked: false, branch: row.branch };
    return { ok: true, exists: true, dirty: state.dirty, locked: state.entry.locked, branch: row.branch };
  });
}

/**
 * Remove an app-owned worktree. The branch stays: the work on it is the task's result (E5).
 *
 * @param {{worktreePath: string, force?: boolean}} opts  `force`: the user agreed to lose uncommitted changes
 * @returns {Promise<{ok: true, removed: boolean, branch: string} | {ok: false, reason: string, message: string}>}
 *   `removed: false` when the folder was already gone and only the record was dropped
 */
async function remove({ worktreePath, force = false } = {}) {
  if (quitting()) return refuse('quitting');
  const owned = resolveOwned(worktreePath);
  if (owned.refused) return owned.refused;
  const { row, provider, wt } = owned;
  return queued(row.repoPath, async () => {
    if (quitting()) return refuse('quitting');
    const state = await readState(row, provider, wt, { prune: true });
    if (state.failed) return refuse('git-failed');
    if (quitting()) return refuse('quitting');
    if (!state.entry) {
      if (fs.existsSync(row.worktreePath)) return refuse('not-a-worktree');
      ctx.db.forgetAppWorktree(row.worktreePath);
      return { ok: true, removed: false, branch: row.branch };
    }
    if (state.entry.locked) return refuse('locked');
    if (state.dirty && !force) return refuse('dirty');
    // Asked again right before the removal: the checks in `resolveOwned` ran before this waited in the queue.
    if (!isInside(row.worktreePath, rootDir())) return refuse('outside-root');
    // Clean by the check above, or the user's consent: `--force` is then what lets `remove` past submodules.
    const hasSubmodules = fs.existsSync(path.join(row.worktreePath, wt.submoduleMarker));
    const removed = await git(provider, wt.removeArgs({ path: row.worktreePath, force: force || hasSubmodules }), row.repoPath);
    if (removed.code !== 0) { logFailure('worktree remove', removed); return refuse('git-failed'); }
    if (quitting()) return refuse('quitting');
    ctx.db.forgetAppWorktree(row.worktreePath);
    if (ctx.log) ctx.log.info(`[task-worktree] removed ${row.worktreePath}; branch ${row.branch} kept`);
    return { ok: true, removed: true, branch: row.branch };
  });
}

module.exports = {
  init, create, list, status, remove,
  // For the tests: the limits the measurements set.
  MAX_WORKTREE_PATH, BRANCH_PREFIX,
};
