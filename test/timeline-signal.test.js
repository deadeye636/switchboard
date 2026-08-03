'use strict';

const test = require('node:test');
const assert = require('node:assert');

const timeline = require('../src/app/timeline');

function harness() {
  const written = [];
  timeline.init({
    recordTimelineEvent: (event) => { written.push(event); return event; },
    log: { debug() {} },
  });
  return written;
}

const kinds = (written) => written.map((e) => e.kind);

test('a busy signal records one working event', () => {
  const written = harness();
  timeline.recordSignal('s1', { kind: 'busy' });
  assert.deepStrictEqual(kinds(written), ['busy']);
  assert.strictEqual(written[0].sessionId, 's1');
  assert.strictEqual(written[0].label, 'Agent working');
});

test('busy repeated is not a second edge', () => {
  const written = harness();
  timeline.recordSignal('s1', { kind: 'busy' });
  timeline.recordSignal('s1', { kind: 'busy' });
  timeline.recordSignal('s1', { kind: 'busy' });
  assert.deepStrictEqual(kinds(written), ['busy'], 'a spinner reports per frame; the record is per turn');
});

test('the end of a turn records BOTH idle and response-ready', () => {
  const written = harness();
  timeline.recordSignal('s1', { kind: 'busy' });
  timeline.recordSignal('s1', { kind: 'idle' });
  assert.deepStrictEqual(kinds(written), ['busy', 'idle', 'response-ready']);
});

test('ready is the same edge as idle', () => {
  const written = harness();
  timeline.recordSignal('s1', { kind: 'busy' });
  timeline.recordSignal('s1', { kind: 'ready' });
  assert.deepStrictEqual(kinds(written), ['busy', 'idle', 'response-ready']);
});

test('an idle report about a session that was never seen working records nothing', () => {
  const written = harness();
  timeline.recordSignal('s1', { kind: 'idle' });
  timeline.recordSignal('s1', { kind: 'ready' });
  assert.deepStrictEqual(kinds(written), [],
    'after a restart the latch is empty — an idle session is not the end of a turn');
});

test('idle repeated does not repeat the turn end', () => {
  const written = harness();
  timeline.recordSignal('s1', { kind: 'busy' });
  timeline.recordSignal('s1', { kind: 'idle' });
  timeline.recordSignal('s1', { kind: 'idle' });
  assert.deepStrictEqual(kinds(written), ['busy', 'idle', 'response-ready']);
});

test('the record does NOT ask where the user was looking (#396 D2)', () => {
  // The renderer wrote `response-ready` only for an UNFOCUSED session, which is a per-window fact and
  // cannot live in a per-session record. There is no focus input here at all — that is the decision.
  const written = harness();
  timeline.recordSignal('s1', { kind: 'busy' });
  timeline.recordSignal('s1', { kind: 'idle' });
  assert.ok(kinds(written).includes('response-ready'));
  assert.strictEqual(timeline.recordSignal.length, 2, 'sessionId and signal — nothing about focus');
});

test('two sessions keep their own latches', () => {
  const written = harness();
  timeline.recordSignal('s1', { kind: 'busy' });
  timeline.recordSignal('s2', { kind: 'idle' });
  timeline.recordSignal('s2', { kind: 'busy' });
  timeline.recordSignal('s1', { kind: 'idle' });
  assert.deepStrictEqual(
    written.map((e) => `${e.sessionId}/${e.kind}`),
    ['s1/busy', 's2/busy', 's1/idle', 's1/response-ready'],
  );
});

test('needs-attention is recorded whatever the session was doing, and carries its reason', () => {
  const written = harness();
  timeline.recordSignal('s1', { kind: 'needs-attention', reason: 'Claude needs your permission' });
  assert.deepStrictEqual(kinds(written), ['needs-attention']);
  assert.strictEqual(written[0].detail, 'Claude needs your permission');

  timeline.recordSignal('s1', { kind: 'busy' });
  timeline.recordSignal('s1', { kind: 'needs-attention', reason: 'again' });
  assert.deepStrictEqual(kinds(written), ['needs-attention', 'busy', 'needs-attention'],
    'attention is not an edge — it is an event, and it does not disturb the busy latch');

  timeline.recordSignal('s1', { kind: 'idle' });
  assert.ok(kinds(written).includes('response-ready'), 'the turn still ends');
});

test('a kind this record has no surface for is ignored', () => {
  const written = harness();
  timeline.recordSignal('s1', { kind: 'subagent-live-start', agentId: 'a1' });
  timeline.recordSignal('s1', { kind: 'subagent-live-stop', agentId: 'a1' });
  assert.deepStrictEqual(kinds(written), []);
});

