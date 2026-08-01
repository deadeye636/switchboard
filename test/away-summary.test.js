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

// #384 lived here: the tests for `isUserInput`, the filter that told a keystroke from a terminal
// report. Both went with the banner (#402) — the recap is closed deliberately now, never by input, so
// there is nothing left to filter. The lesson is kept in docs/specs/03-what-changed.md §1.

// --- buildAwayOverview: one recap for a whole absence (#402) ---------------------

const { buildAwayOverview } = require('../src/renderer/shell/away-summary');

const ev = (sessionId, kind, at, extra = {}) => ({ sessionId, kind, label: kind, at, ...extra });

test('#402: the overview groups a cross-session read into one entry per session', () => {
  const overview = buildAwayOverview({
    events: [
      ev('s2', 'response-ready', minutes(9)),
      ev('s1', 'exited', minutes(6)),
      ev('s1', 'started', minutes(3)),
    ],
    awaySince: minutes(0),
    now: minutes(10),
  });

  assert.equal(overview.hasChanges, true);
  assert.equal(overview.sessionCount, 2);
  // Newest session first: s2's event is later than s1's.
  assert.deepEqual(overview.sessions.map((s) => s.sessionId), ['s2', 's1']);
  assert.deepEqual(overview.sessions[1].events.map((e) => e.kind), ['exited', 'started']);
});

test('#402: only sessions that actually changed are listed', () => {
  const overview = buildAwayOverview({
    // busy/idle churn is noise — a session that only did that did not "change" for a recap.
    events: [ev('quiet', 'busy', minutes(4)), ev('quiet', 'idle', minutes(5)), ev('loud', 'exited', minutes(6))],
    awaySince: minutes(0),
    now: minutes(10),
  });

  assert.deepEqual(overview.sessions.map((s) => s.sessionId), ['loud']);
});

test('#402: events before the absence began are not part of it', () => {
  const overview = buildAwayOverview({
    events: [ev('s1', 'exited', minutes(-5)), ev('s2', 'exited', minutes(5))],
    awaySince: minutes(0),
    now: minutes(10),
  });

  assert.deepEqual(overview.sessions.map((s) => s.sessionId), ['s2']);
});

test('#402: file-touched becomes the files half, deduped, never an event row', () => {
  const overview = buildAwayOverview({
    events: [
      ev('s1', 'file-touched', minutes(8), { label: 'diff', detail: '/repo/src/a.js' }),
      ev('s1', 'file-touched', minutes(7), { label: 'open', detail: '/repo/src/a.js' }),
      ev('s1', 'file-touched', minutes(6), { label: 'open', detail: '/repo/src/b.js' }),
    ],
    awaySince: minutes(0),
    now: minutes(10),
  });

  const entry = overview.sessions[0];
  assert.equal(entry.events.length, 0);
  assert.deepEqual(entry.files.map((f) => f.path), ['/repo/src/a.js', '/repo/src/b.js']);
  // A session whose only news is touched files still counts as changed.
  assert.equal(overview.hasChanges, true);
});

test('#402: waitingCount counts the sessions blocked on the human, not the events', () => {
  const overview = buildAwayOverview({
    events: [
      ev('s1', 'needs-attention', minutes(9)),
      ev('s1', 'response-ready', minutes(8)),
      ev('s2', 'exited', minutes(7)),
    ],
    awaySince: minutes(0),
    now: minutes(10),
  });

  assert.equal(overview.sessionCount, 2);
  assert.equal(overview.waitingCount, 1);
});

test('#402: truncation is passed through, never inferred', () => {
  const args = { events: [ev('s1', 'exited', minutes(5))], awaySince: minutes(0), now: minutes(10) };
  assert.equal(buildAwayOverview({ ...args, truncated: true }).truncated, true);
  assert.equal(buildAwayOverview(args).truncated, false);
});

test('#402: without an absence to measure from there is no overview', () => {
  // The one wrong answer that looks right: listing the entire record as if it all happened while away.
  const overview = buildAwayOverview({ events: [ev('s1', 'exited', minutes(5))], awaySince: null, now: minutes(10) });
  assert.equal(overview.hasChanges, false);
  assert.equal(overview.sessions.length, 0);
});

test('#402: per-session capping still applies, and reports what it dropped', () => {
  const events = [];
  for (let i = 12; i >= 1; i--) events.push(ev('s1', 'forked', minutes(i)));
  const overview = buildAwayOverview({ events, awaySince: minutes(0), now: minutes(20), maxEventsPerSession: 8 });

  assert.equal(overview.sessions[0].events.length, 8);
  assert.equal(overview.sessions[0].extraEventCount, 4);
});
