const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAwaySummary, formatAwayDuration } = require('../src/renderer/shell/away-summary');

const BASE = new Date('2026-06-12T10:00:00.000Z').getTime();
const minutes = (n) => new Date(BASE + n * 60_000).toISOString();

test('events before lastViewedAt are excluded and later events included', () => {
  const summary = buildAwaySummary({
    events: [
      { kind: 'response-ready', label: 'Ready', at: minutes(10) },
      { kind: 'started', label: 'Started', at: minutes(-5) },
    ],
    lastViewedAt: minutes(0),
    now: minutes(12),
  });

  assert.equal(summary.hasChanges, true);
  assert.deepEqual(summary.events.map((e) => e.kind), ['response-ready']);
});

test('events are capped at maxEvents (newest-first) with extra count surfaced', () => {
  const events = [];
  for (let i = 12; i >= 1; i--) {
    events.push({ kind: 'forked', label: `fork ${i}`, at: minutes(i) });
  }

  const summary = buildAwaySummary({
    events,
    lastViewedAt: minutes(0),
    now: minutes(20),
    maxEvents: 8,
  });

  assert.equal(summary.events.length, 8);
  assert.equal(summary.extraEventCount, 4);
  // Newest-first ordering preserved (input newest is fork 12).
  assert.equal(summary.events[0].label, 'fork 12');
});

test('noise kinds (busy/idle) are filtered while meaningful kinds are retained', () => {
  const summary = buildAwaySummary({
    events: [
      { kind: 'idle', label: 'Agent idle', at: minutes(9) },
      { kind: 'needs-attention', label: 'Needs you', at: minutes(8) },
      { kind: 'busy', label: 'Agent working', at: minutes(7) },
      { kind: 'exited', label: 'Process exited', at: minutes(6) },
    ],
    lastViewedAt: minutes(0),
    now: minutes(10),
  });

  assert.deepEqual(summary.events.map((e) => e.kind), ['needs-attention', 'exited']);
});

test('files are deduped by path keeping the most recent touch', () => {
  const summary = buildAwaySummary({
    events: [],
    filesTouched: [
      { path: 'src/a.js', at: minutes(3), kind: 'open' },
      { path: 'src/a.js', at: minutes(5), kind: 'diff' },
      { path: 'src/b.js', at: minutes(4), kind: 'diff' },
    ],
    lastViewedAt: minutes(0),
    now: minutes(10),
  });

  assert.deepEqual(summary.files, [
    { path: 'src/a.js', kind: 'diff' },
    { path: 'src/b.js', kind: 'diff' },
  ]);
  assert.equal(summary.hasChanges, true);
});

test('files before lastViewedAt are excluded', () => {
  const summary = buildAwaySummary({
    filesTouched: [
      { path: 'old.js', at: minutes(-2), kind: 'diff' },
      { path: 'new.js', at: minutes(2), kind: 'diff' },
    ],
    lastViewedAt: minutes(0),
    now: minutes(5),
  });

  assert.deepEqual(summary.files.map((f) => f.path), ['new.js']);
});

test('waitingOnYou is true when a needs-attention or ready event exists since', () => {
  const attention = buildAwaySummary({
    events: [{ kind: 'needs-attention', label: 'Needs you', at: minutes(2) }],
    lastViewedAt: minutes(0),
    now: minutes(5),
  });
  assert.equal(attention.waitingOnYou, true);

  const calm = buildAwaySummary({
    events: [{ kind: 'forked', label: 'Forked', at: minutes(2) }],
    lastViewedAt: minutes(0),
    now: minutes(5),
  });
  assert.equal(calm.waitingOnYou, false);
});

test('hasChanges is false when nothing happened since last view', () => {
  const summary = buildAwaySummary({
    events: [
      { kind: 'started', label: 'Started', at: minutes(-10) },
      { kind: 'idle', label: 'Idle', at: minutes(5) },
    ],
    filesTouched: [{ path: 'old.js', at: minutes(-3), kind: 'diff' }],
    lastViewedAt: minutes(0),
    now: minutes(10),
  });

  assert.equal(summary.hasChanges, false);
  assert.deepEqual(summary.events, []);
  assert.deepEqual(summary.files, []);
});

test('sinceText formats elapsed duration sensibly', () => {
  assert.equal(
    buildAwaySummary({ lastViewedAt: minutes(0), now: minutes(12) }).sinceText,
    'You were away 12m',
  );
  assert.equal(
    buildAwaySummary({ lastViewedAt: BASE, now: BASE + 30_000 }).sinceText,
    'You were away less than a minute',
  );
  assert.equal(
    buildAwaySummary({ lastViewedAt: BASE, now: BASE + 2 * 3_600_000 + 5 * 60_000 }).sinceText,
    'You were away 2h 5m',
  );
  assert.equal(formatAwayDuration(25 * 3_600_000), '1d 1h');
});

test('no lastViewedAt includes all meaningful events with empty sinceText', () => {
  const summary = buildAwaySummary({
    events: [{ kind: 'started', label: 'Started', at: minutes(1) }],
    lastViewedAt: null,
    now: minutes(5),
  });

  assert.equal(summary.sinceText, '');
  assert.equal(summary.hasChanges, true);
  assert.equal(summary.events.length, 1);
});