test('nonsense in is nothing out', () => {
  const written = harness();
  timeline.recordSignal(null, { kind: 'busy' });
  timeline.recordSignal('s1', null);
  timeline.recordSignal('s1', {});
  timeline.recordSignal('', { kind: 'busy' });
  assert.deepStrictEqual(kinds(written), []);
});

test('forgetSession drops the latch, so the next idle is not a turn end', () => {
  const written = harness();
  timeline.recordSignal('s1', { kind: 'busy' });
  timeline.forgetSession('s1');
  timeline.recordSignal('s1', { kind: 'idle' });
  assert.deepStrictEqual(kinds(written), ['busy'],
    'the session died mid-turn; its end was never observed');
  assert.strictEqual(timeline._busyBySession.has('s1'), false);
});

test('the latch holds only what is working, so it cannot grow with dead sessions', () => {
  harness();
  for (let i = 0; i < 50; i++) timeline.recordSignal(`gone-${i}`, { kind: 'idle' });
  assert.strictEqual(timeline._busyBySession.size, 0,
    'an idle report about an unknown session must not create an entry');

  timeline.recordSignal('working', { kind: 'busy' });
  assert.strictEqual(timeline._busyBySession.size, 1);
  timeline.recordSignal('working', { kind: 'idle' });
  assert.strictEqual(timeline._busyBySession.size, 0);
});

test('a store that throws does not take the signal path down with it', () => {
  timeline.init({
    recordTimelineEvent: () => { throw new Error('database is locked'); },
    log: { debug() {}, warn() {} },
  });
  assert.doesNotThrow(() => {
    timeline.recordSignal('s1', { kind: 'busy' });
    timeline.recordSignal('s1', { kind: 'idle' });
  });
});

test('a broken record says so ONCE, loudly, then stays out of the way', () => {
  const warns = [];
  const debugs = [];
  timeline.init({
    recordTimelineEvent: () => { throw new Error('disk is full'); },
    log: { warn: (m) => warns.push(m), debug: (m) => debugs.push(m) },
  });
  for (let i = 0; i < 20; i++) {
    timeline.recordSignal(`s${i}`, { kind: 'busy' });
    timeline.recordSignal(`s${i}`, { kind: 'idle' });
  }
  assert.strictEqual(warns.length, 1, 'a per-event warn would bury the line that matters');
  assert.match(warns[0], /recap will be empty/, 'it has to say what the user will SEE, not just what threw');
  assert.ok(debugs.length > 20, 'the per-event detail is still there for whoever is diagnosing');
});

test('the lifecycle facts are recorded and leave the busy latch alone', () => {
  const written = harness();
  timeline.recordLifecycle('s1', 'started', 'Session started', 'Created from Switchboard.');
  timeline.recordSignal('s1', { kind: 'busy' });
  timeline.recordLifecycle('s1', 'exited', 'Process exited', 'Exit code 0.');

  assert.deepStrictEqual(kinds(written), ['started', 'busy', 'exited']);
  assert.strictEqual(timeline._busyBySession.has('s1'), true,
    'an exit is not the end of a turn — it must not clear the latch behind the signal path');
});

test('a session killed mid-turn is never called ready', () => {
  const written = harness();
  timeline.recordSignal('s1', { kind: 'busy' });
  timeline.recordLifecycle('s1', 'stopped', 'Session stopped', 'Stopped by the user.');
  timeline.recordLifecycle('s1', 'exited', 'Process exited', 'Exit code 1.');
  assert.ok(!kinds(written).includes('response-ready'),
    'work that was thrown away is not work waiting to be read');
});

test('a lifecycle event needs a session and a kind, and keeps its own label', () => {
  const written = harness();
  timeline.recordLifecycle(null, 'started', 'x');
  timeline.recordLifecycle('s1', '', 'x');
  assert.deepStrictEqual(kinds(written), []);

  timeline.recordLifecycle('s1', 'forked');
  assert.strictEqual(written[0].label, 'forked', 'no label falls back to the kind');
  assert.strictEqual(written[0].detail, '');
});

test('#423: a lifecycle event can say its detail names WHAT it is about', () => {
  const written = harness();
  timeline.recordLifecycle('s1', 'file-touched', 'open', '/repo/src/a.js', true);
  timeline.recordLifecycle('s1', 'exited', 'Process exited', 'Exit code 0.');

  assert.strictEqual(written[0].detailIsSubject, true, 'the path is the thing the event is about');
  assert.strictEqual(written[1].detailIsSubject, false, 'an exit code is a description, not a subject');
});

