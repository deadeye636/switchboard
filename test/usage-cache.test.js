const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSuccessfulUsage,
  retrySecondsForUsage,
  buildCachedUsageValue,
  withMainProcessUsageCache,
} = require('../usage-cache');

test('isSuccessfulUsage rejects errors and accepts real usage fields', () => {
  assert.equal(isSuccessfulUsage(null), false);
  assert.equal(isSuccessfulUsage({ _error: true }), false);
  assert.equal(isSuccessfulUsage({ _rateLimited: true }), false);
  assert.equal(isSuccessfulUsage({ extraUsage: 91 }), true);
});

test('withMainProcessUsageCache returns fresh usage and cache value on success', () => {
  const result = withMainProcessUsageCache({ extraUsage: 91 }, null);

  assert.deepEqual(result.response, { extraUsage: 91 });
  assert.deepEqual(result.cacheValue.usage, { extraUsage: 91 });
  assert.equal(result.fromCache, false);
});

test('withMainProcessUsageCache falls back to cached usage on errors', () => {
  const cachedValue = buildCachedUsageValue({ extraUsage: 90 }, '2026-06-16T10:00:00.000Z');
  const result = withMainProcessUsageCache({ _error: true, message: 'No token' }, cachedValue);

  assert.equal(result.response.extraUsage, 90);
  assert.equal(result.response._stale, true);
  assert.equal(result.response._staleMessage, 'No token');
  assert.equal(result.response._retryAfterSeconds, 300);
  assert.equal(result.response._cachedAt, '2026-06-16T10:00:00.000Z');
  assert.equal(result.cacheValue, null);
  assert.equal(result.fromCache, true);
});

test('withMainProcessUsageCache preserves retry-after for cached rate limits', () => {
  const cachedValue = buildCachedUsageValue({ extraUsage: 90 }, '2026-06-16T10:00:00.000Z');
  const result = withMainProcessUsageCache({ _rateLimited: true, retryAfterSeconds: 120 }, cachedValue);

  assert.equal(retrySecondsForUsage({ _rateLimited: true, retryAfterSeconds: 120 }), 125);
  assert.equal(result.response.extraUsage, 90);
  assert.equal(result.response._staleMessage, 'Usage API rate limited');
  assert.equal(result.response._retryAfterSeconds, 125);
});
