const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLEANUP_AGE_PRESETS,
  DEFAULT_CLEANUP_AGE_DAYS,
  ABANDONED_SHORT_DEFAULTS,
  getSpringCleaningCandidates,
  getAbandonedShortSessions,
  summarizeSpringCleaningSelection,
} = require('../public/session-cleanup');

const NOW = new Date('2026-06-15T12:00:00.000Z');

function projects(sessions) {
  return [{
    projectPath: '/repo/app',
    sessions,
  }];
}

test('spring cleaning defaults to 7 day old stopped unpinned sessions', () => {
  const result = getSpringCleaningCandidates(projects([
    { sessionId: 'old-safe', modified: '2026-06-07T11:59:00.000Z', summary: 'old safe' },
    { sessionId: 'recent', modified: '2026-06-12T12:00:00.000Z', summary: 'recent' },
    { sessionId: 'pinned', modified: '2026-06-01T12:00:00.000Z', summary: 'pinned', starred: 1 },
    { sessionId: 'archived', modified: '2026-06-01T12:00:00.000Z', summary: 'archived', archived: 1 },
    { sessionId: 'running', modified: '2026-06-01T12:00:00.000Z', summary: 'running' },
  ]), {
    now: NOW,
    activePtyIds: new Set(['running']),
  });

  assert.equal(DEFAULT_CLEANUP_AGE_DAYS, 7);
  assert.deepEqual(CLEANUP_AGE_PRESETS, [3, 7, 30]);
  assert.deepEqual(result.map(item => item.session.sessionId), ['old-safe']);
});

test('spring cleaning candidate age threshold is configurable', () => {
  const input = projects([
    { sessionId: 'four-days', modified: '2026-06-11T11:59:00.000Z', summary: 'four days' },
    { sessionId: 'ten-days', modified: '2026-06-05T12:00:00.000Z', summary: 'ten days' },
    { sessionId: 'forty-days', modified: '2026-05-06T12:00:00.000Z', summary: 'forty days' },
  ]);

  assert.deepEqual(
    getSpringCleaningCandidates(input, { now: NOW, ageDays: 3 }).map(item => item.session.sessionId),
    ['four-days', 'ten-days', 'forty-days'],
  );
  assert.deepEqual(
    getSpringCleaningCandidates(input, { now: NOW, ageDays: 7 }).map(item => item.session.sessionId),
    ['ten-days', 'forty-days'],
  );
  assert.deepEqual(
    getSpringCleaningCandidates(input, { now: NOW, ageDays: 30 }).map(item => item.session.sessionId),
    ['forty-days'],
  );
});

function abandonedSession(overrides = {}) {
  return {
    sessionId: 'abandoned',
    modified: '2026-06-01T12:00:00.000Z', // 14 days old
    summary: 'abandoned',
    messageCount: 6,
    userMessageCount: 1,
    cacheReadTokens: 1200,
    ...overrides,
  };
}

test('abandoned-short defaults are conservative named constants', () => {
  assert.deepEqual(ABANDONED_SHORT_DEFAULTS, {
    maxMessageCount: 50,
    maxUserMessageCount: 5,
    maxCacheReadTokens: 2_000_000,
    minInactiveDays: 2,
  });
});

test('abandoned-short flags a trivial, inactive session', () => {
  const result = getAbandonedShortSessions([abandonedSession()], { now: NOW });
  assert.deepEqual(result.map(item => item.session.sessionId), ['abandoned']);
  assert.equal(result[0].ageDays, 14);
});

test('abandoned-short excludes sessions over each usage threshold', () => {
  const sessions = [
    abandonedSession({ sessionId: 'too-many-messages', messageCount: 50 }),
    abandonedSession({ sessionId: 'too-many-turns', userMessageCount: 5 }),
    abandonedSession({ sessionId: 'too-much-cache', cacheReadTokens: 2_000_000 }),
  ];
  const result = getAbandonedShortSessions(sessions, { now: NOW });
  assert.deepEqual(result.map(item => item.session.sessionId), []);
});

test('abandoned-short keeps sessions just under each usage threshold', () => {
  const sessions = [
    abandonedSession({ sessionId: 'edge-messages', messageCount: 49 }),
    abandonedSession({ sessionId: 'edge-turns', userMessageCount: 4 }),
    abandonedSession({ sessionId: 'edge-cache', cacheReadTokens: 1_999_999 }),
  ];
  const result = getAbandonedShortSessions(sessions, { now: NOW });
  assert.deepEqual(
    result.map(item => item.session.sessionId).sort(),
    ['edge-cache', 'edge-messages', 'edge-turns'],
  );
});

test('abandoned-short excludes sessions active within the 2-day window', () => {
  const sessions = [
    abandonedSession({ sessionId: 'too-recent', modified: '2026-06-14T12:00:00.000Z' }), // 1 day old
    abandonedSession({ sessionId: 'just-inside', modified: '2026-06-13T11:00:00.000Z' }), // just over 2 days
  ];
  const result = getAbandonedShortSessions(sessions, { now: NOW });
  assert.deepEqual(result.map(item => item.session.sessionId), ['just-inside']);
});

