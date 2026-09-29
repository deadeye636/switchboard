'use strict';
// src/app/renderer-stalls.js — a renderer long task written to main's log (#707). The renderer is not
// trusted with the log line, so every field is checked here.

const test = require('node:test');
const assert = require('node:assert/strict');
const rendererStalls = require('../src/app/renderer-stalls');

test('a report becomes one line naming the window and the work inside the task', () => {
  assert.equal(rendererStalls.stallLine({ ms: 1240.4, work: ['show-session:conversation', 'conversation-reset:1130'] }, 'main'),
    '[renderer-stall] main window blocked ~1240ms; work started in that task: show-session:conversation, conversation-reset:1130');
  assert.match(rendererStalls.stallLine({ ms: 700, work: [], hidden: true }, 'detached'),
    /^\[renderer-stall\] detached \(hidden\) window blocked ~700ms; work started in that task: nothing noted$/);
});

test('a report that is not one logs nothing, and a hostile one is capped', () => {
  for (const bad of [null, 'x', {}, { ms: 'soon' }, { ms: -5 }, { ms: Infinity }]) {
    assert.equal(rendererStalls.stallLine(bad, 'main'), null);
  }
  const line = rendererStalls.stallLine({ ms: 600, work: [...Array(20)].map((_, i) => `w${i}`).concat(['x'.repeat(500), 'a\nb\x1b[31mc\u2028d', 7, null]) }, 'main');
  assert.ok(!/[\x00-\x1f\x7f\u2028\u2029]/.test(line), 'no control character reaches the log');
  assert.match(rendererStalls.stallLine({ ms: 1e300 }, 'main'), /blocked ~600000ms/, 'an absurd duration is clamped');
  const work = line.split('work started in that task: ')[1].split(', ');
  assert.equal(work.length, 8, 'at most eight labels');
  assert.ok(work.every(l => l.length <= 80), 'each label capped');
});

test('registerIpc logs a valid report and names the main window by its sender', () => {
  const lines = [];
  const mainContents = {};
  rendererStalls.init({ getMainWindow: () => ({ isDestroyed: () => false, webContents: mainContents }), log: { info: (m) => lines.push(m) } });
  const handlers = new Map();
  rendererStalls.registerIpc({ on: (ch, fn) => handlers.set(ch, fn) });
  const on = handlers.get('renderer-stall');
  on({ sender: mainContents }, { ms: 'nope' });
  on({ sender: mainContents }, { ms: 900, work: ['conversation-reset:40'] });
  on({ sender: {} }, { ms: 800, work: [] });
  on({ sender: mainContents }, { ms: 950, work: [] });   // the same window again at once: rate-limited
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[renderer-stall\] main window blocked ~900ms/);
  assert.match(lines[1], /^\[renderer-stall\] detached window blocked ~800ms/);
});
