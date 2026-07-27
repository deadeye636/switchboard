'use strict';
// #306 — archiving a session must not reorder its project.
//
// The sidebar sorted projects by the newest VISIBLE session, and the archive filter runs before that.
// So archiving the newest session of a project threw it back to its second-newest one and the project
// jumped down the list. Archiving hides a row; it is not a statement that the project went quiet — the
// date belongs to the PROJECT, and every session hands its timestamp over whether it is shown or not.
//
// projects-view.js takes everything through ctx, so the whole read path runs here with a fake store.

const test = require('node:test');
const assert = require('node:assert/strict');

const view = require('../src/index/projects-view');

const ALPHA = 'C:/temp/demo/alpha';
const BETA = 'C:/temp/demo/beta';
const REGISTERED = { registered: true, registeredAt: '2026-01-01T00:00:00Z' };

function setup(rows, { meta = [], states } = {}) {
  view.init({
    PROJECTS_DIR: 'C:/nope',
    activeSessions: new Map(),
    db: {
      getAllMeta: () => new Map(meta),
      getAllCached: () => rows,
      getAllFolderMeta: () => new Map(),
      setFolderMeta: () => {},
      getFavoritedProjects: () => new Set(),
      getProjectDisplayNames: () => new Map(),
      getProjectStates: () => states || new Map([[ALPHA, REGISTERED], [BETA, REGISTERED]]),
    },
  });
}

const row = (sessionId, projectPath, modified) => ({
  sessionId, projectPath, modified, summary: 's', messageCount: 1,
});

const paths = projects => projects.map(p => p.projectPath);

test('archiving the newest session does not move its project (#306)', () => {
  // alpha's newest work is newer than anything in beta, and it is the session being archived.
  const rows = [
    row('a-new', ALPHA, '2026-06-01T00:00:00Z'),
    row('a-old', ALPHA, '2026-01-05T00:00:00Z'),
    row('b', BETA, '2026-03-01T00:00:00Z'),
  ];

  setup(rows);
  assert.deepEqual(paths(view.buildProjectsFromCache(false)), [ALPHA, BETA], 'baseline: alpha is ahead');

  setup(rows, { meta: [['a-new', { archived: 1 }]] });
  const after = view.buildProjectsFromCache(false);
  assert.deepEqual(paths(after), [ALPHA, BETA],
    'alpha must keep its place — its second-newest session used to decide the order');
  assert.deepEqual(after[0].sessions.map(s => s.sessionId), ['a-old'], 'the archived session is still hidden');
});

test('a project with visible sessions carries lastActivity too (#306)', () => {
  // The renderer sorts on its own copy of this rule, so the figure has to reach it — it used to be
  // attached only to projects that had nothing left to show.
  setup([
    row('a-new', ALPHA, '2026-06-01T00:00:00Z'),
    row('a-old', ALPHA, '2026-01-05T00:00:00Z'),
  ], { meta: [['a-new', { archived: 1 }]] });

  const [alpha] = view.buildProjectsFromCache(false);
  assert.equal(alpha.lastActivity, '2026-06-01T00:00:00Z', 'the archived session still counts');
  assert.equal(alpha.sessions[0].modified, '2026-01-05T00:00:00Z', 'while the row itself stays hidden');
});

test('showing archived sessions gives the same order (#306)', () => {
  setup([
    row('a-new', ALPHA, '2026-06-01T00:00:00Z'),
    row('a-old', ALPHA, '2026-01-05T00:00:00Z'),
    row('b', BETA, '2026-03-01T00:00:00Z'),
  ], { meta: [['a-new', { archived: 1 }]] });

  assert.deepEqual(paths(view.buildProjectsFromCache(true)), [ALPHA, BETA],
    'the toggle changes which sessions are listed, not which project is most recent');
});

test('a project that has never seen a session still sinks to the bottom (#306)', () => {
  // The guard against handing every project a date: a registered-but-never-used project has no activity
  // at all, and `registeredAt` is deliberately absent here so nothing can stand in for one.
  setup([row('b', BETA, '2026-03-01T00:00:00Z')], {
    states: new Map([[ALPHA, { registered: true }], [BETA, REGISTERED]]),
  });

  const projects = view.buildProjectsFromCache(false);
  assert.deepEqual(paths(projects), [BETA, ALPHA]);
  assert.equal(projects[1].lastActivity, null, 'no sessions, no registration date, no recency');
});
