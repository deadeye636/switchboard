'use strict';
// Idle maintenance in src/app/agent-rpc.js (spec 45, #827): the gate, the hold around a maintenance action, and what a
// maintenance turn leaves alone. The child is the Pi stand-in, which answers and refuses the way Pi 1.1.0 was measured to.
const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('node:path');

const { harness, stopped, until, agentRpc, piNative } = require('./helpers/agent-rpc-harness');
const claudeProtocol = require('../src/backends/claude-native/rpc-protocol');
const piProtocol = require('../src/backends/pi-native/rpc-protocol');

const heldOps = (h) => h.sent.filter((m) => m.ch === 'agent-event' && m.op.op === 'held').map((m) => m.op);
const sid = (h) => [...h.activeSessions.keys()][0];
const isIdle = (h) => h.signals.some((s) => s.kind === 'idle');
const idleCount = (h) => h.signals.filter((s) => s.kind === 'idle').length;

async function started(t) {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length > 0);
  return h;
}

test('a warm turn on Pi is quiet from its start to its idle edge, and the next turn is not', async (t) => {
  const h = await started(t);
  const res = await agentRpc.maintain(sid(h), { action: 'warm' });
  assert.equal(res.ok, true);
  assert.equal(res.key, null, 'Pi has no key at send time');
  assert.match(res.text, /keep-alive/);
  await until(() => isIdle(h));
  const warm = h.signals.filter((s) => s.kind === 'busy' || s.kind === 'idle');
  assert.ok(warm.length >= 2);
  for (const s of warm) assert.equal(s.quiet, true, s.kind);

  const before = h.signals.length;
  await agentRpc.sendTurn(sid(h), { text: 'hello' });
  await until(() => idleCount(h) === 2);
  for (const s of h.signals.slice(before)) assert.equal(s.quiet, undefined, 'the user\'s turn raises attention as usual');
});

test('a prompt during a running compaction is held, then sent, and the compaction is confirmed by its answer', async (t) => {
  const h = await started(t);
  await agentRpc.sendTurn(sid(h), { text: 'first' });
  await until(() => isIdle(h));

  const busyBefore = h.signals.filter((s) => s.kind === 'busy').length;
  const compaction = agentRpc.maintain(sid(h), { action: 'compact' });
  assert.equal(agentRpc.maintenanceOpen(sid(h)), false, 'one action at a time');
  const sent = await agentRpc.sendTurn(sid(h), { text: 'during' });
  assert.ok(sent.held, 'held rather than refused by the runtime');
  assert.equal(h.signals.filter((s) => s.kind === 'busy').length, busyBefore, 'a compaction raises no turn edge');

  const res = await compaction;
  assert.equal(res.ok, true);
  assert.equal(res.data.tokensBefore, 10);
  await until(() => idleCount(h) === 2);
  const lastHeld = heldOps(h).at(-1);
  assert.deepEqual(lastHeld.items, [], 'the held prompt went out once the compaction ended');
  const during = h.signals.filter((s) => s.kind === 'busy').at(-1);
  assert.equal(during.quiet, undefined, 'the flag did not outlive the compaction, so the user\'s turn is not quiet');
});

