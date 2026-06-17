const test = require('node:test');
const assert = require('node:assert/strict');

const { bulkTargets } = require('../public/bulk-actions');

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

const SESSIONS = [
  { sessionId: 'attention', modified: '2026-06-12T08:00:00.000Z' },
  { sessionId: 'ready', modified: '2026-06-12T09:00:00.000Z' },
  { sessionId: 'busy', modified: '2026-06-12T10:00:00.000Z' },
  { sessionId: 'running', modified: '2026-06-12T11:00:00.000Z' },
  { sessionId: 'idle', modified: '2026-06-12T12:00:00.000Z' },
];

function fullRuntime() {
  return state({
    attentionSessions: new Set(['attention']),
    responseReadySessions: new Set(['ready']),
    activePtyIds: new Set(['busy', 'running']),
    sessionBusyState: new Map([['busy', true]]),
  });
}

test('readyToClear only includes response-ready sessions in the active filter', () => {
  const runtime = fullRuntime();

  assert.deepEqual(bulkTargets(SESSIONS, runtime, 'all').readyToClear, ['ready']);
  // The "ready" filter still surfaces exactly the response-ready session.
  assert.deepEqual(bulkTargets(SESSIONS, runtime, 'ready').readyToClear, ['ready']);
  // A filter that excludes response-ready sessions yields nothing to clear.
  assert.deepEqual(bulkTargets(SESSIONS, runtime, 'active').readyToClear, []);
});

test('runningToStop only includes busy/running sessions in the active filter', () => {
  const runtime = fullRuntime();

  assert.deepEqual(bulkTargets(SESSIONS, runtime, 'all').runningToStop, ['busy', 'running']);
  assert.deepEqual(bulkTargets(SESSIONS, runtime, 'active').runningToStop, ['busy', 'running']);
  // The attention filter excludes both busy and running sessions.
  assert.deepEqual(bulkTargets(SESSIONS, runtime, 'attention').runningToStop, []);
});

test('queue ordering matches getAttentionInboxItems priority (attention before ready)', () => {
  const runtime = fullRuntime();

  // busy/running are not part of the step-through queue; attention outranks ready.
  assert.deepEqual(bulkTargets(SESSIONS, runtime, 'all').queue, ['attention', 'ready']);
});

test('queue orders multiple attention sessions by most recent activity', () => {
  const sessions = [
    { sessionId: 'attn-old', modified: '2026-06-12T08:00:00.000Z' },
    { sessionId: 'attn-new', modified: '2026-06-12T10:00:00.000Z' },
    { sessionId: 'ready', modified: '2026-06-12T11:00:00.000Z' },
  ];
  const runtime = state({
    attentionSessions: new Set(['attn-old', 'attn-new']),
    responseReadySessions: new Set(['ready']),
  });

  assert.deepEqual(bulkTargets(sessions, runtime, 'all').queue, ['attn-new', 'attn-old', 'ready']);
});

test('all target sets are empty when the filter excludes everything', () => {
  // Only idle sessions present, but filtering for attention yields nothing.
  const idleOnly = [
    { sessionId: 'idle-a', modified: '2026-06-12T08:00:00.000Z' },
    { sessionId: 'idle-b', modified: '2026-06-12T09:00:00.000Z' },
  ];
  const result = bulkTargets(idleOnly, state(), 'attention');

  assert.deepEqual(result, { readyToClear: [], runningToStop: [], queue: [] });
});

test('handles missing/empty session input safely', () => {
  assert.deepEqual(bulkTargets([], state(), 'all'), { readyToClear: [], runningToStop: [], queue: [] });
  assert.deepEqual(bulkTargets(undefined, state(), 'all'), { readyToClear: [], runningToStop: [], queue: [] });
});
