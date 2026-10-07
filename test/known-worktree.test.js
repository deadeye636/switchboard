'use strict';
// #757 — a worktree outside the layout is recognised by its `.git` file, remembered, and answered for by
// the shared module; a worktree whose checkout is gone leaves the sidebar without losing its history.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wt = require('../src/shared/worktree-path');
const { worktreeRepoAt } = require('../src/session/derive-project-path');
const knownWorktrees = require('../src/projects/known-worktree');
const view = require('../src/index/projects-view');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-known-wt-'));

// A checkout as `git worktree add` leaves it: a folder whose `.git` is a FILE pointing into the repository.
function makeWorktree(dir, repo, name, { relative = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const gitdir = path.join(repo, '.git', 'worktrees', name);
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ' + (relative ? path.relative(dir, gitdir) : gitdir) + '\n');
}

test.afterEach(() => wt.setKnownWorktrees([]));

test('the shared module answers for a remembered worktree exactly as for a layout path', () => {
  wt.setKnownWorktrees([{ path: '\\work\\proj\\feature-x', parentPath: '\\work\\proj', repoPath: '\\work\\proj\\repo' }]);
  // Either separator, either case, a trailing separator — the renderer and main must agree on the key.
  for (const p of ['\\work\\proj\\feature-x', '/work/proj/feature-x/', '/WORK/proj/feature-x']) {
    assert.deepEqual(wt.parseWorktreePath(p), { parentPath: '\\work\\proj', name: 'feature-x' }, p);
    assert.equal(wt.worktreeRootOf(p), '\\work\\proj', p);
    assert.equal(wt.worktreeLabelOf(p), 'feature-x', p);
    assert.equal(wt.settingsOwnerPath(p), '\\work\\proj', p);
    assert.equal(wt.knownWorktreeParentOf(p), '\\work\\proj', p);
  }
  // git runs in the repository the `.git` file named, which is not the project it is listed under.
  assert.equal(wt.worktreeRepoOf('\\work\\proj\\feature-x'), '\\work\\proj\\repo');
  // Nothing else changes: an ordinary path is no worktree, a layout path keeps its own answers.
  assert.equal(wt.parseWorktreePath('\\work\\proj\\other'), null);
  assert.equal(wt.knownWorktreeParentOf('/work/proj/.worktrees/a'), null);
  assert.equal(wt.worktreeRepoOf('/work/proj/.worktrees/a'), '/work/proj');
});

test('repoOfGitdir cuts a worktree pointer back to its repository and refuses anything else', () => {
  assert.equal(wt.repoOfGitdir('/code/app/.git/worktrees/feature'), '/code/app');
  assert.equal(wt.repoOfGitdir('\\code\\app\\.git\\worktrees\\feature\\'), '\\code\\app');
  assert.equal(wt.repoOfGitdir('/code/app/.git/modules/sub'), null, 'a submodule is not a worktree');
  assert.equal(wt.repoOfGitdir(''), null);
});

test('worktreeRepoAt reads the `.git` file, absolute or relative, and nothing else', () => {
  const root = tmp();
  const repo = path.join(root, 'repo');
  makeWorktree(path.join(root, 'abs'), repo, 'abs');
  makeWorktree(path.join(root, 'rel'), repo, 'rel', { relative: true });
  fs.mkdirSync(path.join(root, 'plain', '.git'), { recursive: true });
  assert.equal(worktreeRepoAt(path.join(root, 'abs')), repo);
  assert.equal(worktreeRepoAt(path.join(root, 'rel')), repo);
  assert.equal(worktreeRepoAt(path.join(root, 'plain')), null, 'a `.git` directory is a repository, not a worktree');
  assert.equal(worktreeRepoAt(path.join(root, 'gone')), null);
});

function fakeDb(stored = []) {
  const rows = stored.slice();
  return {
    rows,
    getKnownWorktrees: () => rows.slice(),
    recordKnownWorktree: (worktreePath, repoPath) => rows.push({ worktreePath, repoPath }),
  };
}

test('a sibling worktree is recognised once, remembered, and belongs to the project holding its repository', () => {
  const root = tmp();
  const project = path.join(root, 'proj');
  const repo = path.join(project, 'dev', 'repo');
  const worktree = path.join(project, 'feature-x');
  makeWorktree(worktree, repo, 'feature-x');
  const states = new Map([[project, { registered: 1 }], [root, { registered: 1 }]]);

  const db = fakeDb();
  knownWorktrees.init({ db, log: { info() {} } });
  assert.equal(knownWorktrees.refresh([project, worktree], states).changed, true);
  assert.deepEqual(db.rows, [{ worktreePath: worktree, repoPath: repo }]);
  // The NEAREST listed project, not the outermost one.
  assert.equal(wt.worktreeRootOf(worktree), project);
  assert.equal(knownWorktrees.refresh([project, worktree], states).changed, false, 'asked again, nothing moved');
  assert.equal(db.rows.length, 1, 'the `.git` file is read once per path');

  // The checkout is deleted; a restart reads the fact back and the path is still a worktree.
  fs.rmSync(worktree, { recursive: true, force: true });
  knownWorktrees.init({ db, log: { info() {} } });
  knownWorktrees.refresh([project, worktree], states);
  assert.equal(wt.worktreeRootOf(worktree), project);
});

test('a path somebody acted on keeps its behaviour: listed stays a project, removed stays removed', () => {
  const root = tmp();
  const project = path.join(root, 'proj');
  const listedWt = path.join(project, 'long-lived');
  const removedWt = path.join(project, 'thrown-away');
  makeWorktree(listedWt, path.join(project, 'repo'), 'long-lived');
  makeWorktree(removedWt, path.join(project, 'repo'), 'thrown-away');
  const states = new Map([
    [project, { registered: 1 }],
    [listedWt, { registered: 1 }],
    [removedWt, { removedAt: '2026-10-01T00:00:00Z' }],
  ]);
  knownWorktrees.init({ db: fakeDb(), log: { info() {} } });
  knownWorktrees.refresh([project, listedWt, removedWt], states);
  assert.equal(wt.parseWorktreePath(listedWt), null, 'a checkout listed on purpose is a project in its own right (#147)');
  assert.equal(wt.parseWorktreePath(removedWt), null, 'a removed one does not come back nested under its project');
});

test('opening a session in a recognised checkout does not list it; any other path still goes on the list', () => {
  const projects = require('../src/projects/projects');
  const root = tmp();
  const project = path.join(root, 'proj');
  const worktree = path.join(project, 'feature-z');
  makeWorktree(worktree, path.join(project, 'repo'), 'feature-z');
  const written = [];
  const states = new Map([[project, { registered: 1 }]]);
  projects.init({
    log: { info() {}, warn() {} },
    db: {
      ...fakeDb(),
      getProjectStates: () => states,
      setProjectState: (p, patch) => written.push([p, patch.registered]),
    },
  });
  knownWorktrees.refresh([project, worktree], states);
  projects.ensureProjectAdded(worktree, { fromSession: true });
  assert.deepEqual(written, [], 'resuming in it must not turn it into a project for good');
  projects.ensureProjectAdded(path.join(root, 'elsewhere'), { fromSession: true });
  assert.equal(written.length, 1, 'an ordinary directory is listed by a session exactly as before');
});

test('a remembered path whose folder is no worktree any more is forgotten; a gone one is kept', () => {
  const root = tmp();
  const project = path.join(root, 'proj');
  const worktree = path.join(project, 'feature-y');
  makeWorktree(worktree, path.join(project, 'repo'), 'feature-y');
  const states = new Map([[project, { registered: 1 }]]);
  const db = fakeDb();
  db.forgetKnownWorktree = (p) => { const i = db.rows.findIndex(r => r.worktreePath === p); if (i >= 0) db.rows.splice(i, 1); };
  knownWorktrees.init({ db, log: { info() {} } });
  knownWorktrees.refresh([project, worktree], states);
  assert.equal(db.rows.length, 1);

  // Next run: the folder is an ordinary directory now.
  fs.rmSync(path.join(worktree, '.git'));
  knownWorktrees.init({ db, log: { info() {} } });
  knownWorktrees.refresh([project, worktree], states);
  assert.equal(db.rows.length, 0);
  assert.equal(wt.parseWorktreePath(worktree), null);
});

test('a worktree whose repository sits in no listed project stays what it was', () => {
  const root = tmp();
  const worktree = path.join(root, 'loose');
  makeWorktree(worktree, path.join(root, 'elsewhere'), 'loose');
  knownWorktrees.init({ db: fakeDb(), log: { info() {} } });
  knownWorktrees.refresh([worktree], new Map([[path.join(root, 'unrelated'), { registered: 1 }]]));
  assert.equal(wt.parseWorktreePath(worktree), null);
});

// --- the sidebar leaves a gone checkout out (requirement 1) ---

function viewSetup(rows, states, activeSessions = new Map()) {
  view.init({
    PROJECTS_DIR: path.join(os.tmpdir(), 'sb-nope'),
    activeSessions,
    db: {
      getAllMeta: () => new Map(),
      getAllCached: () => rows,
      getAllFolderMeta: () => new Map(),
      setFolderMeta: () => {},
      getFavoritedProjects: () => new Set(),
      getProjectDisplayNames: () => new Map(),
      getProjectStates: () => states,
    },
  });
}
const row = (sessionId, projectPath) => ({ sessionId, projectPath, modified: '2026-10-01T00:00:00Z', summary: 's', messageCount: 1 });

test('a worktree whose checkout is gone leaves the sidebar while its project is there', () => {
  const project = tmp();
  const gone = path.join(project, '.worktrees', 'done');
  viewSetup([row('p', project), row('w', gone)], new Map([[project, { registered: 1 }]]));
  const paths = view.buildProjectsFromCache(false).map(p => p.projectPath);
  assert.deepEqual(paths, [project]);
});

test('…but not while a session in it runs, and not when the project is missing too', () => {
  const project = tmp();
  const gone = path.join(project, '.worktrees', 'busy');
  viewSetup([row('p', project), row('w', gone)], new Map([[project, { registered: 1 }]]),
    new Map([['w', { exited: false }]]));
  assert.ok(view.buildProjectsFromCache(false).some(p => p.projectPath === gone), 'a running session keeps its row (#598)');

  const missingProject = path.join(os.tmpdir(), 'sb-known-wt-no-such-project');
  const goneToo = path.join(missingProject, '.worktrees', 'x');
  viewSetup([row('p', missingProject), row('w', goneToo)], new Map([[missingProject, { registered: 1 }]]));
  assert.ok(view.buildProjectsFromCache(false).some(p => p.projectPath === goneToo), 'an unplugged drive is likelier');
});

test('a new sibling worktree is recognised before the first payload, so it never goes out as a project', () => {
  // A group that changes parent between two renders makes morphdom throw (`insertBefore`), so the first
  // payload that carries the worktree must already nest it.
  const project = tmp();
  const worktree = path.join(project, 'feature-new');
  makeWorktree(worktree, path.join(project, 'repo'), 'feature-new');
  const states = new Map([[project, { registered: 1 }]]);
  knownWorktrees.init({ db: fakeDb(), log: { info() {} } });
  view.init({
    PROJECTS_DIR: path.join(os.tmpdir(), 'sb-nope'),
    activeSessions: new Map(),
    refreshKnownWorktrees: (paths, st) => knownWorktrees.refresh(paths, st),
    db: {
      getAllMeta: () => new Map(), getAllCached: () => [row('p', project), row('w', worktree)],
      getAllFolderMeta: () => new Map(), setFolderMeta: () => {}, getFavoritedProjects: () => new Set(),
      getProjectDisplayNames: () => new Map(), getProjectStates: () => states,
    },
  });
  const byPath = new Map(view.buildProjectsFromCache(false).map(p => [p.projectPath, p]));
  assert.ok(byPath.has(worktree), 'unregistered, yet visible — through its project');
  assert.equal(byPath.get(worktree).nestUnder, project);
  assert.equal(byPath.get(worktree).knownWorktreeParent, project);
});

test('a remembered worktree outside the layout is hidden the same way, and stamped for the renderer', () => {
  const project = tmp();
  const present = path.join(project, 'feature-a');
  fs.mkdirSync(present);
  const gone = path.join(project, 'feature-b');
  wt.setKnownWorktrees([
    { path: present, parentPath: project, repoPath: project },
    { path: gone, parentPath: project, repoPath: project },
  ]);
  viewSetup([row('p', project), row('a', present), row('b', gone)], new Map([[project, { registered: 1 }]]));
  const projects = view.buildProjectsFromCache(false);
  const byPath = new Map(projects.map(p => [p.projectPath, p]));
  assert.equal(byPath.has(gone), false);
  assert.equal(byPath.get(present).nestUnder, project);
  assert.equal(byPath.get(present).knownWorktreeParent, project);
  assert.equal(byPath.get(project).knownWorktreeParent, null);
});
