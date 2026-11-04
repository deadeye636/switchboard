'use strict';
// #805 T2 — the worktrees the app creates for a writing task: created outside the project under the data folder,
// removed only when app-owned, never with changes unless told, and resolving to their project like any worktree
// outside the layout. Runs real git in throwaway repositories; skipped where git is not on PATH.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const vcs = require('../src/vcs');
const service = require('../src/app/task-worktree');
const knownWorktrees = require('../src/projects/known-worktree');
const wtPath = require('../src/shared/worktree-path');
const { samePath } = require('../src/app/path-containment');

let HAVE_GIT = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { HAVE_GIT = false; }

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'probe@example.invalid',
  GIT_COMMITTER_NAME: 'probe', GIT_COMMITTER_EMAIL: 'probe@example.invalid',
};
const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const sandboxes = [];
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-twt-'));
  sandboxes.push(dir);
  return dir;
}
test.after(() => { for (const d of sandboxes) fs.rmSync(d, { recursive: true, force: true }); });
test.afterEach(() => wtPath.setKnownWorktrees([]));

function makeRepo(parent, name = 'proj') {
  const repo = path.join(parent, name);
  fs.mkdirSync(repo, { recursive: true });
  gitIn(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  gitIn(repo, 'add', '.');
  gitIn(repo, 'commit', '-qm', 'init');
  return repo;
}

function fakeDb() {
  const rows = [];
  return {
    rows,
    getAppWorktrees: () => rows.slice(),
    recordAppWorktree: (r) => {
      if (rows.some(x => x.worktreePath === r.worktreePath)) throw new Error('UNIQUE constraint failed');
      rows.push({ ...r, createdAt: 1 });
    },
    forgetAppWorktree: (p) => { const i = rows.findIndex(x => x.worktreePath === p); if (i >= 0) rows.splice(i, 1); },
  };
}

function setup({ quitting = false } = {}) {
  const box = sandbox();
  const dataDir = path.join(box, 'data');
  const db = fakeDb();
  const warnings = [];
  service.init({ vcs, dataDir, db, log: { info() {}, warn: (m) => warnings.push(m) }, getAppQuitting: () => quitting });
  return { box, dataDir, db, warnings };
}

const branches = (repo) => gitIn(repo, 'branch', '--list', '--format=%(refname:short)').split(/\r?\n/).filter(Boolean);

test('create makes a worktree and a branch outside the project; remove takes the checkout and keeps the branch', { skip: !HAVE_GIT }, async () => {
  const { box, dataDir, db } = setup();
  const repo = makeRepo(box);
  const head = gitIn(repo, 'rev-parse', 'HEAD').trim();

  const made = await service.create({ projectPath: repo, taskId: 't1' });
  assert.equal(made.ok, true, made.message);
  assert.ok(samePath(made.worktreePath, path.join(dataDir, 'wt', 't1')));
  assert.ok(samePath(made.repoPath, repo));
  assert.equal(made.branch, 'switchboard/task-t1');
  assert.equal(made.baseCommit, head);
  assert.equal(made.baseDirty, false);
  assert.equal(made.hasSubmodules, false);
  assert.ok(fs.existsSync(path.join(made.worktreePath, 'a.txt')));
  assert.equal(db.rows.length, 1, 'recorded as app-owned');
  assert.deepEqual(service.list().map(r => r.taskId), ['t1']);

  const state = await service.status(made.worktreePath);
  assert.deepEqual(state, { ok: true, exists: true, dirty: false, locked: false, branch: 'switchboard/task-t1' });

  const gone = await service.remove({ worktreePath: made.worktreePath });
  assert.deepEqual(gone, { ok: true, removed: true, branch: 'switchboard/task-t1' });
  assert.equal(fs.existsSync(made.worktreePath), false);
  assert.equal(db.rows.length, 0);
  assert.ok(branches(repo).includes('switchboard/task-t1'), 'the branch is the task\'s result and stays');
});

test('a folder that is not a repository refuses a writing task', { skip: !HAVE_GIT }, async () => {
  const { box, db } = setup();
  const plain = path.join(box, 'plain');
  fs.mkdirSync(plain);
  const r = await service.create({ projectPath: plain, taskId: 't1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-a-repository');
  assert.equal(typeof r.message, 'string');
  assert.equal(db.rows.length, 0);
});

test('a repository with no commit refuses too: there is nothing to branch from', { skip: !HAVE_GIT }, async () => {
  const { box } = setup();
  const empty = path.join(box, 'empty');
  fs.mkdirSync(empty);
  gitIn(empty, 'init', '-q', '-b', 'main');
  const r = await service.create({ projectPath: empty, taskId: 't1' });
  assert.equal(r.reason, 'not-a-repository');
});

test('a task id that is not a plain name is refused before anything runs', async () => {
  setup();
  for (const taskId of ['', '../x', 'a/b', '-x', 'x y', 'a'.repeat(41), undefined]) {
    const r = await service.create({ projectPath: os.tmpdir(), taskId });
    assert.equal(r.reason, 'invalid-task', String(taskId));
  }
});

test('the worktree folder must lie outside the repository (E5)', { skip: !HAVE_GIT }, async () => {
  const box = sandbox();
  const repo = makeRepo(box);
  service.init({ vcs, dataDir: path.join(repo, '.data'), db: fakeDb(), log: { info() {}, warn() {} } });
  const r = await service.create({ projectPath: repo, taskId: 't1' });
  assert.equal(r.reason, 'inside-project');
});

test('a worktree folder that is a junction into the repository counts as inside it', { skip: !HAVE_GIT }, async () => {
  const { box, dataDir } = setup();
  const repo = makeRepo(box);
  const target = path.join(repo, 'nested');
  fs.mkdirSync(target);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.symlinkSync(target, path.join(dataDir, 'wt'), 'junction');
  const r = await service.create({ projectPath: repo, taskId: 't1' });
  assert.equal(r.reason, 'inside-project');
  assert.deepEqual(fs.readdirSync(target), [], 'nothing was checked out into the repository');
});

test('a worktree path past the measured length is refused before git runs', { skip: !HAVE_GIT }, async () => {
  const box = sandbox();
  const repo = makeRepo(box);
  const deep = path.join(box, 'd'.repeat(Math.max(1, service.MAX_WORKTREE_PATH - box.length)));
  const calls = [];
  service.init({
    vcs, dataDir: deep, db: fakeDb(), log: { info() {}, warn() {} },
    runGit: (bin, args, cwd) => {
      calls.push(args[0]);
      return Promise.resolve({ code: 0, stdout: path.resolve(repo).replace(/\\/g, '/') + '\n' + 'a'.repeat(40) + '\n', stderr: '' });
    },
  });
  const r = await service.create({ projectPath: repo, taskId: 't1' });
  assert.equal(r.reason, 'path-too-long');
  assert.deepEqual(calls, [], 'git never ran');
  assert.equal(fs.existsSync(path.join(deep, 'wt')), false, 'and nothing was created on disk');
});

test('a taken branch name is skipped for a free one', { skip: !HAVE_GIT }, async () => {
  const { box } = setup();
  const repo = makeRepo(box);
  gitIn(repo, 'branch', 'switchboard/task-t1');
  const made = await service.create({ projectPath: repo, taskId: 't1' });
  assert.equal(made.ok, true, made.message);
  assert.equal(made.branch, 'switchboard/task-t1-2');
});

test('a dirty main checkout is reported, because the worktree does not see those changes', { skip: !HAVE_GIT }, async () => {
  const { box } = setup();
  const repo = makeRepo(box);
  fs.writeFileSync(path.join(repo, 'new.txt'), 'u\n');
  const made = await service.create({ projectPath: repo, taskId: 't1' });
  assert.equal(made.ok, true, made.message);
  assert.equal(made.baseDirty, true);
  assert.equal(fs.existsSync(path.join(made.worktreePath, 'new.txt')), false);
});

test('a second create for the same task is refused, and two tasks in one repository both succeed', { skip: !HAVE_GIT }, async () => {
  const { box } = setup();
  const repo = makeRepo(box);
  const [a, b] = await Promise.all([
    service.create({ projectPath: repo, taskId: 't1' }),
    service.create({ projectPath: repo, taskId: 't2' }),
  ]);
  assert.equal(a.ok, true, a.message);
  assert.equal(b.ok, true, b.message);
  const again = await service.create({ projectPath: repo, taskId: 't1' });
  assert.equal(again.reason, 'exists');
});

test('a failed add rolls back the branch it created', { skip: !HAVE_GIT }, async () => {
  const { box } = setup();
  const repo = makeRepo(box);
  // Let every real call through but make `worktree add` create its branch and then fail, the way git does.
  service.init({
    vcs, dataDir: path.join(box, 'data'), db: fakeDb(), log: { info() {}, warn() {} },
    runGit: (bin, args, cwd) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        gitIn(cwd, 'branch', args[3]);
        return Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: simulated' });
      }
      try {
        return Promise.resolve({ code: 0, stdout: execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' });
      } catch (err) {
        return Promise.resolve({ code: typeof err.status === 'number' ? err.status : -1, stdout: '', stderr: '' });
      }
    },
  });
  const r = await service.create({ projectPath: repo, taskId: 't1' });
  assert.equal(r.reason, 'git-failed');
  assert.equal(branches(repo).includes('switchboard/task-t1'), false, 'the half-made branch is gone');
});

// Runs every git call for real, except where `override` answers first.
function realGitWith(override) {
  return (bin, args, cwd) => {
    const hit = override(args, cwd);
    if (hit) return Promise.resolve(hit);
    try {
      return Promise.resolve({ code: 0, stdout: execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' });
    } catch (err) {
      return Promise.resolve({ code: typeof err.status === 'number' ? err.status : -1, stdout: '', stderr: '' });
    }
  };
}

test('the rollback leaves a branch alone that does not point where this call made it', { skip: !HAVE_GIT }, async () => {
  const { box } = setup();
  const repo = makeRepo(box);
  gitIn(repo, 'checkout', '-q', '-b', 'side');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  gitIn(repo, 'add', '.');
  gitIn(repo, 'commit', '-qm', 'side work');
  const sideCommit = gitIn(repo, 'rev-parse', 'HEAD').trim();
  gitIn(repo, 'checkout', '-q', 'main');
  // Somebody else creates the task's branch, with commits of its own, between the name check and `add`.
  service.init({
    vcs, dataDir: path.join(box, 'data'), db: fakeDb(), log: { info() {}, warn() {} },
    runGit: realGitWith((args, cwd) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        gitIn(cwd, 'branch', args[3], sideCommit);
        return { code: 255, stdout: '', stderr: 'fatal: a branch named it already exists' };
      }
      return null;
    }),
  });
  const r = await service.create({ projectPath: repo, taskId: 't1' });
  assert.equal(r.reason, 'git-failed');
  assert.equal(gitIn(repo, 'rev-parse', 'switchboard/task-t1').trim(), sideCommit, 'their branch and its commit survive');
});

test('a row left by a task whose folder was deleted by hand does not block a new one of the same id', { skip: !HAVE_GIT }, async () => {
  const { box, db } = setup();
  const repo = makeRepo(box);
  const first = await service.create({ projectPath: repo, taskId: 't1' });
  fs.rmSync(first.worktreePath, { recursive: true, force: true });
  const again = await service.create({ projectPath: repo, taskId: 't1' });
  assert.equal(again.ok, true, again.message);
  assert.equal(again.branch, 'switchboard/task-t1-2', 'the first task\'s branch is kept, a new one is made');
  assert.deepEqual(db.rows.map(r => r.branch), ['switchboard/task-t1-2'], 'one row, the new one');
});

test('a record that cannot be written takes the checkout and its branch back', { skip: !HAVE_GIT }, async () => {
  const { box, dataDir } = setup();
  const repo = makeRepo(box);
  const db = fakeDb();
  db.recordAppWorktree = () => { throw new Error('SQLITE_BUSY: database is locked at some/internal/path'); };
  service.init({ vcs, dataDir, db, log: { info() {}, warn() {} } });
  const r = await service.create({ projectPath: repo, taskId: 't1' });
  assert.equal(r.reason, 'internal');
  assert.equal(/SQLITE|path/.test(r.message), false, 'the thrown text stays in the log');
  assert.equal(fs.existsSync(path.join(dataDir, 'wt', 't1')), false);
  assert.equal(branches(repo).includes('switchboard/task-t1'), false);
});

test('a quit that arrives while remove reads git writes nothing', { skip: !HAVE_GIT }, async () => {
  const { box, dataDir } = setup();
  const repo = makeRepo(box);
  const made = await service.create({ projectPath: repo, taskId: 't1' });
  const rows = [{ ...service.list()[0] }];
  fs.rmSync(made.worktreePath, { recursive: true, force: true });
  let quitting = false;
  const db = { getAppWorktrees: () => rows.slice(), recordAppWorktree() {}, forgetAppWorktree: () => { throw new Error('written after quit'); } };
  service.init({
    vcs, dataDir, db, log: { info() {}, warn() {} }, getAppQuitting: () => quitting,
    runGit: realGitWith((args) => { if (args[0] === 'worktree' && args[1] === 'list') quitting = true; return null; }),
  });
  const r = await service.remove({ worktreePath: made.worktreePath });
  assert.equal(r.reason, 'quitting');
});

test('dirty means tracked edits and staged changes too, not only untracked files', { skip: !HAVE_GIT }, async () => {
  const { box } = setup();
  const repo = makeRepo(box);
  const edited = await service.create({ projectPath: repo, taskId: 't1' });
  fs.appendFileSync(path.join(edited.worktreePath, 'a.txt'), 'more\n');
  assert.equal((await service.remove({ worktreePath: edited.worktreePath })).reason, 'dirty');
  const staged = await service.create({ projectPath: repo, taskId: 't2' });
  fs.writeFileSync(path.join(staged.worktreePath, 'n.txt'), 'n\n');
  gitIn(staged.worktreePath, 'add', 'n.txt');
  assert.equal((await service.remove({ worktreePath: staged.worktreePath })).reason, 'dirty');
});

test('a worktree with submodules is reported on create and removed when clean', { skip: !HAVE_GIT }, async () => {
  const { box } = setup();
  const sub = makeRepo(box, 'sub');
  const repo = makeRepo(box, 'super');
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'lib'], { cwd: repo, env: GIT_ENV, stdio: 'ignore' });
  gitIn(repo, 'commit', '-qm', 'add submodule');
  const made = await service.create({ projectPath: repo, taskId: 't1' });
  assert.equal(made.ok, true, made.message);
  assert.equal(made.hasSubmodules, true);
  const gone = await service.remove({ worktreePath: made.worktreePath });
  assert.equal(gone.ok, true, gone.message);
  assert.equal(fs.existsSync(made.worktreePath), false);
});

