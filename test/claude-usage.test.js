const test = require('node:test');
const assert = require('node:assert/strict');

const { transformUsageResponse } = require('../src/backends/claude/usage');

test('claude usage: the credit pool survives a response with no windows', () => {
  const usage = transformUsageResponse({
    five_hour: null,
    extra_usage: {
      is_enabled: true,
      monthly_limit: 200000,
      used_credits: 176958,
      utilization: 88.479,
      currency: 'USD',
      disabled_reason: null,
    },
  });

  assert.equal(usage.backendId, 'claude');
  assert.equal(usage.live, true);
  assert.deepEqual(usage.buckets, []);
  assert.deepEqual(usage.quota, {
    percent: 88,
    used: 176958,
    limit: 200000,
    currency: 'USD',
    enabled: true,
    disabledReason: null,
  });
});

test('claude usage: windows become buckets, and only two of them belong in the bar', () => {
  const usage = transformUsageResponse({
    five_hour: { utilization: 42.7, resets_at: '2026-07-14T18:00:00Z' },
    seven_day: { utilization: 12.1 },
    seven_day_sonnet: { utilization: 9 },
    seven_day_opus: { utilization: 3 },
  });

  assert.deepEqual(usage.buckets.map(b => b.key), ['session', 'weekAll', 'weekSonnet', 'weekOpus']);
  // Floored, never rounded up: 42.7% used is not 43% used.
  assert.equal(usage.buckets[0].percent, 42);
  assert.equal(usage.buckets[0].tier, 'short');   // refills within hours
  assert.equal(usage.buckets[1].tier, 'long');    // refills over days
  // The bar shows two windows; Sonnet and Opus would make it four wide for no gain (Stats has them).
  assert.deepEqual(usage.buckets.filter(b => b.bar).map(b => b.key), ['session', 'weekAll']);
  assert.equal(usage.quota, null);
});

test('claude usage: a window the API omits produces no bucket at all', () => {
  // Not a 0% bucket. A missing window means "not reported", and a fabricated zero would read as
  // "you have used none of it" — the opposite of unknown.
  const usage = transformUsageResponse({ five_hour: { utilization: 5 } });
  assert.deepEqual(usage.buckets.map(b => b.key), ['session']);
});

test('claude usage: an empty response is a shape, not a crash', () => {
  const usage = transformUsageResponse(null);
  assert.deepEqual(usage, { backendId: 'claude', live: true, buckets: [], quota: null });
});
