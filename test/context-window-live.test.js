'use strict';
// #865: a pipe-driven session that is RUNNING has a live window - the one its runtime reported for the model it is on
// now - and the shared resolver (health badge, Flow tab hint) reads it before the descriptor and the stored row.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createContextWindowResolver } = require('../src/index/context-window');

const backend = { id: 'b1', contextWindow: () => ({ windowTokens: 1000000, model: 'stored' }), contextWindowAsync: async () => ({ windowTokens: 1000000, model: 'stored' }) };

test('a running session\'s live window outranks the stored row, in both the sync and the async form', async () => {
  const live = new Map([['s1', { windowTokens: 200000, model: 'claude-haiku-4-5' }]]);
  const resolver = createContextWindowResolver(() => ({}), { liveWindowOf: (id) => live.get(id) });
  assert.deepEqual(resolver.windowOf({ sessionId: 's1' }, backend), { windowTokens: 200000, model: 'claude-haiku-4-5' });
  assert.deepEqual(await resolver.windowOfAsync({ sessionId: 's1' }, backend), { windowTokens: 200000, model: 'claude-haiku-4-5' });
});

test('a session that is not running, or no live source at all, keeps the descriptor\'s answer', async () => {
  const resolver = createContextWindowResolver(() => ({}), { liveWindowOf: () => null });
  assert.equal(resolver.windowOf({ sessionId: 's2' }, backend).model, 'stored');
  assert.equal((await resolver.windowOfAsync({ sessionId: 's2' }, backend)).model, 'stored');
  assert.equal(createContextWindowResolver(() => ({})).windowOf({ sessionId: 's2' }, backend).model, 'stored');
  const throwing = createContextWindowResolver(() => ({}), { liveWindowOf: () => { throw new Error('x'); } });
  assert.equal(throwing.windowOf({ sessionId: 's2' }, backend).model, 'stored', 'a live source that throws is no answer');
});
