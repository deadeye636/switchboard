'use strict';
// #147 — real git worktrees are first-class projects, and a session that MOVED into one follows it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveWorktreePath, isRealGitWorktree, extractCwdFromJsonl,
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

test('the FOLDER still identifies itself by the head cwd — that is what keeps siblings put', () => {
  const dir = tmpDir('wt4-');
  const jsonl = path.join(dir, 's.jsonl');
  const line = (cwd) => JSON.stringify({ type: 'user', cwd }) + '\n';
  // started in the parent repo, then moved into the worktree
  fs.writeFileSync(jsonl, line('D:\\Projekte\\repo') + line('D:\\Projekte\\repo') + line('D:\\Projekte\\repo-feature'));

  // #147 added a windowed TAIL read to answer "where does this session work now". It was never wired to
  // anything, and it is gone: the parser walks every line anyway, so it just remembers the last cwd it saw
  // (read-session-file.js, `st.lastCwd`). What survives here is the folder's identity, and it is the HEAD
  // cwd on purpose — a folder is keyed on the directory it was created from.
  assert.strictEqual(extractCwdFromJsonl(jsonl), 'D:\\Projekte\\repo', 'head cwd = where it started');
});

// --- #157: a session belongs to the PROJECT ROOT of the cwd it works in, not to the cwd -------------
//
// Measured on a real store before any of this was written: 38 of 180 sessions change working directory,
// and nearly all of them merely `cd` into a subdirectory (`…/build/logs`, `…/.claude/scratchpad`,
// `…/node_modules/node-pty/deps/winpty/src`). One visited 19 distinct cwds. Claude's `cwd` is the SHELL's
// directory, not the session's project — so attributing a session to its raw current cwd (what the issue
// originally asked for) would scatter those into phantom projects. Their project ROOT never moved.

const { projectRootOf, sessionProjectPath, _resetRootCache } = require('../derive-project-path');
const { readSessionFile } = require('../read-session-file');
const { encodeProjectPath } = require('../encode-project-path');

