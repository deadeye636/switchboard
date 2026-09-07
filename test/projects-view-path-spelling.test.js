'use strict';
// #245 — one directory, two spellings, ONE project.
//
// A project bucket is keyed on the `cwd` a transcript recorded, and that string is not canonical: real
// stores contain both drive-letter cases, and a path can arrive with either separator depending on who
// wrote it (a live CLI, a seed, an older record). The buckets already collapsed those, but the
// VISIBILITY check in front of them compared the raw string against the registered spelling — so a row
// spelled differently from its registration was dropped before it could be merged. Measured: a real
// session, indexed and correct, that the sidebar simply did not show, in a project it was already
// displaying.
//
// projects-view.js takes everything through ctx, so the whole read path runs here with a fake store.

const test = require('node:test');
const assert = require('node:assert/strict');

const view = require('../src/index/projects-view');
const { normPath } = require('../src/session/derive-project-path');

const REGISTERED = 'C:/temp/demo/alpha';       // how the project is on the register
const OTHER_SPELLING = 'C:\\temp\\demo\\alpha'; // how a live CLI wrote it into the transcript
const CASE_SPELLING = 'c:/TEMP/demo/alpha';    // and how a third record spelled it
const TRAILING_SPELLING = REGISTERED + '/';    // and how a fourth left the separator on

// A spelling belongs in the fixture only where it denotes the SAME directory on the platform running
// the test, and neither exception is a shortcut:
//
//   - CASE folds only on Windows. On a case-sensitive filesystem `/x/A` and `/x/a` ARE two directories,
//     so merging them would be the bug.
//   - The SEPARATOR folds only on Windows too, since #563. The key used to be a string transform that
//     rewrote every `\` into `/` on every platform; it is the real path now, and on POSIX a backslash is
//     an ordinary character in a filename — `/x/a\b` is one directory named `a\b` there, and it is not
//     `/x/a/b`. So the backslash spelling is a WINDOWS fixture; asserting that it folds anywhere else
//     was asserting Windows behaviour on the Linux CI, the same mistake the case rule already records.
//
// A trailing separator folds everywhere, so it is what keeps "one directory, two spellings" a real test
// on POSIX rather than a fixture with nothing left to merge.
const WIN = process.platform === 'win32';
const SPELLINGS = WIN
  ? [['a', REGISTERED], ['b', OTHER_SPELLING], ['c', CASE_SPELLING]]
  : [['a', REGISTERED], ['b', TRAILING_SPELLING]];

// The second spelling to use where a test names one directly rather than walking `SPELLINGS`.
const SECOND_SPELLING = WIN ? OTHER_SPELLING : TRAILING_SPELLING;

const REGISTERED_STATE = { registered: true, registeredAt: '2026-01-01T00:00:00Z' };

function setup(rows, { favorited = [], displayNames = [], states } = {}) {
  view.init({
    PROJECTS_DIR: 'C:/nope',
    activeSessions: new Map(),
    db: {
      getAllMeta: () => new Map(),
      getAllCached: () => rows,
      getAllFolderMeta: () => new Map(),
      setFolderMeta: () => {},
      getFavoritedProjects: () => new Set(favorited),
      getProjectDisplayNames: () => new Map(displayNames),
      getProjectStates: () => states || new Map([[REGISTERED, REGISTERED_STATE]]),
    },
  });
}

const row = (sessionId, projectPath, modified) => ({
  sessionId, projectPath, modified, summary: 's', messageCount: 1,
});

test('a session whose cwd is spelled differently still lands in its registered project (#245)', () => {
  const dates = { a: '2026-01-02T00:00:00Z', b: '2026-01-03T00:00:00Z', c: '2026-01-04T00:00:00Z' };
  setup(SPELLINGS.map(([id, spelling]) => row(id, spelling, dates[id])));

  const projects = view.buildProjectsFromCache(false);
  assert.equal(projects.length, 1, `one directory must be one project, got: ${projects.map(p => p.projectPath).join(' | ')}`);
  assert.deepEqual(projects[0].sessions.map(s => s.sessionId).sort(), SPELLINGS.map(([id]) => id),
    'every spelling belongs to the same project — the differently-spelled ones used to vanish entirely');
});

