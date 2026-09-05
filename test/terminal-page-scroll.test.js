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
//   claude  re-measured against 2.1.261 (#558): ESC[5~/ESC[6~ reach the CLI and move to the start and
//           end of the CURRENT line — Home and End, not paging — so the "pages its own history" half of
//           the old row is gone. Its BUFFER is not a constant: four long-running sessions were on
//           `normal` with 226-2470 lines of scrollback and a fresh one on `alternate` with baseY 0, one
//           machine, one version, tui: "fullscreen" in both homes. That is why the target declares what
//           we do when there is a viewport, and the routing asks the live buffer whether there is one.
//   codex   ignores ESC[5~ at its prompt, and runs on the NORMAL buffer, so xterm holds the history
//   pi      ignores ESC[5~ at its prompt, and runs on the NORMAL buffer, so xterm holds the history
//   hermes  measured: the bare keys do nothing, and the history pages only under Shift — which is
//           xterm's own scrollback, so the TUI is not using them and xterm holds the transcript
//   agy     measured: the same, in a session against the real store (agy declares no store variable,
//           so it cannot be driven from an isolated instance — this row is the owner's reading)
const PAGE_KEY_TARGETS = {
  claude: 'viewport',
  codex: 'viewport',
  pi: 'viewport',
  hermes: 'viewport',
  agy: 'viewport',
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

// --- there has to BE a viewport to page (#558) ----------------------------------------------------
//
// A descriptor declares what its CLI does with the key. It cannot declare which BUFFER that CLI is on:
// Claude answers the alternate screen with its classic renderer and the normal buffer with `tui:
// "fullscreen"` — measured, both, on one machine on one CLI version. On the alternate screen `baseY` is
// 0, so `scrollPages()` moves nothing; consuming the key there is the worst of both — no scroll, and the
// TUI that owns the screen never sees it either. Measured in a live session before this guard existed:
// bare PageUp sent nothing to the PTY, moved no viewport and moved no cursor.

test('a viewport-owned page key falls back to the PTY when there is nothing to page', () => {
  for (const key of ['PageUp', 'PageDown']) {
    const event = pageEvent(key);
    const scrolls = [];
    assert.equal(handleTerminalPageKeyEvent(event, 'viewport', pages => scrolls.push(pages), false), true,
      `${key}: on the alternate screen the key belongs to the application`);
    assert.equal(event.wasPrevented(), false, `${key}: an application key must not be prevented`);
    assert.deepEqual(scrolls, [], `${key}: there is no scrollback to move`);
  }
});

test('only an explicit false diverts — an absent answer is not a missing viewport', () => {
  // The guard is `canPage === false`, not `!canPage`, and the difference is the whole test: written the
  // short way, every caller that does not answer would lose the key to the PTY, which is every caller
  // that has no opinion. `undefined` is what an omitted argument gives; `null` and `0` are what a
  // getter answers before it has been wired up.
  for (const canPage of [true, undefined, null, 0, '']) {
    const event = pageEvent('PageUp');
    const scrolls = [];
    assert.equal(handleTerminalPageKeyEvent(event, 'viewport', pages => scrolls.push(pages), canPage), false,
      `canPage=${JSON.stringify(canPage)}: only an explicit false means "there is nothing to page"`);
    assert.equal(event.wasPrevented(), true);
    assert.deepEqual(scrolls, [-1]);
  }
});

test('terminal-manager routes page keys through the tested decision', () => {
  assert.match(SRC, /handleTerminalPageKeyEvent\(e, getPageKeyTarget\?\.\(\)/,
    'the live terminal key handler must use the tested routing helper');
  assert.match(SRC, /return backend\?\.pageKeyTarget/,
    'the mounted session must resolve its target from the renderer backend registry');
  // The buffer type has to be read LIVE at the key press. A value captured when the session mounted
  // describes the startup screen: the buffer switches partway through a CLI's start.
  assert.match(SRC, /terminal\.buffer\?\.active\?\.type !== 'alternate'/,
    'the routing decision must be handed the CURRENT buffer type, not a remembered one');
});
