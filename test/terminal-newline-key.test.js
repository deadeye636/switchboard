'use strict';
// Shift+Enter (and Ctrl+Enter off macOS) means "newline, not submit" — but the BYTES that say so differ
// per CLI. The backend descriptor declares its own sequence; the renderer never names a backend.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC = read('src/renderer/terminal/terminal-manager.js');
const MAIN = read('src/main.js');
const BACKENDS = require('../src/backends').list().filter(b => b.status === 'ready' && !b.isProfile);
const { handleTerminalNewlineKeyEvent } = require('../src/renderer/terminal/newline-key-routing');

function enterEvent(overrides = {}) {
  return {
    key: 'Enter',
    type: 'keydown',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  };
}

// The answer PER BACKEND, pinned — the same guard shape as PAGE_KEY_TARGETS in
// test/terminal-page-scroll.test.js, and for the same reason: one sequence was hardcoded for every
// backend, which made the chord a dead key in the CLIs that do not read it. Changing any backend's answer
// has to fail HERE, by name, so whoever moves it says so out loud.
//
// Each entry was MEASURED: the CLI spawned in a real pty, text typed on either side of the candidate
// sequence, and the rendered screen read back to see whether the composer grew a second row.
//
//   claude  reads the kitty keyboard protocol — CSI 13;2u IS Shift+Enter to it. The one backend the old
//           hardcoded sequence was right for; it is the regression control, so leave it alone.
//   codex   cli 0.151.0 ignores CSI 13;2u and a bare LF alike (the cursor does not move) and inserts a
//           newline on ESC CR. This is the backend #493 was about.
//   pi      inserts a newline on CSI 13;2u — already worked, keeps what it was measured on
//   hermes  inserts a newline on CSI 13;2u — already worked, keeps what it was measured on
//   agy     inserts a newline on CSI 13;2u — already worked, keeps what it was measured on
const NEWLINE_KEY_SEQUENCES = {
  claude: '\x1b[13;2u',
  codex: '\x1b\r',
  pi: '\x1b[13;2u',
  hermes: '\x1b[13;2u',
  agy: '\x1b[13;2u',
};

test('every backend explicitly declares the newline sequence its composer reads', () => {
  for (const backend of BACKENDS) {
    assert.equal(typeof backend.newlineKeySequence, 'string',
      `${backend.id}: newlineKeySequence must be the sequence measured against this CLI`);
    assert.ok(backend.newlineKeySequence.length > 0, `${backend.id}: an empty sequence sends nothing`);
  }
});

test('each backend keeps the newline sequence that was measured for IT', () => {
  for (const backend of BACKENDS) {
    const expected = NEWLINE_KEY_SEQUENCES[backend.id];
    assert.ok(expected,
      `${backend.id}: new backend — type either side of Shift+Enter in a live session and add it to `
      + 'NEWLINE_KEY_SEQUENCES');
    assert.equal(backend.newlineKeySequence, expected,
      `${backend.id}: its newline sequence changed. If that is deliberate, say so by editing `
      + 'NEWLINE_KEY_SEQUENCES — a backend whose chord already worked is the regression control, never '
      + 'collateral of a change aimed at a different one');
  }
});

test('the descriptor newline sequence reaches the renderer', () => {
  assert.match(MAIN, /newlineKeySequence:\s*b\.newlineKeySequence/,
    'backends-list must project newlineKeySequence or every backend silently gets an inert chord');
  assert.match(read('src/backends/index.js'), /newlineKeySequence:\s*base\s*\?\s*base\.newlineKeySequence/,
    'a template must inherit the newline chord of the binary it runs');
});

test('Shift+Enter sends the backend\'s own sequence and never reaches xterm', () => {
  for (const seq of ['\x1b[13;2u', '\x1b\r']) {
    const sent = [];
    const result = handleTerminalNewlineKeyEvent(enterEvent({ shiftKey: true }), seq, s => sent.push(s), false);
    assert.equal(result, false, 'xterm must not also act on the chord');
    assert.deepEqual(sent, [seq]);
  }
});

test('Ctrl+Enter carries the same sequence off macOS, and is not claimed on macOS', () => {
  const sent = [];
  assert.equal(handleTerminalNewlineKeyEvent(enterEvent({ ctrlKey: true }), '\x1b\r', s => sent.push(s), false), false);
  assert.deepEqual(sent, ['\x1b\r'], 'Windows/Linux Ctrl+Enter is the PowerShell convention');

  const onMac = [];
  assert.equal(handleTerminalNewlineKeyEvent(enterEvent({ ctrlKey: true }), '\x1b\r', s => onMac.push(s), true), null,
    'on macOS Ctrl+Enter is not the newline chord — leave it to the terminal');
  assert.deepEqual(onMac, []);
});

test('a backend that declares no sequence gets an INERT chord, never a submit', () => {
  for (const missing of [null, undefined, '']) {
    const sent = [];
    assert.equal(handleTerminalNewlineKeyEvent(enterEvent({ shiftKey: true }), missing, s => sent.push(s), false), false,
      'falling through would let xterm send CR — submitting a half-written prompt nobody gets back');
    assert.deepEqual(sent, []);
  }
});

test('the chord fires once per press, not on keyup as well', () => {
  const sent = [];
  assert.equal(handleTerminalNewlineKeyEvent(enterEvent({ shiftKey: true, type: 'keyup' }), '\x1b\r', s => sent.push(s), false), false);
  assert.deepEqual(sent, [], 'only keydown sends');
});

test('plain Enter and unrelated chords retain their existing xterm handling', () => {
  const cases = [
    enterEvent(),                                        // submit — the CLI\'s own key
    enterEvent({ shiftKey: true, altKey: true }),
    enterEvent({ shiftKey: true, metaKey: true }),
    enterEvent({ shiftKey: true, ctrlKey: true }),
    enterEvent({ key: 'a', shiftKey: true }),
  ];
  for (const event of cases) {
    const sent = [];
    assert.equal(handleTerminalNewlineKeyEvent(event, '\x1b\r', s => sent.push(s), false), null);
    assert.deepEqual(sent, []);
  }
});

test('terminal-manager routes the newline chord through the tested decision', () => {
  assert.match(SRC, /handleTerminalNewlineKeyEvent\(\s*e, getNewlineSequence\?\.\(\)/,
    'the live terminal key handler must use the tested routing helper');
  assert.match(SRC, /return backend\?\.newlineKeySequence/,
    'the mounted session must resolve its sequence from the renderer backend registry');
  assert.doesNotMatch(SRC, /sendInput\([^)]*'\\x1b\[13;2u'/,
    'no CLI-specific sequence may be hardcoded in the shared terminal key handler again');
});
