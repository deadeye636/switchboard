const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { fetchUsage, transformRateLimits, lastRateLimitsIn } = require('../src/backends/codex/usage');
const { withMainProcessUsageCache } = require('../src/backends/usage-cache');

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

// --- #494: the block a session ENDS with is a reason, not a reading -------------------------------

// Measured on a real store the moment the account ran out. No window, no pool, and the one fact worth
// having: `rate_limit_reached_type`.
const DEPLETED = {
  limit_id: 'premium',
  limit_name: null,
  primary: null,
  secondary: null,
  credits: { has_credits: false, unlimited: false, balance: null },
  individual_limit: null,
  spend_control_reached: null,
  plan_type: 'team',
  rate_limit_reached_type: 'workspace_member_credits_depleted',
};

test('codex usage: the last block with WINDOWS wins over the empty one a session ends with', () => {
  const root = tmpStore();
  const file = writeRollout(root, 'rollout-2026-07-13T00-00-00-end.jsonl', [
    tokenCount({ ...RATE_LIMITS, primary: { used_percent: 69, window_minutes: 300, resets_at: 1784493536 } }),
    tokenCount(DEPLETED),
  ]);
  // The literal last block measures nothing. Taking it threw away the reading two lines above it.
  assert.equal(lastRateLimitsIn(file).primary.used_percent, 69);
  fs.rmSync(root, { recursive: true, force: true });
});

test('codex usage: a reading and a reason are BOTH reported', async () => {
  const root = tmpStore();
  writeRollout(root, 'rollout-2026-07-13T00-00-00-both.jsonl', [
    tokenCount(RATE_LIMITS),
    tokenCount(DEPLETED),
  ]);

  const usage = await fetchUsage(root);
  // The windows are current, so they are shown — flagging this `_rateLimited` would send it to the
  // stale-cache fallback and replace a fresh reading with an older one.
  assert.equal(usage.buckets.length, 2);
  assert.equal(usage._rateLimited, undefined);
  assert.equal(usage.limitReached, 'workspace_member_credits_depleted');
  assert.equal(usage.limitReachedMessage, 'Your workspace credits are used up.');
  fs.rmSync(root, { recursive: true, force: true });
});

