'use strict';
// Spec 39, T9: a session a review started (`_review`, set by the spawn path) raises no attention. Its busy, idle and
// waiting edges reach the timeline and nothing else: no `cli-busy-state` and no `attention-signal` to the window, so
// no notification, inbox entry, chime or badge. An ordinary session is unchanged. Driven through the real
// `deliverBindSignal`, the one delivery both a terminal binding and a pipe-driven session use.
const test = require('node:test');
const assert = require('node:assert/strict');

const hooks = require('../src/app/hooks');

function setup(sessions) {
  const sent = [];
  const timeline = [];
  hooks.init({
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel, ...args) => sent.push([channel, ...args]) } }),
    getSetting: () => ({}),
    activeSessions: new Map(sessions),
    indexWorker: { postFile: () => {} },
    sendTimelineSignal: (id, signal) => timeline.push([id, signal.kind]),
    log: { info() {}, warn() {}, debug() {}, error() {} },
    isPackaged: true,
  });
  return { sent, timeline };
}

const EDGES = [{ kind: 'busy' }, { kind: 'waiting', prompt_kind: 'confirm' }, { kind: 'idle' }];

test('a review session\'s busy, waiting and idle edges reach the timeline and nothing else', () => {
  const { sent, timeline } = setup([['rev', { _review: true, _spawnedBy: 'caller' }]]);
  for (const edge of EDGES) hooks.deliverBindSignal('rev', edge);
  assert.deepEqual(sent, [], 'no busy edge and no attention signal reach the window');
  assert.deepEqual(timeline.map(([id]) => id), ['rev', 'rev', 'rev']);
  assert.deepEqual(timeline.map(([, kind]) => kind), ['busy', 'needs-attention', 'idle']);
});

test('a review session adopted onto its runtime\'s id is found by that id', () => {
  const { sent, timeline } = setup([['launch-id', { _review: true, realSessionId: 'runtime-id' }]]);
  hooks.deliverBindSignal('runtime-id', { kind: 'waiting', prompt_kind: 'input' });
  assert.deepEqual(sent, []);
  assert.equal(timeline.length, 1);
});

test('an ordinary session is unchanged: its edges reach the window and the timeline', () => {
  const { sent, timeline } = setup([['plain', {}], ['rev', { _review: true }]]);
  for (const edge of EDGES) hooks.deliverBindSignal('plain', edge);
  assert.deepEqual(sent.filter(([c]) => c === 'cli-busy-state').map(([, id, busy]) => [id, busy]), [['plain', true], ['plain', false], ['plain', false]]);
  assert.equal(sent.filter(([c]) => c === 'attention-signal').length, 1, 'the waiting edge raises attention');
  assert.equal(timeline.length, 3);
  const unknown = setup([]);
  hooks.deliverBindSignal('nobody', { kind: 'busy' });
  assert.equal(unknown.sent.length, 1, 'a session the app does not hold is not a review');
});

test('a review session\'s subagent edges stay off the attention channel and reach the timeline', () => {
  const { sent, timeline } = setup([['rev', { _review: true }]]);
  hooks.deliverBindSignal('rev', { kind: 'subagent-start', agent_id: 'a1' });
  hooks.deliverBindSignal('rev', { kind: 'subagent-stop', agent_id: 'a1' });
  assert.deepEqual(sent, []);
  assert.equal(timeline.length, 2);
});

// Documented, not a guard: a user who opens the review row and types into it is still in a review session, and it
// stays silent. The flag belongs to the session, not to who is typing.
test('a review session the user types into stays silent', () => {
  const { sent } = setup([['rev', { _review: true }]]);
  hooks.deliverBindSignal('rev', { kind: 'busy', turn_start: true });
  hooks.deliverBindSignal('rev', { kind: 'idle' });
  assert.deepEqual(sent, []);
});
