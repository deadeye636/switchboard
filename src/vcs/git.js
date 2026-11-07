// The git VCS provider (#277) — a descriptor the neutral core in `src/app/vcs.js` drives.
//
// The core is VCS-blind: it asks the registry which provider owns a cwd, then calls that provider's
// hooks. git is the only shipped provider; hg/svn would be sibling files declaring the same shape.
//
// One status spawn per poll: `git --no-optional-locks status --porcelain=v2 --branch -z`.
//   - `--no-optional-locks` is a GLOBAL git flag → it MUST come before `status` (git rejects it as a
//     status option). It stops the background poll from taking index.lock and fighting the session's
//     own agent (#277 H1).
//   - the in-progress `state` (merging/rebasing/cherry-picking) is NOT in porcelain — it is read from
//     `.git/` markers by `detectState(cwd)`, filesystem-only, so it costs no extra spawn (H3).
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseGitStatus } = require('./parse-git-status');

// Walk up from cwd to the nearest repository. `.git` may be a DIRECTORY (normal repo) or a FILE
// (worktree / submodule: `gitdir: <path>`), so existence — not directory-ness — is the test (#277 H2).
function findRepo(startDir) {
  let dir;
  try { dir = path.resolve(startDir); } catch { return null; }
  while (true) {
    const gitPath = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(gitPath); } catch { st = null; }
    if (st) {
      if (st.isDirectory()) return { root: dir, gitDir: gitPath };
      // `.git` file → read the real gitdir it points at.
      try {
        const content = fs.readFileSync(gitPath, 'utf8');
        const m = content.match(/^gitdir:\s*(.+)$/m);
        if (m) {
          let gd = m[1].trim();
          if (!path.isAbsolute(gd)) gd = path.resolve(dir, gd);
          return { root: dir, gitDir: gd };
        }
      } catch { /* fall through */ }
      return { root: dir, gitDir: gitPath };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function detect(cwd) {
  return findRepo(cwd) != null;
}

// Where a working directory sits (#821): the checkout's root, and the main repository's root when that checkout is a
// linked worktree, else null. Filesystem only, no spawn. A linked worktree's gitdir holds a `commondir` file naming the
// main repository's git directory (relative to the gitdir); a submodule's gitdir has none, so it is no worktree.
function describeRepo(cwd) {
  const repo = findRepo(cwd);
  if (!repo) return null;
  let mainRoot = null;
  try {
    const common = fs.readFileSync(path.join(repo.gitDir, 'commondir'), 'utf8').trim();
    if (common) {
      const commonDir = path.resolve(repo.gitDir, common);
      // A bare main repository has no working tree to name; the worktree is then the only checkout there is.
      if (path.basename(commonDir) === '.git') mainRoot = path.dirname(commonDir);
    }
  } catch { /* no commondir: a plain checkout or a submodule */ }
  return { root: repo.root, mainRoot };
}

// In-progress operation from `.git/` markers — filesystem only, no spawn.
function detectState(cwd) {
  const repo = findRepo(cwd);
  if (!repo) return null;
  const has = (p) => { try { return fs.existsSync(path.join(repo.gitDir, p)); } catch { return false; } };
  if (has('rebase-merge') || has('rebase-apply')) return 'rebasing';
  if (has('MERGE_HEAD')) return 'merging';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-picking';
  if (has('REVERT_HEAD')) return 'reverting';
  return null;
}

// Argv for the one status call. `--no-optional-locks` first (global flag). `-uno` drops untracked
// scanning when the user turned counting off — faster and quieter in huge repos (#277 vcsCountUntracked).
function statusArgs(opts = {}) {
  const args = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z'];
  if (opts.countUntracked === false) args.push('-uno');
  return args;
}

// Parse porcelain into the normalized summary. The provider layer, not the core, owns this so a future
// hg/svn provider parses its own format into the same shape.
function parse(raw, opts) {
  return parseGitStatus(raw, opts);
}

// Argv for a single file's diff (#285). Run with `cwd` = the repo. `staged` picks the index-vs-HEAD
// diff (a staged change), else the working-tree-vs-index diff. Untracked files have no tracked side
// and are handled by the caller (read the file), not here.
function diffArgs({ path, staged } = {}) {
  return ['--no-optional-locks', 'diff', '--no-color', ...(staged ? ['--cached'] : []), '--', path];
}

// Argv to print ONE version of a file's content to stdout (#287, for the side-by-side diff window).
// `ref` is 'HEAD' for the committed version or '' for the index (staged) version — `git show <ref>:<path>`.
// The working-copy version is read from disk by the caller, not here.
function showArgs({ ref, path } = {}) {
  return ['--no-optional-locks', 'show', `${ref || ''}:${path}`];
}

// Argv that forgets the checkouts whose directory is gone (#679). A deleted worktree leaves its entry under
// `.git/worktrees/`, and `git worktree list` reports it as prunable until this runs. It removes every entry of
// the repository whose directory is missing at that moment (a locked one excepted) — not only the one that was
// cleaned up, and including a checkout on a drive that is only unplugged. It never touches a checkout that is there.
function pruneWorktreesArgs() {
  return ['worktree', 'prune'];
}

// --- App-owned worktrees (#805, spec 41 M6) ---
//
// The argv and the output readers the worktree service in `src/app/task-worktree.js` runs. That module names
// no VCS; everything git spells is here. Each argv is run with `cwd` set to the repository (or the worktree,
// for `dirtyArgs`) rather than with `-C`, and always as an argument vector, never a shell string.

// The repository's top level and the commit a new branch starts from. Fails (exit 128) outside a work tree,
// in a bare repository (`--show-toplevel` needs a work tree) and in a repository with no commit yet — all
// three are folders a writing task cannot branch from. `--is-inside-work-tree` alone is not enough: a bare
// repository answers `false` with exit 0.
function worktreeHeadArgs() {
  return ['rev-parse', '--show-toplevel', 'HEAD'];
}

/** @returns {{root: string, head: string}|null} */
function parseWorktreeHead(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length < 2 || !/^[0-9a-f]{40,64}$/i.test(lines[1])) return null;
  return { root: lines[0], head: lines[1] };
}

// Exit 0 when the branch exists, 1 when it does not — `show-ref --quiet` reports nothing else. A branch
// name already taken is answered BEFORE `add`, because `add -b` with a taken name exits 255, not 128.
function branchExistsArgs(branch) {
  return ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch];
}