test('the newest activity counts even when it arrived under another spelling (#245)', () => {
  setup([row('a', REGISTERED, '2026-01-02T00:00:00Z'), row('b', SECOND_SPELLING, '2026-06-01T00:00:00Z')]);
  const [project] = view.buildProjectsFromCache(false);
  // Sorting by recency reads lastActivity; keyed rawly, the newer session's timestamp was invisible.
  const newest = project.sessions.map(s => s.modified).sort().pop();
  assert.equal(newest, '2026-06-01T00:00:00Z');
});

test('a star and a display name survive a differently-spelled bucket (#245)', () => {
  // The user starred/renamed the REGISTERED spelling; the bucket takes its display path from the row.
  setup([row('b', SECOND_SPELLING, '2026-01-03T00:00:00Z')], {
    favorited: [REGISTERED],
    displayNames: [[REGISTERED, 'Alpha']],
  });
  const [project] = view.buildProjectsFromCache(false);
  assert.equal(project.favorited, true, 'the star is stored against the spelling the user clicked');
  assert.equal(project.displayName, 'Alpha');
});

test('genuinely different directories stay separate (#245)', () => {
  // The guard against over-merging. BOTH directories are registered here on purpose: with only one of
  // them on the register, "one project" would also be the answer for a normalisation that wrongly
  // collapsed them, and the test would pass while proving nothing.
  setup([row('a', REGISTERED, '2026-01-02T00:00:00Z'), row('b', 'C:/temp/demo/beta', '2026-01-03T00:00:00Z')], {
    states: new Map([[REGISTERED, REGISTERED_STATE], ['C:/temp/demo/beta', REGISTERED_STATE]]),
  });
  const projects = view.buildProjectsFromCache(false);
  assert.equal(projects.length, 2, 'alpha and beta are different directories and must stay two projects');
  const byPath = new Map(projects.map(p => [normPath(p.projectPath), p.sessions.map(s => s.sessionId)]));
  assert.deepEqual(byPath.get(normPath(REGISTERED)), ['a']);
  assert.deepEqual(byPath.get(normPath('C:/temp/demo/beta')), ['b']);
});

// #245's MEASURED symptom was in the admin list: it showed the same directory twice, and only one of the
// two rows carried the register entry — so the row the user saw first could be the one that knew nothing
// about their project. The sidebar half above says nothing about this path.
test('the admin list shows one row per directory, however its sessions are spelled (#245)', () => {
  const dates = { a: '2026-01-02T00:00:00Z', b: '2026-06-01T00:00:00Z', c: '2026-03-01T00:00:00Z' };
  setup(SPELLINGS.map(([id, spelling]) => row(id, spelling, dates[id])),
    { favorited: [REGISTERED], displayNames: [[REGISTERED, 'Alpha']] });

  // buildProjectsAdmin returns the rows themselves; the `{ ok, projects }` envelope is the IPC handler's.
  const projects = view.buildProjectsAdmin();
  // Compared as a KEY, never as a substring of one: the canonical form is the real path now (#563), so
  // its separator is the platform's and a literal `/temp/demo/alpha` would only match on POSIX.
  const mine = projects.filter(p => normPath(p.projectPath) === normPath(REGISTERED));
  assert.equal(mine.length, 1, `one directory, one admin row — got: ${mine.map(p => p.projectPath).join(' | ')}`);

  const [entry] = mine;
  assert.equal(entry.sessionCount, SPELLINGS.length, 'every spelling counts towards the same project');
  assert.equal(entry.registered, true, 'the register entry must reach the row the user sees');
  assert.equal(entry.projectPath, REGISTERED, 'the REGISTERED spelling is the one to display');
  assert.equal(entry.favorite, true, 'the star was stored against the registered spelling');
  assert.equal(entry.displayName, 'Alpha');
  assert.equal(entry.lastActivity, '2026-06-01T00:00:00Z', 'newest activity across all spellings');
});

// #596 — the same defect one layer up: the SIDEBAR paired a worktree with its project by a raw `===`.
// A bucket exposes whichever spelling filled it, so one directory reaches the renderer spelled two ways,
// and a worktree whose parent did not match was drawn nowhere at all — it is already excluded from the
// top level for being a worktree, so "no parent found" is "no row". `nestUnder` answers it in main.
const WORKTREE = REGISTERED + '/.claude/worktrees/wt1';
const bothRegistered = (parentSpelling) => new Map([
  [parentSpelling, REGISTERED_STATE],
  [WORKTREE, REGISTERED_STATE],
]);