test('status reads only: a folder deleted by hand stays prunable in the user\'s list', { skip: !HAVE_GIT }, async () => {
  const { box } = setup();
  const repo = makeRepo(box);
  const made = await service.create({ projectPath: repo, taskId: 't1' });
  fs.rmSync(made.worktreePath, { recursive: true, force: true });
  const state = await service.status(made.worktreePath);
  assert.equal(state.exists, false);
  assert.ok(gitIn(repo, 'worktree', 'list', '--porcelain').includes('prunable'));
});

test('status and remove answer not-owned for a path the app never made', async () => {
  setup();
  const somewhere = path.join(os.tmpdir(), 'never-made-by-the-app');
  assert.equal((await service.status(somewhere)).reason, 'not-owned');
  assert.equal((await service.remove({ worktreePath: somewhere })).reason, 'not-owned');
});

test('remove needs the owner marker: a worktree git made without the app is left alone', { skip: !HAVE_GIT }, async () => {
  const { box, dataDir } = setup();
  const repo = makeRepo(box);
  const foreign = path.join(dataDir, 'wt', 'foreign');
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  gitIn(repo, 'worktree', 'add', '-q', '-b', 'mine', foreign);
  const r = await service.remove({ worktreePath: foreign });
  assert.equal(r.reason, 'not-owned');
  assert.ok(fs.existsSync(foreign));
});