function worktreeAddArgs({ path, branch, base } = {}) {
  return ['worktree', 'add', '-b', branch, '--', path, base];
}

// `-z` keeps a path with a newline in it one field; records end with an empty field.
function worktreeListArgs() {
  return ['worktree', 'list', '--porcelain', '-z'];
}

/**
 * `worktree list --porcelain -z`, one object per checkout. Paths are as git writes them (forward slashes,
 * the drive letter as git spells it), so a caller compares them through `src/app/path-containment.js`.
 *
 * @returns {Array<{path: string, head: string|null, branch: string|null, bare: boolean, detached: boolean,
 *   locked: boolean, prunable: boolean}>}
 */
function parseWorktreeList(stdout) {
  const out = [];
  let cur = null;
  for (const field of String(stdout || '').split('\0')) {
    if (!field) { if (cur) out.push(cur); cur = null; continue; }
    const space = field.indexOf(' ');
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? '' : field.slice(space + 1);
    if (key === 'worktree') {
      if (cur) out.push(cur);
      cur = { path: value, head: null, branch: null, bare: false, detached: false, locked: false, prunable: false };
      continue;
    }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'bare') cur.bare = true;
    else if (key === 'detached') cur.detached = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  if (cur) out.push(cur);
  return out;
}

// Anything to lose in a checkout: modified, staged, untracked (every file, not only the directory) and a
// submodule with changes of its own. Run with `cwd` = the worktree; any output means it is not clean.
// `git worktree remove` refuses one untracked file too — this is the same question, asked before it.
// The delete dialog's dirty check. One `-C`, the worktree (#624): a second would only add a chdir that can fail.
function worktreeStatusArgs(worktreePath) {
  return ['--no-optional-locks', '-C', worktreePath, 'status', '--porcelain'];
}

function worktreeDirtyArgs() {
  return ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=none'];
}

// `--force` only when the caller has decided: after its own clean check for a worktree with submodules
// (which `remove` refuses without it, always), or on the user's explicit consent for one with changes.
function worktreeRemoveArgs({ path, force } = {}) {
  return ['worktree', 'remove', ...(force ? ['--force'] : []), '--', path];
}

