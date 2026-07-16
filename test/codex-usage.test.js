const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { fetchUsage, transformRateLimits, lastRateLimitsIn } = require('../src/backends/codex/usage');

// The shape Codex actually writes, copied from a real rollout (docs/backend-formats.md).
const RATE_LIMITS = {
  limit_id: 'codex',
  limit_name: null,
  primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1784493536 },
  secondary: { used_percent: 3.0, window_minutes: 10080, resets_at: 1784993536 },
  credits: null,
  individual_limit: null,
  plan_type: 'team',
  rate_limit_reached_type: null,
};

function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-codex-usage-'));
}

function writeRollout(root, name, lines) {
  const dir = path.join(root, '2026', '07', '13');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const tokenCount = (rateLimits) => ({
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: {} }, rate_limits: rateLimits },
});

test('codex usage: both windows become buckets, tiered by how fast they refill', () => {
  const usage = transformRateLimits(RATE_LIMITS, '2026-07-13T08:00:00.000Z');

  assert.equal(usage.backendId, 'codex');
  assert.equal(usage.live, false);            // as of the last Codex turn, never "now"
  assert.equal(usage.observedAt, '2026-07-13T08:00:00.000Z');
  assert.deepEqual(usage.buckets.map(b => b.key), ['primary', 'secondary']);

  // The label is DERIVED from window_minutes — 300 → 5h, 10080 → 7d. Codex does not name its windows,
  // and the provider is free to change them, so nothing here may hardcode "5h"/"7d".
  assert.equal(usage.buckets[0].label, '5h');
  assert.equal(usage.buckets[0].tier, 'short');
  assert.equal(usage.buckets[1].label, '7d');
  assert.equal(usage.buckets[1].tier, 'long');
  assert.equal(usage.buckets[0].percent, 12);  // floored
  assert.equal(usage.planType, 'team');
});

test('codex usage: a null secondary window is absent, not zero', () => {
  const usage = transformRateLimits({ ...RATE_LIMITS, secondary: null });
  assert.deepEqual(usage.buckets.map(b => b.key), ['primary']);
});

test('codex usage: a credits pool lands in the same slot as Claude\'s', () => {
  const usage = transformRateLimits({ ...RATE_LIMITS, credits: { used_percent: 40.9, used: 20, limit: 50 } });
  assert.deepEqual(usage.quota, { percent: 40, used: 20, limit: 50, currency: 'USD' });
});

test('codex usage: the LAST rate_limits in a rollout wins', () => {
  const root = tmpStore();
  const file = writeRollout(root, 'rollout-2026-07-13T00-00-00-aaa.jsonl', [
    tokenCount({ ...RATE_LIMITS, primary: { used_percent: 1, window_minutes: 300, resets_at: 1784493536 } }),
    { type: 'response_item', payload: { type: 'message' } },
    tokenCount({ ...RATE_LIMITS, primary: { used_percent: 88, window_minutes: 300, resets_at: 1784493536 } }),
  ]);
  // A rollout emits token_count on every turn; only the last one is current.
  assert.equal(lastRateLimitsIn(file).primary.used_percent, 88);
  fs.rmSync(root, { recursive: true, force: true });
});

test('codex usage: reads the newest rollout, and skips one that never reported a limit', async () => {
  const root = tmpStore();
  const stale = writeRollout(root, 'rollout-2026-07-13T00-00-00-old.jsonl', [tokenCount(RATE_LIMITS)]);
  const newest = writeRollout(root, 'rollout-2026-07-13T09-00-00-new.jsonl', [
    { type: 'session_meta', payload: { cwd: '/tmp' } },   // a session that never got a reply
  ]);
  fs.utimesSync(stale, new Date('2026-07-13T08:00:00Z'), new Date('2026-07-13T08:00:00Z'));
  fs.utimesSync(newest, new Date('2026-07-13T09:00:00Z'), new Date('2026-07-13T09:00:00Z'));

  // The newest file has no rate_limits — fall through to the one that does, rather than reporting
  // "no data" while a perfectly good figure sits one file away.
  const usage = await fetchUsage(root);
  assert.equal(usage.buckets.length, 2);
  assert.equal(usage.observedAt, new Date('2026-07-13T08:00:00Z').toISOString());
  fs.rmSync(root, { recursive: true, force: true });
});

test('codex usage: installed but never run reports no data — never a fabricated 0%', async () => {
  const root = tmpStore();
  const usage = await fetchUsage(root);
  assert.equal(usage._noData, true);
  assert.deepEqual(usage.buckets, []);
  assert.equal(usage._error, undefined);   // "never run" is a state, not a failure
  fs.rmSync(root, { recursive: true, force: true });
});

test('codex usage: a missing store is no data, not a throw', async () => {
  const usage = await fetchUsage(path.join(os.tmpdir(), 'sb-codex-does-not-exist-191'));
  assert.equal(usage._noData, true);
});