test('#423: a status signal never claims its reason names a thing', () => {
  const written = harness();
  timeline.recordSignal('s1', { kind: 'needs-attention', reason: 'waiting for you' });
  timeline.recordSignal('s1', { kind: 'busy' });
  timeline.recordSignal('s1', { kind: 'idle' });

  // needs-attention, busy, then the idle edge — which is two events, idle and response-ready.
  assert.deepStrictEqual(written.map((e) => `${e.kind}:${e.detailIsSubject}`),
    ['needs-attention:false', 'busy:false', 'idle:false', 'response-ready:false'],
    'two producers reporting one edge with different wording must still collapse into one');
});

test('a turn that spans a session id change still ends', () => {
  const written = harness();
  timeline.recordSignal('launch-id', { kind: 'busy' });
  // What Claude's first hook POST does, and what a fork does: the session keeps running under a new id.
  timeline.rekeySession('launch-id', 'real-id');
  timeline.recordSignal('real-id', { kind: 'idle' });

  assert.deepStrictEqual(
    written.map((e) => `${e.sessionId}/${e.kind}`),
    ['launch-id/busy', 'real-id/idle', 'real-id/response-ready'],
    'without the latch moving, the end of this turn is never recorded at all',
  );
  assert.strictEqual(timeline._busyBySession.size, 0);
});

test('a rekey of an idle session moves nothing and invents nothing', () => {
  const written = harness();
  timeline.rekeySession('launch-id', 'real-id');
  timeline.recordSignal('real-id', { kind: 'idle' });
  assert.deepStrictEqual(kinds(written), [], 'a session that was not working did not just stop working');
  assert.strictEqual(timeline._busyBySession.size, 0);
});

test('rekey ignores what cannot be a move', () => {
  harness();
  timeline.recordSignal('s1', { kind: 'busy' });
  timeline.rekeySession('s1', 's1');
  timeline.rekeySession('s1', null);
  timeline.rekeySession(null, 's2');
  assert.strictEqual(timeline._busyBySession.has('s1'), true, 'the latch survives a non-move');
  assert.strictEqual(timeline._busyBySession.size, 1);
});

test('init clears the latches left by a previous wiring', () => {
  const first = harness();
  timeline.recordSignal('s1', { kind: 'busy' });
  assert.deepStrictEqual(kinds(first), ['busy']);

  const second = harness();
  timeline.recordSignal('s1', { kind: 'idle' });
  assert.deepStrictEqual(kinds(second), [], 'a fresh wiring has seen no turn start');
});

// --- The read side for the recap overview (#402) ---------------------------------

/** A minimal ipcMain: registerIpc hands its handlers here, and the test calls them directly. */
function ipcHarness(ctx) {
  const handlers = new Map();
  timeline.init(ctx);
  timeline.registerIpc({ handle: (channel, fn) => handlers.set(channel, fn) });
  return (channel, ...args) => handlers.get(channel)(null, ...args);
}

test('#402: timeline:since passes the record through, truncation flag included', () => {
  const answer = { events: [{ sessionId: 's1', kind: 'exited', at: 5 }], truncated: true };
  const asked = [];
  const invoke = ipcHarness({
    getTimelineEventsSince: (sinceMs) => { asked.push(sinceMs); return answer; },
    log: { debug() {} },
  });

  assert.deepStrictEqual(invoke('timeline:since', 1234), answer);
  assert.deepStrictEqual(asked, [1234], 'the store is asked once, with the absence start');
});

test('#402: a record that cannot be read answers an empty absence, not a throw', () => {
  const invoke = ipcHarness({
    getTimelineEventsSince: () => { throw new Error('database is locked'); },
    log: { debug() {} },
  });

  assert.deepStrictEqual(invoke('timeline:since', 1), { events: [], truncated: false });
});

test('#402: an older main process without the cross-session read answers empty', () => {
  const invoke = ipcHarness({ log: { debug() {} } });
  assert.deepStrictEqual(invoke('timeline:since', 1), { events: [], truncated: false });
});

test('#423: the note carries the declaration across IPC, and only a real one', () => {
  const written = [];
  const invoke = ipcHarness({
    recordTimelineEvent: (event) => { written.push(event); return event; },
    log: { debug() {} },
  });

  assert.strictEqual(invoke('timeline:note', 's1', 'file-touched', 'open', '/repo/src/a.js', true), true);
  assert.strictEqual(invoke('timeline:note', 's1', 'viewed', 'Viewed', ''), true);
  assert.strictEqual(invoke('timeline:note', 's1', 'busy', 'Agent working', '', true), false,
    'a window still cannot forge a busy edge, declaration or not');

  assert.deepStrictEqual(written.map((e) => [e.kind, e.detailIsSubject]),
    [['file-touched', true], ['viewed', false]]);
});
