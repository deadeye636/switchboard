const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSuccessfulUsage,
  retrySecondsForUsage,
  buildCachedUsageValue,
  withMainProcessUsageCache,
} = require('../usage-cache');

// A reading now arrives with backendId / label / live stamped on it by the collector (#191). "Successful"
// therefore has to mean "it measured something" — a bucket or a quota — and not "some key is set", or an
// error response would be cached straight over the last good one.
const reading = (extra = {}) => ({
  backendId: 'claude',
  label: 'Claude Code',
  live: true,
  buckets: [{ key: 'session', label: '5h', percent: 42, tier: 'short', bar: true }],
  quota: null,
  ...extra,
});

test('a reading is successful only when it actually measured something', () => {
  assert.equal(isSuccessfulUsage(null), false);
  assert.equal(isSuccessfulUsage(reading({ _error: true })), false);
  assert.equal(isSuccessfulUsage(reading({ _rateLimited: true })), false);
  assert.equal(isSuccessfulUsage(reading()), true);
  // Buckets AND quota empty: identity fields alone are not a measurement. This is the case the old
  // "does any non-underscore key have a value" test got wrong — it would have called this successful.
  assert.equal(isSuccessfulUsage({ backendId: 'codex', label: 'Codex', live: false, buckets: [], quota: null }), false);
  // A credit pool with no windows is still a measurement.
  assert.equal(isSuccessfulUsage({ backendId: 'claude', buckets: [], quota: { percent: 88 } }), true);
});

test('a fresh reading is returned as-is and cached', () => {
  const result = withMainProcessUsageCache(reading(), null);

  assert.deepEqual(result.response, reading());
  assert.deepEqual(result.cacheValue.usage, reading());
  assert.equal(result.fromCache, false);
});

test('a failed poll serves the last good reading, marked stale', () => {
  const cachedValue = buildCachedUsageValue(reading(), '2026-06-16T10:00:00.000Z');
  const result = withMainProcessUsageCache({ backendId: 'claude', _error: true, message: 'No token' }, cachedValue);

  assert.equal(result.response.buckets[0].percent, 42);
  assert.equal(result.response._stale, true);
  assert.equal(result.response._staleMessage, 'No token');
  assert.equal(result.response._retryAfterSeconds, 300);
  assert.equal(result.response._cachedAt, '2026-06-16T10:00:00.000Z');
  assert.equal(result.cacheValue, null);          // a failure never overwrites the good reading
  assert.equal(result.fromCache, true);
});

test('a rate limit keeps the server\'s retry-after', () => {
  const cachedValue = buildCachedUsageValue(reading(), '2026-06-16T10:00:00.000Z');
  const result = withMainProcessUsageCache({ backendId: 'claude', _rateLimited: true, retryAfterSeconds: 120 }, cachedValue);

  assert.equal(retrySecondsForUsage({ _rateLimited: true, retryAfterSeconds: 120 }), 125);
  assert.equal(result.response.buckets[0].percent, 42);
  assert.equal(result.response._staleMessage, 'Usage API rate limited');
  assert.equal(result.response._retryAfterSeconds, 125);
});

test('a cached body can never claim to be another backend', () => {
  // The cache is keyed per backend, but the response is assembled from a stored body — so the identity of
  // the LIVE call wins. A Codex poll must not come back wearing Claude's name because of a stale entry.
  const cachedValue = buildCachedUsageValue(reading(), '2026-06-16T10:00:00.000Z');
  const result = withMainProcessUsageCache({ backendId: 'codex', _error: true, message: 'boom' }, cachedValue);
  assert.equal(result.response.backendId, 'codex');
});

test('a backend that has never reported a limit is passed through, not dressed up as an error', () => {
  const noData = { backendId: 'codex', live: false, buckets: [], quota: null, _noData: true };
  const result = withMainProcessUsageCache(noData, null);
  assert.equal(result.response._noData, true);
  assert.equal(result.response._error, undefined);
  assert.equal(result.cacheValue, null);
});
