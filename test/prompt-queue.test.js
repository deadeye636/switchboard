// The staged-prompt queue and its delivery gate (#614).
//
// The queue is a pure module on purpose: the two rules that decide whether a staged prompt may be typed
// into a live session — the status, and whether the user has something half-typed in the session's own
// prompt line — are exactly the kind of thing the renderer's suite cannot see. Nothing here touches the
// DOM, a timer or `window.api`.
//
// The status half is asserted against the REAL `getSessionStatus`, not against hand-written keys: the
// gate's whole claim is that it agrees with the status vocabulary every indicator already reads, and a
// test that invents its own keys would keep passing while the two drifted apart.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROMPT_QUEUE_DELIVERABLE_STATUSES,
  createPromptQueue,
  promptQueueFor,
  promptQueueCount,
  enqueuePrompt,
  removeQueuedPrompt,
  clearQueuedPrompts,
  rekeyQueuedPrompts,
  nextDeliverable,
  promptLineEffectOf,
  promptLineDirtyAfter,
} = require('../src/renderer/shell/prompt-queue');

const { getSessionStatus } = require('../src/renderer/session/session-status');

const SID = 'session-a';

function queueWith(...texts) {
  let state = createPromptQueue();
  for (const text of texts) state = enqueuePrompt(state, SID, text, { at: 1 });
  return state;
}

