'use strict';
// #775: the mouse wheel over a CLI on the alternate screen whose mouse request ConPTY consumed. The backend
// declares that its CLI reads SGR wheel reports; the renderer writes them and names no backend.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC = read('src/renderer/terminal/terminal-manager.js');
const BACKENDS = require('../src/backends').list().filter(b => b.status === 'ready' && !b.isProfile);
const { terminalWheelReports } = require('../src/renderer/terminal/wheel-routing');

// The answer PER BACKEND, pinned, the same shape as NEWLINE_KEY_SEQUENCES in terminal-newline-key.test.js.
// Each 'sgr' was MEASURED: the CLI in a real ConPTY, an SGR wheel report written to its input, and the
// transcript seen to scroll.
//
//   pi      1.1.0 fullscreen: scrolls on the report ("Jump to latest message" appears); a cursor key, which
//           xterm sends instead, does nothing visible.
//   claude  NOT measured: its fullscreen renderer may want the same, but the demo ran its classic renderer.
//           Leave it on xterm's handling until somebody watches it.
const ALT_SCREEN_WHEEL = {
  pi: 'sgr',
};

const ev = (o = {}) => ({ deltaY: -100, deltaMode: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...o });
const ctx = (o = {}) => ({ declared: 'sgr', bufferType: 'alternate', mouseTracking: 'none', rows: 40, cellHeight: 20, col: 10, row: 5, ...o });

test('each backend keeps the wheel answer that was measured for it, and no other', () => {
  for (const backend of BACKENDS) {
    assert.equal(backend.altScreenWheel, ALT_SCREEN_WHEEL[backend.id],
      `${backend.id}: its alternate-screen wheel answer changed. Measure it in a real ConPTY and edit ALT_SCREEN_WHEEL`);
  }
});

test('the declaration reaches the renderer, and a template inherits its base\'s', () => {
  assert.match(read('src/main.js'), /altScreenWheel:\s*b\.altScreenWheel/, 'backends-list must project altScreenWheel');
  assert.match(read('src/backends/index.js'), /altScreenWheel:\s*base\s*\?\s*base\.altScreenWheel/,
    'a template runs its base\'s TUI and reads the wheel the same way');
  assert.match(SRC, /return backend\?\.altScreenWheel/, 'the mounted session must resolve its answer from the registry');
  assert.match(SRC, /terminalWheelReports\(e,/, 'the live wheel listener must use the tested decision');
});

test('a wheel step up and down becomes SGR wheel reports at the pointer\'s cell', () => {
  assert.deepEqual(terminalWheelReports(ev({ deltaY: -60 }), ctx(), { acc: 0 }), Array(3).fill('\x1b[<64;10;5M'));
  assert.deepEqual(terminalWheelReports(ev({ deltaY: 20, deltaMode: 1 }), ctx(), { acc: 0 }).slice(0, 1), ['\x1b[<65;10;5M']);
  assert.equal(terminalWheelReports(ev({ deltaY: 1000, deltaMode: 1 }), ctx(), { acc: 0 }).length, 10, 'capped per event');
});

test('Shift and Alt travel as SGR modifier bits', () => {
  assert.deepEqual(terminalWheelReports(ev({ deltaY: -20, shiftKey: true }), ctx(), { acc: 0 }), ['\x1b[<68;10;5M']);
  assert.deepEqual(terminalWheelReports(ev({ deltaY: -20, altKey: true }), ctx(), { acc: 0 }), ['\x1b[<72;10;5M']);
});

test('a trackpad\'s small pixel deltas add up to whole lines, and the event is still answered', () => {
  const state = { acc: 0 };
  assert.deepEqual(terminalWheelReports(ev({ deltaY: -8 }), ctx(), state), [], 'less than a line: nothing sent, xterm kept out');
  assert.deepEqual(terminalWheelReports(ev({ deltaY: -14 }), ctx(), state), ['\x1b[<64;10;5M']);
});

test('it steps aside wherever xterm\'s own handling is right', () => {
  const cases = [
    [ev(), ctx({ declared: undefined }), 'a backend that declares nothing'],
    [ev(), ctx({ bufferType: 'normal' }), 'the normal buffer: the wheel scrolls xterm\'s scrollback'],
    [ev(), ctx({ mouseTracking: 'any' }), 'xterm already reports the mouse (no ConPTY in between)'],
    [ev(), ctx({ mouseTracking: 'vt200' }), 'any tracking mode xterm knows of'],
    [ev({ ctrlKey: true }), ctx(), 'Ctrl+wheel is the font zoom'],
    [ev({ metaKey: true }), ctx(), 'Cmd+wheel is the font zoom on macOS'],
    [ev({ deltaY: 0 }), ctx(), 'a horizontal-only scroll'],
  ];
  for (const [e, c, why] of cases) assert.equal(terminalWheelReports(e, c, { acc: 0 }), null, why);
});

test('a reversal starts from zero instead of paying off the other direction\'s fraction', () => {
  const state = { acc: 0.9 };
  assert.deepEqual(terminalWheelReports(ev({ deltaY: -20 }), ctx(), state), ['\x1b[<64;10;5M'],
    'one line up after 0.9 lines down left over is one line up');
});