test('codex usage: a reason with no reading anywhere is rate-limited, not "no data yet"', async () => {
  const root = tmpStore();
  writeRollout(root, 'rollout-2026-07-13T00-00-00-a.jsonl', [tokenCount(DEPLETED)]);
  writeRollout(root, 'rollout-2026-07-13T00-00-01-b.jsonl', [tokenCount(DEPLETED)]);

  const usage = await fetchUsage(root);
  assert.equal(usage._rateLimited, true);
  assert.equal(usage._noData, undefined);   // Codex said WHY; "no data yet" would throw that away
  assert.equal(usage.message, 'Your workspace credits are used up.');
  assert.deepEqual(usage.buckets, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('codex usage: an unmeasured reached-type is de-snaked, never invented', () => {
  const { reachedMessage } = require('../src/backends/codex/usage');
  assert.equal(reachedMessage('some_new_code'), 'Codex reported a limit was reached (some new code).');
  assert.equal(reachedMessage(null), null);
});

test('codex usage: the current credits shape does not fake a quota', () => {
  // `{has_credits, unlimited, balance}` carries no denominator, so there is no percentage to draw.
  assert.equal(transformRateLimits({ ...RATE_LIMITS, credits: { has_credits: false, unlimited: false, balance: null } }).quota, null);
  assert.equal(transformRateLimits({ ...RATE_LIMITS, credits: { has_credits: true, unlimited: true, balance: null } }).quota, null);
  // A balance is not a percentage: it says what is LEFT, of a total Codex does not report. Inventing the
  // denominator would draw a bar from a number nobody has captured.
  assert.equal(transformRateLimits({ ...RATE_LIMITS, credits: { has_credits: true, unlimited: false, balance: 30 } }).quota, null);
  // The older shape, which does carry one, still reads.
  assert.deepEqual(
    transformRateLimits({ ...RATE_LIMITS, credits: { used_percent: 40.9, used: 20, limit: 50 } }).quota,
    { percent: 40, used: 20, limit: 50, currency: 'USD' },
  );
});

test('codex usage: the scan window survives a burst of sessions that never reported', async () => {
  const root = tmpStore();
  const reading = writeRollout(root, 'rollout-2026-07-13T00-00-00-good.jsonl', [tokenCount(RATE_LIMITS)]);
  fs.utimesSync(reading, new Date('2026-07-13T08:00:00Z'), new Date('2026-07-13T08:00:00Z'));
  // Seven newer sessions that never got a reply — more than the five slots this used to have.
  for (let i = 0; i < 7; i++) {
    const empty = writeRollout(root, `rollout-2026-07-13T09-00-0${i}-empty.jsonl`, [
      { type: 'session_meta', payload: { cwd: '/tmp' } },
    ]);
    fs.utimesSync(empty, new Date('2026-07-13T09:00:00Z'), new Date('2026-07-13T09:00:00Z'));
  }

  const usage = await fetchUsage(root);
  assert.equal(usage.buckets.length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('codex usage: the reading is found past the tail of a very large rollout', async () => {
  const root = tmpStore();
  // The reading sits at the top, then a megabyte of noise — further from the end than the tail read
  // covers, so the full-file fallback is the only thing that can find it.
  const filler = Array.from({ length: 4000 }, (_, i) => ({
    type: 'response_item', payload: { type: 'message', text: 'x'.repeat(300), n: i },
  }));
  writeRollout(root, 'rollout-2026-07-13T00-00-00-big.jsonl', [tokenCount(RATE_LIMITS), ...filler]);

  const usage = await fetchUsage(root);
  assert.equal(usage.buckets.length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('codex usage: an unchanged rollout is not read twice', async () => {
  const root = tmpStore();
  writeRollout(root, 'rollout-2026-07-13T00-00-00-memo.jsonl', [tokenCount(RATE_LIMITS)]);

  const realReadFileSync = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (...args) => {
    if (String(args[0]).includes('rollout-')) reads++;
    return realReadFileSync(...args);
  };
  try {
    await fetchUsage(root);
    const afterFirst = reads;
    await fetchUsage(root);   // polled again a minute later, nothing has changed
    assert.ok(afterFirst > 0, 'the first poll has to read the file');
    assert.equal(reads, afterFirst, 'the second poll must answer from the memo');
  } finally {
    fs.readFileSync = realReadFileSync;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('codex usage: a cached reading says WHY it is cached, and "no data" is not a failure', () => {
  const good = { backendId: 'codex', buckets: [{ key: 'primary', percent: 12 }], quota: null };
  const cached = { usage: good, fetchedAt: '2026-07-13T08:00:00.000Z' };

  const noData = withMainProcessUsageCache({ backendId: 'codex', buckets: [], _noData: true }, cached);
  assert.equal(noData.fromCache, true);
  assert.equal(noData.response._staleKind, 'no-data');
  assert.equal(noData.response._staleMessage, 'No newer limit reported yet');

  const limited = withMainProcessUsageCache(
    { backendId: 'codex', buckets: [], _rateLimited: true, message: 'Your workspace credits are used up.' },
    cached,
  );
  assert.equal(limited.response._staleKind, 'rate-limited');
  // The backend's own sentence, not "Usage API rate limited" about an API it never called.
  assert.equal(limited.response._staleMessage, 'Your workspace credits are used up.');
});

// A rollout bigger than the tail window, with the reading placed where the caller asks for it. `head`
// lines come before it, `tail` lines after — so the same helper builds "reading inside the tail" and
// "reading out of its reach".
function writeBigRollout(root, name, { head = 0, tail = 0 } = {}) {
  const noise = (n, tag) => Array.from({ length: n }, (_, i) => ({
    type: 'response_item', payload: { type: 'message', text: 'x'.repeat(300), tag, n: i },
  }));
  return writeRollout(root, name, [...noise(head, 'head'), tokenCount(RATE_LIMITS), ...noise(tail, 'tail')]);
}

test('codex usage: a reading near the end of a huge rollout is found WITHOUT reading the whole file', async () => {
  const root = tmpStore();
  // ~1.2 MB of head, then the reading, then far less than the 256 KB tail window — the shape of every
  // real session: the last token_count is a few kilobytes from the end of a very large transcript.
  const file = writeBigRollout(root, 'rollout-2026-07-13T00-00-00-fast.jsonl', { head: 4000, tail: 100 });
  assert.ok(fs.statSync(file).size > 256 * 1024, 'the fixture has to exceed the tail window to prove anything');

  const realReadFileSync = fs.readFileSync;
  const wholeFileReads = [];
  fs.readFileSync = (...args) => {
    if (String(args[0]).includes('rollout-')) wholeFileReads.push(String(args[0]));
    return realReadFileSync(...args);
  };
  try {
    const usage = await fetchUsage(root);
    assert.equal(usage.buckets.length, 2);
    // The point of the tail read: the seek path answered, and the megabyte in front of it was never read.
    assert.deepEqual(wholeFileReads, []);
  } finally {
    fs.readFileSync = realReadFileSync;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('codex usage: a fruitless whole-file read is not repeated on every poll', async () => {
  const root = tmpStore();
  // No reading anywhere, and big enough that the tail cannot prove it — so the fallback runs.
  const file = writeBigRollout(root, 'rollout-2026-07-13T00-00-00-slow.jsonl', { head: 0, tail: 0 });
  fs.writeFileSync(file, Array.from({ length: 4000 }, (_, i) =>
    JSON.stringify({ type: 'response_item', payload: { type: 'message', text: 'x'.repeat(300), n: i } })).join('\n') + '\n');

  const realReadFileSync = fs.readFileSync;
  let fullReads = 0;
  fs.readFileSync = (...args) => {
    if (String(args[0]).includes('rollout-')) fullReads++;
    return realReadFileSync(...args);
  };
  try {
    await fetchUsage(root);
    assert.equal(fullReads, 1, 'the first poll pays for the whole file once');

    // The session writes another turn: mtime and size change, so the memo is invalidated. Without the
    // cooldown this bought the whole multi-megabyte file again, once a minute, forever.
    fs.appendFileSync(file, JSON.stringify({ type: 'response_item', payload: { type: 'message' } }) + '\n');
    await fetchUsage(root);
    assert.equal(fullReads, 1, 'the appended part is in the tail — the old part is not re-read');
  } finally {
    fs.readFileSync = realReadFileSync;
  }
  fs.rmSync(root, { recursive: true, force: true });
});
