'use strict';
// #530 — does a Pi session still owe a turn?
//
// The core holds a "the agent finished" signal when the CLI still has a prompt queued (#495). Only Claude
// could answer, so a `Stop` arriving with work still pending was believed for every other backend and the
// session sat on Ready while it worked.
//
// The shape under test is a PUSH remembered for a PULL: the per-spawn binding extension reports
// `ctx.hasPendingMessages()` on every lifecycle event, and the core asks synchronously, by transcript
// path, whenever it is deciding whether to hold. The two ends meet through the session id Pi spells into
// its own file name, so the core learns nothing about either.
//
// The most important assertions here are about the answers this must NOT give:
//
//   - "nothing is queued" when it simply has not heard. That releases a hold that was right; `null` is
//     the core's word for today's behaviour and is the honest answer.
//   - "the queued turn started" for anything other than a turn actually beginning. The binding posts a
//     busy edge when a UI prompt ENDS too (#529), and taking that for a turn would release the hold
//     without even the ceiling to catch it.
//
// Both take an explicit `now`, because a clock is the one thing a test must not share with the code.

const test = require('node:test');
const assert = require('node:assert/strict');

const turnQueue = require('../src/backends/pi/turn-queue');

const SESSION = '0199f1ce-4a1b-7c2d-9e3f-1a2b3c4d5e6f';
const TRANSCRIPT = `2026-09-04T10-11-12-345Z_${SESSION}.jsonl`;

// Far enough from zero that the age check has room underneath it.
const T0 = 1_000_000;

test.beforeEach(() => turnQueue._reset());

test('a session nothing has reported for answers null, not "nothing queued" (#530)', () => {
  // The difference the whole hold depends on. `null` means "this backend cannot tell" and the core keeps
  // today's behaviour; `{ queued: 0 }` would be a claim, and a wrong one for every session adopted after
  // a restart or running without the extension.
  assert.equal(turnQueue.readTurnQueue(TRANSCRIPT), null);
  assert.equal(turnQueue.readTurnQueue(TRANSCRIPT, 1000), null);
});

test('a reported pending prompt is answered as queued (#530)', () => {
  turnQueue.noteTurnQueue(SESSION, { pending: true }, T0);
  assert.deepEqual(turnQueue.readTurnQueue(TRANSCRIPT, 0, T0), { queued: 1, turnStarted: false });

  turnQueue.noteTurnQueue(SESSION, { pending: false }, T0);
  assert.deepEqual(turnQueue.readTurnQueue(TRANSCRIPT, 0, T0), { queued: 0, turnStarted: false });
});

test('the count is a boolean in disguise, and says so (#530)', () => {
  // `hasPendingMessages()` answers whether, never how many. The hold only asks whether the number is
  // above zero, so 1 is an honest stand-in — but nothing may come to depend on the depth.
  turnQueue.noteTurnQueue(SESSION, { pending: true }, T0);
  assert.equal(turnQueue.readTurnQueue(TRANSCRIPT, 0, T0).queued, 1);
  turnQueue.noteTurnQueue(SESSION, { pending: true }, T0);
  assert.equal(turnQueue.readTurnQueue(TRANSCRIPT, 0, T0).queued, 1, 'two reports are still "at least one"');
});

// --- what proves a turn started ------------------------------------------------------------------------

test('a turn START after the signal is what releases a hold (#530)', () => {
  const stopAt = T0 + 100;
  turnQueue.noteTurnQueue(SESSION, { pending: true }, T0);
  assert.equal(turnQueue.readTurnQueue(TRANSCRIPT, stopAt, T0 + 200).turnStarted, false, 'nothing has started yet');

  turnQueue.noteTurnQueue(SESSION, { pending: false, turnStart: true }, T0 + 300);
  assert.equal(turnQueue.readTurnQueue(TRANSCRIPT, stopAt, T0 + 400).turnStarted, true);
});

test('a report that is NOT a turn start proves nothing, however recent (#530)', () => {
  // The discriminating case, and the one the binding actually produces: `ui_prompt_end` posts a busy edge
  // (#529) while the hold is running. Reading that as the queued turn having started would release the
  // hold as "it ran" for a turn that never did — and a release drops the signal instead of delivering it,
  // so not even the 60 s ceiling would save it.
  const stopAt = T0 + 100;
  turnQueue.noteTurnQueue(SESSION, { pending: true }, T0);
  for (const report of [{ pending: true }, { pending: false }, { pending: true, turnStart: false }]) {
    turnQueue.noteTurnQueue(SESSION, report, T0 + 300);
    assert.equal(turnQueue.readTurnQueue(TRANSCRIPT, stopAt, T0 + 400).turnStarted, false,
      `${JSON.stringify(report)} is not a turn beginning`);
  }
});

test('a turn start from BEFORE the signal proves nothing (#530)', () => {
  // The turn that has just ended is not the turn the queued prompt will start. Answering true here would
  // release every hold immediately, which is the bug with extra steps.
  turnQueue.noteTurnQueue(SESSION, { pending: true, turnStart: true }, T0);
  assert.equal(turnQueue.readTurnQueue(TRANSCRIPT, T0 + 500, T0 + 600).turnStarted, false);
});

test('a later report does not erase a turn start that already happened (#530)', () => {
  const stopAt = T0 + 100;
  turnQueue.noteTurnQueue(SESSION, { pending: true, turnStart: true }, T0 + 200);
  turnQueue.noteTurnQueue(SESSION, { pending: false }, T0 + 300);
  assert.equal(turnQueue.readTurnQueue(TRANSCRIPT, stopAt, T0 + 400).turnStarted, true,
    'the turn still started, whatever was reported after it');
});

