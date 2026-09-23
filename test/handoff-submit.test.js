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

// --- Waiting for the CLI's own word instead of for silence (#640) ---
//
// "700 ms of quiet" is a guess, and on a CLI that pauses mid-startup it is a wrong one: measured on Pi,
// the pause after its update check satisfies it about 1.2 s into a startup that prints until 6.2 s, the
// submit is refused, and the packet is left sitting unsent in the CLI's own composer. Where a backend
// announces its own session, the seeding path waits for that announcement instead — and REPLACES the
// quiet rule with it, because offering the quiet rule as a second chance would keep the bug.
//
// A wiring guard: three names in three files, and nothing else connects them.

test('a backend that announces its session is waited for, not guessed at', () => {
  const body = seedFn();
  assert.match(body, /announcesReady/, 'the primitive takes the backend\'s answer');
  assert.match(body, /sessionWasAnnounced\(liveId\)/,
    'it asks whether the CLI ANNOUNCED. An id comparison also matches the store-file route, and that '
    + 'file is born before the CLI can take a prompt, so it would put this bug back under another cause');
  assert.ok(!/liveId !== sessionId/.test(body), 'and it does not compare ids, for the same reason');
  assert.match(body, /announcesReady \? announced : settled/,
    'it replaces the quiet rule rather than joining it: an OR would fire at the same wrong moment');
  // The definition is not the wiring. Reverting only the branch to `settled` leaves every assertion above
  // matching while the feature is off, so the branch itself is pinned.
  assert.match(body, /if \(pipe \|\| ready \|\| timedOut\)/,
    'the branch consumes `ready` — a `settled` here disables the whole thing with the rest still in place');
});

test('only the CLI\'s own report is recorded as an announcement', () => {
  const IPC = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'shell', 'session-ipc.js'), 'utf8');
  const TRANSITIONS = fs.readFileSync(path.join(ROOT, 'src', 'session', 'session-transitions.js'), 'utf8');
  const PRELOAD = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  const ADOPT = fs.readFileSync(path.join(ROOT, 'src', 'watch', 'adopt.js'), 'utf8');
  assert.match(TRANSITIONS, /applyRekey\(fromId, session, newId, 'announced'\)/,
    'adoptSessionId is the CLI naming its own session, and it is the only origin that says so');
  assert.match(TRANSITIONS, /send\('session-forked', fromId, toId, origin\)/, 'the origin travels');
  assert.match(PRELOAD, /'session-forked', \(_event, oldId, newId, origin\)/, 'and crosses the bridge');
  assert.match(IPC, /origin === 'announced'/, 'the renderer records only that one');
  assert.ok(!/'announced'/.test(ADOPT),
    'a session adopted because a file appeared in a store is not the CLI saying it can take a prompt');
});

test('only a fresh launch may wait for the announcement', () => {
  // The other two callers seed a session that is already running, where the id changed long ago and
  // waiting for it to change again would sit out the timeout.
  const PLANS = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'views', 'plans-memory-view.js'), 'utf8');
  assert.ok(!/announcesReady/.test(HANDOFF), 'the handoff request seeds a running session');
  assert.ok(!/announcesReady/.test(PLANS), 'the plan request seeds a running session');
  assert.match(APP, /announcesReady: !!\(backend && backend\.announcesSessionReady\)/,
    'the launch site reads it off the descriptor');
});

test('the descriptor field travels, and only a backend that can answer declares it', () => {
  const PI = fs.readFileSync(path.join(ROOT, 'src', 'backends', 'pi', 'index.js'), 'utf8');
  const REGISTRY = fs.readFileSync(path.join(ROOT, 'src', 'backends', 'index.js'), 'utf8');
  const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.match(PI, /announcesSessionReady: true/, 'Pi names its own session over its live binding');
  assert.match(REGISTRY, /base\.announcesSessionReady/, 'a template runs the same binary and inherits it');
  assert.match(MAIN, /announcesSessionReady: !!b\.announcesSessionReady/,
    'and it has to cross the descriptor boundary, or the renderer never sees it');
});
