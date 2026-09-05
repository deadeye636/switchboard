'use strict';
// Which path arms the redraw nudge (#560).
//
// The nudge itself lives in `src/app/terminal/io.js` and is pinned behaviourally in
// `test/terminal-io.test.js`: `firstResize: true` means the next resize is followed by a cols+1/cols
// wiggle, `false` means it is not. What THIS file pins is the other half — which of the two paths in
// `spawn.js` sets the flag in the first place, because the two want opposite things:
//
//   - the REATTACH path arms it, so a TUI that has been drawing all along repaints into a terminal
//     that was just re-mounted (`test/spawn-guards.test.js` covers that one behaviourally, since a
//     reattach never reaches `pty.spawn`);
//   - a FRESH SPAWN must not, because a CLI that started milliseconds ago has drawn nothing to
//     repaint, and the wiggle only hands it two more geometry changes inside its first 150 ms.
//
// WHY A SOURCE CHECK: `node-pty` is required at module load rather than taken through ctx, so there is
// no seam a test can reach a fresh spawn through — the same reason `test/spawn-timeline-echo.test.js`
// gives for reading this file as text. What a source check can pin is the regression that will actually
// happen: someone restores the symmetry between the two branches because it looks like an oversight.
//
// Measured on a restore of four Claude sessions: the PTY spawns at 120x30, `syncPtySize` pushes the real
// size, and the nudge then adds cols+1 and cols back — three geometry changes while the CLI is drawing
// its first frame. Claude Code counts a fullscreen session as started only once it has drawn a frame and
// survived, and after two failures it drops the machine to its classic renderer without asking.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stripComments } = require('./helpers/strip-comments');

const SPAWN = path.join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js');
const CODE = stripComments(fs.readFileSync(SPAWN, 'utf8'));

test('a freshly spawned session does not arm the redraw nudge (#560)', () => {
  // The session literal built after `pty.spawn` — the only place a fresh session object is made.
  const armed = CODE.match(/firstResize:\s*true/g) || [];
  assert.deepEqual(armed, [],
    'the fresh-spawn session literal must not carry `firstResize: true` — that nudge resizes the PTY '
    + 'twice more while the CLI is drawing its first frame, which is what #560 is about');

  assert.match(CODE, /firstResize:\s*false/,
    'the fresh-spawn session literal still has to SAY what it wants, rather than leaving the flag '
    + 'undefined and the decision unreadable');
});

test('the reattach path still arms it (#560 must not disarm the case the nudge exists for)', () => {
  assert.match(CODE, /session\.firstResize\s*=\s*!session\.isPlainTerminal/,
    'reattaching to a live session arms the nudge, because there a TUI IS already drawing and the '
    + 're-mounted terminal needs the repaint; a plain terminal is excluded because the wiggle gives it '
    + 'a duplicate prompt');
});

test('the stripper is doing its job, so a comment cannot satisfy these checks', () => {
  // A positive control: without it, a regex that stopped matching anything would pass both assertions
  // above by scanning an empty string, and this guard would report success about code it never read.
  assert.ok(CODE.includes('pty.spawn'), 'the stripped source must still hold the code it is asked about');
  assert.ok(!CODE.includes('NOT armed on a fresh spawn'),
    'the prose explaining the decision must be gone, or the check is reading the comment');
});
