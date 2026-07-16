const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getSessionStatus,
  getAttentionInboxItems,
  getNextAttentionInboxItem,
  getStatusCounts,
  getFilteredSessionsByStatus,
  getGridAutoOpenSessionIds,
} = require('../src/renderer/session/session-status');

function state(overrides = {}) {
  return {
    activePtyIds: new Set(),
    attentionSessions: new Set(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map(),
    openSessions: new Map(),
    lastActivityTime: new Map(),
    activeSessionId: null,
    ...overrides,
  };
}

test('session status prioritizes needs-attention over other states', () => {
  const session = { sessionId: 's1', modified: '2026-06-12T10:00:00.000Z' };
  const result = getSessionStatus(session, state({
    activePtyIds: new Set(['s1']),
    attentionSessions: new Set(['s1']),
    responseReadySessions: new Set(['s1']),
    sessionBusyState: new Map([['s1', true]]),
  }));

  assert.equal(result.key, 'needs-attention');
  assert.equal(result.label, 'Needs You');
  assert.equal(result.priority, 100);
  assert.equal(result.inInbox, true);
});

test('session status reports unread ready output before running and idle', () => {
  const session = { sessionId: 's1', modified: '2026-06-12T10:00:00.000Z' };
  const result = getSessionStatus(session, state({
    activePtyIds: new Set(['s1']),
    responseReadySessions: new Set(['s1']),
  }));

  assert.equal(result.key, 'response-ready');
  assert.equal(result.label, 'Ready');
  assert.equal(result.priority, 90);
  assert.equal(result.inInbox, true);
});

test('session status distinguishes busy, running, exited, and idle', () => {
  const busy = { sessionId: 'busy', modified: '2026-06-12T10:00:00.000Z' };
  const running = { sessionId: 'running', modified: '2026-06-12T10:00:00.000Z' };
  const exited = { sessionId: 'exited', modified: '2026-06-12T10:00:00.000Z' };
  const idle = { sessionId: 'idle', modified: '2026-06-12T10:00:00.000Z' };
  const runtime = state({
    activePtyIds: new Set(['busy', 'running']),
    sessionBusyState: new Map([['busy', true]]),
    openSessions: new Map([['exited', { closed: true }]]),
  });

  assert.equal(getSessionStatus(busy, runtime).key, 'busy');
  assert.equal(getSessionStatus(running, runtime).key, 'running');
  assert.equal(getSessionStatus(exited, runtime).key, 'exited');
  assert.equal(getSessionStatus(idle, runtime).key, 'idle');
});

test('subagent activity does not change the parent status (#112 overlay)', () => {
  // Subagent work is an overlay (a two-color dot), never a status of its own:
  // with async subagents the parent keeps generating, so it stays "busy".
  const s = { sessionId: 'p', modified: '2026-06-12T10:00:00.000Z' };
  const runtime = state({
    activePtyIds: new Set(['p']),
    sessionBusyState: new Map([['p', true]]),
    subagentActiveSessions: new Set(['p']),
  });
  assert.equal(getSessionStatus(s, runtime).key, 'busy');
});

test('attention inbox orders human-critical sessions first then recent activity', () => {
  const sessions = [
    { sessionId: 'running-old', modified: '2026-06-12T09:00:00.000Z', summary: 'old run' },
    { sessionId: 'ready', modified: '2026-06-12T10:00:00.000Z', summary: 'ready' },
    { sessionId: 'attention', modified: '2026-06-12T08:00:00.000Z', summary: 'blocked' },
    { sessionId: 'idle', modified: '2026-06-12T11:00:00.000Z', summary: 'idle' },
  ];
  const result = getAttentionInboxItems(sessions, state({
    activePtyIds: new Set(['running-old']),
    responseReadySessions: new Set(['ready']),
    attentionSessions: new Set(['attention']),
  }));

  assert.deepEqual(result.map(item => item.session.sessionId), ['attention', 'ready', 'running-old']);
});

// --- running-in-inbox modes (configurable) ---
const runSession = { sessionId: 'run', modified: '2026-06-12T10:00:00.000Z' };
function runInbox(overrides) {
  return getAttentionInboxItems([runSession], state({ activePtyIds: new Set(['run']), ...overrides }))
    .map(item => item.session.sessionId);
}

test('running-in-inbox: default/unspecified mode keeps the historical always-on behavior', () => {
  assert.deepEqual(runInbox({}), ['run']);
});

test('running-in-inbox: always shows running regardless of finish stamp', () => {
  assert.deepEqual(runInbox({ runningInboxMode: 'always' }), ['run']);
});

test('running-in-inbox: never hides running entirely', () => {
  assert.deepEqual(runInbox({ runningInboxMode: 'never', finishedAt: new Map([['run', 1000]]), now: 1000 }), []);
});

test('running-in-inbox: until-read needs a finish stamp', () => {
  assert.deepEqual(runInbox({ runningInboxMode: 'until-read' }), [], 'no stamp ⇒ never-worked session stays out');
  assert.deepEqual(runInbox({ runningInboxMode: 'until-read', finishedAt: new Map([['run', 1000]]) }), ['run']);
});

test('running-in-inbox: after-finish surfaces within the window and drops past it', () => {
  const finishedAt = new Map([['run', 1000]]);
  assert.deepEqual(
    runInbox({ runningInboxMode: 'after-finish', runningInboxMinutes: 5, finishedAt, now: 1000 + 2 * 60000 }),
    ['run'], 'within 5 min ⇒ shown');
  assert.deepEqual(
    runInbox({ runningInboxMode: 'after-finish', runningInboxMinutes: 5, finishedAt, now: 1000 + 6 * 60000 }),
    [], 'past 5 min ⇒ hidden');
  assert.deepEqual(
    runInbox({ runningInboxMode: 'after-finish', runningInboxMinutes: 5, now: 1000 }),
    [], 'no stamp ⇒ hidden');
});

test('running-in-inbox: timed uses the same window as after-finish (open-clearing is renderer-side)', () => {
  const finishedAt = new Map([['run', 1000]]);
  assert.deepEqual(
    runInbox({ runningInboxMode: 'timed', runningInboxMinutes: 5, finishedAt, now: 1000 + 2 * 60000 }),
    ['run'], 'within window ⇒ shown');
  assert.deepEqual(
    runInbox({ runningInboxMode: 'timed', runningInboxMinutes: 5, finishedAt, now: 1000 + 6 * 60000 }),
    [], 'past window ⇒ hidden');
  assert.deepEqual(
    runInbox({ runningInboxMode: 'timed', runningInboxMinutes: 5, now: 1000 }),
    [], 'no stamp ⇒ hidden');
});

test('next attention inbox item cycles after the current session', () => {
  const sessions = [
    { sessionId: 'running-old', modified: '2026-06-12T09:00:00.000Z', summary: 'old run' },
    { sessionId: 'ready', modified: '2026-06-12T10:00:00.000Z', summary: 'ready' },
    { sessionId: 'attention', modified: '2026-06-12T08:00:00.000Z', summary: 'blocked' },
  ];
  const runtime = state({
    activePtyIds: new Set(['running-old']),
    responseReadySessions: new Set(['ready']),
    attentionSessions: new Set(['attention']),
  });

  assert.equal(getNextAttentionInboxItem(sessions, runtime, null).session.sessionId, 'attention');
  assert.equal(getNextAttentionInboxItem(sessions, runtime, 'attention').session.sessionId, 'ready');
  assert.equal(getNextAttentionInboxItem(sessions, runtime, 'running-old').session.sessionId, 'attention');
});

test('next attention inbox item returns null when inbox is empty', () => {
  const sessions = [
    { sessionId: 'idle', modified: '2026-06-12T09:00:00.000Z', summary: 'idle' },
  ];

  assert.equal(getNextAttentionInboxItem(sessions, state(), 'idle'), null);
});

test('status counts group busy and running sessions under active', () => {
  const sessions = [
    { sessionId: 'attention', modified: '2026-06-12T08:00:00.000Z' },
    { sessionId: 'ready', modified: '2026-06-12T09:00:00.000Z' },
    { sessionId: 'busy', modified: '2026-06-12T10:00:00.000Z' },
    { sessionId: 'running', modified: '2026-06-12T11:00:00.000Z' },
    { sessionId: 'idle', modified: '2026-06-12T12:00:00.000Z' },
  ];
  const counts = getStatusCounts(sessions, state({
    attentionSessions: new Set(['attention']),
    responseReadySessions: new Set(['ready']),
    activePtyIds: new Set(['busy', 'running']),
    sessionBusyState: new Map([['busy', true]]),
  }));

  assert.deepEqual(counts, {
    all: 5,
    attention: 1,
    ready: 1,
    active: 2,
  });
});

test('status filters return sessions matching the requested grid mode', () => {
  const sessions = [
    { sessionId: 'attention', modified: '2026-06-12T08:00:00.000Z' },
    { sessionId: 'ready', modified: '2026-06-12T09:00:00.000Z' },
    { sessionId: 'busy', modified: '2026-06-12T10:00:00.000Z' },
    { sessionId: 'running', modified: '2026-06-12T11:00:00.000Z' },
    { sessionId: 'idle', modified: '2026-06-12T12:00:00.000Z' },
  ];
  const runtime = state({
    attentionSessions: new Set(['attention']),
    responseReadySessions: new Set(['ready']),
    activePtyIds: new Set(['busy', 'running']),
    sessionBusyState: new Map([['busy', true]]),
  });

  assert.deepEqual(getFilteredSessionsByStatus(sessions, runtime, 'all').map(s => s.sessionId), ['attention', 'ready', 'busy', 'running', 'idle']);
  assert.deepEqual(getFilteredSessionsByStatus(sessions, runtime, 'attention').map(s => s.sessionId), ['attention']);
  assert.deepEqual(getFilteredSessionsByStatus(sessions, runtime, 'ready').map(s => s.sessionId), ['ready']);
  assert.deepEqual(getFilteredSessionsByStatus(sessions, runtime, 'active').map(s => s.sessionId), ['busy', 'running']);
});

test('grid auto-open targets every live PTY that is not already open', () => {
  const runtime = state({
    activePtyIds: new Set(['a', 'b', 'c']),
    openSessions: new Map([
      ['a', { closed: false }],   // already open → skip
      ['c', { closed: true }],    // closed entry → re-open
    ]),
  });

  assert.deepEqual(getGridAutoOpenSessionIds(runtime), ['b', 'c']);
});

test('grid auto-open never surfaces idle/stopped sessions (no live PTY = nothing to open)', () => {
  const runtime = state({
    activePtyIds: new Set(),
    openSessions: new Map([['idle', { closed: false }]]),
  });

  assert.deepEqual(getGridAutoOpenSessionIds(runtime), []);
});

test('grid auto-open opens all running sessions when none are mounted yet', () => {
  const runtime = state({ activePtyIds: new Set(['x', 'y']) });
  assert.deepEqual(getGridAutoOpenSessionIds(runtime), ['x', 'y']);
});

test('grid auto-open tolerates a missing runtime', () => {
  assert.deepEqual(getGridAutoOpenSessionIds(), []);
  assert.deepEqual(getGridAutoOpenSessionIds({}), []);
});