test('abandoned-short surfaces a 3-6 day old tiny session (below the 7-day age list)', () => {
  const sessions = [
    abandonedSession({ sessionId: 'three-days', modified: '2026-06-12T12:00:00.000Z' }),
    abandonedSession({ sessionId: 'six-days', modified: '2026-06-09T12:00:00.000Z' }),
  ];
  const result = getAbandonedShortSessions(sessions, { now: NOW });
  assert.deepEqual(
    result.map(item => item.session.sessionId).sort(),
    ['six-days', 'three-days'],
  );
});

test('abandoned-short excludes starred, archived, terminal and running sessions', () => {
  const sessions = [
    abandonedSession({ sessionId: 'starred', starred: 1 }),
    abandonedSession({ sessionId: 'archived', archived: 1 }),
    abandonedSession({ sessionId: 'terminal', type: 'terminal' }),
    abandonedSession({ sessionId: 'running' }),
    abandonedSession({ sessionId: 'safe' }),
  ];
  const result = getAbandonedShortSessions(sessions, {
    now: NOW,
    activePtyIds: new Set(['running']),
  });
  assert.deepEqual(result.map(item => item.session.sessionId), ['safe']);
});

test('abandoned-short detects sessions shaped like buildProjectsFromCache output', () => {
  // Mirrors the real session shape produced by session-cache.js buildProjectsFromCache,
  // so a field-name drift in the selector vs. the data source can't silently regress.
  const realisticSession = {
    sessionId: 'cache-shaped',
    summary: 'quick question',
    firstPrompt: 'hello',
    created: '2026-05-30T09:00:00.000Z',
    modified: '2026-05-30T09:05:00.000Z',
    messageCount: 4,
    userMessageCount: 1,
    inputTokens: 320,
    outputTokens: 210,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    largestUserPromptWords: 12,
    startedAt: '2026-05-30T09:00:00.000Z',
    lastEntryAt: '2026-05-30T09:05:00.000Z',
    activeMinutes: 2,
    projectPath: '/repo/app',
    slug: null,
    aiTitle: null,
    name: null,
    starred: 0,
    archived: 0,
  };

  const result = getAbandonedShortSessions([realisticSession], { now: NOW });
  assert.deepEqual(result.map(item => item.session.sessionId), ['cache-shaped']);
});

test('abandoned-short flags a realistic tiny session with real cache-read volume', () => {
  // Real sampled session from the SQLite cache: a 5-message, 1-turn session that
  // sat untouched for days. Claude Code still read ~349k cache tokens for it, which
  // the original 50k bound wrongly excluded. With a realistic bound it qualifies.
  const realTiny = {
    sessionId: '95a4c33f',
    summary: 'quick check',
    projectPath: '/repo/app',
    created: '2026-06-10T08:00:00.000Z',
    modified: '2026-06-10T08:12:00.000Z', // ~5 days before NOW
    messageCount: 5,
    userMessageCount: 1,
    inputTokens: 4200,
    outputTokens: 1800,
    cacheCreationTokens: 12000,
    cacheReadTokens: 348868,
    largestUserPromptWords: 40,
    activeMinutes: 6,
    starred: 0,
    archived: 0,
  };
  const result = getAbandonedShortSessions([realTiny], { now: NOW });
  assert.deepEqual(result.map(item => item.session.sessionId), ['95a4c33f']);
});

test('abandoned-short excludes a heavy-cache session even with few messages', () => {
  const sessions = [abandonedSession({ sessionId: 'heavy', messageCount: 8, userMessageCount: 2, cacheReadTokens: 3_000_000 })];
  const result = getAbandonedShortSessions(sessions, { now: NOW });
  assert.deepEqual(result.map(item => item.session.sessionId), []);
});

test('abandoned-short does not flag sessions with unknown metrics', () => {
  const sessions = [
    // Old enough, but metric fields are absent — must NOT be treated as 0/abandoned.
    { sessionId: 'no-metrics', modified: '2026-06-01T12:00:00.000Z', summary: 'mystery' },
    { sessionId: 'null-metrics', modified: '2026-06-01T12:00:00.000Z', messageCount: null, userMessageCount: null, cacheReadTokens: null },
  ];
  const result = getAbandonedShortSessions(sessions, { now: NOW });
  assert.deepEqual(result.map(item => item.session.sessionId), []);
});

test('abandoned-short respects custom thresholds', () => {
  const sessions = [abandonedSession({ sessionId: 'busy', messageCount: 40, userMessageCount: 8, cacheReadTokens: 500_000 })];
  const result = getAbandonedShortSessions(sessions, {
    now: NOW,
    thresholds: { maxMessageCount: 100, maxUserMessageCount: 20, maxCacheReadTokens: 1_000_000, minInactiveDays: 3 },
  });
  assert.deepEqual(result.map(item => item.session.sessionId), ['busy']);
});

test('spring cleaning summary groups selected sessions by project', () => {
  const candidates = getSpringCleaningCandidates([
    {
      projectPath: '/repo/app',
      sessions: [
        { sessionId: 'a', modified: '2026-06-01T12:00:00.000Z', summary: 'A' },
      ],
    },
    {
      projectPath: '/repo/other',
      sessions: [
        { sessionId: 'b', modified: '2026-06-01T12:00:00.000Z', summary: 'B' },
        { sessionId: 'c', modified: '2026-06-01T12:00:00.000Z', summary: 'C' },
      ],
    },
  ], { now: NOW });

  assert.deepEqual(summarizeSpringCleaningSelection(candidates, new Set(['a', 'c'])), {
    selectedCount: 2,
    projectCount: 2,
  });
});
