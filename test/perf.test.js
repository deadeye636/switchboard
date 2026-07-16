const { test } = require('node:test');
const assert = require('node:assert');
const { startTimer, timed, timedAsync } = require('../src/perf');

test('startTimer returns a non-decreasing, non-negative elapsed probe', () => {
  const done = startTimer();
  const a = done();
  const b = done();
  assert.ok(a >= 0, 'first reading is non-negative');
  assert.ok(b >= a, 'later reading is not smaller');
  assert.equal(typeof a, 'number');
});

test('timed returns the wrapped value', () => {
  const out = timed('x', () => 42, { log: null });
  assert.equal(out, 42);
});

test('timed logs one [perf] line when the span is at/over the threshold', () => {
  const lines = [];
  const log = { debug: (m) => lines.push(m) };
  // slowMs: -1 so any non-negative elapsed counts as slow → deterministic.
  timed('hot.block', () => {}, { log, slowMs: -1 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[perf\] hot\.block \d+(\.\d+)?ms$/);
});

test('timed stays silent when under the threshold', () => {
  const lines = [];
  const log = { debug: (m) => lines.push(m) };
  timed('cheap', () => {}, { log, slowMs: Infinity });
  assert.equal(lines.length, 0);
});

test('timed measures and rethrows even when fn throws', () => {
  const lines = [];
  const log = { debug: (m) => lines.push(m) };
  assert.throws(() => timed('boom', () => { throw new Error('nope'); }, { log, slowMs: -1 }), /nope/);
  assert.equal(lines.length, 1, 'the finally block still logged the span');
});

test('timed without a logger measures silently and does not throw', () => {
  assert.doesNotThrow(() => timed('no-log', () => {}, { slowMs: -1 }));
});

test('timedAsync awaits the value and logs when slow', async () => {
  const lines = [];
  const log = { debug: (m) => lines.push(m) };
  const out = await timedAsync('async.block', async () => 'ok', { log, slowMs: -1 });
  assert.equal(out, 'ok');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[perf\] async\.block /);
});
