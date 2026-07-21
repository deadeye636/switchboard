const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { transformQuotaResponse, fetchUsage } = require('../src/backends/agy/usage');

// A reset well over a day out, so the tier is deterministic regardless of when the suite runs.
const farReset = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();

test('agy usage: each model bucket carries its used percent, reset and card label', () => {
  const usage = transformQuotaResponse({
    buckets: [
      { modelId: 'gemini-2.5-pro', tokenType: 'REQUESTS', remainingFraction: 0.25, resetTime: farReset },
      { modelId: 'gemini-2.5-flash-lite', tokenType: 'REQUESTS', remainingFraction: 1, resetTime: farReset },
    ],
  });

  assert.equal(usage.backendId, 'agy');
  assert.equal(usage.live, true);
  assert.equal(usage.quota, null);
  assert.deepEqual(usage.buckets.map(b => b.key), ['gemini-2.5-pro', 'gemini-2.5-flash-lite']);
  // remainingFraction 0.25 -> 75% used, floored.
  assert.equal(usage.buckets[0].percent, 75);
  assert.equal(usage.buckets[1].percent, 0);
  assert.equal(usage.buckets[0].label, '2.5 Pro');
  assert.equal(usage.buckets[0].cardLabel, 'Gemini 2.5 Pro');
  assert.ok(usage.buckets[0].reset, 'a reset string is formatted');
});

test('agy usage: exactly one bucket is flagged for the status bar — the model nearest its limit', () => {
  const usage = transformQuotaResponse({
    buckets: [
      { modelId: 'gemini-2.5-flash', tokenType: 'REQUESTS', remainingFraction: 0.9, resetTime: farReset },
      { modelId: 'gemini-2.5-pro', tokenType: 'REQUESTS', remainingFraction: 0.4, resetTime: farReset },
      { modelId: 'gemini-2.5-flash-lite', tokenType: 'REQUESTS', remainingFraction: 1, resetTime: farReset },
    ],
  });

  const barred = usage.buckets.filter(b => b.bar);
  assert.equal(barred.length, 1);
  assert.equal(barred[0].key, 'gemini-2.5-pro'); // 60% used, the highest
});

test('agy usage: on an all-fresh account the headline bar is the most capable model', () => {
  const usage = transformQuotaResponse({
    buckets: [
      { modelId: 'gemini-2.5-flash', tokenType: 'REQUESTS', remainingFraction: 1, resetTime: farReset },
      { modelId: 'gemini-2.5-pro', tokenType: 'REQUESTS', remainingFraction: 1, resetTime: farReset },
      { modelId: 'gemini-2.5-flash-lite', tokenType: 'REQUESTS', remainingFraction: 1, resetTime: farReset },
    ],
  });
  const barred = usage.buckets.filter(b => b.bar);
  assert.equal(barred.length, 1);
  assert.equal(barred[0].key, 'gemini-2.5-pro'); // tie on 0% used -> highest model rank
});

test('agy usage: a non-REQUESTS pool is tagged so it can\'t read as a request count', () => {
  const usage = transformQuotaResponse({
    buckets: [{ modelId: 'gemini-2.5-pro', tokenType: 'TOKENS', remainingFraction: 0.5, resetTime: farReset }],
  });
  assert.equal(usage.buckets[0].label, '2.5 Pro (tokens)');
  assert.equal(usage.buckets[0].cardLabel, 'Gemini 2.5 Pro (tokens)');
});

test('agy usage: a bucket with no remaining fraction is dropped, not shown as 100% used', () => {
  // undefined, null and '' must ALL drop — Number(null)/Number('') are 0, which would paint the model
  // as fully exhausted (100%, red) from an unmetered pool this undocumented API might report as null.
  const usage = transformQuotaResponse({
    buckets: [
      { modelId: 'gemini-2.5-pro', tokenType: 'REQUESTS', resetTime: farReset },                    // undefined
      { modelId: 'gemini-2.5-flash-lite', tokenType: 'REQUESTS', remainingFraction: null, resetTime: farReset },
      { modelId: 'gemini-3.1-flash-lite', tokenType: 'REQUESTS', remainingFraction: '', resetTime: farReset },
      { modelId: 'gemini-2.5-flash', tokenType: 'REQUESTS', remainingFraction: 0.5, resetTime: farReset },
    ],
  });
  assert.deepEqual(usage.buckets.map(b => b.key), ['gemini-2.5-flash']);
});

test('agy usage: an empty or shapeless response is a shape, not a crash', () => {
  assert.deepEqual(transformQuotaResponse(null), { backendId: 'agy', live: true, buckets: [], quota: null });
  assert.deepEqual(transformQuotaResponse({}), { backendId: 'agy', live: true, buckets: [], quota: null });
});

test('agy usage: not signed in (no creds file) is a rendered _error, never a throw', async () => {
  // Point the creds resolver at a file that does not exist — readCreds returns null, no network is
  // touched, and fetchUsage must return a renderable error state instead of throwing.
  const prev = process.env.SWITCHBOARD_AGY_CREDS;
  process.env.SWITCHBOARD_AGY_CREDS = path.join(os.tmpdir(), `agy-no-creds-${process.pid}.json`);
  try {
    const usage = await fetchUsage();
    assert.equal(usage.backendId, 'agy');
    assert.equal(usage.live, true);
    assert.equal(usage._error, true);
    assert.ok(usage.message, 'carries a message the status bar can show');
  } finally {
    if (prev === undefined) delete process.env.SWITCHBOARD_AGY_CREDS;
    else process.env.SWITCHBOARD_AGY_CREDS = prev;
  }
});
