'use strict';
// #229 — the core carries the backend's answer, and this is the step nothing else covers.
//
// The seam has three links: a backend answers `openedWithCommand`, `projects-view.js` stamps that answer
// onto the payload row, and the renderer borrows a name while the answer stands. The first and the third
// have tests of their own (`test/backend-parity.test.js`, `test/clear-continuation-title.test.js`) and both
// keep passing if the middle link is deleted — the renderer's tests build their rows by asking the
// descriptor directly, so the feature would be dead on screen with a green suite.
//
// So: run the real read path with a fake store and assert the field is there, per backend.

const test = require('node:test');
const assert = require('node:assert/strict');

const view = require('../src/index/projects-view');

const ALPHA = '/invented/demo-alpha';
const REGISTERED = { registered: true, registeredAt: '2026-01-01T00:00:00Z' };

function setup(rows) {
  view.init({
    PROJECTS_DIR: '/invented/nowhere',
    activeSessions: new Map(),
    db: {
      getAllMeta: () => new Map(),
      getAllCached: () => rows,
      getAllFolderMeta: () => new Map(),
      setFolderMeta: () => {},
      getFavoritedProjects: () => new Set(),
      getProjectDisplayNames: () => new Map(),
      getProjectStates: () => new Map([[ALPHA, REGISTERED]]),
    },
  });
}

const row = (sessionId, summary, backendId) => ({
  sessionId, projectPath: ALPHA, modified: '2026-06-01T00:00:00Z',
  summary, messageCount: 1, backendId,
});

function sessionsOf(projects) {
  const out = new Map();
  for (const p of projects) for (const s of p.sessions) out.set(s.sessionId, s);
  return out;
}

test('the payload carries the backend\'s answer about a session\'s opening command', () => {
  setup([
    row('claude-cleared', '/clear', 'claude'),
    row('claude-working', 'rewrite the parser', 'claude'),
    // A row written before the multi-LLM columns existed carries no backendId and IS Claude — it must be
    // routed to Claude's descriptor like any other, not skipped for want of an id.
    { sessionId: 'legacy-cleared', projectPath: ALPHA, modified: '2026-06-01T00:00:00Z', summary: '/clear', messageCount: 1 },
    // A backend that declines the question: its rows must carry null whatever their summary looks like.
    row('codex-lookalike', '/clear', 'codex'),
  ]);
  const sessions = sessionsOf(view.buildProjectsFromCache(false));

  assert.equal(sessions.get('claude-cleared').openedWithCommand, '/clear',
    'without this the renderer never learns the row has nothing of its own');
  assert.equal(sessions.get('legacy-cleared').openedWithCommand, '/clear');
  assert.equal(sessions.get('claude-working').openedWithCommand, null);
  assert.equal(sessions.get('codex-lookalike').openedWithCommand, null,
    'the answer is the backend\'s, never the core reading the string itself');
});

test('a backend that throws or answers oddly cannot take the sidebar down with it', () => {
  setup([
    row('unknown-backend', '/clear', 'not-a-backend-at-all'),
  ]);
  const sessions = sessionsOf(view.buildProjectsFromCache(false));
  assert.equal(sessions.get('unknown-backend').openedWithCommand, null);
});
