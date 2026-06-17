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
    maxMessageCount: 15,
    maxUserMessageCount: 3,
    maxCacheReadTokens: 50_000,
    minInactiveDays: 7,
  });
});

test('abandoned-short flags a trivial, inactive session', () => {
  const result = getAbandonedShortSessions([abandonedSession()], { now: NOW });
  assert.deepEqual(result.map(item => item.session.sessionId), ['abandoned']);
  assert.equal(result[0].ageDays, 14);
});

test('abandoned-short excludes sessions over each usage threshold', () => {
  const sessions = [
    abandonedSession({ sessionId: 'too-many-messages', messageCount: 15 }),
    abandonedSession({ sessionId: 'too-many-turns', userMessageCount: 3 }),
    abandonedSession({ sessionId: 'too-much-cache', cacheReadTokens: 50_000 }),
  ];
  const result = getAbandonedShortSessions(sessions, { now: NOW });
  assert.deepEqual(result.map(item => item.session.sessionId), []);
});

test('abandoned-short keeps sessions just under each usage threshold', () => {
  const sessions = [
    abandonedSession({ sessionId: 'edge-messages', messageCount: 14 }),
    abandonedSession({ sessionId: 'edge-turns', userMessageCount: 2 }),
    abandonedSession({ sessionId: 'edge-cache', cacheReadTokens: 49_999 }),
  ];
  const result = getAbandonedShortSessions(sessions, { now: NOW });
  assert.deepEqual(
    result.map(item => item.session.sessionId).sort(),
    ['edge-cache', 'edge-messages', 'edge-turns'],
  );
});

test('abandoned-short excludes recently active sessions', () => {
  const sessions = [
    abandonedSession({ sessionId: 'recent', modified: '2026-06-12T12:00:00.000Z' }),
    abandonedSession({ sessionId: 'just-inside', modified: '2026-06-08T11:00:00.000Z' }),
  ];
  const result = getAbandonedShortSessions(sessions, { now: NOW });
  assert.deepEqual(result.map(item => item.session.sessionId), ['just-inside']);
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
