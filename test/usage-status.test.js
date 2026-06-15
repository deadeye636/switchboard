const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatUsageStatus,
  getUsageRefreshDelayMs,
  withCachedUsageFallback,
} = require('../public/usage-status');

test('formatUsageStatus summarizes current usage buckets compactly', () => {
  const result = formatUsageStatus({
    session: 12,
    weekAll: 38,
    weekSonnet: 44,
    weekOpus: 4,
    sessionReset: '1pm (BST)',
  });

  assert.deepEqual(result, {
    text: 'Usage: 5h 12% · 7d 38% · Sonnet 44% · Opus 4%',
    title: 'Current 5-hour usage: 12% · resets 1pm (BST)',
    level: 'normal',
    percent: 44,
  });
});

test('formatUsageStatus marks high usage when any bucket is near the limit', () => {
  const result = formatUsageStatus({ session: 85, weekAll: 42 });

  assert.equal(result.level, 'high');
  assert.equal(result.text, 'Usage: 5h 85% · 7d 42%');
  assert.equal(result.percent, 85);
});

test('formatUsageStatus shows extra usage quota when rate-limit buckets are unavailable', () => {
  const result = formatUsageStatus({
    extraUsage: 88,
    extraUsageUsed: 176958,
    extraUsageLimit: 200000,
    extraUsageCurrency: 'USD',
  });

  assert.deepEqual(result, {
    text: 'Quota: $1,769.58 / $2,000.00 (88%)',
    title: 'Monthly extra usage quota: $1,769.58 used of $2,000.00',
    level: 'high',
    percent: 88,
  });
});

test('formatUsageStatus marks cached usage after an unavailable response', () => {
  const result = formatUsageStatus({
    extraUsage: 88,
    extraUsageUsed: 176958,
    extraUsageLimit: 200000,
    extraUsageCurrency: 'USD',
    _stale: true,
    _staleMessage: 'Could not fetch usage',
    _retryAfterSeconds: 300,
  });

  assert.equal(result.text, 'Quota: $1,769.58 / $2,000.00 (88%)');
  assert.equal(result.level, 'high');
  assert.match(result.title, /Using cached usage/);
  assert.match(result.title, /Retrying in ~5 mins/);
  assert.match(result.title, /Could not fetch usage/);
});

test('withCachedUsageFallback preserves last successful usage on unavailable response', () => {
  const cached = { session: 20, extraUsage: 40 };
  const result = withCachedUsageFallback({ _error: true, message: 'No token' }, cached);

  assert.equal(result.session, 20);
  assert.equal(result.extraUsage, 40);
  assert.equal(result._stale, true);
  assert.equal(result._staleMessage, 'No token');
});

test('formatUsageStatus returns useful rate-limit and error states', () => {
  assert.deepEqual(formatUsageStatus({ _rateLimited: true, retryAfterSeconds: 120 }), {
    text: 'Usage rate limited',
    title: 'Usage API rate limited. Try again in ~2 mins.',
    level: 'warning',
    percent: null,
  });

  assert.deepEqual(formatUsageStatus({ _error: true, message: 'No token' }), {
    text: 'Usage unavailable',
    title: 'No token',
    level: 'warning',
    percent: null,
  });
});

test('getUsageRefreshDelayMs respects usage API retry-after windows', () => {
  assert.equal(getUsageRefreshDelayMs({ _rateLimited: true, retryAfterSeconds: 120 }), 125000);
  assert.equal(getUsageRefreshDelayMs({ session: 12 }), 300000);
  assert.equal(getUsageRefreshDelayMs({ _error: true }), 300000);
});
