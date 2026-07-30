// The status bar's live-terminal count (#352): where it starts speaking, and what it says.
//
// The number matters because the LRU deliberately does NOT bound it — `lruEvictOne` skips every
// session with a live PTY, since discarding a running session's scrollback is a visible loss rather
// than a cache decision. So the limit is shown instead of enforced, and these thresholds are the
// whole of that decision.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TERMINAL_PRESSURE_WARN,
  TERMINAL_PRESSURE_HIGH,
  terminalPressure,
} = require('../src/renderer/shell/terminal-pressure');

test('below the threshold there is nothing to say', () => {
  for (const n of [0, 1, 12, TERMINAL_PRESSURE_WARN - 1]) {
    const p = terminalPressure(n);
    assert.equal(p.level, 'none', `${n} terminals is ordinary`);
    assert.equal(p.label, '', 'and an empty label, so the segment is not painted at all');
    assert.equal(p.title, '');
  }
});

test('the warning starts at the threshold and escalates', () => {
  assert.equal(terminalPressure(TERMINAL_PRESSURE_WARN).level, 'warn');
  assert.equal(terminalPressure(TERMINAL_PRESSURE_HIGH - 1).level, 'warn');
  assert.equal(terminalPressure(TERMINAL_PRESSURE_HIGH).level, 'high');
  assert.equal(terminalPressure(120).level, 'high');
});

test('both thresholds sit below the point contexts start dying', () => {
  // Chromium drops contexts past roughly 32. A warning that arrives after that is a post-mortem.
  assert.ok(TERMINAL_PRESSURE_WARN < TERMINAL_PRESSURE_HIGH);
  assert.ok(TERMINAL_PRESSURE_HIGH < 32);
});

test('the label is the count and the tooltip says what to do about it', () => {
  const p = terminalPressure(26);
  assert.equal(p.label, '26 terminals');
  assert.match(p.title, /^26 terminals open in this window/);
  assert.match(p.title, /Closing tabs you are done with frees them/);
  // The reassurance is load-bearing: without it "close some tabs" reads as "lose some sessions".
  assert.match(p.title, /the session and its history stay either way/);
});

test('a count that is not a count reads as empty rather than throwing', () => {
  for (const bad of [undefined, null, NaN, -4, 'many']) {
    assert.equal(terminalPressure(bad).level, 'none');
  }
});

test('a fractional count is floored, not rounded up into a warning', () => {
  assert.equal(terminalPressure(TERMINAL_PRESSURE_WARN - 0.5).level, 'none');
  assert.equal(terminalPressure(TERMINAL_PRESSURE_WARN + 0.5).label, `${TERMINAL_PRESSURE_WARN} terminals`);
});
