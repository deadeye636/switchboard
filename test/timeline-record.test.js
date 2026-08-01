'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  RETENTION,
  retentionCutoff,
  normalizeTimelineEvent,
  isDuplicateOf,
  splitTruncated,
} = require('../src/db/timeline-record');

test('retention limits are stated, not accidental', () => {
  assert.ok(RETENTION.maxPerSession > 80, 'the point of #396 is more than the old renderer cap');
  assert.ok(RETENTION.maxAgeDays >= 1);
  assert.throws(() => { RETENTION.maxPerSession = 1; }, 'the limits are frozen');
});

test('retentionCutoff is maxAgeDays before now', () => {
  const now = 1_800_000_000_000;
  const cutoff = retentionCutoff(now);
  assert.strictEqual(now - cutoff, RETENTION.maxAgeDays * 24 * 60 * 60 * 1000);
});

test('retentionCutoff falls back to a real clock when now is not a number', () => {
  const before = Date.now() - RETENTION.maxAgeDays * 24 * 60 * 60 * 1000;
  const cutoff = retentionCutoff(undefined);
  assert.ok(Math.abs(cutoff - before) < 5000);
});

test('an event without a session or a kind is not an event', () => {
  assert.strictEqual(normalizeTimelineEvent(null), null);
  assert.strictEqual(normalizeTimelineEvent({}), null);
  assert.strictEqual(normalizeTimelineEvent({ kind: 'started' }), null);
  assert.strictEqual(normalizeTimelineEvent({ sessionId: 's1' }), null);
  assert.strictEqual(normalizeTimelineEvent({ sessionId: '   ', kind: 'started' }), null);
});

test('label falls back to the kind, detail to an empty string', () => {
  const event = normalizeTimelineEvent({ sessionId: 's1', kind: 'started' }, 1000);
  assert.strictEqual(event.label, 'started');
  assert.strictEqual(event.detail, '');
  assert.strictEqual(event.at, 1000);
});

test('at accepts the three shapes the callers being ported over send', () => {
  const now = 5000;
  const iso = normalizeTimelineEvent({ sessionId: 's1', kind: 'idle', at: '2026-08-01T10:00:00.000Z' }, now);
  assert.strictEqual(iso.at, Date.parse('2026-08-01T10:00:00.000Z'));

  const ms = normalizeTimelineEvent({ sessionId: 's1', kind: 'idle', at: 1234 }, now);
  assert.strictEqual(ms.at, 1234);

  const date = normalizeTimelineEvent({ sessionId: 's1', kind: 'idle', at: new Date(9876) }, now);
  assert.strictEqual(date.at, 9876);
});

test('an unreadable time becomes now rather than NaN', () => {
  const now = 7777;
  for (const at of ['not a date', new Date('nope'), Number.NaN, {}, []]) {
    const event = normalizeTimelineEvent({ sessionId: 's1', kind: 'idle', at }, now);
    assert.strictEqual(event.at, now, `${String(at)} should fall back to now`);
  }
});

test('a duplicate is the same session and kind within the window', () => {
  const first = { sessionId: 's1', kind: 'exited', label: 'Exited', detail: 'code 0', at: 1_000_000 };

  assert.ok(isDuplicateOf({ ...first, at: 1_000_200 }, first));
  assert.ok(isDuplicateOf({ ...first, at: 999_800 }, first), 'the window is symmetric');
  assert.ok(isDuplicateOf({ ...first, detail: 'worded differently' }, first),
    'the same fact reported twice can carry a different reason');

  assert.ok(!isDuplicateOf({ ...first, at: 1_003_000 }, first), 'outside the window');
  assert.ok(!isDuplicateOf({ ...first, at: 1_000_600 }, first),
    'the window is a duplicate catcher, not a rate limit — a second real event survives it');
  assert.ok(!isDuplicateOf({ ...first, kind: 'stopped' }, first));
  assert.ok(!isDuplicateOf({ ...first, sessionId: 's2' }, first));
  assert.ok(!isDuplicateOf(first, null));
  assert.ok(!isDuplicateOf(null, first));
});

test('splitTruncated tells a full answer from a cut one', () => {
  const rows = [1, 2, 3, 4, 5];

  // Fewer than asked for: nothing was hidden.
  assert.deepStrictEqual(splitTruncated(rows, 10), { events: rows, truncated: false });

  // EXACTLY the cap, because the caller over-fetched by one and got no extra row.
  assert.deepStrictEqual(splitTruncated(rows, 5), { events: rows, truncated: false });

  // One past the cap is the signal: the answer is cut and the caller can say so.
  assert.deepStrictEqual(splitTruncated(rows, 4), { events: [1, 2, 3, 4], truncated: true });
});

test('splitTruncated survives what a query can hand it', () => {
  assert.deepStrictEqual(splitTruncated(null, 5), { events: [], truncated: false });
  assert.deepStrictEqual(splitTruncated(undefined, 5), { events: [], truncated: false });
  assert.deepStrictEqual(splitTruncated([1, 2], 0), { events: [], truncated: true });
  assert.deepStrictEqual(splitTruncated([1, 2], -3), { events: [], truncated: true });
});
