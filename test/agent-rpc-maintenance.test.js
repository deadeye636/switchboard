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

// A runtime that streams, with the fake agent asking after its reply: a question (kind `questions`) or a permission (`approval`).
function askingRpc() {
  const text = (e) => (e && e.message && Array.isArray(e.message.content) ? e.message.content.map((b) => b.text).join('') : '');
  return {
    createDecoder: () => ({
      decode: (m) => {
        if (m.ev === 'append') return [{ op: 'append', entry: m.entry }];
        if (m.ev === 'ask') return [{ op: 'ask', request: { id: m.id, kind: m.kind, method: 'select', ...(m.kind === 'questions' ? { asksUser: true } : {}) } }];
        return m.ev === 'result' ? [{ op: 'busy', busy: false }] : [];
      },
      currentPartial: () => null,
    }),
    responseOf: () => null,
    sendAcknowledged: false,
    sendCommand: ({ text: t }) => ({ type: 'user', text: t }),
    entryKey: (e) => (e && e.uuid) || null,
    assistantTextOf: (e) => (e && e.type === 'assistant' ? text(e) : null),
    entriesFromTranscript: async () => [],
  };
}

for (const [line, kind, unfolds] of [['reply then ask', 'questions', true], ['reply then approve', 'approval', false]]) {
  test(`a warm turn's ${kind} ask ${unfolds ? 'un-folds the reply, live and for an attach' : 'leaves the reply folded'} (#855)`, async (t) => {
    const rpc = askingRpc();
    rpc.maintenanceCommand = ({ id }) => ({ line: { type: 'user', text: line }, endsBy: 'idle', key: id, text: line });
    const h = harness({ rpc, fixture: path.join(__dirname, 'fixtures', 'fake-stream-agent.js') });
    t.after(() => stopped(h));
    await agentRpc.maintain('launch-id', { action: 'warm' });
    await until(() => h.signals.some((s) => s.kind === 'waiting'));
    const ops = h.sent.filter((m) => m.ch === 'agent-event').map((m) => m.op.op);
    assert.equal(ops.includes('unfold'), unfolds);
    if (unfolds) assert.ok(ops.indexOf('unfold') < ops.indexOf('ask'), 'before the card');
    const reply = (await agentRpc.attach('launch-id')).entries.find((e) => e.type === 'assistant');
    assert.ok(reply, 'the attach holds the reply');
    assert.equal(reply.maintenance === true, !unfolds, 'and an attach draws it as the view does');
  });
}

test('an attach reads the file: a question line there takes the warm reply over, merged with what is live (#855)', async (t) => {
  const rpc = askingRpc();
  const warm = { uuid: 'e1', type: 'user', prompt: true, message: { role: 'user', content: [{ type: 'text', text: 'reply then approve' }] } };
  const said = { uuid: 'e2', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Which one?' }] } };
  const question = { uuid: 'e3', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: {} }] } };
  rpc.entriesFromTranscript = async () => [warm, said, question];
  rpc.asksUserOf = (e) => !!(e && e.message && Array.isArray(e.message.content) && e.message.content.some((b) => b.type === 'tool_use'));
  rpc.maintenanceCommand = ({ id }) => ({ line: { type: 'user', text: 'reply then approve' }, endsBy: 'idle', key: id, text: 'reply then approve' });
  const h = harness({ rpc, fixture: path.join(__dirname, 'fixtures', 'fake-stream-agent.js'), maintenanceTurnsOf: () => [{ key: 'e1', text: null }] });
  t.after(() => stopped(h));
  await agentRpc.maintain('launch-id', { action: 'warm' });
  await until(() => h.signals.some((s) => s.kind === 'waiting'));
  const entries = (await agentRpc.attach('launch-id')).entries;
  assert.equal(entries.filter((e) => e.uuid === 'e2').length, 1, 'the live reply is the file copy, not drawn twice');
  assert.deepEqual(entries.map((e) => [e.uuid, e.maintenance === true]), [['e1', true], ['e2', false], ['e3', false]]);
});

