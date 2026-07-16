'use strict';
// A prompt typed into an agent has to be SUBMITTED, or nobody was asked.
//
// Enter is a CARRIAGE RETURN on a terminal (0x0D). A line feed (0x0A) only moves the cursor down. The
// handoff had two routes that both paste a prompt into a session, written at different times:
//
//   route 2 (a fresh agent reads the old session) ended its paste with `\r`  — correct
//   route 1 (this agent summarises itself)        ended its paste with `\n`  — pasted, never submitted
//
// So route 1 dropped the prompt into the input box and left it there, while the code right below it sat
// polling the transcript for an answer that could only ever arrive if the user pressed Enter themselves.
// The toast said "Asked the agent for a handoff". It had asked nobody. Reported from the field: with
// Hermes the pasted block even became a file in its TUI, which made the dead end look like a feature.
//
// Both routes go through ONE function now. These tests pin the byte and the single door.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const HANDOFF = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'handoff', 'handoff.js'), 'utf8');

/** The one place a prompt is pasted into a session. */
function seedFn() {
  const start = APP.indexOf('function seedSessionWhenReady(');
  assert.notEqual(start, -1, 'the shared seeding primitive must exist');
  const rest = APP.slice(start);
  return rest.slice(0, rest.indexOf('\n}\n') + 2);
}

test('the paste is submitted with a carriage return, not a line feed', () => {
  const body = seedFn();
  assert.match(body, /\\x1b\[200~\$\{seedText\}\\x1b\[201~\\r/,
    'bracketed paste, then CR. A \\n here is the difference between asking an agent and typing at it.');
  assert.ok(!/\\x1b\[201~\\n/.test(body), 'a line feed does not submit anything');
});

test('the bracketed-paste markers are still there — a multi-line packet must survive as one input', () => {
  const body = seedFn();
  assert.match(body, /\\x1b\[200~/);
  assert.match(body, /\\x1b\[201~/);
});

// The bug existed because two places did the same thing and one of them was wrong. There is one now.
test('the handoff does not paste into a session on its own any more', () => {
  assert.ok(!/sendInput\([^)]*\[200~/.test(HANDOFF),
    'handoff.js must not build its own paste sequence — it goes through seedSessionWhenReady');
  assert.match(HANDOFF, /seedSessionWhenReady\(session\.sessionId, requestPrompt/,
    'the "this agent writes it" route uses the shared primitive');
});

test('the seeding waits for the CLI to fall quiet, and for a slow one to boot at all', () => {
  const body = seedFn();
  assert.match(body, /SETTLE_MS/, 'never type into an agent that is still printing');
  assert.match(body, /elapsed < graceMs/, 'and a resumed Hermes needs ~12 s of Python imports first');
});

// Both routes seed; the timeline should say which one did, rather than claiming a fresh session was
// seeded when an existing one was asked to summarise itself.
test('the timeline entry says what actually happened', () => {
  const body = seedFn();
  assert.match(body, /timelineLabel \|\| 'Handoff seeded'/);
  assert.match(HANDOFF, /timelineLabel: 'Handoff requested'/);
});