// Rolls back the branch a failed `add -b` leaves behind — and only if it still points at the commit it was made
// from. `update-ref -d <ref> <old>` checks and deletes in one step, so a branch somebody else created under the same
// name in the meantime (another instance of the app, the user) is left alone, commits and all.
function branchRollbackArgs(branch, commit) {
  return ['update-ref', '-d', 'refs/heads/' + branch, commit];
}

// The submodule marker in a checkout, by file name — the reason `remove` needs `--force` there.
const SUBMODULE_MARKER = '.gitmodules';

// Which file `git` is. On Windows a bare name given to `execFile` is looked up in the child's working directory
// BEFORE PATH, and every status, diff and worktree call runs with the repository as its working directory, so a
// repository holding its own git.exe would have it run as soon as the app polled it (measured with
// `scripts/measure-planted-exe.js`). So on Windows the provider answers an absolute path, or one that cannot start.
//
// `.exe` and `.com` only, the two a shell-less start can run, and absolute PATH entries only: a relative one means
// the working directory again. A hit is kept while PATH stays the same; a miss is asked again after a while, so a git
// installed while the app runs is found. POSIX has no such search, and the bare name stays.
const BIN_MISS_MS = 30000;
let _bin = { pathValue: null, file: null, missedAt: 0 };
function resolveBin({ platform = process.platform, env = process.env, isFile = isFileOnDisk, now = Date.now() } = {}) {
  if (platform !== 'win32') return 'git';
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const pathValue = pathKey ? String(env[pathKey]) : '';
  // A hit is looked at again, so a removed git falls through to the next PATH entry as a bare name would.
  if (_bin.pathValue === pathValue && (_bin.file ? isFile(_bin.file) : now - _bin.missedAt < BIN_MISS_MS)) {
    return _bin.file || missingBin(env);
  }
  let file = null;
  for (const raw of pathValue.split(';')) {
    const dir = raw.trim().replace(/^"|"$/g, '');
    if (!path.win32.isAbsolute(dir) || !/^([a-z]:[\\/]|\\\\)/i.test(dir)) continue;
    for (const name of ['git.exe', 'git.com']) {
      const candidate = path.win32.join(dir, name);
      if (isFile(candidate)) { file = candidate; break; }
    }
    if (file) break;
  }
  _bin = { pathValue, file, missedAt: now };
  return file || missingBin(env);
}
// Absolute, so the start fails with ENOENT like a missing git does, and no directory is searched for it.
function missingBin(env) {
  return path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'git-is-not-on-path.exe');
}
function isFileOnDisk(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

let _probe = null;
function probe() {
  if (_probe) return _probe;
  try {
    execFileSync(resolveBin(), ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    _probe = { ok: true, reason: null };
  } catch {
    _probe = { ok: false, reason: 'git was not found on PATH' };
  }
  return _probe;
}

module.exports = {
  id: 'git',
  label: 'Git',
  get bin() { return resolveBin(); },
  resolveBin,
  // What this VCS actually has — drives which chip segments render. A provider that lacks a segment
  // sets it false here AND returns null for it, so the core never shows an empty "staged: 0" for a VCS
  // with no index.
  capabilities: { branch: true, staging: true, untracked: true, conflicts: true, state: true },
  netFree: true,               // the status path never touches the network (parity-asserted)
  detect,
  findRepo,
  describeRepo,
  detectState,
  statusArgs,
  worktreeStatusArgs,
  diffArgs,
  showArgs,
  pruneWorktreesArgs,
  // App-owned worktrees (#805). A provider without them sets `worktree: null`, and the service refuses a
  // writing task in its folders with a sentence.
  worktree: {
    headArgs: worktreeHeadArgs,
    parseHead: parseWorktreeHead,
    branchExistsArgs,
    addArgs: worktreeAddArgs,
    listArgs: worktreeListArgs,
    parseList: parseWorktreeList,
    dirtyArgs: worktreeDirtyArgs,
    removeArgs: worktreeRemoveArgs,
    branchRollbackArgs,
    pruneArgs: pruneWorktreesArgs,
    submoduleMarker: SUBMODULE_MARKER,
  },
  parse,
  probe,
  _resetProbeForTests() { _probe = null; },
};