test('remove refuses an owned path that resolves outside the worktree folder (junction)', { skip: !HAVE_GIT }, async () => {
  const { box, dataDir, db } = setup();
  const repo = makeRepo(box);
  const outside = path.join(box, 'elsewhere');
  fs.mkdirSync(outside);
  const planted = path.join(dataDir, 'wt', 'planted');
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.symlinkSync(outside, planted, 'junction');
  db.recordAppWorktree({ worktreePath: planted, repoPath: repo, branch: 'b', baseCommit: 'c', taskId: 'planted' });
  const r = await service.remove({ worktreePath: planted });
  assert.equal(r.reason, 'outside-root');
  assert.ok(fs.existsSync(outside));
  assert.equal(db.rows.length, 1);
});

test('remove refuses a worktree with uncommitted or untracked changes unless forced', { skip: !HAVE_GIT }, async () => {
  const { box } = setup();
  const repo = makeRepo(box);
  const made = await service.create({ projectPath: repo, taskId: 't1' });
  fs.writeFileSync(path.join(made.worktreePath, 'untracked.txt'), 'u\n');

  const state = await service.status(made.worktreePath);
  assert.equal(state.dirty, true);
  const refused = await service.remove({ worktreePath: made.worktreePath });
  assert.equal(refused.reason, 'dirty');
  assert.ok(fs.existsSync(path.join(made.worktreePath, 'untracked.txt')));

  const forced = await service.remove({ worktreePath: made.worktreePath, force: true });
  assert.equal(forced.ok, true, forced.message);
  assert.equal(fs.existsSync(made.worktreePath), false);
});