// The runtime snapshot that makes `getSessionStatus` answer each of the six statuses, built the way the
// app builds it — so the keys under test are the ones the sidebar dot, the tab dot and the grid card read.
function runtimeFor(statusKey) {
  const base = {
    attentionSessions: new Set(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map(),
    activePtyIds: new Set(),
    openSessions: new Map(),
    pendingSessions: new Map(),
    launchExitedSessions: new Set(),
  };
  if (statusKey === 'needs-attention') base.attentionSessions.add(SID);
  else if (statusKey === 'response-ready') base.responseReadySessions.add(SID);
  else if (statusKey === 'busy') base.sessionBusyState.set(SID, true);
  else if (statusKey === 'running') base.activePtyIds.add(SID);
  else if (statusKey === 'exited') base.openSessions.set(SID, { closed: true });
  // 'idle' is the fall-through: nothing set at all, which is what "no live PTY" looks like.
  return base;
}

function statusOf(statusKey) {
  const status = getSessionStatus({ sessionId: SID }, runtimeFor(statusKey));
  assert.equal(status.key, statusKey, `the runtime built for "${statusKey}" must actually produce it`);
  return status;
}

test('the deliverable set is running and response-ready, and nothing else', () => {
  assert.deepEqual(PROMPT_QUEUE_DELIVERABLE_STATUSES.slice().sort(), ['response-ready', 'running']);
});

// One assertion per status, each named after the status it covers: reverting the gate to any other set
// fails by name here rather than as one opaque "gate wrong".
test('the gate delivers in `running`', () => {
  const item = nextDeliverable(queueWith('first'), SID, { status: statusOf('running'), dirty: false });
  assert.equal(item.text, 'first');
});

test('the gate delivers in `response-ready`', () => {
  const item = nextDeliverable(queueWith('first'), SID, { status: statusOf('response-ready'), dirty: false });
  assert.equal(item.text, 'first');
});

test('the gate never delivers in `busy`', () => {
  assert.equal(nextDeliverable(queueWith('first'), SID, { status: statusOf('busy'), dirty: false }), null);
});

test('the gate never delivers in `needs-attention`', () => {
  assert.equal(nextDeliverable(queueWith('first'), SID, { status: statusOf('needs-attention'), dirty: false }), null);
});

test('the gate never delivers in `exited`', () => {
  assert.equal(nextDeliverable(queueWith('first'), SID, { status: statusOf('exited'), dirty: false }), null);
});

// The correction to #614's body: `idle` is the fall-through for a session with no live PTY, so it blocks
// for the opposite reason to the rest — there is nothing to deliver INTO. The issue inherited "idle or
// response-ready" from #275, and a gate written to that wording would have fired for nothing that could
// listen. This assertion is what keeps it from being "fixed" back.
test('the gate never delivers in `idle` — there is no live PTY to deliver into', () => {
  assert.equal(nextDeliverable(queueWith('first'), SID, { status: statusOf('idle'), dirty: false }), null);
});

test('the gate never delivers while the prompt line is dirty, in either deliverable status', () => {
  for (const key of ['running', 'response-ready']) {
    assert.equal(
      nextDeliverable(queueWith('first'), SID, { status: statusOf(key), dirty: true }), null,
      `a dirty line must block delivery in ${key}`,
    );
  }
});

test('a bare status key is accepted as well as a status object', () => {
  assert.equal(nextDeliverable(queueWith('first'), SID, { status: 'running' }).text, 'first');
  assert.equal(nextDeliverable(queueWith('first'), SID, { status: 'busy' }), null);
});

test('an unknown or missing status blocks rather than delivers', () => {
  assert.equal(nextDeliverable(queueWith('first'), SID, {}), null);
  assert.equal(nextDeliverable(queueWith('first'), SID, { status: 'made-up' }), null);
  assert.equal(nextDeliverable(queueWith('first'), SID), null);
});

test('an empty queue delivers nothing, whatever the gate says', () => {
  assert.equal(nextDeliverable(createPromptQueue(), SID, { status: 'running', dirty: false }), null);
});

test('items deliver oldest first, one at a time', () => {
  const state = queueWith('first', 'second');
  const gate = { status: 'running', dirty: false };
  const first = nextDeliverable(state, SID, gate);
  assert.equal(first.text, 'first');
  const afterFirst = removeQueuedPrompt(state, SID, first.id);
  assert.equal(nextDeliverable(afterFirst, SID, gate).text, 'second');
});

test('a queue is per session — one session\'s gate says nothing about another\'s', () => {
  let state = enqueuePrompt(createPromptQueue(), 'a', 'for a', { at: 1 });
  state = enqueuePrompt(state, 'b', 'for b', { at: 2 });
  assert.equal(nextDeliverable(state, 'a', { status: 'running' }).text, 'for a');
  assert.equal(nextDeliverable(state, 'b', { status: 'busy' }), null);
  assert.equal(promptQueueCount(state, 'b'), 1);
});

test('the state is plain, serializable and never mutated in place', () => {
  const before = queueWith('first');
  const snapshot = JSON.stringify(before);
  const after = enqueuePrompt(before, SID, 'second', { at: 2 });
  assert.equal(JSON.stringify(before), snapshot, 'enqueue must not mutate the state it was given');
  assert.deepEqual(JSON.parse(JSON.stringify(after)), after);
  assert.deepEqual(Object.keys(after[SID][0]).sort(), ['at', 'id', 'text']);
});

test('blank text stages nothing and returns the state untouched', () => {
  const state = createPromptQueue();
  assert.equal(enqueuePrompt(state, SID, '   '), state);
  assert.equal(enqueuePrompt(state, SID, ''), state);
  assert.equal(enqueuePrompt(state, '', 'text'), state);
  assert.equal(promptQueueCount(enqueuePrompt(state, SID, null), SID), 0);
});

test('text is trimmed and ids are unique within a session', () => {
  const state = queueWith('  padded  ', 'second');
  assert.equal(promptQueueFor(state, SID)[0].text, 'padded');
  assert.notEqual(promptQueueFor(state, SID)[0].id, promptQueueFor(state, SID)[1].id);
});

test('removing the last item drops the session key entirely', () => {
  const state = queueWith('only');
  const emptied = removeQueuedPrompt(state, SID, promptQueueFor(state, SID)[0].id);
  assert.deepEqual(Object.keys(emptied), []);
});

test('removing an id that is not there changes nothing', () => {
  const state = queueWith('only');
  assert.equal(removeQueuedPrompt(state, SID, 'no-such-id')[SID].length, 1);
  assert.equal(removeQueuedPrompt(state, 'no-such-session', 'x'), state);
});

test('clearing a session takes every item and leaves the others alone', () => {
  let state = queueWith('first', 'second');
  state = enqueuePrompt(state, 'other', 'theirs', { at: 3 });
  const cleared = clearQueuedPrompts(state, SID);
  assert.equal(promptQueueCount(cleared, SID), 0);
  assert.equal(promptQueueCount(cleared, 'other'), 1);
  assert.equal(clearQueuedPrompts(cleared, SID), cleared, 'clearing nothing returns the same state');
});

test('a re-key moves a queue onto the new id, oldest first', () => {
  const state = queueWith('first', 'second');
  const moved = rekeyQueuedPrompts(state, SID, 'session-b');
  assert.equal(promptQueueCount(moved, SID), 0);
  assert.deepEqual(promptQueueFor(moved, 'session-b').map(i => i.text), ['first', 'second']);
  assert.equal(rekeyQueuedPrompts(state, SID, SID), state);
  assert.equal(rekeyQueuedPrompts(state, 'unknown', 'session-b'), state);
});

// --- The dirty prompt line ---

test('a submit clears the line — carriage return and newline both', () => {
  for (const key of ['\r', '\n', '\r\n']) {
    assert.equal(promptLineEffectOf(key), 'submit');
    assert.equal(promptLineDirtyAfter(true, key), false, `${JSON.stringify(key)} must clear the line`);
  }
});

// ENCODES A LIVE MEASUREMENT, and it replaced the opposite assertion. These used to be classified
// 'cancel'/'kill' and to CLEAR the line, on the reasoning that Esc and Ctrl-C abandon what was typed and
// Ctrl-U kills it. In Claude Code 2.1.267: a prompt was staged, `half typed by hand` was left in the
// composer, Esc was pressed — and the staged prompt was delivered into the line that was still there. The
// turn the CLI answered read `half typed by handow summarise what you counted in one sentence.`, and it
// remarked that the message looked cut off mid-typing.
//
// Whether a key empties a composer is that CLI's business rather than a terminal fact, and nobody has
// measured the other four backends. So only a submit clears — the note in `shell/prompt-queue.js` argues
// the direction: a hold that lasts too long is visible and one keystroke ends it, a merge is neither.
test('a cancel does NOT clear the line — Esc and Ctrl-C leave it dirty', () => {
  for (const key of ['\x1b', '\x03']) {
    assert.equal(promptLineEffectOf(key), 'type', `${JSON.stringify(key)} may not be read as emptying the line`);
    assert.equal(promptLineDirtyAfter(true, key), true, 'a line that was dirty stays dirty');
    assert.equal(promptLineDirtyAfter(false, key), true, 'and it cannot make a clean line deliverable');
  }
});

test('a line kill does NOT clear the line either — Ctrl-U', () => {
  assert.equal(promptLineEffectOf('\x15'), 'type');
  assert.equal(promptLineDirtyAfter(true, '\x15'), true);
});

test('there are only three effects, and only one of them clears', () => {
  // The vocabulary itself is the guard: reintroducing a 'cancel' or a 'kill' means reintroducing a claim
  // about one CLI's input widget that this codebase cannot make for the other four (CLAUDE.md reflex 5).
  const seen = new Set(['', 'a', '\r', '\n', '\x1b', '\x03', '\x15', '\x1b[A', '\x1b[?1;2c', 'hello\r']
    .map(promptLineEffectOf));
  assert.deepEqual([...seen].sort(), ['none', 'submit', 'type']);
});

test('anything else makes the line dirty', () => {
  for (const key of ['a', 'hello', '\x7f', '\t', '\x1b[A', '\x1b[B', ' ']) {
    assert.equal(promptLineEffectOf(key), 'type', `${JSON.stringify(key)} should count as typing`);
    assert.equal(promptLineDirtyAfter(false, key), true);
  }
});

test('an empty or non-string chunk leaves the line as it was', () => {
  assert.equal(promptLineEffectOf(''), 'none');
  assert.equal(promptLineDirtyAfter(true, ''), true);
  assert.equal(promptLineDirtyAfter(false, ''), false);
  assert.equal(promptLineDirtyAfter(true, undefined), true);
  assert.equal(promptLineDirtyAfter(false, null), false);
});

test('typing then submitting takes a session from blocked to deliverable', () => {
  const state = queueWith('staged');
  let dirty = false;
  dirty = promptLineDirtyAfter(dirty, 'h');
  dirty = promptLineDirtyAfter(dirty, 'i');
  assert.equal(nextDeliverable(state, SID, { status: 'running', dirty }), null);
  dirty = promptLineDirtyAfter(dirty, '\r');
  assert.equal(nextDeliverable(state, SID, { status: 'running', dirty }).text, 'staged');
});

// --- The terminal's own answers are not keystrokes ---
//
// `terminal.onData` is not a keyboard: xterm replies to the CLI on that same channel, unprompted and
// without the user touching anything. Every one of these used to read as typing and hold a staged prompt
// for the life of the window — the wheel one silently, on a scroll nobody would connect to a prompt that
// never arrived.

test('a device attributes reply leaves the line untouched — primary and secondary', () => {
  for (const reply of ['\x1b[?1;2c', '\x1b[?6c', '\x1b[?62;1;2;6;8;9;15;22c', '\x1b[>0;276;0c', '\x1b[>c']) {
    assert.equal(promptLineEffectOf(reply), 'none', `${JSON.stringify(reply)} is the terminal answering, not the user`);
    assert.equal(promptLineDirtyAfter(false, reply), false);
    assert.equal(promptLineDirtyAfter(true, reply), true, 'it says nothing about the line, so it changes nothing');
  }
});

test('a device status or cursor position report leaves the line untouched', () => {
  for (const reply of ['\x1b[0n', '\x1b[3n', '\x1b[24;80R', '\x1b[1;1R']) {
    assert.equal(promptLineEffectOf(reply), 'none');
    assert.equal(promptLineDirtyAfter(false, reply), false);
  }
});

test('a mouse report leaves the line untouched — one wheel notch used to block delivery forever', () => {
  for (const reply of [
    '\x1b[<64;10;20M',   // wheel up
    '\x1b[<65;10;20M',   // wheel down
    '\x1b[<2;10;20M',    // right button down
    '\x1b[<2;10;20m',    // …and up
    '\x1b[<1;10;20M',    // middle button
    '\x1b[M !!',         // the older X10 encoding: three coordinate bytes
  ]) {
    assert.equal(promptLineEffectOf(reply), 'none', `${JSON.stringify(reply)} is the mouse, not the keyboard`);
    assert.equal(promptLineDirtyAfter(false, reply), false);
  }
});

test('a focus report leaves the line untouched — the same family the terminal filter caught alone', () => {
  for (const reply of ['\x1b[I', '\x1b[O']) {
    assert.equal(promptLineEffectOf(reply), 'none');
    assert.equal(promptLineDirtyAfter(false, reply), false);
  }
});

test('two replies arriving in one chunk are still both replies', () => {
  assert.equal(promptLineEffectOf('\x1b[?1;2c\x1b[0n'), 'none');
  assert.equal(promptLineEffectOf('\x1b[<64;1;1M\x1b[<64;1;1M'), 'none');
});

test('a real byte mixed in with a reply falls through to the ordinary rules', () => {
  // The safe direction: anything this rule cannot account for in full is treated as the user typing.
  assert.equal(promptLineEffectOf('\x1b[0nx'), 'type');
  assert.equal(promptLineEffectOf('x\x1b[0n'), 'type');
});

test('the arrow keys stay dirty, deliberately — a wheel over an alt-screen TUI sends them', () => {
  // The trade is stated in the rule module: an arrow can pull a previous prompt out of history into the
  // line, and there is no way to tell that one from a wheel notch. Being wrong here costs a delayed
  // delivery, which the chip says out loud; being wrong the other way merges two prompts into one.
  for (const key of ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1bOA', '\x1b[1;5C']) {
    assert.equal(promptLineEffectOf(key), 'type', `${JSON.stringify(key)} must stay on the dirty side`);
  }
});

test('a bracketed paste is input, not a reply', () => {
  assert.equal(promptLineEffectOf('\x1b[200~hello\x1b[201~'), 'type');
});

// --- A chunk, not a keystroke ---
//
// The signal is taken at `window.api.sendInput`, so what arrives is whatever a WRITER passed in one call.
// Reading a submit as an exact match was right for a keyboard and wrong for every other writer in
// `src/renderer/**`: the seed insert sends its text and the return together.

test('a chunk that ends in a return submits the line', () => {
  for (const chunk of ['hello\r', 'hello\n', 'hello\r\n', '\x1b[200~seed text\x1b[201~\r', 'a\nb\n']) {
    assert.equal(promptLineEffectOf(chunk), 'submit', `${JSON.stringify(chunk)} ends the line`);
    assert.equal(promptLineDirtyAfter(true, chunk), false);
  }
});

test('a return in the MIDDLE of a chunk does not — what follows it is still in the line', () => {
  assert.equal(promptLineEffectOf('foo\rbar'), 'type');
  assert.equal(promptLineDirtyAfter(false, 'foo\rbar'), true);
});

test('the newline chord ends in a return and does NOT submit — ESC before it makes it a sequence', () => {
  // Shift+Enter sends the backend's declared sequence. One CLI declares `\x1b\r`; the rest declare the
  // kitty protocol's `\x1b[13;2u`, which ends in `u` and needs no exception. Both insert a newline in the
  // composer, so the line is fuller than it was.
  for (const chord of ['\x1b\r', '\x1b\n', '\x1b[13;2u']) {
    assert.equal(promptLineEffectOf(chord), 'type', `${JSON.stringify(chord)} inserts, it does not send`);
    assert.equal(promptLineDirtyAfter(false, chord), true);
  }
});

test('a bracketed paste holds even when its CONTENT ends in a newline', () => {
  // The closing marker is the last byte, which is what keeps this on the right side: a paste never
  // submits, however many line breaks are inside it.
  assert.equal(promptLineEffectOf('\x1b[200~one\ntwo\n\x1b[201~'), 'type');
});
