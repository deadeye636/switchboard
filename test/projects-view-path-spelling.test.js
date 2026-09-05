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
