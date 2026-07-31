const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAwaySummary, formatAwayDuration, isUserInput } = require('../src/renderer/shell/away-summary');

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

// --- #384: only a human dismisses the recap ---
//
// `onData` is everything bound for the PTY, the terminal's own answers included. The recap dismissed
// on all of it, so revealing a session — which necessarily moves focus — tore the banner down in the
// same beat it was rendered. Measured in a running instance: one focus switch, nothing typed, one
// payload, and it was the focus-out report.

const ESC = '';

test('#384: a terminal answering a query is not a keystroke', () => {
  const reports = [
    `${ESC}[I`, `${ESC}[O`,                 // focus in / out (DECSET 1004) — the measured one
    `${ESC}[24;80R`,                        // cursor position report
    `${ESC}[0n`,                            // device status report
    `${ESC}[?1;2c`, `${ESC}[>0;276;0c`,     // device attributes, primary and secondary
    `${ESC}[M !!`,                          // mouse, X10 — button plus two coordinate bytes
    `${ESC}[<0;12;7M`, `${ESC}[<0;12;7m`,   // mouse, SGR press and release
  ];
  for (const payload of reports) {
    assert.equal(isUserInput(payload), false, `should not dismiss on ${JSON.stringify(payload)}`);
  }
});

test('#384: a keystroke still dismisses', () => {
  const keys = [
    'a', 'Z', ' ', '\r', '',           // plain characters, Enter, Ctrl-C
    ESC,                                     // the Escape KEY is input; a bare ESC is not a report
    `${ESC}[A`, `${ESC}[D`,                  // arrows, normal mode
    `${ESC}OA`, `${ESC}OP`,                  // arrows and F1 in application mode (SS3, not CSI)
    `${ESC}[200~hello${ESC}[201~`,           // a bracketed paste is the user acting
  ];
  for (const payload of keys) {
    assert.equal(isUserInput(payload), true, `should dismiss on ${JSON.stringify(payload)}`);
  }
});

test('#384: nothing at all is not input either', () => {
  assert.equal(isUserInput(''), false);
  assert.equal(isUserInput(null), false);
  assert.equal(isUserInput(undefined), false);
});
