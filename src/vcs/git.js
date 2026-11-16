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
const { parseNumstat, parseLog } = require('./parse-git-changes');

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

// The main repository's working tree, or null when it has none (a bare repository: the worktree is then the only
// checkout there is). Usually the git directory is `<root>/.git`, and that is the whole answer. Otherwise (#858) its
// `config` decides, read from disk, bounded, no spawn: `core.bare = true` is a bare repository; `core.worktree` names the
// working tree (relative to the git directory) as a submodule's repository records it; with neither, as for
// `git init --separate-git-dir`, nothing records where the working tree is and the git directory itself stands for the
// repository (git's own `worktree list` names it the same way).
function mainWorkingTree(commonDir) {
  if (path.basename(commonDir) === '.git') return path.dirname(commonDir);
  const core = readCoreConfig(path.join(commonDir, 'config'));
  if (core.bare) return null;
  return core.worktree ? path.resolve(commonDir, core.worktree) : commonDir;
}

// `bare` and `worktree` from the `[core]` section of a git config file. A read of the first 64 KiB: the section sits at
// the top of a file git writes, and a huge config is not worth a stall.
function readCoreConfig(file) {
  const out = { bare: false, worktree: null };
  let text = '';
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    text = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
  } catch { return out; } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* closed */ } }
  let inCore = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = line.match(/^\[\s*([^\s\]"]+)/);
    if (section) { inCore = section[1].toLowerCase() === 'core'; continue; }
    // A key with no `=` is true in git. A `#` or `;` starts a comment unless it sits inside a quoted value.
    const m = inCore && line.match(/^(bare|worktree)\s*(?:=\s*(.*))?$/i);
    if (!m) continue;
    const rest = m[2] == null ? null : m[2];
    const quoted = rest != null && rest.match(/^"((?:[^"\\]|\\.)*)"/);
    const value = rest == null ? 'true' : quoted ? quoted[1] : rest.replace(/[#;].*$/, '').trim();
    if (m[1].toLowerCase() === 'bare') out.bare = /^(true|yes|on|1)$/i.test(value);
    else if (rest != null) out.worktree = value.replace(/\\\\/g, '\\') || null;
  }
  return out;
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
      mainRoot = mainWorkingTree(commonDir);
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
// `rev` (#870) diffs the file from that revision to the working tree, or to `to` when that is given too.
// `--literal-pathspecs` (global, so before `diff`): the path is a file name, not a pathspec, so `*`, `?` and a
// leading `:` in a name mean themselves. `rev` and `staged` do not combine (a rev diff has no index side).
function diffArgs({ path, staged, rev, to } = {}) {
  if (rev && staged) throw new TypeError('git: rev and staged do not combine');
  if (rev) {
    return ['--no-optional-locks', '--literal-pathspecs', 'diff', '--no-color', checkRev(rev, { head: true }),
      ...(to ? [checkRev(to, { head: true })] : []), '--', path];
  }
  return ['--no-optional-locks', '--literal-pathspecs', 'diff', '--no-color', ...(staged ? ['--cached'] : []), '--', path];
}

// Argv to print ONE version of a file's content to stdout (#287, for the side-by-side diff window).
// `ref` is 'HEAD' for the committed version, '' for the index (staged) version, or (#870) a commit SHA —
// `git show <ref>:<path>`. The working-copy version is read from disk by the caller, not here.
function showArgs({ ref, path } = {}) {
  return ['--no-optional-locks', 'show', `${ref ? checkRev(ref, { head: true }) : ''}:${path}`];
}

// --- Session changes (#870, spec 47 section 4) ---
//
// Every revision here can come out of a transcript (a commit the CLI printed), so it is UNTRUSTED: it must be
// a hex SHA before it reaches an argv, or the argv builder throws. `HEAD` is accepted only where the caller
// is this code, via `{ head: true }`. A path always follows `--` (a path starting with `-` is then a path).

const SHA_RE = /^[0-9a-f]{4,64}$/;
// ISO 8601 date, optionally with time and zone. Starts with a digit, so `--before=<it>` can never be an option.
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function checkRev(rev, { head = false } = {}) {
  if (typeof rev === 'string' && (SHA_RE.test(rev) || (head && rev === 'HEAD'))) return rev;
  throw new TypeError('git: not a commit SHA');
}

function checkTime(t) {
  if (typeof t === 'string' && ISO_TIME_RE.test(t)) return t;
  throw new TypeError('git: not an ISO time');
}

function checkPaths(paths) {
  if (paths == null) return [];
  if (!Array.isArray(paths)) throw new TypeError('git: paths must be an array');
  for (const p of paths) {
    if (typeof p !== 'string' || !p || p.includes('\0')) throw new TypeError('git: bad path');
  }
  return ['--', ...paths];
}

// Per-file added/deleted counts from `from` to `to`, or to the working tree when `to` is null. `-z` gives
// NUL-separated records with unquoted names, `--no-renames` makes a rename a delete plus an add (spec 47
// section 4). `--literal-pathspecs` (global): `paths` are file names, not pathspecs. Read with `parseNumstat`.
function numstatArgs({ from, to = null, paths } = {}) {
  return ['--no-optional-locks', '--literal-pathspecs', 'diff', '--numstat', '-z', '--no-renames', '--no-color',
    checkRev(from, { head: true }), ...(to ? [checkRev(to, { head: true })] : []), ...checkPaths(paths)];
}

// Commits in `from..to` (`from` null: everything reachable from `to`, capped by `max`). `-z` plus NUL between
// the fields: a commit message cannot contain NUL, so it cannot forge a record or a field. The output is a flat
// NUL-separated list, three fields per commit (sha, author time, subject) — read with `parseLog(raw, 3)`. NOT
// first-parent by default: a pushed range is the exact commit range the push carried, merged-in commits
// included (`firstParent: true` for a caller that wants the branch's own line only).
const LOG_FORMAT = '--format=%H%x00%at%x00%s';
function logRangeArgs({ from = null, to, max = 200, firstParent = false } = {}) {
  if (!Number.isInteger(max) || max < 1 || max > 10000) throw new TypeError('git: bad max');
  const range = from ? `${checkRev(from)}..${checkRev(to, { head: true })}` : checkRev(to, { head: true });
  return ['--no-optional-locks', 'log', '--no-color', '-z', LOG_FORMAT, `-n${max}`,
    ...(firstParent ? ['--first-parent'] : []), range, '--'];
}

// Exit 0 when the commit exists in this repository, 128 when it does not (E2, E3).
function revExistsArgs(rev) {
  return ['--no-optional-locks', 'cat-file', '-e', `${checkRev(rev, { head: true })}^{commit}`];
}

function headArgs() {
  return ['--no-optional-locks', 'rev-parse', 'HEAD'];
}

// The commit the session started on (E1): the newest first-parent commit at or before `isoTime`. Prints
// nothing when there is none (the caller falls back to HEAD).
function revBeforeArgs(isoTime) {
  return ['--no-optional-locks', 'rev-list', '-1', '--first-parent', `--before=${checkTime(isoTime)}`, 'HEAD'];
}

// One commit's sha, author time, subject and body, NUL-separated like the log: read with `parseLog(raw, 4)`.
function showCommitArgs(sha) {
  return ['--no-optional-locks', 'show', '-s', '--no-color', '-z', '--format=%H%x00%at%x00%s%x00%b',
    checkRev(sha), '--'];
}

// Resolves an untrusted (possibly abbreviated) SHA to the full one: prints it, exit 1 and nothing when it is
// not a commit of this repository. The caller uses the printed full SHA from then on.
function resolveCommitArgs(sha) {
  return ['--no-optional-locks', 'rev-parse', '--verify', '--quiet', `${checkRev(sha)}^{commit}`];
}

// Exit 0 when `a` is an ancestor of `b`, 1 when not (a rewritten history, E3).
function isAncestorArgs(a, b) {
  return ['--no-optional-locks', 'merge-base', '--is-ancestor', checkRev(a, { head: true }), checkRev(b, { head: true })];
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
  // Session changes (#870). A provider without them answers null for each.
  numstatArgs,
  logRangeArgs,
  revExistsArgs,
  headArgs,
  revBeforeArgs,
  showCommitArgs,
  resolveCommitArgs,
  isAncestorArgs,
  parseNumstat,
  parseLog,
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
