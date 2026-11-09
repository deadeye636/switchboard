'use strict';
// A maintenance turn's edges (spec 45, E8) through the one delivery path: they reach the timeline, labelled, and nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');

const hooks = require('../src/app/hooks');
const timeline = require('../src/app/timeline');

function setup() {
  const sent = [];
  const timelineSignals = [];
  const queueNotes = [];
  const holds = [];
  let cancels = 0;
  hooks.init({
    log: { info() {}, warn() {}, debug() {} },
    activeSessions: new Map(),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (ch, ...args) => sent.push({ ch, args }) } }),
    sendTimelineSignal: (id, signal) => timelineSignals.push({ id, signal }),
    noteTurnQueue: (id, note) => queueNotes.push(note),
    holdReady: (id, deliver) => { holds.push(deliver); return false; },
    cancelHeldReady: () => { cancels += 1; },
  });
  return { sent, timelineSignals, queueNotes, holds, cancels: () => cancels };
}

test('a quiet edge reaches no window, cancels no held ready and is not held itself', () => {
  const h = setup();
  hooks.deliverBindSignal('s1', { kind: 'busy', pending: false, turn_start: true, quiet: true });
  hooks.deliverBindSignal('s1', { kind: 'idle', pending: false, quiet: true });
  assert.deepEqual(h.sent, [], 'no busy state, so an unread ready stays and no ready is raised');
  assert.equal(h.cancels(), 0);
  assert.equal(h.holds.length, 0);
  assert.equal(h.queueNotes[0].turnStart, false, 'it is not the queued prompt a hold is waiting for');
  assert.deepEqual(h.timelineSignals.map((t) => t.signal.maintenance), [true, true]);
});

test('an ordinary edge still does all of it', () => {
  const h = setup();
  hooks.deliverBindSignal('s1', { kind: 'busy', pending: false, turn_start: true });
  hooks.deliverBindSignal('s1', { kind: 'idle', pending: false });
  assert.deepEqual(h.sent.map((m) => [m.ch, m.args[1]]), [['cli-busy-state', true], ['cli-busy-state', false]]);
  assert.equal(h.cancels(), 1);
  assert.equal(h.holds.length, 1);
  assert.equal(h.queueNotes[0].turnStart, true);
  assert.equal(h.timelineSignals[0].signal.maintenance, undefined);
});

test('the timeline writes one labelled event for a maintenance turn, and no Ready after it', () => {
  const events = [];
  timeline.init({ recordTimelineEvent: (event) => { events.push(event); return event; }, log: { info() {}, warn() {}, debug() {} } });
  timeline.recordSignal('m1', { kind: 'busy', maintenance: true });
  timeline.recordSignal('m1', { kind: 'idle', maintenance: true });
  assert.deepEqual(events.map((e) => e.kind), ['maintenance']);
  timeline.recordSignal('m1', { kind: 'busy' });
  timeline.recordSignal('m1', { kind: 'idle' });
  assert.deepEqual(events.map((e) => e.kind), ['maintenance', 'busy', 'idle', 'response-ready']);
});
