'use strict';
// #173: a subagent is rendered NESTED UNDER ITS PARENT (or, when the parent is not on
// screen, in the "Orphan subagents" section). So the payload must not hand the sidebar a
// subagent whose parent it is deliberately withholding: an archived parent, a parent
// whose project is hidden. Those rows were painted as orphans under a parent nobody could
// see, and — because a project whose payload holds nothing but subagent rows used to be
// skipped outright — they could take the whole project row off the sidebar with them.
//
// The rule: whatever keeps the parent out keeps its subagents out. A parent the STORE has
// never heard of is the one exception — that subagent is a genuine orphan and still shows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');

const row = (over) => ({
  sessionId: 's', folder: 'f', projectPath: '/p', summary: '', firstPrompt: '',
  created: '2026-07-01T08:00:00.000Z', modified: '2026-07-01T09:00:00.000Z',
  messageCount: 3, parentSessionId: null, ...over,
});

// projectPaths: which projects are on the register (all shown); rows: the cached sessions;
// meta: sessionId -> { archived }.
function build({ projectPaths, rows, meta = new Map(), showArchived = false }) {
  sessionCache.init({
    PROJECTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-projects-')),
    activeSessions: new Map(),
    getMainWindow: () => null,
    log: console,
    db: {
      getAllMeta: () => meta,
      getAllCached: () => rows,
      getSetting: () => null,
      setFolderMeta: () => {},
      getProjectMeta: () => null,
      getProjectStates: () => new Map(projectPaths.map(p => [p, { registered: 1 }])),
    },
  });
  return sessionCache.buildProjectsFromCache(showArchived);
}

test('#173: a subagent whose parent is archived is not sent to the sidebar', () => {
  const projects = build({
    projectPaths: ['/p'],
    rows: [
      row({ sessionId: 'parent', projectPath: '/p' }),
      row({ sessionId: 'kid', projectPath: '/p', parentSessionId: 'parent' }),
    ],
    meta: new Map([['parent', { sessionId: 'parent', archived: 1 }]]),
  });

  const project = projects.find(p => p.projectPath === '/p');
  // The project stays on the list — as an EMPTY row, not as a row full of orphans.
  assert.ok(project, 'the project must not disappear when its only session is archived');
  assert.deepEqual(project.sessions.map(s => s.sessionId), []);
});

test('#173: the parent is dropped even when its meta row cannot be resolved', () => {
  // The archived flag lives in session_meta, so a subagent used to survive whenever that
  // lookup came back empty. Here the parent is withheld for a different reason — its
  // project is hidden — and the meta map says nothing about it at all.
  const projects = build({
    projectPaths: ['/visible'], // '/hidden' is NOT on the register
    rows: [
      row({ sessionId: 'parent', projectPath: '/hidden' }),
      row({ sessionId: 'kid', projectPath: '/visible', parentSessionId: 'parent' }),
    ],
  });

  const project = projects.find(p => p.projectPath === '/visible');
  assert.ok(project);
  assert.deepEqual(project.sessions.map(s => s.sessionId), [],
    'a subagent must not outlive the parent it is nested under');
});

test('#173: a subagent whose parent the store does not know is still shown', () => {
  // Nothing is being withheld here — the parent transcript is simply not in the cache.
  // This is the genuine orphan the sidebar has an "Orphan subagents" section for.
  const projects = build({
    projectPaths: ['/p'],
    rows: [row({ sessionId: 'kid', projectPath: '/p', parentSessionId: 'ghost' })],
  });

  const project = projects.find(p => p.projectPath === '/p');
  assert.deepEqual(project.sessions.map(s => s.sessionId), ['kid']);
});

test('#173: a subagent with a shown parent is untouched', () => {
  const projects = build({
    projectPaths: ['/p'],
    rows: [
      row({ sessionId: 'parent', projectPath: '/p' }),
      row({ sessionId: 'kid', projectPath: '/p', parentSessionId: 'parent' }),
    ],
  });

  const project = projects.find(p => p.projectPath === '/p');
  assert.deepEqual(project.sessions.map(s => s.sessionId).sort(), ['kid', 'parent']);
});

test('#173: showArchived brings the archived parent AND its subagent back', () => {
  const projects = build({
    projectPaths: ['/p'],
    rows: [
      row({ sessionId: 'parent', projectPath: '/p' }),
      row({ sessionId: 'kid', projectPath: '/p', parentSessionId: 'parent' }),
    ],
    meta: new Map([['parent', { sessionId: 'parent', archived: 1 }]]),
    showArchived: true,
  });

  const project = projects.find(p => p.projectPath === '/p');
  assert.deepEqual(project.sessions.map(s => s.sessionId).sort(), ['kid', 'parent']);
});
