'use strict';
// src/renderer/session/shell-line-status.js (#836): the pure half of a running `!` line's display.
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatElapsedMs, shellLineEnding, shellLinesRunningText, shellLineTail, mergeBackgroundRows, elapsedTimerNeeded } = require('../src/renderer/session/shell-line-status.js');

test('elapsed text is m:ss, and h:mm:ss from an hour', () => {
  assert.equal(formatElapsedMs(0), '0:00');
  assert.equal(formatElapsedMs(65000), '1:05');
  assert.equal(formatElapsedMs(3725000), '1:02:05');
  assert.equal(formatElapsedMs(-5), '0:00');
});

test('an ending names the exit code, and only a non-zero or stopped one is bad', () => {
  assert.deepEqual(shellLineEnding('done', 0), { text: 'exit 0', bad: false });
  assert.deepEqual(shellLineEnding('error', 3), { text: 'exit 3', bad: true });
  assert.deepEqual(shellLineEnding('cancelled', null), { text: 'stopped', bad: true });
  assert.deepEqual(shellLineEnding('error', null), { text: 'failed', bad: true });
  assert.deepEqual(shellLineEnding('done', undefined), { text: 'exit 0', bad: false });
});

test('the session line is singular for one and plural for more', () => {
  assert.equal(shellLinesRunningText(1), '1 shell line running');
  assert.equal(shellLinesRunningText(2), '2 shell lines running');
});

test('the strip shows the last non-empty lines', () => {
  assert.equal(shellLineTail('a\n\nb\nc\nd\n', 3), 'b\nc\nd');
  assert.equal(shellLineTail('', 3), '');
});

test('the Background rows merge the lines in without touching the tasks', () => {
  const tasks = [{ id: 't1', kind: 'agent', description: 'x' }];
  const frozen = JSON.stringify(tasks);
  const long = 'echo ' + 'y'.repeat(200);
  const rows = mergeBackgroundRows(tasks, new Map([['7', { command: long, startedAt: 5 }]]));
  assert.equal(JSON.stringify(tasks), frozen, 'the runtime list is untouched');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].shellLineId, null);
  assert.equal(rows[1].kind, 'shell');
  assert.equal(rows[1].shellLineId, '7');
  assert.equal(rows[1].startedAt, 5);
  assert.ok(rows[1].description.length <= 80 && rows[1].description.endsWith('…'));
  assert.deepEqual(mergeBackgroundRows(null, null), []);
});

test('the timer is armed only for something counting, on screen, attached and alive', () => {
  const on = { counting: 1, shown: true, connected: true, exited: false };
  assert.equal(elapsedTimerNeeded(on), true);
  for (const off of [{ counting: 0 }, { shown: false }, { connected: false }, { exited: true }]) {
    assert.equal(elapsedTimerNeeded({ ...on, ...off }), false);
  }
});