test('a worktree nests under its project even when the two are spelled differently (#596)', () => {
  // The parent row takes the OTHER spelling (a backslash one on Windows, a trailing separator on POSIX)
  // while the worktree path is built from the registered one — which is exactly how it happens: a
  // registered project carries the register's spelling and a worktree carries its session rows'.
  setup([row('p', SECOND_SPELLING, '2026-01-02T00:00:00Z'), row('w', WORKTREE, '2026-01-03T00:00:00Z')],
    { states: bothRegistered(SECOND_SPELLING) });

  const projects = view.buildProjectsFromCache(false);
  const parent = projects.find(p => normPath(p.projectPath) === normPath(REGISTERED));
  const worktree = projects.find(p => normPath(p.projectPath) === normPath(WORKTREE));
  assert.ok(parent && worktree, `expected both rows, got: ${projects.map(p => p.projectPath).join(' | ')}`);
  assert.equal(worktree.nestUnder, parent.projectPath,
    'the worktree must point at the parent ROW, whatever spelling that row carries');
  assert.equal(parent.nestUnder, null, 'a plain project nests under nothing');
});

test('a worktree still nests when both are spelled the same way (#596)', () => {
  // The control. Without it a fix that always returned the parent would pass the test above.
  setup([row('p', REGISTERED, '2026-01-02T00:00:00Z'), row('w', WORKTREE, '2026-01-03T00:00:00Z')],
    { states: bothRegistered(REGISTERED) });

  const worktree = view.buildProjectsFromCache(false).find(p => normPath(p.projectPath) === normPath(WORKTREE));
  assert.equal(worktree.nestUnder, REGISTERED);
});

test('a worktree whose parent is not in the payload nests under nothing (#596)', () => {
  // The behaviour that must NOT change: a parent that is hidden or not listed draws no header, so there
  // is nothing to nest under and the worktree keeps rendering nowhere. That is #591, not this fix.
  setup([row('w', WORKTREE, '2026-01-03T00:00:00Z')], { states: new Map([[WORKTREE, REGISTERED_STATE]]) });

  const projects = view.buildProjectsFromCache(false);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].nestUnder, null);
});

// A worktree carries no registration of its own any more — it is a sub-unit of its project, so its
// visibility is the project's. These pin the three answers that follow from that.

test('a worktree with no registration of its own is visible because its project is', () => {
  setup([row('p', REGISTERED, '2026-01-02T00:00:00Z'), row('w', WORKTREE, '2026-01-03T00:00:00Z')],
    { states: new Map([[REGISTERED, REGISTERED_STATE]]) });

  const projects = view.buildProjectsFromCache(false);
  const worktree = projects.find(p => normPath(p.projectPath) === normPath(WORKTREE));
  assert.ok(worktree, `the worktree must still be shown, got: ${projects.map(p => p.projectPath).join(' | ')}`);
  assert.deepEqual(worktree.sessions.map(s => s.sessionId), ['w']);
});

test('hiding the project takes its worktrees with it', () => {
  setup([row('p', REGISTERED, '2026-01-02T00:00:00Z'), row('w', WORKTREE, '2026-01-03T00:00:00Z')],
    { states: new Map([[REGISTERED, { ...REGISTERED_STATE, hidden: 1 }]]) });

  assert.deepEqual(view.buildProjectsFromCache(false), [],
    'the user hid the project; a sub-unit of it is not a second thing to hide');
});

test('a worktree may still be hidden on its own', () => {
  setup([row('p', REGISTERED, '2026-01-02T00:00:00Z'), row('w', WORKTREE, '2026-01-03T00:00:00Z')],
    { states: new Map([[REGISTERED, REGISTERED_STATE], [WORKTREE, { hidden: 1 }]]) });

  const projects = view.buildProjectsFromCache(false);
  assert.equal(projects.length, 1, 'only the project is left');
  assert.equal(normPath(projects[0].projectPath), normPath(REGISTERED));
});

