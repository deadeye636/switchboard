'use strict';
// #147 — real git worktrees are first-class projects, and a session that MOVED into one follows it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveWorktreePath, isRealGitWorktree, sessionCwd, extractCurrentCwdFromJsonl, extractCwdFromJsonl,
} = require('../derive-project-path');

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

test('a real `git worktree add` worktree is its OWN project, not the parent repo', () => {
  const root = tmpDir('wt-');
  const parent = path.join(root, 'repo');
  const wt = path.join(root, 'repo-feature');
  fs.mkdirSync(path.join(parent, '.git'), { recursive: true }); // parent: .git is a DIRECTORY
  fs.mkdirSync(wt, { recursive: true });
  // a real worktree's .git is a FILE pointing into the parent's git dir
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(parent, '.git', 'worktrees', 'feature')}\n`);

  assert.strictEqual(isRealGitWorktree(wt), true, 'detected via the .git FILE');
  assert.strictEqual(isRealGitWorktree(parent), false, 'the main repo has a .git directory');
  assert.strictEqual(resolveWorktreePath(wt), wt, 'grouped on its own top-level, not collapsed');
});

test('a real worktree is NOT collapsed even when it sits under a conventional worktrees dir', () => {
  const root = tmpDir('wt2-');
  const parent = path.join(root, 'proj');
  const wt = path.join(parent, '.worktrees', 'feature');
  fs.mkdirSync(parent, { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /somewhere/.git/worktrees/feature\n');
  assert.strictEqual(resolveWorktreePath(wt), wt, 'a real worktree owns its sessions');
});

test('the .claude/worktrees convention collapse still works for a plain dir', () => {
  const root = tmpDir('wt3-');
  const parent = path.join(root, 'proj');
  const wt = path.join(parent, '.claude', 'worktrees', 'feature');
  fs.mkdirSync(wt, { recursive: true });   // no .git file -> just the convention
  assert.strictEqual(resolveWorktreePath(wt), parent, 'convention worktrees still fold into the parent');
});

test('a session that MOVED parent->worktree attributes to its current tree, not the head line', () => {
  const dir = tmpDir('wt4-');
  const jsonl = path.join(dir, 's.jsonl');
  const line = (cwd) => JSON.stringify({ type: 'user', cwd }) + '\n';
  // started in the parent repo, then moved into the worktree
  fs.writeFileSync(jsonl, line('D:\\Projekte\\repo') + line('D:\\Projekte\\repo') + line('D:\\Projekte\\repo-feature'));

  assert.strictEqual(extractCwdFromJsonl(jsonl), 'D:\\Projekte\\repo', 'head cwd = where it started');
  assert.strictEqual(extractCurrentCwdFromJsonl(jsonl), 'D:\\Projekte\\repo-feature', 'tail cwd = where it works now');
  assert.strictEqual(sessionCwd(jsonl), 'D:\\Projekte\\repo-feature', 'grouping follows the current tree');
});

test('a session that never moved is unaffected', () => {
  const dir = tmpDir('wt5-');
  const jsonl = path.join(dir, 's.jsonl');
  const line = (cwd) => JSON.stringify({ type: 'user', cwd }) + '\n';
  fs.writeFileSync(jsonl, line('D:\\Projekte\\repo') + line('D:\\Projekte\\repo'));
  assert.strictEqual(sessionCwd(jsonl), 'D:\\Projekte\\repo');
});

test('sessionCwd falls back to the head when the tail carries no cwd', () => {
  const dir = tmpDir('wt6-');
  const jsonl = path.join(dir, 's.jsonl');
  fs.writeFileSync(jsonl,
    JSON.stringify({ type: 'user', cwd: 'D:\\Projekte\\repo' }) + '\n' +
    JSON.stringify({ type: 'summary' }) + '\n');   // later lines have no cwd
  assert.strictEqual(sessionCwd(jsonl), 'D:\\Projekte\\repo');
});

test('a truncated tail line does not break the current-cwd read', () => {
  const dir = tmpDir('wt7-');
  const jsonl = path.join(dir, 's.jsonl');
  fs.writeFileSync(jsonl,
    JSON.stringify({ type: 'user', cwd: 'D:\\Projekte\\repo-feature' }) + '\n' +
    '{"type":"user","cw');   // live append, mid-write
  assert.strictEqual(sessionCwd(jsonl), 'D:\\Projekte\\repo-feature');
});
