'use strict';
// #594 — a worktree with no sessions is invisible, so no session can be started in it.
//
// A sidebar row came from a registration or from a cached session, and a worktree has neither: not
// registered by design, and no session when it is fresh. This is the third source — what a project holds
// on disk — and the two decisions in it are the ones worth pinning, because both are owner calls that a
// later change would undo by looking reasonable:
//
//   * only a REAL `git worktree add` checkout gets a row. An ordinary folder under a conventional
//     worktrees directory matches the path pattern and is not somewhere to start work;
//   * the collection carries a floor, so its cost is bounded by the clock rather than by how often
//     anything asks — the #521/#590 shape.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const worktreeDirs = require('../src/index/worktree-dirs');
const { worktreeDirsIn } = require('../src/shared/worktree-path');

function tmpProject(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

/** A directory whose `.git` is a FILE pointing into a repository — what `git worktree add` leaves. */
function makeWorktree(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ' + path.join(dir, '..', '.git', 'worktrees', 'x') + '\n');
  return dir;
}

/** A directory that is not a checkout at all — the shape the path pattern cannot tell apart. */
function makePlainDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('worktreeDirsIn composes the three conventional directories without touching the disk', () => {
  const dirs = worktreeDirsIn('/example/repo');
  assert.equal(dirs.length, 3);
  assert.ok(dirs.every(d => d.startsWith('/example/repo/.')), `unexpected: ${dirs.join(' | ')}`);
  assert.deepEqual(new Set(dirs).size, 3, 'three distinct layouts');
  assert.deepEqual(worktreeDirsIn(''), [], 'no path, no candidates');
  assert.deepEqual(worktreeDirsIn(null), []);
  assert.deepEqual(worktreeDirsIn('/example/repo/'), worktreeDirsIn('/example/repo'),
    'a trailing separator must not double it');
});

test('a real worktree is found, a plain directory of the same shape is not', () => {
  const project = tmpProject('wtd-');
  const [claudeDir] = worktreeDirsIn(project);
  const real = makeWorktree(path.join(claudeDir, 'agent-real'));
  makePlainDir(path.join(claudeDir, 'agent-plain'));

  worktreeDirs._reset();
  assert.equal(worktreeDirs.refresh([project], { force: true }).ran, true, 'a forced pass runs');

  const found = worktreeDirs.list().map(p => path.resolve(p));
  assert.deepEqual(found, [path.resolve(real)],
    'the plain directory matches the path pattern and is NOT a checkout — offering "new session" there ' +
    'would be the app inventing one');
});

test('all three layouts are walked', () => {
  const project = tmpProject('wtd-');
  const made = worktreeDirsIn(project).map((dir, i) => makeWorktree(path.join(dir, 'agent-' + i)));

  worktreeDirs._reset();
  worktreeDirs.refresh([project], { force: true });

  const found = new Set(worktreeDirs.list().map(p => path.resolve(p)));
  for (const wt of made) assert.ok(found.has(path.resolve(wt)), `${wt} must be found`);
});

test('a worktree of a worktree is found too', () => {
  const project = tmpProject('wtd-');
  const [claudeDir] = worktreeDirsIn(project);
  const outer = makeWorktree(path.join(claudeDir, 'agent-a'));
  const inner = makeWorktree(path.join(worktreeDirsIn(outer)[0], 'hotfix-1'));

  worktreeDirs._reset();
  worktreeDirs.refresh([project], { force: true });

  const found = new Set(worktreeDirs.list().map(p => path.resolve(p)));
  assert.ok(found.has(path.resolve(outer)));
  assert.ok(found.has(path.resolve(inner)), 'the nested checkout is a row too — #586 gives it a place to sit');
});

test('MAX_DEPTH is where the walk stops, exactly', () => {
  // The cap is what keeps a filesystem walk from being open-ended, so both sides of it are pinned: the
  // deepest level it is meant to reach is reached, and the one past it is not. Read off the constant
  // rather than written as a number, so raising the cap moves the test with it.
  const project = tmpProject('wtd-');
  let cur = project;
  const levels = [];
  for (let i = 0; i <= worktreeDirs.MAX_DEPTH; i++) {
    cur = makeWorktree(path.join(worktreeDirsIn(cur)[0], 'level-' + i));
    levels.push(cur);
  }

  worktreeDirs._reset();
  worktreeDirs.refresh([project], { force: true });

  const found = new Set(worktreeDirs.list().map(p => path.resolve(p)));
  assert.equal(found.size, worktreeDirs.MAX_DEPTH, `one answer per level walked, got: ${[...found].join(' | ')}`);
  for (const wt of levels.slice(0, worktreeDirs.MAX_DEPTH)) {
    assert.ok(found.has(path.resolve(wt)), `${path.basename(wt)} is inside the cap and must be found`);
  }
  assert.ok(!found.has(path.resolve(levels[worktreeDirs.MAX_DEPTH])),
    'and the level past the cap is not — a walk of the filesystem does not get to be open-ended');
});

test('the floor holds a second pass off, and force gets past it', () => {
  const project = tmpProject('wtd-');
  const [claudeDir] = worktreeDirsIn(project);
  makeWorktree(path.join(claudeDir, 'agent-one'));

  worktreeDirs._reset();
  const t0 = 1_000_000;
  assert.equal(worktreeDirs.refresh([project], { now: t0 }).ran, true, 'the first pass always runs');
  assert.equal(worktreeDirs.list().length, 1);

  // A second checkout appears, and a pass asked for one millisecond later must not go and look.
  makeWorktree(path.join(claudeDir, 'agent-two'));
  assert.equal(worktreeDirs.refresh([project], { now: t0 + 1 }).ran, false, 'inside the floor: no pass');
  assert.equal(worktreeDirs.list().length, 1, 'and the answer is the one the last pass gave');

  assert.equal(worktreeDirs.refresh([project], { now: t0 + worktreeDirs.MIN_INTERVAL_MS }).ran, true,
    'past the floor it runs again');
  assert.equal(worktreeDirs.list().length, 2);

  makeWorktree(path.join(claudeDir, 'agent-three'));
  assert.equal(worktreeDirs.refresh([project], { force: true }).ran, true, 'force ignores the floor');
  assert.equal(worktreeDirs.list().length, 3);
});

test('a pass reports whether the answer MOVED, not merely that it ran (#594)', () => {
  // What the caller pushes on. The sweep this rides notifies only when the INDEX moved, and a new
  // checkout moves no index at all — so a fresh worktree sat in the payload, correct and unrendered,
  // until something unrelated happened to change a row. Measured in the demo before this was added.
  // Reporting "a pass ran" instead would push on every quiet pass, which is the opposite mistake.
  const project = tmpProject('wtd-');
  const [claudeDir] = worktreeDirsIn(project);
  makeWorktree(path.join(claudeDir, 'agent-one'));

  worktreeDirs._reset();
  assert.equal(worktreeDirs.refresh([project], { force: true }).changed, true, 'the first find is a change');
  assert.equal(worktreeDirs.refresh([project], { force: true }).changed, false,
    'nothing happened in between — a quiet pass must not make the renderer rebuild the sidebar');

  makeWorktree(path.join(claudeDir, 'agent-two'));
  assert.equal(worktreeDirs.refresh([project], { force: true }).changed, true, 'a new checkout is');

  const inside = worktreeDirs.refresh([project], { now: 0 });
  assert.deepEqual(inside, { ran: false, changed: false }, 'a pass the floor refused changed nothing');
});

test('one directory registered under two spellings is walked once (#594)', () => {
  // MEASURED, on a live instance: 7 answers for 3 checkouts. The register holds one directory under
  // several spellings — a cwd out of a transcript, a drive-letter case, a trailing separator — so the
  // same project arrives here more than once and each spelling composes a different candidate string for
  // the same directory. Deduplicating on the raw string deduplicates nothing, and it compounds with
  // depth: once per spelling of the project, then again per spelling of each worktree above.
  //
  // A trailing separator is the spelling that folds on every platform, which is what keeps this a real
  // test off Windows (`test/projects-view-path-spelling.test.js` has the long form of that rule).
  const project = tmpProject('wtd-');
  const [claudeDir] = worktreeDirsIn(project);
  makeWorktree(path.join(claudeDir, 'agent-one'));

  worktreeDirs._reset();
  worktreeDirs.refresh([project, project + path.sep], { force: true });
  assert.equal(worktreeDirs.list().length, 1,
    `one checkout, one answer — got: ${worktreeDirs.list().join(' | ')}`);
});

test('a worktree handed in AS a project is still reported (#594)', () => {
  // MEASURED, on a live instance: 1 answer for 3 checkouts. A database written before discovery stopped
  // registering worktrees hands us worktrees as projects, so a checkout arrived as a starting point and
  // its own discovery then read as a duplicate of itself. What bounds the walk and what bounds the
  // answer have to be two different sets.
  const project = tmpProject('wtd-');
  const [claudeDir] = worktreeDirsIn(project);
  const outer = makeWorktree(path.join(claudeDir, 'agent-a'));
  const sibling = makeWorktree(path.join(claudeDir, 'agent-b'));
  const inner = makeWorktree(path.join(worktreeDirsIn(outer)[0], 'hotfix-1'));

  worktreeDirs._reset();
  worktreeDirs.refresh([project, outer, inner], { force: true });

  const found = new Set(worktreeDirs.list().map(p => path.resolve(p)));
  for (const wt of [outer, sibling, inner]) {
    assert.ok(found.has(path.resolve(wt)), `${path.basename(wt)} must be reported even though a legacy row named it a project`);
  }
  assert.equal(worktreeDirs.list().length, 3, `three checkouts, three answers — got: ${worktreeDirs.list().join(' | ')}`);
});

test('a project with nothing under it, and a path that does not exist, answer empty', () => {
  const project = tmpProject('wtd-');
  worktreeDirs._reset();
  worktreeDirs.refresh([project, path.join(project, 'nowhere-at-all')], { force: true });
  assert.deepEqual(worktreeDirs.list(), [],
    'an unreadable or absent directory is the ordinary case here, not an error');

  worktreeDirs._reset();
  worktreeDirs.refresh(null, { force: true });
  assert.deepEqual(worktreeDirs.list(), [], 'no projects, no walk');
});

test('a deleted checkout leaves the list on the next pass', () => {
  const project = tmpProject('wtd-');
  const [claudeDir] = worktreeDirsIn(project);
  const wt = makeWorktree(path.join(claudeDir, 'agent-gone'));

  worktreeDirs._reset();
  worktreeDirs.refresh([project], { force: true });
  assert.equal(worktreeDirs.list().length, 1);

  fs.rmSync(wt, { recursive: true, force: true });
  worktreeDirs.refresh([project], { force: true });
  assert.deepEqual(worktreeDirs.list(), [],
    'the source is the filesystem, which is the whole reason it is: a remembered list would keep a row ' +
    'for a checkout that is gone');
});