test('the admin row says which project a worktree belongs to', () => {
  // The auto-hide fold reads this field, and its own tests hand it to a fixture. Nothing else asserted
  // that the real builder produces it, which is a field name matching across two files on trust.
  setup([row('p', REGISTERED, '2026-01-02T00:00:00Z'), row('w', WORKTREE, '2026-01-03T00:00:00Z')],
    { states: new Map([[REGISTERED, REGISTERED_STATE]]) });

  const rows = view.buildProjectsAdmin();
  const worktree = rows.find(r => normPath(r.projectPath) === normPath(WORKTREE));
  const project = rows.find(r => normPath(r.projectPath) === normPath(REGISTERED));
  assert.ok(worktree && project, 'both rows are in the admin list');
  assert.equal(normPath(worktree.worktreeRoot), normPath(REGISTERED));
  assert.equal(project.worktreeRoot, null, 'an ordinary project belongs to nothing');
  assert.equal(worktree.registered, false, "and it is on nobody's list");
});

// #586 — a worktree created inside a worktree. `parseWorktreePath` answers "who is my parent", which
// here is another worktree; that parent is itself excluded from the top level, and the nesting pass only
// runs for top-level projects, so the inner checkout was attached to nothing and drawn nowhere at all.
// The owner chose to attach it to the TOP-MOST project rather than nest a rail deeper.
const NESTED = WORKTREE + '/.worktrees/wt2';

test('a worktree of a worktree nests under the top-most project (#586)', () => {
  setup([
    row('p', REGISTERED, '2026-01-02T00:00:00Z'),
    row('w', WORKTREE, '2026-01-03T00:00:00Z'),
    row('n', NESTED, '2026-01-04T00:00:00Z'),
  ], { states: new Map([[REGISTERED, REGISTERED_STATE]]) });

  const projects = view.buildProjectsFromCache(false);
  const nested = projects.find(p => normPath(p.projectPath) === normPath(NESTED));
  assert.ok(nested, `the nested worktree must be in the payload, got: ${projects.map(p => p.projectPath).join(' | ')}`);
  assert.equal(nested.nestUnder, REGISTERED,
    'it points at the PROJECT, not at the worktree it sits inside — which is drawn nested itself and so ' +
    'has no header of its own for a third level to hang under');
});

test('a nested worktree is still hidden with the project it belongs to (#586)', () => {
  // The control for the flattening: the row moved, the model did not. Visibility walks to the top
  // already (`resolveVisible`), and this pins that the two answers agree about the same directory.
  setup([row('n', NESTED, '2026-01-04T00:00:00Z')],
    { states: new Map([[REGISTERED, { ...REGISTERED_STATE, hidden: 1 }]]) });

  assert.deepEqual(view.buildProjectsFromCache(false), []);
});

// #595 — the project manager groups a worktree under its project, and the row it groups under has to be
// the one the SIDEBAR nests it under, or the two surfaces name one directory two things. Both ask
// `nestUnder`, and both resolve it canonically, so this pins the admin half against the same fixtures.

test('the admin row points at the project ROW it belongs under (#595)', () => {
  setup([row('p', SECOND_SPELLING, '2026-01-02T00:00:00Z'), row('w', WORKTREE, '2026-01-03T00:00:00Z')],
    { states: bothRegistered(SECOND_SPELLING) });

  const rows = view.buildProjectsAdmin();
  const parent = rows.find(r => normPath(r.projectPath) === normPath(REGISTERED));
  const worktree = rows.find(r => normPath(r.projectPath) === normPath(WORKTREE));
  assert.ok(parent && worktree, `expected both rows, got: ${rows.map(r => r.projectPath).join(' | ')}`);
  assert.equal(worktree.nestUnder, parent.projectPath,
    'the manager groups by this, so it must be the row\'s own display spelling — the parent takes the ' +
    'register\'s and the worktree its session rows\', and a raw compare misses that');
  assert.equal(parent.nestUnder, null, 'an ordinary project is grouped under nothing');
});

test('a nested worktree groups under the same project the sidebar nests it under (#595)', () => {
  setup([
    row('p', REGISTERED, '2026-01-02T00:00:00Z'),
    row('w', WORKTREE, '2026-01-03T00:00:00Z'),
    row('n', NESTED, '2026-01-04T00:00:00Z'),
  ], { states: new Map([[REGISTERED, REGISTERED_STATE]]) });

  const admin = view.buildProjectsAdmin().find(r => normPath(r.projectPath) === normPath(NESTED));
  const sidebar = view.buildProjectsFromCache(false).find(p => normPath(p.projectPath) === normPath(NESTED));
  assert.ok(admin && sidebar);
  assert.equal(normPath(admin.nestUnder), normPath(sidebar.nestUnder),
    'the two surfaces cannot disagree about which project a worktree belongs to');
});

