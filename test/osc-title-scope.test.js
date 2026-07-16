'use strict';
// The OSC-0 title busy heuristic is CLAUDE's, and must only run for Claude.
//
// The rule it encodes: a Braille spinner glyph in the window title means busy; the character ✳ means
// idle. The busy half is generic enough to fire on any TUI that spins in its title — Codex does. The idle
// half is not generic at all: no other CLI has any reason to write a ✳.
//
// So on a Codex session the latch closed on the first spinner frame and never opened again. The session
// sat at "working" forever while it waited at its prompt — reported from the field, and exactly what you
// would predict from reading the two lines together.
//
// Every other backend reports its own state through `liveState` (Codex reads its rollout tail). This
// heuristic exists precisely because Claude does not.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js'), 'utf8');

test('the OSC-0 title heuristic is gated on the session that owns it', () => {
  assert.match(MAIN, /if \(code === '0' && session\._oscTitleState\)/,
    'the title heuristic must not run for a backend that never writes Claude\'s idle glyph');
});

test('...and the gate is set from the binary, not from the backend id', () => {
  // A Claude TEMPLATE (Axis-A) runs the claude binary and therefore spins Claude's spinner — it must
  // keep the heuristic. Keying on `backend.id === 'claude'` would have silently dropped it.
  assert.match(MAIN, /oscTitleState = isClaudeBinary;/);
  assert.match(MAIN, /const isClaudeBinary = launch\.command === 'claude';/);
});

test('the session carries the flag, so the data handler can see it', () => {
  assert.match(MAIN, /_oscTitleState: oscTitleState,/);
});

// The busy latch is what makes the bug permanent rather than momentary: once `_cliBusy` is set, only the
// ✳ branch clears it. Pin that this is still a latch, so nobody "fixes" the symptom by making the busy
// side stricter and leaves the trap armed for the next backend.
test('the idle half of the heuristic is the literal glyph — which is why it cannot be generic', () => {
  const osc0 = MAIN.slice(MAIN.indexOf("if (code === '0' && session._oscTitleState)"));
  const block = osc0.slice(0, osc0.indexOf('\n        }'));
  assert.match(block, /const isIdle = firstChar === '\\u2733'/,
    'if this ever stops being Claude-specific, the gate above can go — until then it must stay');
});
