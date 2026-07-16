const { test } = require('node:test');
const assert = require('node:assert');
const { computeHandoffActions } = require('../src/renderer/handoff/handoff-actions.js');

// A handoff is a PACKET — a summary of the actual state, written by an agent. There are two ways to get
// one, and which one you want is a real choice, so the dialog asks instead of guessing:
//
//   'this' — this session's agent summarises what it is holding (resumed for one turn if it is stopped)
//   'new'  — a fresh agent reads this session's transcript and writes the packet itself
//
// What the app used to do instead: with no live agent it quietly saved a "starter" — a metadata skeleton
// telling the next session to work the state out for itself. It looked like a handoff in the library and
// contained no summary at all.

test('a running session: ask its agent, or let a new one read it', () => {
  const a = computeHandoffActions({ canAskRunning: true, hasProject: true, canReadTranscript: true });
  assert.deepStrictEqual(a.producers.map(p => p.id), ['this', 'new']);
  assert.strictEqual(a.producers[0].needsResume, false);
});

test('a stopped session offers the same two — its agent is simply resumed for one turn', () => {
  const a = computeHandoffActions({ canAskRunning: false, hasProject: true, canReadTranscript: true });
  assert.deepStrictEqual(a.producers.map(p => p.id), ['this', 'new']);
  assert.strictEqual(a.producers[0].needsResume, true, 'and it says so');
  assert.match(a.producers[0].detail, /resumed/i);
  assert.match(a.producers[0].detail, /tokens/i, 'spending tokens is never a surprise');
});

test('with no readable transcript, only its own agent can write the packet', () => {
  // Nothing to read: a session that has not written a transcript yet (or a backend that cannot expose it).
  const a = computeHandoffActions({ canAskRunning: true, hasProject: true, canReadTranscript: false });
  assert.deepStrictEqual(a.producers.map(p => p.id), ['this']);
});

test('with no project there is nowhere to launch a reader', () => {
  const a = computeHandoffActions({ canAskRunning: true, hasProject: false, canReadTranscript: true });
  assert.deepStrictEqual(a.producers.map(p => p.id), ['this']);
});

test('the local starter is always reachable — and is never a producer', () => {
  const a = computeHandoffActions({ canAskRunning: false, hasProject: false, canReadTranscript: false });
  assert.strictEqual(a.starter, true, 'you can always copy it somewhere');
  assert.ok(!a.producers.some(p => p.id === 'starter'), 'but it writes no packet — it contains no summary');
});

test('every producer states that it spends tokens', () => {
  const a = computeHandoffActions({ canAskRunning: false, hasProject: true, canReadTranscript: true });
  for (const p of a.producers) {
    assert.strictEqual(p.spendsTokens, true);
    assert.ok(p.detail && p.detail.length > 20, `${p.id} must explain itself`);
  }
});