test('a worktree whose project has no row of its own still knows the path (#595)', () => {
  // Manual mode: a worktree can be listed while its project is not. There is nothing to group under, so
  // the manager names the parent in the cell instead — and `worktreeRoot` is what it names.
  setup([row('w', WORKTREE, '2026-01-03T00:00:00Z')], { states: new Map([[WORKTREE, REGISTERED_STATE]]) });

  const rows = view.buildProjectsAdmin();
  const worktree = rows.find(r => normPath(r.projectPath) === normPath(WORKTREE));
  assert.equal(worktree.nestUnder, null, 'no row to group under');
  assert.equal(normPath(worktree.worktreeRoot), normPath(REGISTERED),
    'but the path is still there, so the row can say whose sub-unit it is');
});

// #594 — the third row source. `buildProjectsFromCache` reads what `worktree-dirs` found on disk, so a
// worktree with no sessions still gets a row and somewhere to start one.
const worktreeDirs = require('../src/index/worktree-dirs');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { worktreeDirsIn } = require('../src/shared/worktree-path');

function seedWorktreeOnDisk(projectDir, name) {
  const dir = nodePath.join(worktreeDirsIn(projectDir)[0], name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(nodePath.join(dir, '.git'), 'gitdir: ' + nodePath.join(projectDir, '.git') + '\n');
  return dir;
}

test('a worktree with no sessions still gets a row (#594)', () => {
  const project = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'pv594-'));
  const idle = seedWorktreeOnDisk(project, 'demo-idle');
  worktreeDirs._reset();
  worktreeDirs.refresh([project], { force: true });

  setup([], { states: new Map([[project, REGISTERED_STATE]]) });
  const projects = view.buildProjectsFromCache(false);
  const row = projects.find(p => normPath(p.projectPath) === normPath(idle));
  assert.ok(row, `the idle worktree must have a row, got: ${projects.map(p => p.projectPath).join(' | ')}`);
  assert.deepEqual(row.sessions, [], 'and it has no sessions, which is the whole point');
  assert.equal(normPath(row.nestUnder), normPath(project), 'it nests under its project like any other');
  worktreeDirs._reset();
});

test('a worktree found on disk does not overwrite the row its sessions built (#594)', () => {
  // The ordering trap: the disk pass runs after the cached rows, and a bucket it replaced would be a
  // worktree whose sessions all vanished from the sidebar.
  const project = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'pv594-'));
  const busy = seedWorktreeOnDisk(project, 'demo-busy');
  worktreeDirs._reset();
  worktreeDirs.refresh([project], { force: true });

  setup([row('s', busy, '2026-01-03T00:00:00Z')], { states: new Map([[project, REGISTERED_STATE]]) });
  const found = view.buildProjectsFromCache(false).find(p => normPath(p.projectPath) === normPath(busy));
  assert.ok(found);
  assert.deepEqual(found.sessions.map(s => s.sessionId), ['s'], 'its sessions survive the third source');
  worktreeDirs._reset();
});

test('a worktree on disk under a HIDDEN project gets no row (#594)', () => {
  // The third source is gated by the same visibility as the other two — a sub-unit of a hidden project
  // is hidden, and a source that skipped that check would put the project back on screen one row at a time.
  const project = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'pv594-'));
  seedWorktreeOnDisk(project, 'demo-idle');
  worktreeDirs._reset();
  worktreeDirs.refresh([project], { force: true });

  setup([], { states: new Map([[project, { ...REGISTERED_STATE, hidden: 1 }]]) });
  assert.deepEqual(view.buildProjectsFromCache(false), []);
  worktreeDirs._reset();
});

test('a worktree the user hid gets no row even though it is on disk (#594)', () => {
  const project = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'pv594-'));
  const idle = seedWorktreeOnDisk(project, 'demo-idle');
  worktreeDirs._reset();
  worktreeDirs.refresh([project], { force: true });

  setup([], { states: new Map([[project, REGISTERED_STATE], [idle, { hidden: 1 }]]) });
  const projects = view.buildProjectsFromCache(false);
  assert.equal(projects.length, 1, `only the project is left, got: ${projects.map(p => p.projectPath).join(' | ')}`);
  assert.equal(normPath(projects[0].projectPath), normPath(project));
  worktreeDirs._reset();
});
