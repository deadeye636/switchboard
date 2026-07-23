'use strict';

// Parity: every registered VCS provider must answer the whole hook contract (even to decline), and the
// status path must be network-free. Mirrors `test/backend-parity.test.js` — it exists so a future
// hg/svn provider cannot ship half-wired (#277).

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const vcs = require('../src/vcs');

const providers = vcs.list();

test('the registry has at least git', () => {
  assert.ok(providers.length >= 1);
  assert.ok(vcs.get('git'), 'git provider resolvable by id');
  assert.strictEqual(vcs.get('nope'), null);
});

for (const p of providers) {
  test(`${p.id}: descriptor shape`, () => {
    assert.strictEqual(typeof p.id, 'string');
    assert.ok(p.id.length > 0);
    assert.strictEqual(typeof p.label, 'string');
    assert.strictEqual(typeof p.bin, 'string');
    assert.strictEqual(typeof p.detect, 'function');
    assert.strictEqual(typeof p.detectState, 'function');
    assert.strictEqual(typeof p.statusArgs, 'function');
    assert.strictEqual(typeof p.parse, 'function');
    assert.strictEqual(typeof p.probe, 'function');
  });

  test(`${p.id}: capabilities declares all five segments as booleans`, () => {
    const c = p.capabilities;
    assert.strictEqual(typeof c, 'object');
    for (const key of ['branch', 'staging', 'untracked', 'conflicts', 'state']) {
      assert.strictEqual(typeof c[key], 'boolean', `capability ${key} must be a boolean`);
    }
  });

  test(`${p.id}: the status path is network-free`, () => {
    assert.strictEqual(p.netFree, true);
  });

  test(`${p.id}: statusArgs honours the untracked toggle`, () => {
    const on = p.statusArgs({ countUntracked: true });
    const off = p.statusArgs({ countUntracked: false });
    assert.ok(Array.isArray(on) && Array.isArray(off));
    // off must ask for fewer/no untracked than on
    assert.ok(off.includes('-uno') || off.length <= on.length);
  });

  test(`${p.id}: probe returns {ok, reason}`, () => {
    const r = p.probe();
    assert.strictEqual(typeof r.ok, 'boolean');
    assert.ok('reason' in r);
  });

  test(`${p.id}: detect() is false for a plain non-repo temp dir`, () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-parity-'));
    try {
      assert.strictEqual(p.detect(d), false);
      assert.strictEqual(p.detectState(d), null);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
}

test('git: --no-optional-locks is the first (global) arg, before status', () => {
  const git = vcs.get('git');
  const args = git.statusArgs({});
  assert.strictEqual(args[0], '--no-optional-locks');
  assert.ok(args.indexOf('status') > 0, 'status comes after the global flag');
  assert.ok(args.includes('--porcelain=v2'));
  assert.ok(args.includes('-z'));
});

test('git: detect() finds a repo via a .git FILE (worktree), not just a dir', () => {
  const git = vcs.get('git');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-wt-'));
  try {
    const realGitDir = path.join(base, 'realgit');
    fs.mkdirSync(realGitDir);
    const wt = path.join(base, 'worktree');
    fs.mkdirSync(wt);
    // a worktree checkout has a .git FILE pointing at the gitdir
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${realGitDir}\n`);
    assert.strictEqual(git.detect(wt), true);
    // a nested subdir walks up to the same worktree root
    const nested = path.join(wt, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    assert.strictEqual(git.detect(nested), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('git: --no-optional-locks off adds -uno for git specifically', () => {
  const git = vcs.get('git');
  assert.ok(git.statusArgs({ countUntracked: false }).includes('-uno'));
  assert.ok(!git.statusArgs({ countUntracked: true }).includes('-uno'));
});

test('git: diffArgs is global-flag-first, -- before path, --cached only when staged (#285)', () => {
  const git = vcs.get('git');
  const unstaged = git.diffArgs({ path: 'src/x.js', staged: false });
  const staged = git.diffArgs({ path: 'src/x.js', staged: true });
  assert.strictEqual(unstaged[0], '--no-optional-locks');
  assert.ok(unstaged.indexOf('diff') > 0);
  assert.ok(!unstaged.includes('--cached'));
  assert.ok(staged.includes('--cached'));
  // `--` guards a path that starts with a dash from being read as a flag
  const dd = unstaged.indexOf('--');
  assert.ok(dd > 0 && unstaged[dd + 1] === 'src/x.js');
});

test('git: showArgs reads HEAD vs index versions, global-flag-first (#287)', () => {
  const git = vcs.get('git');
  const head = git.showArgs({ ref: 'HEAD', path: 'src/x.js' });
  const index = git.showArgs({ ref: '', path: 'src/x.js' });
  assert.strictEqual(head[0], '--no-optional-locks');
  assert.ok(head.indexOf('show') > 0);
  assert.strictEqual(head[head.length - 1], 'HEAD:src/x.js');
  assert.strictEqual(index[index.length - 1], ':src/x.js');
});

test('git: detectState resolves a worktree .git-file gitdir pointer', () => {
  const git = vcs.get('git');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-wt-state-'));
  try {
    // the real gitdir a worktree points at
    const realGitDir = path.join(base, 'main', '.git', 'worktrees', 'wt');
    fs.mkdirSync(realGitDir, { recursive: true });
    const wt = path.join(base, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${realGitDir}\n`);
    assert.strictEqual(git.detectState(wt), null);
    // a rebase in progress writes rebase-merge into that per-worktree gitdir
    fs.mkdirSync(path.join(realGitDir, 'rebase-merge'));
    assert.strictEqual(git.detectState(wt), 'rebasing');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('git: detectState reads in-progress markers from .git', () => {
  const git = vcs.get('git');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-state-'));
  try {
    const gitDir = path.join(repo, '.git');
    fs.mkdirSync(gitDir);
    assert.strictEqual(git.detectState(repo), null);
    fs.writeFileSync(path.join(gitDir, 'MERGE_HEAD'), 'deadbeef\n');
    assert.strictEqual(git.detectState(repo), 'merging');
    fs.rmSync(path.join(gitDir, 'MERGE_HEAD'));
    fs.mkdirSync(path.join(gitDir, 'rebase-merge'));
    assert.strictEqual(git.detectState(repo), 'rebasing');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