test('a locked worktree is the user\'s and is not removed', { skip: !HAVE_GIT }, async () => {
  const { box } = setup();
  const repo = makeRepo(box);
  const made = await service.create({ projectPath: repo, taskId: 't1' });
  gitIn(repo, 'worktree', 'lock', made.worktreePath);
  const r = await service.remove({ worktreePath: made.worktreePath, force: true });
  assert.equal(r.reason, 'locked');
  assert.ok(fs.existsSync(made.worktreePath));
});

test('a worktree folder deleted by hand is pruned and its record dropped', { skip: !HAVE_GIT }, async () => {
  const { box, db } = setup();
  const repo = makeRepo(box);
  const made = await service.create({ projectPath: repo, taskId: 't1' });
  fs.rmSync(made.worktreePath, { recursive: true, force: true });
  const state = await service.status(made.worktreePath);
  assert.equal(state.exists, false);
  const r = await service.remove({ worktreePath: made.worktreePath });
  assert.deepEqual(r, { ok: true, removed: false, branch: 'switchboard/task-t1' });
  assert.equal(db.rows.length, 0);
  assert.equal(gitIn(repo, 'worktree', 'list', '--porcelain').includes('prunable'), false);
});

test('nothing is written once the app is quitting', { skip: !HAVE_GIT }, async () => {
  const { box, db } = setup({ quitting: true });
  const repo = makeRepo(box);
  const r = await service.create({ projectPath: repo, taskId: 't1' });
  assert.equal(r.reason, 'quitting');
  assert.equal(db.rows.length, 0);
});

