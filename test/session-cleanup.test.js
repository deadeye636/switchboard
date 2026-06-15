const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLEANUP_AGE_PRESETS,
  DEFAULT_CLEANUP_AGE_DAYS,
  getSpringCleaningCandidates,
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
