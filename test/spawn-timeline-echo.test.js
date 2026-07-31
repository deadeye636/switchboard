'use strict';
// Every busy/attention fact the terminal produces is echoed to the window that renders the session
// (#395) — a source-level invariant, because this one cannot be driven from a test.
//
// WHY A SOURCE CHECK:
//   The OSC parser lives inside the `onData` handler that `pty.spawn` returns, and `node-pty` is
//   required at module load rather than taken through ctx. So there is no seam here: reaching those
//   lines needs a real PTY and a real CLI, which is what the in-app check covers and what this file
//   deliberately does not pretend to do.
//
//   What a source check CAN pin is the regression that will actually happen: someone adds a fifth place
//   that reports busy, or moves one, and the window of its own silently stops hearing about it. That
//   failure is invisible — the app works, the main window is right, and only the second monitor is
//   quietly wrong. The two producers that DO have a seam (the hook server, the store watcher) are
//   covered behaviourally in test/hook-ingest.test.js and test/live-adopt.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js'), 'utf8');

/** Lines, so a count can be reported against something a reader can find. */
const LINES = SRC.split('\n');
const linesMatching = (re) => LINES
  .map((text, i) => ({ line: i + 1, text }))
  .filter(({ text }) => re.test(text));

test('every busy state the terminal reports is also echoed to the owning window', () => {
  const busySends = linesMatching(/sendToWindow\('cli-busy-state'/);
  const echoes = linesMatching(/echoTimeline\([^)]*'(busy|idle)'/);

  assert.ok(busySends.length >= 4, `expected the OSC-0 and OSC-9;4 edges, found ${busySends.length}`);
  assert.equal(echoes.length, busySends.length,
    `${busySends.length} busy reports to main but ${echoes.length} echoes — a window of its own would `
    + 'hear about some turns and not others, which reads as a flaky app rather than a missing call');
});

test('the echo sits beside its send, not somewhere else in the file', () => {
  // Adjacency is the only thing that keeps the two in step through a later edit: a reviewer moving one
  // sees the other. Allowed distance covers the `if (windowLive()) { … }` wrapper around the send.
  for (const { line } of linesMatching(/sendToWindow\('cli-busy-state'/)) {
    const near = LINES.slice(line, line + 4).join('\n');
    assert.match(near, /echoTimeline\(/,
      `the busy report at line ${line} has no echo within the next few lines`);
  }
});

test('the message notification is classified for the echo rather than relayed raw', () => {
  // The renderer classifies the same payload with the same shared module; sending the raw string would
  // make a window of its own the only place a second reading of one message could appear.
  assert.match(SRC, /classifyAttentionSignal\(\{ source: 'osc9', payload \}\)/);
  assert.match(SRC, /require\('\.\.\/\.\.\/shared\/attention-source'\)/,
    'and it must be the shared module, not a local copy of the rules');
});

test('the echo is a no-op when nothing is wired, so an older ctx cannot throw', () => {
  assert.match(SRC, /if \(ctx\.sendTimelineSignal\)/);
});
