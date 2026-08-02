'use strict';
// Bare PageUp/PageDown may be application keys. The backend descriptor decides whether they reach its
// TUI through the PTY or scroll Switchboard's xterm viewport.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC = read('src/renderer/terminal/terminal-manager.js');
const MAIN = read('src/main.js');
const BACKENDS = require('../src/backends').list().filter(b => b.status === 'ready' && !b.isProfile);
const { handleTerminalPageKeyEvent } = require('../src/renderer/terminal/page-key-routing');

function pageEvent(key, overrides = {}) {
  let prevented = false;
  return {
    key,
    type: 'keydown',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault() { prevented = true; },
    wasPrevented() { return prevented; },
    ...overrides,
  };
}

test('every backend explicitly owns its bare page-key target', () => {
  for (const backend of BACKENDS) {
    assert.ok(['pty', 'viewport'].includes(backend.pageKeyTarget),
      `${backend.id}: pageKeyTarget must explicitly be "pty" or "viewport"`);
  }
});

test('current coding TUIs receive bare PageUp/PageDown through the PTY', () => {
  for (const backend of BACKENDS) {
    assert.equal(backend.pageKeyTarget, 'pty',
      `${backend.id}: its TUI handles page keys; intercepting them breaks application history and overlays`);
  }
});

test('the descriptor page-key target reaches the renderer', () => {
  assert.match(MAIN, /pageKeyTarget:\s*b\.pageKeyTarget/,
    'backends-list must project pageKeyTarget or every backend silently falls back to the PTY');
  assert.match(read('src/backends/index.js'), /pageKeyTarget:\s*base\s*\?\s*base\.pageKeyTarget/,
    'a template must inherit the page-key behaviour of the binary it runs');
});

test('PTY-owned bare page keys are not prevented or scrolled', () => {
  for (const target of ['pty', undefined, 'invalid']) {
    const event = pageEvent('PageUp');
    const scrolls = [];
    assert.equal(handleTerminalPageKeyEvent(event, target, pages => scrolls.push(pages)), true);
    assert.equal(event.wasPrevented(), false, `${target}: the application key must not be prevented`);
    assert.deepEqual(scrolls, [], `${target}: xterm must not scroll instead of the TUI`);
  }
});

test('viewport-owned bare page keys are swallowed and scroll xterm in the right direction', () => {
  for (const [key, direction] of [['PageUp', -1], ['PageDown', 1]]) {
    const event = pageEvent(key);
    const scrolls = [];
    assert.equal(handleTerminalPageKeyEvent(event, 'viewport', pages => scrolls.push(pages)), false);
    assert.equal(event.wasPrevented(), true);
    assert.deepEqual(scrolls, [direction]);
  }
});

test('modifier chords and unrelated keys retain their existing xterm handling', () => {
  for (const event of [pageEvent('PageUp', { shiftKey: true }), pageEvent('ArrowUp')]) {
    const scrolls = [];
    assert.equal(handleTerminalPageKeyEvent(event, 'viewport', pages => scrolls.push(pages)), null);
    assert.equal(event.wasPrevented(), false);
    assert.deepEqual(scrolls, []);
  }
});

test('terminal-manager routes page keys through the tested decision', () => {
  assert.match(SRC, /handleTerminalPageKeyEvent\(e, getPageKeyTarget\?\.\(\)/,
    'the live terminal key handler must use the tested routing helper');
  assert.match(SRC, /return backend\?\.pageKeyTarget/,
    'the mounted session must resolve its target from the renderer backend registry');
});