test('a refused compaction ends the action, says so to its caller, and draws no error', async (t) => {
  const h = await started(t);
  const res = await agentRpc.maintain(sid(h), { action: 'compact' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /Nothing to compact/);
  assert.equal(agentRpc.maintenanceOpen(sid(h)), true);
  const errors = h.sent.filter((m) => m.ch === 'agent-event' && m.op.op === 'notice' && m.op.level === 'error');
  assert.deepEqual(errors, []);
});

test('a user\'s prompt in the gap before a turn begins is held, not refused', async (t) => {
  const h = await started(t);
  await agentRpc.sendTurn(sid(h), { text: 'slow start' });
  const second = await agentRpc.sendTurn(sid(h), { text: 'second' });
  assert.ok(second.held);
  await until(() => idleCount(h) === 2);
  assert.deepEqual(heldOps(h).at(-1).items, []);
});

test('an answer saying a command took the line releases the gap at once', async (t) => {
  const h = await started(t);
  await agentRpc.sendTurn(sid(h), { text: 'handled line' });
  assert.equal(agentRpc.maintenanceOpen(sid(h)), true);
  const next = await agentRpc.sendTurn(sid(h), { text: 'next' });
  assert.equal(next.held, undefined);
  await until(() => isIdle(h));
});

test('the gate refuses while a turn runs, in the gap, and for an action the backend does not know', async (t) => {
  const h = await started(t);
  await agentRpc.sendTurn(sid(h), { text: 'slow start' });
  assert.equal(agentRpc.maintenanceOpen(sid(h)), false);
  assert.deepEqual(await agentRpc.maintain(sid(h), { action: 'warm' }), { ok: false, reason: 'blocked' });
  await until(() => isIdle(h));
  assert.equal(agentRpc.maintenanceOpen(sid(h)), true);
  assert.deepEqual(await agentRpc.maintain(sid(h), { action: 'nonsense' }), { ok: false, reason: 'declined' });
  assert.equal(agentRpc.maintenanceOpen(sid(h)), true);
  assert.deepEqual(await agentRpc.maintain('no-such-session', { action: 'warm' }), { ok: false, reason: 'not running' });
});

// The warm line, swapped for one the stand-in plays a particular way.
async function startedWithWarm(t, message) {
  const rpc = { ...piNative.rpc, maintenanceCommand: ({ id }) => ({ line: { id, type: 'prompt', message }, endsBy: 'idle', key: null, text: message }) };
  const h = harness({ rpc });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length > 0);
  return h;
}

test('a warm line a command took ends the action at once, so prompts are not held', async (t) => {
  const h = await startedWithWarm(t, 'handled line');
  const res = await agentRpc.maintain(sid(h), { action: 'warm' });
  assert.equal(res.ok, true);
  assert.equal(agentRpc.maintenanceOpen(sid(h)), true);
  const next = await agentRpc.sendTurn(sid(h), { text: 'next' });
  assert.equal(next.held, undefined);
});

test('a warm turn that never begins lets go after the wait, and a prompt held behind it goes out', async (t) => {
  const h = await startedWithWarm(t, 'no turn');
  await agentRpc.maintain(sid(h), { action: 'warm' });
  const held = await agentRpc.sendTurn(sid(h), { text: 'waiting' });
  assert.ok(held.held);
  await until(() => idleCount(h) === 1, 8000);
  assert.deepEqual(heldOps(h).at(-1).items, []);
  assert.equal(h.signals.filter((s) => s.kind === 'idle').at(-1).quiet, undefined, 'the user\'s turn is not quiet');
});

test('a queue behind a command that starts no turn moves on', async (t) => {
  const h = await started(t);
  await agentRpc.sendTurn(sid(h), { text: 'slow start' });
  await agentRpc.sendTurn(sid(h), { text: 'handled line' });
  await agentRpc.sendTurn(sid(h), { text: 'after it' });
  await until(() => idleCount(h) === 2, 8000);
  assert.deepEqual(heldOps(h).at(-1).items, []);
  assert.equal(agentRpc.maintenanceOpen(sid(h)), true);
});

test('a steer entering a warm turn makes the turn the user\'s, so its end is not quiet', async (t) => {
  const h = await startedWithWarm(t, 'slow start');
  const warm = agentRpc.maintain(sid(h), { action: 'warm' });
  await until(() => h.signals.length >= 0);
  await agentRpc.sendTurn(sid(h), { text: 'do this instead', mode: 'steer' });
  await warm;
  await until(() => isIdle(h));
  assert.equal(h.signals.filter((s) => s.kind === 'idle').at(-1).quiet, undefined);
});

test('a user\'s prompt during a warm turn runs next, as its own loud turn', async (t) => {
  const h = await startedWithWarm(t, 'slow start');
  const warm = agentRpc.maintain(sid(h), { action: 'warm' });
  const held = await agentRpc.sendTurn(sid(h), { text: 'mine' });
  assert.ok(held.held);
  await warm;
  await until(() => idleCount(h) === 2);
  const idles = h.signals.filter((s) => s.kind === 'idle');
  assert.equal(idles[0].quiet, true);
  assert.equal(idles[1].quiet, undefined);
});

