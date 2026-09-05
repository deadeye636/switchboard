const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  deriveProjectPath, resolveWorktreePath, normPath, samePath,
  isDescendant, sessionProjectPath, _resetRootCache,
} = require('../src/session/derive-project-path');

// #8: the same directory spelled two ways must normalise to one key — otherwise the register keeps both
// and the sidebar shows the project twice.
//
// The separators are built with `path.join` rather than written out (#563). The canonical form is the
// REAL path now, and on POSIX a backslash is an ordinary character in a filename: `one\two\three` is one
// directory there, not three, so asserting that it folds would be asserting Windows behaviour on the
// Linux runner.
test('normPath collapses a trailing separator to one canonical key, and keeps different directories apart', () => {
  const dir = path.join('one', 'two', 'three');
  assert.equal(normPath(dir + path.sep), normPath(dir));
  assert.equal(samePath(dir + path.sep, dir), true);
  // A genuinely different string (separators stripped entirely) is NOT the same directory — it stays distinct.
  assert.notEqual(normPath('onetwothree'), normPath(dir));
});

test('on Windows both separators spell the same directory', { skip: process.platform !== 'win32' }, () => {
  assert.equal(normPath('one\\two\\three'), normPath('one/two/three'));
  assert.equal(samePath('one\\two\\three', 'one/two/three'), true);
});

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-dpp-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('resolveWorktreePath collapses /<repo>/.claude/worktrees/<name> back to <repo> when parent exists', () => {
  const tmp = mkTmp();
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const worktree = path.join(repo, '.claude', 'worktrees', 'agent-abc');
    assert.equal(resolveWorktreePath(worktree), repo);
  } finally {
    cleanup(tmp);
  }
});

test('resolveWorktreePath collapses /<repo>/.claude-worktrees/<name> back to <repo>', () => {
  const tmp = mkTmp();
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const worktree = path.join(repo, '.claude-worktrees', 'foo');
    assert.equal(resolveWorktreePath(worktree), repo);
  } finally {
    cleanup(tmp);
  }
});

test('resolveWorktreePath collapses /<repo>/.worktrees/<name> back to <repo>', () => {
  const tmp = mkTmp();
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const worktree = path.join(repo, '.worktrees', 'bar');
    assert.equal(resolveWorktreePath(worktree), repo);
  } finally {
    cleanup(tmp);
  }
});

test('resolveWorktreePath handles trailing-slash variant', () => {
  const tmp = mkTmp();
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const worktreeWithSlash = path.join(repo, '.worktrees', 'bar') + '/';
    assert.equal(resolveWorktreePath(worktreeWithSlash), repo);
  } finally {
    cleanup(tmp);
  }
});

test('resolveWorktreePath returns input unchanged when the parent dir does not exist on disk', () => {
  // /nonexistent-xyzzy-12345/.claude/worktrees/agent-foo — regex matches, but parent dir absent
  const fake = '/nonexistent-xyzzy-12345/.claude/worktrees/agent-foo';
  assert.equal(resolveWorktreePath(fake), fake);
});

test('resolveWorktreePath returns input unchanged when the path does not match the worktree pattern', () => {
  assert.equal(resolveWorktreePath('/repo/src/foo'), '/repo/src/foo');
  assert.equal(resolveWorktreePath('/repo/.claude/agents/foo'), '/repo/.claude/agents/foo');
  // Worktrees segment but two extra components (nested under worktree) — must not match
  assert.equal(resolveWorktreePath('/repo/.worktrees/foo/bar'), '/repo/.worktrees/foo/bar');
});

test('resolveWorktreePath passes falsy input through unchanged without throwing', () => {
  assert.equal(resolveWorktreePath(null), null);
  assert.equal(resolveWorktreePath(undefined), undefined);
  assert.equal(resolveWorktreePath(''), '');
});

test('deriveProjectPath end-to-end: jsonl with worktree cwd resolves to parent repo', () => {
  const tmp = mkTmp();
  try {
    // Real on-disk repo so existsSync returns true
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const worktreeCwd = path.join(repo, '.claude', 'worktrees', 'agent-x');
    // worktreeCwd itself doesn't need to exist; only its derived parent does

    // The folder we feed deriveProjectPath is a "projects/foo" style dir
    // containing a single jsonl whose first cwd line points at the worktree.
    const folder = path.join(tmp, 'project-folder');
    fs.mkdirSync(folder);
    fs.writeFileSync(
      path.join(folder, 'session-1.jsonl'),
      JSON.stringify({ type: 'user', cwd: worktreeCwd }) + '\n',
      'utf8'
    );

    assert.equal(deriveProjectPath(folder), repo);
  } finally {
    cleanup(tmp);
  }
});

// --- the canonical key is the REAL path, not the spelling (#563) ---
//
// `normPath` was a string transform, so a project reached through a junction, a symlink or a `subst`
// drive was two keys for one directory: two registrations, two sidebar rows, a remap that moves half of
// them. The escape is exercised with a link that really exists on disk — a string that merely looks like
// one passes every version of this code, which is exactly why the bug lasted.
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
function makeLink(from, to) {
  try { fs.symlinkSync(to, from, LINK_TYPE); return true; } catch { return false; }
}

test('normPath gives a project one key however it is reached — through a link or directly', () => {
  const tmp = fs.realpathSync.native(mkTmp());
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const viaLink = path.join(tmp, 'repo-link');
    if (!makeLink(viaLink, repo)) {
      assert.fail('could not create a link on this platform — that IS the case under test, so it is not skipped silently');
    }

    assert.equal(normPath(viaLink), normPath(repo), 'one directory, one bucket');
    assert.equal(samePath(viaLink, repo), true);
    assert.notEqual(normPath(path.join(tmp, 'other')), normPath(repo), 'and a different directory is still different');
  } finally { cleanup(tmp); }
});

test('sessionProjectPath keeps the folder\'s spelling when the session is in the same directory by another name', () => {
  const tmp = fs.realpathSync.native(mkTmp());
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const viaLink = path.join(tmp, 'repo-link');
    if (!makeLink(viaLink, repo)) assert.fail('could not create a link — that IS the case under test');
    _resetRootCache();

    // The folder stands for the linked spelling; the transcript recorded the real one. That is one
    // project, so the folder's string wins — it is the grouping key the sidebar already renders.
    assert.equal(sessionProjectPath(repo, viaLink), viaLink,
      'a session must not be re-attributed to a second project that is the same directory');
  } finally { cleanup(tmp); }
});

test('isDescendant answers about the real path: a link out of a project is not inside it', () => {
  const tmp = fs.realpathSync.native(mkTmp());
  try {
    const repo = path.join(tmp, 'repo');
    const outside = path.join(tmp, 'elsewhere');
    fs.mkdirSync(repo);
    fs.mkdirSync(outside);
    const escape = path.join(repo, 'linked');
    if (!makeLink(escape, outside)) assert.fail('could not create a link — that IS the case under test');

    assert.equal(escape.startsWith(repo + path.sep), true, 'it IS spelled inside — that was the bug');
    assert.equal(isDescendant(escape, repo), false, 'and it is not actually inside');
    assert.equal(isDescendant(path.join(repo, 'sub'), repo), true, 'an ordinary subdirectory still is');
    assert.equal(isDescendant(repo, repo), false, 'a directory is not a descendant of itself');
  } finally { cleanup(tmp); }
});