// A repo has a `.git` DIRECTORY; a worktree has a `.git` FILE. That is the whole difference, and it is
// all these functions look at — no git binary needed.
function makeRepo(dir) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}
function makeWorktree(dir, parentGitDir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${parentGitDir}\n`);
  return dir;
}

test('projectRootOf walks up to the nearest .git — a subdirectory is not a project', () => {
  _resetRootCache();
  const root = tmpDir('pr-');
  const repo = makeRepo(path.join(root, 'repo'));
  const deep = path.join(repo, 'src', 'deep', 'deeper');
  fs.mkdirSync(deep, { recursive: true });

  assert.strictEqual(projectRootOf(deep), repo, 'a cd into a subdirectory does not leave the project');
  assert.strictEqual(projectRootOf(repo), repo);
  assert.strictEqual(projectRootOf(path.join(root, 'nowhere')), null, 'outside any repo: no root, no guess');
  assert.strictEqual(projectRootOf(null), null);
});

test('projectRootOf stops at a worktree — it does not walk on into the parent', () => {
  _resetRootCache();
  const root = tmpDir('pr2-');
  const repo = makeRepo(path.join(root, 'repo'));
  const wt = makeWorktree(path.join(repo, 'nested-wt'), path.join(repo, '.git', 'worktrees', 'x'));
  const inside = path.join(wt, 'src');
  fs.mkdirSync(inside, { recursive: true });

  assert.strictEqual(projectRootOf(inside), wt, 'the worktree is the nearest root, and it is its own project');
});

test('sessionProjectPath: a cd into a subdirectory keeps the session where it was', () => {
  _resetRootCache();
  const root = tmpDir('sp-');
  const repo = makeRepo(path.join(root, 'repo'));
  const deep = path.join(repo, '.claude', 'scratchpad');
  fs.mkdirSync(deep, { recursive: true });

  assert.strictEqual(sessionProjectPath(deep, repo), repo, 'the scratchpad is not a project');
});

test('sessionProjectPath: a session that moved into a worktree follows it', () => {
  _resetRootCache();
  const root = tmpDir('sp2-');
  const repo = makeRepo(path.join(root, 'repo'));
  const wt = makeWorktree(path.join(root, 'repo-feature'), path.join(repo, '.git', 'worktrees', 'feature'));

  assert.strictEqual(sessionProjectPath(wt, repo), wt);
  assert.strictEqual(sessionProjectPath(path.join(wt, 'src'), repo), wt, 'from anywhere inside it');
});

test('sessionProjectPath: a session that moved into ANOTHER repo follows that one', () => {
  _resetRootCache();
  const root = tmpDir('sp3-');
  const repo = makeRepo(path.join(root, 'repo'));
  const other = makeRepo(path.join(root, 'other-repo'));

  assert.strictEqual(sessionProjectPath(other, repo), other);
});

test('sessionProjectPath never guesses: no cwd, or a cwd in no repo at all, keeps the folder', () => {
  _resetRootCache();
  const root = tmpDir('sp4-');
  const repo = makeRepo(path.join(root, 'repo'));
  const loose = path.join(root, 'loose');
  fs.mkdirSync(loose, { recursive: true });

  assert.strictEqual(sessionProjectPath(null, repo), repo, 'a transcript with no cwd at all');
  assert.strictEqual(sessionProjectPath(loose, repo), repo, 'a directory outside any repo is not a project');
});

test('sessionProjectPath keeps the folder\'s exact spelling for the same directory', () => {
  // A real store carries both `d:\Projekte\x` and `D:\Projekte\x`. Compared naively they become two projects
  // — the grouping key is the projectPath STRING.
  _resetRootCache();
  const root = tmpDir('sp5-');
  const repo = makeRepo(path.join(root, 'repo'));
  const shouty = process.platform === 'win32' ? repo.toUpperCase() : repo;

  const got = sessionProjectPath(shouty, repo);
  assert.strictEqual(got, repo, 'the folder\'s spelling wins, so both spell one project');
});

test('THE TRAP: a moved session does not drag its siblings, whatever the readdir order', () => {
  // This is what sank the first attempt (#147 -> #157): deriving the FOLDER's project from a session's
  // current cwd let whichever file readdir happened to yield first decide for every session in it. Here
  // the moved session is written FIRST on purpose.
  _resetRootCache();
  const root = tmpDir('trap-');
  const repo = makeRepo(path.join(root, 'repo'));
  const wt = makeWorktree(path.join(root, 'repo-feature'), path.join(repo, '.git', 'worktrees', 'feature'));
  const sub = path.join(repo, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });

  const folder = encodeProjectPath(repo);
  const folderDir = path.join(root, 'projects', folder);
  fs.mkdirSync(folderDir, { recursive: true });

  const line = (cwd, i) => JSON.stringify({
    type: i % 2 ? 'assistant' : 'user',
    cwd,
    timestamp: new Date(Date.UTC(2026, 6, 13, 10, i)).toISOString(),
    message: { role: i % 2 ? 'assistant' : 'user', content: 'turn ' + i },
  }) + '\n';
  const write = (name, cwds) => {
    const file = path.join(folderDir, name);
    fs.writeFileSync(file, cwds.map(line).join(''));
    return file;
  };

  const moved = write('aaaa.jsonl', [repo, repo, wt, wt]);        // first in readdir — the trap
  const sibling = write('bbbb.jsonl', [repo, repo]);
  const subdir = write('cccc.jsonl', [repo, sub, sub]);

  const read = (file) => readSessionFile(file, folder, repo, {}).projectPath;

  assert.strictEqual(read(moved), wt, 'the moved session follows the tree it is working in');
  assert.strictEqual(read(sibling), repo, 'its sibling stays put — nothing dragged it');
  assert.strictEqual(read(subdir), repo, 'and a cd into a subdirectory is not a move at all');
});