test('the gate stays closed for an open question, a held prompt and a session someone is observing', async (t) => {
  const h = await started(t);
  await agentRpc.sendTurn(sid(h), { text: 'ask me' });
  await until(() => agentRpc.maintenanceOpen(sid(h)) === false);
  assert.equal(agentRpc.maintenanceOpen(sid(h)), false);

  const other = await started(t);
  await agentRpc.sendTurn(sid(other), { text: 'slow start' });
  await agentRpc.sendTurn(sid(other), { text: 'second' });
  assert.equal(agentRpc.maintenanceOpen(sid(other)), false, 'a prompt is held');
  await until(() => idleCount(other) === 2);
  assert.equal(agentRpc.maintenanceOpen(sid(other)), true);
  agentRpc.observe(sid(other), {});
  assert.equal(agentRpc.maintenanceOpen(sid(other)), false, 'a review follows its turn through the edges');
});

test('a warm turn that asks the user something raises attention and stops being quiet', async (t) => {
  const h = await startedWithWarm(t, 'ask me');
  await agentRpc.maintain(sid(h), { action: 'warm' });
  await until(() => h.signals.some((s) => s.kind === 'waiting'));
  assert.equal(h.signals.find((s) => s.kind === 'waiting').quiet, undefined);
});

test('a draft in the composer keeps the gate closed until it is gone', async (t) => {
  const h = await started(t);
  assert.equal(agentRpc.maintenanceOpen(sid(h)), true, 'no view has said anything, and nothing can be typed without one');
  agentRpc.noteDraft(sid(h), true);
  assert.equal(agentRpc.maintenanceOpen(sid(h)), false);
  assert.deepEqual(await agentRpc.maintain(sid(h), { action: 'warm' }), { ok: false, reason: 'blocked' });
  agentRpc.noteDraft(sid(h), false);
  assert.equal(agentRpc.maintenanceOpen(sid(h)), true);
  assert.doesNotThrow(() => agentRpc.noteDraft('no-such-session', true));
});

test('a prompt read back is stamped by its record, once per record, and the idle schedule hears the edges in order', async (t) => {
  const edges = [];
  const records = [{ key: null, text: 'a warm line', kind: 'warm', at: 1 }];
  const h = harness({ onMaintenanceEdge: (r) => edges.push([r.edge, r.quiet]), maintenanceTurnsOf: () => records });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length > 0);
  await agentRpc.sendTurn(sid(h), { text: 'a warm line' });
  await until(() => isIdle(h));
  await agentRpc.sendTurn(sid(h), { text: 'a warm line' });
  await until(() => idleCount(h) === 2);
  const { entries } = await agentRpc.attach(sid(h));
  const prompts = entries.filter((e) => e.prompt === true);
  assert.deepEqual(prompts.map((e) => e.maintenance === true), [true, false], 'the user wrote the same words the second time');
  assert.deepEqual(edges.slice(0, 3), [['start', false], ['busy', false], ['idle', false]]);

  const warm = harness({ onMaintenanceEdge: () => {} });
  t.after(() => stopped(warm));
  await until(() => warm.rekeys.length > 0);
  await agentRpc.maintain(sid(warm), { action: 'warm' });
  await until(() => isIdle(warm));
  const live = warm.sent.filter((m) => m.ch === 'agent-event' && m.op.op === 'append' && m.op.entry && m.op.entry.prompt === true);
  assert.equal(live.at(-1).op.entry.maintenance, true);
});