test('claude-native flags a question or plan ask, a malformed one included, and no other (#855)', () => {
  const ask = (tool, input) => claudeProtocol.createDecoder().decode({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: tool, tool_use_id: 't', input } })[0].request;
  assert.equal(ask('AskUserQuestion', { questions: [{ question: 'Which?', options: [] }] }).asksUser, true);
  assert.equal(ask('AskUserQuestion', {}).asksUser, true, 'the approval it falls back to is still a question');
  assert.equal(ask('ExitPlanMode', { plan: 'p' }).asksUser, true);
  assert.equal(ask('Bash', { command: 'ls' }).asksUser, undefined);
});

test('a warm turn without a question sends no unfold op (#855)', async (t) => {
  const quiet = await started(t);
  await agentRpc.maintain(sid(quiet), { action: 'warm' });
  await until(() => isIdle(quiet));
  assert.ok(!quiet.sent.some((m) => m.ch === 'agent-event' && m.op.op === 'unfold'));
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
  // The reply of the maintenance turn folds with its prompt, up to the next prompt; the user's turn after it does not.
  const second = entries.indexOf(prompts[1]);
  const replies = (from, to) => entries.slice(from + 1, to).filter((e) => e.prompt !== true);
  assert.ok(replies(entries.indexOf(prompts[0]), second).length > 0, 'the maintenance turn has a reply read back');
  assert.ok(replies(entries.indexOf(prompts[0]), second).every((e) => e.maintenance === true), 'and it is stamped');
  assert.ok(replies(second, entries.length).every((e) => e.maintenance !== true), 'the user\'s reply is not');
  assert.deepEqual(edges.slice(0, 3), [['start', false], ['busy', false], ['idle', false]]);

  const warm = harness({ onMaintenanceEdge: () => {} });
  t.after(() => stopped(warm));
  await until(() => warm.rekeys.length > 0);
  await agentRpc.maintain(sid(warm), { action: 'warm' });
  await until(() => isIdle(warm));
  const live = warm.sent.filter((m) => m.ch === 'agent-event' && m.op.op === 'append' && m.op.entry && m.op.entry.prompt === true);
  assert.equal(live.at(-1).op.entry.maintenance, true);
  const liveReplies = warm.sent.filter((m) => m.ch === 'agent-event' && m.op.op === 'append' && m.op.entry && m.op.entry.prompt !== true);
  assert.ok(liveReplies.length > 0 && liveReplies.every((m) => m.op.entry.maintenance === true), 'the live reply is stamped too');
  await agentRpc.sendTurn(sid(warm), { text: 'mine' });
  await until(() => idleCount(warm) === 2);
  const after = warm.sent.filter((m) => m.ch === 'agent-event' && m.op.op === 'append').slice(liveReplies.length + live.length);
  assert.ok(after.length > 0 && after.every((m) => m.op.entry.maintenance !== true), 'and the user\'s next turn is not');
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
    capabilityOf: () => piNative.idleMaintenance({ exe: null }), // not this machine's Pi
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

// A runtime whose compaction ends in an ordinary turn end whether it ran or not, as Claude's does (measured,
// `docs/backend-formats.md`): only its `compacted` op says it took place. The fake agent answers each line as a turn.
function compactingRpc() {
  const textOfEntry = (e) => (e && e.message && Array.isArray(e.message.content) ? e.message.content.map((b) => b.text).join('') : '');
  return {
    createDecoder: () => ({
      decode: (m) => {
        if (m.ev === 'append' && m.entry.type === 'user' && textOfEntry(m.entry) === 'compact-ok') return [{ op: 'compacted' }];
        return m.ev === 'result' ? [{ op: 'busy', busy: false }] : [];
      },
      currentPartial: () => null,
    }),
    responseOf: () => null,
    sendAcknowledged: false,
    sendCommand: ({ text }) => ({ type: 'user', text }),
    maintenanceCommand: ({ instructions }) => ({ line: { type: 'user', text: instructions }, endsBy: 'idle', key: null, text: instructions, confirmedBy: 'compacted' }),
    // A reply is a model call, so the schedule counts the user's turn (a turn with unchanged figures reached no model).
    usageOf: (m) => (m.ev === 'append' && m.entry.type === 'assistant' ? { input: 10, read: 0, write: 0 } : null),
  };
}

test('a compaction that names its proof is confirmed only by that op; one that ends without it is not (#827 gap)', async (t) => {
  for (const [line, expected] of [['compact-ok', true], ['compact-refused', false]]) {
    const edges = [];
    const h = harness({ rpc: compactingRpc(), fixture: path.join(__dirname, 'fixtures', 'fake-stream-agent.js'), onMaintenanceEdge: (r) => edges.push(r) });
    t.after(() => stopped(h));
    const res = await agentRpc.maintain('launch-id', { action: 'compact', instructions: line });
    assert.equal(res.ok, true, 'the line went out');
    await until(() => edges.some((e) => e.edge === 'idle'));
    const end = edges.find((e) => e.edge === 'idle');
    assert.equal(end.quiet, true);
    assert.equal(end.confirmed, expected, `${line}: confirmed is ${expected}`);
  }
});

test('the schedule records a confirmed compaction as compacted and an unconfirmed one as skipped', async (t) => {
  const idle = require('../src/app/idle-maintenance');
  t.after(() => idle.stop());
  for (const [line, ended, note] of [
    ['compact-ok', 'compacted', ['Compacted while idle (best effort)', '']],
    // The stand-in declines this one, as Claude does with nothing to compact.
    ['compact-refused', 'refused', ['Compaction skipped', 'no compaction took place']],
  ]) {
    const notes = [];
    const timers = [];
    idle.init({
      setTimer: (fn) => { timers.push(fn); return fn; },
      clearTimer: () => {},
      effectiveSettings: () => ({ idleMaintenanceMode: 'compact' }),
      capabilityOf: () => require('../src/backends/claude-native').idleMaintenance(),
      recordLifecycle: (id, kind, label, detail) => notes.push([label, detail]),
      log: { info() {}, warn() {} },
    });
    const rpc = compactingRpc();
    rpc.maintenanceCommand = () => ({ line: { type: 'user', text: line }, endsBy: 'idle', key: null, text: '/compact', confirmedBy: 'compacted' });
    const h = harness({ rpc, fixture: path.join(__dirname, 'fixtures', 'fake-stream-agent.js'), onMaintenanceEdge: (r) => idle.track(r) });
    await agentRpc.sendTurn('launch-id', { text: 'first' });
    await until(() => timers.length === 1);
    timers.pop()();
    await until(() => idle.getState('launch-id').ended !== null);
    assert.equal(idle.getState('launch-id').ended, ended, line);
    assert.deepEqual(notes, [note], line);
    await stopped(h);
    idle.stop();
  }
});

test('claude-native: the measured stream of a declined /compact yields no compacted op, a boundary does', () => {
  const decoder = claudeProtocol.createDecoder();
  // The lines `scripts/measure-idle-maintenance.js --only=claude-refused-compact` saw (2026-11-10), fields cut to the read ones.
  const declined = [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'assistant', uuid: 'a1', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Error: No messages to compact' }], usage: {} } },
    { type: 'result', subtype: 'success', is_error: false, result: '', local_command: 'compact', session_id: 's1' },
  ];
  const ops = declined.flatMap((m) => decoder.decode(m));
  assert.ok(!ops.some((o) => o.op === 'compacted'), 'nothing in a declined compaction confirms one');
  assert.ok(ops.some((o) => o.op === 'busy' && o.busy === false), 'and it still ends like a turn');
  const boundary = claudeProtocol.createDecoder().decode({ type: 'system', subtype: 'compact_boundary', session_id: 's1' });
  assert.ok(boundary.some((o) => o.op === 'compacted'), 'a boundary confirms it');
  assert.equal(claudeProtocol.maintenanceCommand({ id: 'u1', action: 'compact' }).confirmedBy, 'compacted');
  assert.equal(claudeProtocol.maintenanceCommand({ id: 'u1', action: 'warm' }).confirmedBy, undefined, 'a warm turn names no proof');
});

test('only a maintenance turn\'s prompt and reply text fold; a summary, a tool-only line and the next turn do not', () => {
  const rpc = claudeProtocol;
  const prompt = (text, uuid) => ({ type: 'user', uuid, prompt: true, message: { role: 'user', content: text } });
  const reply = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const toolOnly = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } };
  const summary = { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Summary of the conversation' } };
  assert.equal(agentRpc.maintenanceEntry(rpc, prompt('x')), true);
  assert.equal(agentRpc.maintenanceEntry(rpc, reply('ok')), true);
  assert.equal(agentRpc.maintenanceEntry(rpc, summary), false, 'a compaction\'s summary stays visible');
  assert.equal(agentRpc.maintenanceEntry(rpc, toolOnly), false);
  assert.equal(agentRpc.maintenanceEntry({}, reply('ok')), false, 'a backend that cannot read a reply folds only its prompt');

  // Read back: the reply after the recorded prompt folds; a line that is not a reply ends the stretch, even with no prompt.
  const entries = [prompt('warm words', 'w1'), reply('ok'), summary, reply('after the summary'), prompt('mine', 'u2'), reply('yours')];
  const stamped = agentRpc.stampWithRecords(rpc, entries, [{ key: 'w1', text: null }]);
  assert.deepEqual(stamped.map((e) => e.maintenance === true), [true, true, false, false, false, false]);
});

test('a question or plan approval takes a maintenance turn over: its reply text is drawn, read back (#855)', () => {
  const rpc = claudeProtocol;
  const line = (...content) => ({ type: 'assistant', message: { role: 'assistant', content } });
  const text = (t) => ({ type: 'text', text: t });
  const tool = (name) => ({ type: 'tool_use', id: 'q1', name, input: {} });
  const warm = { type: 'user', uuid: 'w1', prompt: true, message: { role: 'user', content: 'warm' } };
  const mine = { type: 'user', uuid: 'u2', prompt: true, message: { role: 'user', content: 'mine' } };
  const records = [{ key: 'w1', text: null }];
  assert.equal(rpc.asksUserOf(line(tool('AskUserQuestion'))), true);
  assert.equal(rpc.asksUserOf(line(tool('ExitPlanMode'))), true);
  assert.equal(rpc.asksUserOf(line(text('ok'), tool('Bash'))), false);
  for (const name of ['AskUserQuestion', 'ExitPlanMode']) {
    // Claude writes the text and the call as two lines.
    const stamped = agentRpc.stampWithRecords(rpc, [warm, line(text('Which one?')), line(tool(name)), mine, line(text('yours'))], records);
    assert.deepEqual(stamped.map((e) => e.maintenance === true), [true, false, false, false, false], name);
  }
  // A question in a LATER turn (a task notice, not a prompt) is that turn's own: the warm reply stays folded.
  const notice = { type: 'task-notice', message: { role: 'user', content: 'done' } };
  const later = agentRpc.stampWithRecords(rpc, [warm, line(text('ok')), notice, line(text('Which one?')), line(tool('AskUserQuestion'))], records);
  assert.deepEqual(later.map((e) => e.maintenance === true), [true, true, false, false, false]);
  const plain = agentRpc.stampWithRecords(rpc, [warm, line(text('ok')), line(tool('Bash')), mine, line(text('yours'))], records);
  assert.deepEqual(plain.map((e) => e.maintenance === true), [true, true, false, false, false], 'no question: still folded');
  assert.equal(agentRpc.maintenanceEntry(rpc, line(text('Which one?'))), true, 'the text alone is a reply until the question arrives');
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
