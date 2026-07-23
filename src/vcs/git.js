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

let _probe = null;
function probe() {
  if (_probe) return _probe;
  try {
    execFileSync('git', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    _probe = { ok: true, reason: null };
  } catch {
    _probe = { ok: false, reason: 'git was not found on PATH' };
  }
  return _probe;
}

module.exports = {
  id: 'git',
  label: 'Git',
  bin: 'git',
  // What this VCS actually has — drives which chip segments render. A provider that lacks a segment
  // sets it false here AND returns null for it, so the core never shows an empty "staged: 0" for a VCS
  // with no index.
  capabilities: { branch: true, staging: true, untracked: true, conflicts: true, state: true },
  netFree: true,               // the status path never touches the network (parity-asserted)
  detect,
  findRepo,
  detectState,
  statusArgs,
  diffArgs,
  showArgs,
  parse,
  probe,
  _resetProbeForTests() { _probe = null; },
};
