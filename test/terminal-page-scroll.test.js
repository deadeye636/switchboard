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

// The answer PER BACKEND, pinned. This table is the guard #410 did not have: a change to shared terminal
// key handling cannot quietly move a backend that was not in its scope, because moving one fails HERE, by
// name, and whoever does it has to say so out loud by editing this table.
//
// Each entry is what was MEASURED in a live session — key pressed, both directions watched — not what a
// CLI's keymap documentation claims. Documentation got this wrong twice: first every backend was given to
// xterm (which took the key away from Claude, the one that already worked), then every backend was given
// to the PTY (which left Pi and Codex with a key that does nothing).
//
//   claude  its full-screen TUI pages its own history, and it runs on the ALTERNATE screen where xterm
//           holds no scrollback at all — there is nothing here that could page anything. It worked
//           before #410 touched it. Leave it alone.
//   codex   ignores ESC[5~ at its prompt, and runs on the NORMAL buffer, so xterm holds the history
//   pi      ignores ESC[5~ at its prompt, and runs on the NORMAL buffer, so xterm holds the history
//   hermes  NOT measured — keeps the conservative default, which is also its behaviour today
//   agy     NOT measured — same
const PAGE_KEY_TARGETS = {
  claude: 'pty',
  codex: 'viewport',
  pi: 'viewport',
  hermes: 'pty',
  agy: 'pty',
};

test('every backend explicitly owns its bare page-key target', () => {
  for (const backend of BACKENDS) {
    assert.ok(['pty', 'viewport'].includes(backend.pageKeyTarget),
      `${backend.id}: pageKeyTarget must explicitly be "pty" or "viewport"`);
  }
});

test('each backend keeps the page-key answer that was measured for IT', () => {
  for (const backend of BACKENDS) {
    const expected = PAGE_KEY_TARGETS[backend.id];
    assert.ok(expected,
      `${backend.id}: new backend — measure its page keys in a live session and add it to PAGE_KEY_TARGETS`);
    assert.equal(backend.pageKeyTarget, expected,
      `${backend.id}: its page-key ownership changed. If that is deliberate, say so by editing `
      + 'PAGE_KEY_TARGETS — a backend that already worked is the regression control, never collateral of '
      + 'a change aimed at a different one');
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