test('the new worktree resolves through worktreeRootOf to its project', { skip: !HAVE_GIT }, async () => {
  const { box } = setup();
  const repo = makeRepo(box);
  const made = await service.create({ projectPath: repo, taskId: 't1' });
  const rows = [];
  knownWorktrees.init({ db: { getKnownWorktrees: () => rows.slice(), recordKnownWorktree: (w, r) => rows.push({ worktreePath: w, repoPath: r }) }, log: { info() {} } });
  knownWorktrees.refresh([repo, made.worktreePath], new Map([[repo, { registered: 1 }]]));
  assert.ok(samePath(wtPath.worktreeRootOf(made.worktreePath), repo));
  assert.ok(samePath(wtPath.settingsOwnerPath(made.worktreePath), repo));
});

test('git: the worktree list reader takes the -z porcelain, bare entry included', () => {
  const git = vcs.get('git');
  const raw = [
    'worktree /r/bare', 'bare', '',
    'worktree /r/main', 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/main', '',
    'worktree /data/wt/t1', 'HEAD ' + 'b'.repeat(40), 'branch refs/heads/switchboard/task-t1', 'locked reason here', '',
    'worktree /data/wt/gone', 'HEAD ' + 'c'.repeat(40), 'detached', 'prunable gitdir file points to non-existent location', '',
  ].join('\0');
  const list = git.worktree.parseList(raw);
  assert.equal(list.length, 4);
  assert.equal(list[0].bare, true);
  assert.equal(list[1].branch, 'main');
  assert.deepEqual([list[2].branch, list[2].locked], ['switchboard/task-t1', true]);
  assert.deepEqual([list[3].detached, list[3].prunable, list[3].branch], [true, true, null]);
});

test('git: every worktree argv separates options from paths and branch names', () => {
  const { worktree: worktrees } = vcs.get('git');
  const add = worktrees.addArgs({ path: '-p', branch: 'b', base: 'h' });
  assert.ok(add.indexOf('--') < add.indexOf('-p'));
  const rm = worktrees.removeArgs({ path: '-p', force: false });
  assert.equal(rm.includes('--force'), false);
  assert.ok(rm.indexOf('--') < rm.indexOf('-p'));
  assert.ok(worktrees.removeArgs({ path: 'x', force: true }).includes('--force'));
  assert.deepEqual(worktrees.branchRollbackArgs('b', 'h'), ['update-ref', '-d', 'refs/heads/b', 'h'],
    'the rollback deletes only a branch still at the commit it was made from');
  assert.equal(worktrees.parseHead('/r\n' + 'a'.repeat(40) + '\n').head, 'a'.repeat(40));
  assert.equal(worktrees.parseHead('/r\nHEAD\n'), null);
});