test('sinceMs zero asks nothing about a turn (#530)', () => {
  // The core passes 0 when it is only asking about the queue, and every timestamp is greater than 0.
  turnQueue.noteTurnQueue(SESSION, { pending: true, turnStart: true }, T0);
  assert.equal(turnQueue.readTurnQueue(TRANSCRIPT, 0, T0).turnStarted, false);
  assert.equal(turnQueue.readTurnQueue(TRANSCRIPT, undefined, T0).turnStarted, false);
});

test('a turn starting while a second prompt waits is the ordinary case (#530)', () => {
  turnQueue.noteTurnQueue(SESSION, { pending: true, turnStart: true }, T0 + 200);
  assert.deepEqual(turnQueue.readTurnQueue(TRANSCRIPT, T0 + 100, T0 + 300), { queued: 1, turnStarted: true });
});

// --- what names a session, and how long an answer lasts -------------------------------------------------

test('only a real Pi transcript names a session (#530)', () => {
  turnQueue.noteTurnQueue(SESSION, { pending: true }, T0);
  assert.equal(turnQueue.readTurnQueue(null, 0, T0), null);
  assert.equal(turnQueue.readTurnQueue('', 0, T0), null);
  assert.equal(turnQueue.readTurnQueue('rollout-2026-09-04T10-11-12-something.jsonl', 0, T0), null, "another backend's file");
  assert.equal(turnQueue.readTurnQueue(`${SESSION}.jsonl`, 0, T0), null, 'the id alone is not the name Pi writes');
  // The real thing, spelled with a directory in front of it, which is how the core hands it over.
  assert.ok(turnQueue.readTurnQueue(`\\\\store\\\\sessions\\\\${TRANSCRIPT}`, 0, T0), 'backslash-spelled');
  assert.ok(turnQueue.readTurnQueue(`/store/sessions/${TRANSCRIPT}`, 0, T0), 'slash-spelled');
});

test('a report older than the bound answers null again (#530)', () => {
  // Nothing tells this module that a session ended — the PTY dying reaches the app, not the extension — so
  // a `pending: true` from a killed session would answer about the past until it happened to be evicted.
  turnQueue.noteTurnQueue(SESSION, { pending: true }, T0);
  assert.ok(turnQueue.readTurnQueue(TRANSCRIPT, 0, T0 + turnQueue.MAX_AGE_MS), 'still inside the bound');
  assert.equal(turnQueue.readTurnQueue(TRANSCRIPT, 0, T0 + turnQueue.MAX_AGE_MS + 1), null, 'past it');
  // And it is dropped rather than re-checked on every ask.
  assert.equal(turnQueue._size(), 0);
});

test('a report without a usable pending value is ignored (#530)', () => {
  // An older Pi has no `hasPendingMessages`, so `pending` is absent from the JSON. Recording that as
  // `false` would be the "nothing queued" claim this module refuses to make.
  turnQueue.noteTurnQueue(SESSION, { turnStart: true }, T0);
  turnQueue.noteTurnQueue(SESSION, { pending: 'yes' }, T0);
  turnQueue.noteTurnQueue(SESSION, {}, T0);
  turnQueue.noteTurnQueue(null, { pending: true }, T0);
  assert.equal(turnQueue.readTurnQueue(TRANSCRIPT, 0, T0), null);
});

test('a session that ended is forgotten (#530)', () => {
  turnQueue.noteTurnQueue(SESSION, { pending: true }, T0);
  turnQueue.forgetSession(SESSION);
  assert.equal(turnQueue.readTurnQueue(TRANSCRIPT, 0, T0), null);
  turnQueue.forgetSession(null);          // not an error
});

test('the map is bounded, and evicts by last use (#530)', () => {
  const idFor = (n) => `0199f1ce-4a1b-7c2d-9e3f-${String(n).padStart(12, '0')}`;
  const fileFor = (n) => `2026-09-04T10-11-12-345Z_${idFor(n)}.jsonl`;

  for (let n = 0; n < turnQueue.MAX_ENTRIES; n++) turnQueue.noteTurnQueue(idFor(n), { pending: true }, T0);
  assert.equal(turnQueue._size(), turnQueue.MAX_ENTRIES);

  // Touch one in the MIDDLE, then overflow past where it sat. Two things this shape is careful about, and
  // both are ways the assertion passes while proving nothing:
  //   - touching the OLDEST proves nothing, because the overflow evicts and re-adds it either way;
  //   - one insertion after the touch proves nothing either, because a `Map.set` on an existing key keeps
  //     the key where it was, so the entry has not moved far enough for its position to matter.
  // Insert enough that the touched entry's ORIGINAL position is long gone: only a re-insert saves it.
  const touched = Math.floor(turnQueue.MAX_ENTRIES / 2);
  turnQueue.noteTurnQueue(idFor(touched), { pending: true }, T0);
  for (let n = 0; n < touched + 2; n++) turnQueue.noteTurnQueue(idFor(1000 + n), { pending: true }, T0);

  assert.equal(turnQueue._size(), turnQueue.MAX_ENTRIES);
  assert.ok(turnQueue.readTurnQueue(fileFor(touched), 0, T0), 'the recently reported session survived');
  assert.ok(turnQueue.readTurnQueue(fileFor(1000 + touched + 1), 0, T0), 'and so did the newest');
  assert.equal(turnQueue.readTurnQueue(fileFor(0), 0, T0), null, 'the least recently used went');
});