test('the schedule and the real driver together: a Pi compaction ends as compacted, a refused one says so', async (t) => {
  const idle = require('../src/app/idle-maintenance');
  t.after(() => idle.stop());
  const notes = [];
  const timers = [];
  idle.init({
    setTimer: (fn) => { timers.push(fn); return fn; },
    clearTimer: () => {},
    effectiveSettings: () => ({ idleMaintenanceMode: 'compact' }),
    capabilityOf: () => piNative.idleMaintenance(),
    recordLifecycle: (id, kind, label) => notes.push(label),
    log: { info() {}, warn() {} },
  });
  const h = harness({ onMaintenanceEdge: (r) => idle.track(r) });
  t.after(() => stopped(h));
  await until(() => h.rekeys.length > 0);
  await agentRpc.sendTurn(sid(h), { text: 'first' });
  await until(() => timers.length === 1);
  timers.pop()();
  await until(() => idle.getState(sid(h)).ended !== null);
  assert.equal(idle.getState(sid(h)).ended, 'compacted');
  assert.deepEqual(notes, ['Compacted while idle (best effort)']);
});

test('a refused compaction draws neither its error nor its start', async (t) => {
  const h = await started(t);
  await agentRpc.maintain(sid(h), { action: 'compact' });
  const notices = h.sent.filter((m) => m.ch === 'agent-event' && m.op.op === 'notice');
  assert.deepEqual(notices, []);
});

test('on a runtime that answers no turn line, the write is the busy edge and the result ends the action', async (t) => {
  const rpc = {
    createDecoder: () => ({ decode: (m) => (m.ev === 'result' ? [{ op: 'busy', busy: false }] : []), currentPartial: () => null }),
    responseOf: () => null,
    sendAcknowledged: false,
    sendCommand: ({ text }) => ({ type: 'user', text }),
    maintenanceCommand: ({ id }) => ({ line: { type: 'user', text: 'warm' }, endsBy: 'idle', key: id, text: 'warm' }),
  };
  const h = harness({ rpc, fixture: path.join(__dirname, 'fixtures', 'fake-stream-agent.js') });
  t.after(() => stopped(h));
  const res = await agentRpc.maintain('launch-id', { action: 'warm' });
  assert.equal(res.ok, true);
  assert.ok(res.key, 'the key is known when the line is written');
  assert.equal(h.signals[0].kind, 'busy');
  assert.equal(h.signals[0].quiet, true);
  const held = await agentRpc.sendTurn('launch-id', { text: 'mine' });
  assert.ok(held.held);
  await until(() => idleCount(h) === 2);
  assert.equal(h.signals.filter((s) => s.kind === 'idle')[0].quiet, true);
  assert.equal(h.signals.filter((s) => s.kind === 'idle')[1].quiet, undefined);
});

test('each backend words its own action, and how it ends', () => {
  const claudeWarm = claudeProtocol.maintenanceCommand({ id: 'u1', action: 'warm' });
  assert.equal(claudeWarm.line.uuid, 'u1', 'the key is known at send time');
  assert.equal(claudeWarm.key, 'u1');
  assert.equal(claudeWarm.endsBy, 'idle');
  assert.equal(claudeWarm.line.type, 'user');
  assert.equal(claudeProtocol.maintenanceCommand({ id: 'u1', action: 'compact' }).line.message.content, '/compact');
  assert.equal(claudeProtocol.maintenanceCommand({ id: 'u1', action: 'compact', instructions: 'keep\nthe plan' }).line.message.content, '/compact keep the plan');
  assert.equal(claudeProtocol.maintenanceCommand({ id: 'u1', action: 'x' }), null);

  const piCompact = piProtocol.maintenanceCommand({ id: 'p1', action: 'compact', instructions: 'keep it' });
  assert.deepEqual(piCompact.line, { id: 'p1', type: 'compact', customInstructions: 'keep it' });
  assert.equal(piCompact.endsBy, 'answer');
  assert.equal(piProtocol.maintenanceCommand({ id: 'p1', action: 'warm' }).endsBy, 'idle');
  assert.equal(piProtocol.maintenanceCommand({ id: 'p1', action: 'x' }), null);

  assert.equal(piProtocol.answerStartsTurn({ data: { disposition: 'started' } }), true);
  assert.equal(piProtocol.answerStartsTurn({ data: { disposition: 'queued' } }), true);
  assert.equal(piProtocol.answerStartsTurn({ data: { disposition: 'handled' } }), false);
  assert.equal(piProtocol.answerStartsTurn({ success: true }), null, 'an older Pi names nothing');
});
