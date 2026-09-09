const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSuccessfulUsage,
  retrySecondsForUsage,
  buildCachedUsageValue,
  withMainProcessUsageCache,
  cachedUsageIsFresh,
  touchProbeAttempt,
  USAGE_GATE_MAX_AGE_MS,
} = require('../src/backends/usage-cache');

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

test('a cached reading preserves a backend-owned no-data reason', () => {
  const cachedValue = buildCachedUsageValue(reading(), '2026-06-16T10:00:00.000Z');
  const result = withMainProcessUsageCache({
    backendId: 'agy',
    _noData: true,
    message: 'This OAuth source does not expose AGY limits.',
  }, cachedValue);
  assert.equal(result.response._staleKind, 'no-data');
  assert.equal(result.response._staleMessage, 'This OAuth source does not expose AGY limits.');
});

// --- the probe gate ages out (#604) ------------------------------------------------------------

// `hasCachedUsage` is what stops a backend from starting a process of its own just to read a quota, and
// it used to be permanent: the key is persistent and nothing ever cleared it, so the first successful
// reading switched the probe off for the life of the installation.
test('a fresh stored reading still suppresses the probe; an old one does not', () => {
  const now = Date.UTC(2026, 5, 16, 12, 0, 0);
  const at = (msAgo) => buildCachedUsageValue(reading(), new Date(now - msAgo));

  assert.equal(cachedUsageIsFresh(at(0), now), true);
  assert.equal(cachedUsageIsFresh(at(USAGE_GATE_MAX_AGE_MS - 1000), now), true);
  assert.equal(cachedUsageIsFresh(at(USAGE_GATE_MAX_AGE_MS), now), false);
  assert.equal(cachedUsageIsFresh(at(3 * 24 * 60 * 60 * 1000), now), false);
});

// An entry that cannot say when it was taken answers NO. It costs one probe; the other way round it
// restores exactly the permanent lock-out this exists to end.
test('a cache entry with no usable stamp does not suppress the probe', () => {
  const now = Date.UTC(2026, 5, 16, 12, 0, 0);
  assert.equal(cachedUsageIsFresh(null, now), false);
  assert.equal(cachedUsageIsFresh({ usage: reading() }, now), false);
  assert.equal(cachedUsageIsFresh({ usage: reading(), fetchedAt: 'not a date' }, now), false);
  assert.equal(cachedUsageIsFresh({ usage: reading(), fetchedAt: '' }, now), false);
  // A stamp from the future is a clock that moved, not a fresh reading.
  assert.equal(cachedUsageIsFresh(buildCachedUsageValue(reading(), new Date(now + 60000)), now), false);
});

// A failed reading must not overwrite the good one, so `fetchedAt` does not move — and a gate reading
// only that stamp would stand open from the first failure onwards, bounded by nothing but the probe's own
// backoff. The ATTEMPT is stamped instead, and the gate reads whichever stamp is newer.
test('a failed probe is remembered as an attempt, without touching the reading', () => {
  const now = Date.UTC(2026, 5, 16, 12, 0, 0);
  const old = buildCachedUsageValue(reading(), new Date(now - 7 * 60 * 60 * 1000));
  assert.equal(cachedUsageIsFresh(old, now), false, 'seven hours: the gate is open');

  const touched = touchProbeAttempt(old, new Date(now));
  assert.deepEqual(touched.usage, old.usage, 'the last good figure is carried over untouched');
  assert.equal(touched.fetchedAt, old.fetchedAt, 'and so is when it was measured — this is not a reading');
  assert.equal(cachedUsageIsFresh(touched, now), true, 'but the attempt closes the gate for the window');
  assert.equal(cachedUsageIsFresh(touched, now + USAGE_GATE_MAX_AGE_MS), false, 'and it ages out like the other');
});

test('an install that has never had a reading has no attempt to stamp', () => {
  // It keeps today's behaviour: the probe's own backoff is the only thing bounding it, as #509 left it.
  assert.equal(touchProbeAttempt(null), null);
  assert.equal(touchProbeAttempt({ usage: { backendId: 'agy', _error: true } }), null);
  assert.equal(touchProbeAttempt({ usage: { backendId: 'agy', buckets: [], quota: null } }), null);
});
