'use strict';
// #159 — one clock for every backend's metrics.
//
// Claude bucketed by slicing the ISO timestamp (the UTC day); Hermes grouped with SQLite's `localtime`
// (the local day). East of Greenwich after 00:00 those disagree, so in a chart that stacked both
// backends the same evening's work landed in two different columns. These tests pin the shared answer.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  NO_HOUR, localDateKey, bucketOf, bucketFromIso, bucketFromEpochSeconds, bucketKey,
} = require('../metrics-bucket');

test('localDateKey formats the LOCAL calendar day, never the UTC one', () => {
  // Local midnight. toISOString() would render this as the PREVIOUS day anywhere east of Greenwich —
  // which is precisely the bug: the day the user worked is the day their own clock showed.
  const d = new Date(2026, 5, 1, 0, 0, 0);   // 1 June 2026, 00:00 local
  assert.equal(localDateKey(d), '2026-06-01');

  const late = new Date(2026, 5, 1, 23, 59, 59);
  assert.equal(localDateKey(late), '2026-06-01', 'still the same local day at one second to midnight');
});

test('a timestamp lands on the hour the user was actually at the keyboard', () => {
  const iso = '2026-06-01T22:30:00.000Z';
  const at = bucketFromIso(iso);
  const expected = new Date(iso);
  assert.equal(at.hour, expected.getHours());
  assert.equal(at.date, localDateKey(expected));
});

test('epoch SECONDS (Hermes stores REAL seconds, not millis) resolve to the same bucket', () => {
  const iso = '2026-06-01T22:30:00.000Z';
  const seconds = Date.parse(iso) / 1000;
  assert.deepEqual(bucketFromEpochSeconds(seconds), bucketFromIso(iso));
});

test('a millisecond value passed as seconds does NOT silently land in the year 56000', () => {
  // It resolves to *a* date rather than throwing — but the point of the separate entry points is that
  // a caller states its unit. This pins the unit so a future refactor cannot quietly swap it.
  const ms = Date.parse('2026-06-01T22:30:00.000Z');
  assert.notDeepEqual(bucketFromEpochSeconds(ms), bucketFromIso('2026-06-01T22:30:00.000Z'));
});

test('an unusable timestamp falls back to the given day and admits it has no hour', () => {
  for (const bad of [null, undefined, '', 'not-a-date', 42, {}]) {
    const at = bucketFromIso(bad, '2026-06-01');
    assert.equal(at.date, '2026-06-01');
    assert.equal(at.hour, NO_HOUR, 'never guessed as midnight — the grid leaves it out instead');
  }
});

test('an unusable timestamp with no fallback yields no date at all (the caller must skip it)', () => {
  const at = bucketFromIso('rubbish', null);
  assert.equal(at.date, null);
  assert.equal(at.hour, NO_HOUR);
});

test('epoch 0 / negative is not a session from 1970 — it is a missing timestamp', () => {
  assert.equal(bucketFromEpochSeconds(0, '2026-06-01').date, '2026-06-01');
  assert.equal(bucketFromEpochSeconds(0, '2026-06-01').hour, NO_HOUR);
  assert.equal(bucketFromEpochSeconds(-5, '2026-06-01').hour, NO_HOUR);
});

test('bucketOf takes a Date and refuses an invalid one', () => {
  const d = new Date(2026, 5, 1, 9, 15);
  assert.deepEqual(bucketOf(d), { date: '2026-06-01', hour: 9 });
  assert.deepEqual(bucketOf(new Date('nope'), '2026-06-02'), { date: '2026-06-02', hour: NO_HOUR });
  assert.deepEqual(bucketOf('2026-06-01', '2026-06-02'), { date: '2026-06-02', hour: NO_HOUR },
    'a string is not a Date — bucketOf does not parse, the typed entry points do');
});

test('the bucket key separates the three dimensions and normalises a missing model', () => {
  assert.equal(bucketKey('2026-06-01', 9, 'opus'), '2026-06-01|9|opus');
  assert.equal(bucketKey('2026-06-01', 9, null), '2026-06-01|9|');
  assert.equal(bucketKey('2026-06-01', 9, ''), '2026-06-01|9|');
  // Two different hours are two different buckets — that is the whole point of the hour dimension.
  assert.notEqual(bucketKey('2026-06-01', 9, 'opus'), bucketKey('2026-06-01', 10, 'opus'));
  // ...and an hour-less bucket never collides with the midnight one.
  assert.notEqual(bucketKey('2026-06-01', NO_HOUR, 'opus'), bucketKey('2026-06-01', 0, 'opus'));
});
