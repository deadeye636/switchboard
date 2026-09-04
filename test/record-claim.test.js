'use strict';
// #527 — which live session may claim a store record.
//
// `matchLiveSession` correlates by directory and a time window, and nothing in a record says which
// process wrote it. Two unpaired sessions of one backend in one project are enough to break that: the
// core asks them in the order they were opened, so the older one is offered the record the younger one's
// turn just produced, and takes it. These pin the question the correlation never asked — could this
// session have written that record at all?
const test = require('node:test');
const assert = require('node:assert/strict');

const { recordWindowStart, claimVerdict } = require('../src/watch/record-claim');

const T = 1_800_000_000_000;
const GRACE = 10_000;

// ---------------------------------------------------------------------------
// The window a session could have written in
// ---------------------------------------------------------------------------

test('a spawn backend can have written from its spawn onwards', () => {
  assert.equal(recordWindowStart({ _openedAt: T }, 'spawn'), T);
  assert.equal(recordWindowStart({ _openedAt: T }, undefined), T, 'the default');
});

test('a first-turn backend has written nothing until it is asked something', () => {
  // The heart of the observed case: a Codex session sitting at its prompt has no rollout, so it cannot
  // own the one the session next door just produced.
  assert.equal(recordWindowStart({ _openedAt: T }, 'first-turn'), 0);
  assert.equal(recordWindowStart({ _openedAt: T, _firstTurnAt: T + 5000 }, 'first-turn'), T + 5000);
});

test('a session with no times at all owns nothing', () => {
  assert.equal(recordWindowStart({}, 'spawn'), 0);
  assert.equal(recordWindowStart(null, 'spawn'), 0);
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

const ask = (over) => claimVerdict({ graceMs: GRACE, ...over });

test('the one session that could have written it claims it', () => {
  const candidates = [{ sessionId: 'a', from: T }, { sessionId: 'b', from: 0 }];
  assert.equal(ask({ candidates, bornMs: T + 1000, askingId: 'a' }), 'claim');
});

test('the session that could NOT have written it leaves it alone', () => {
  // The reported case, in one line: `a` was opened first and is asked first, but it has no turn behind
  // it, so the record belongs to `b` and `a` must not take it on the way past.
  const candidates = [{ sessionId: 'a', from: 0 }, { sessionId: 'b', from: T }];
  assert.equal(ask({ candidates, bornMs: T + 1000, askingId: 'a' }), 'defer');
  assert.equal(ask({ candidates, bornMs: T + 1000, askingId: 'b' }), 'claim');
});

test('the OLDEST session that could have written it takes it', () => {
  // Both sessions plainly predate the record — the overlap band, where the store's own order decides.
  // `matchLiveSession` offers the oldest unclaimed record, so the oldest eligible session must take it;
  // awarding it to the newest swaps the two sessions' records outright.
  const candidates = [{ sessionId: 'a', from: T }, { sessionId: 'b', from: T + 1000 }];
  assert.equal(ask({ candidates, bornMs: T + 2000, askingId: 'a' }), 'claim');
  assert.equal(ask({ candidates, bornMs: T + 2000, askingId: 'b' }), 'defer');
});

test('a record born before the second session is still the first one\u0027s', () => {
  const candidates = [{ sessionId: 'a', from: T }, { sessionId: 'b', from: T + 8000 }];
  assert.equal(ask({ candidates, bornMs: T + 1000, askingId: 'a' }), 'claim', 'born before b existed');
  assert.equal(ask({ candidates, bornMs: T + 1000, askingId: 'b' }), 'defer');
});

test('the grace is the ASKING session\u0027s alone, and never widens another candidate', () => {
  // The regression a first version shipped: extending the grace to every candidate made `b` a possible
  // writer of a record born before it started, so two sessions eight seconds apart deadlocked and
  // neither ever paired.
  const candidates = [{ sessionId: 'a', from: T }, { sessionId: 'b', from: T + 8000 }];
  assert.equal(ask({ candidates, bornMs: T + 2000, askingId: 'a' }), 'claim');
  // …while the asking session's own window still reaches back over the clock skew.
  assert.equal(ask({ candidates: [{ sessionId: 'a', from: T }], bornMs: T - 5000, askingId: 'a' }), 'claim');
  assert.equal(ask({ candidates: [{ sessionId: 'a', from: T }], bornMs: T - 20_000, askingId: 'a' }), 'defer',
    'too old to be ours, and we know it');
});

test('an exact tie goes to whoever asked, because refusing both would be permanent', () => {
  // A window never changes, so a tie that defers both defers them for the life of the sessions. This is
  // what happened before the module existed and it is the one place that behaviour is kept on purpose.
  const candidates = [{ sessionId: 'a', from: T }, { sessionId: 'b', from: T }];
  assert.equal(ask({ candidates, bornMs: T + 5000, askingId: 'a' }), 'claim');
  assert.equal(ask({ candidates, bornMs: T + 5000, askingId: 'b' }), 'claim');
});

test('a backend that does not date its record keeps the behaviour it had', () => {
  const candidates = [{ sessionId: 'a', from: T }, { sessionId: 'b', from: T }];
  for (const bornMs of [null, undefined, NaN, 'yesterday']) {
    assert.equal(ask({ candidates, bornMs, askingId: 'a' }), 'unknown');
  }
});

test('a record nothing could have written is left to the old behaviour, not refused', () => {
  // Every window is missing — a first-turn backend whose turn was submitted through a path we do not
  // see. Answering 'defer' would strand a session the correlation used to pair, for a signal we may
  // simply have missed.
  assert.equal(ask({ candidates: [{ sessionId: 'a', from: 0 }], bornMs: T, askingId: 'a' }), 'unknown');
  assert.equal(ask({ candidates: [], bornMs: T, askingId: 'a' }), 'unknown');
  assert.equal(ask({}), 'unknown');
});

test('an asker with a start it cannot square with the record defers even when it is alone', () => {
  // It provably did not write this one, whoever did. Claiming it anyway is the mis-pairing of #527 with
  // one candidate instead of two.
  assert.equal(ask({ candidates: [{ sessionId: 'a', from: T }], bornMs: T - 60_000, askingId: 'a' }), 'defer');
});
