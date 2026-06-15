const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getWorktreeLabel,
  getSessionMetricLabels,
  getQuietDetailParts,
  getMetricTrafficLevel,
  getActivityTrafficLevel,
} = require('../public/session-card-details');

test('getWorktreeLabel extracts worktree names from Claude worktree paths', () => {
  assert.equal(
    getWorktreeLabel({
      projectPath: '/repo/.claude/worktrees/feature-session-cards',
    }),
    'Worktree feature-session-cards',
  );
  assert.equal(getWorktreeLabel({ projectPath: '/repo/app' }), '');
});

test('getSessionMetricLabels returns individual high-signal metric labels', () => {
  assert.deepEqual(
    getSessionMetricLabels({
      userMessageCount: 42,
      cacheReadTokens: 1_800_000,
      activeMinutes: 300,
    }),
    ['42 turns', '1.8M cache', '5h active'],
  );
});

test('getQuietDetailParts combines activity, messages, and metrics as quiet text parts', () => {
  assert.deepEqual(
    getQuietDetailParts({
      timeLabel: '2m ago',
      session: {
        messageCount: 15,
        userMessageCount: 42,
        cacheReadTokens: 1_800_000,
        activeMinutes: 300,
      },
      includeMetrics: true,
    }),
    ['2m ago', '15 msgs', '42 turns', '1.8M cache', '5h active'],
  );
  assert.deepEqual(getQuietDetailParts({ timeLabel: 'just now', session: {}, includeMetrics: false }), ['just now']);
});

test('getMetricTrafficLevel grades individual metrics independently', () => {
  assert.equal(getMetricTrafficLevel('userMessageCount', 10), 'green');
  assert.equal(getMetricTrafficLevel('userMessageCount', 24), 'amber');
  assert.equal(getMetricTrafficLevel('userMessageCount', 30), 'red');
  assert.equal(getMetricTrafficLevel('cacheReadTokens', 18_000_000), 'amber');
  assert.equal(getMetricTrafficLevel('activeMinutes', 240), 'red');
});

test('getActivityTrafficLevel grades last activity age', () => {
  const now = new Date('2026-06-15T10:00:00.000Z');

  assert.equal(getActivityTrafficLevel('2026-06-15T09:55:00.000Z', now), 'green');
  assert.equal(getActivityTrafficLevel('2026-06-15T09:00:00.000Z', now), 'amber');
  assert.equal(getActivityTrafficLevel('2026-06-15T06:00:00.000Z', now), 'red');
});

