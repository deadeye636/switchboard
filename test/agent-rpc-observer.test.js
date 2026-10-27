'use strict';
// The core observer of a runtime-driven session (#507 slice 2b, spec 39): what the review runner follows a session
// through, without a view. Against a real child on a real pipe, through pi-native's own protocol half, like
// test/agent-rpc.test.js — so the observer sees what the core really moves, not a mock agreeing with itself.
const test = require('node:test');
const assert = require('node:assert/strict');

const { harness, stopped, until, agentRpc } = require('./helpers/agent-rpc-harness');
const claudeNative = require('../src/backends/claude-native');
const piNative = require('../src/backends/pi-native');

const opsOf = (h) => h.sent.filter(m => m.ch === 'agent-event').map(m => m.op);

test('the observer sees the busy edges in order and each finished entry with its assistant text', async (t) => {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  const seen = [];
  assert.equal(agentRpc.observe('fake-session', {
    onBusy: (busy) => seen.push(['busy', busy]),
    onEntry: (entry, text) => seen.push(['entry', entry.message.role, text]),
  }), true);
  await agentRpc.sendTurn('fake-session', { text: 'hello', mode: 'prompt' });
  await until(() => seen.some(([k, b]) => k === 'busy' && b === false));
  const busy = seen.filter(([k]) => k === 'busy').map(([, b]) => b);
  assert.deepEqual(busy, [true, false]);
  const entries = seen.filter(([k]) => k === 'entry');
  assert.deepEqual(entries.map(([, role]) => role), ['user', 'assistant']);
  assert.equal(entries[0][2], null, 'a user entry has no assistant text');
  assert.equal(typeof entries[1][2], 'string');
  assert.ok(entries[1][2].length > 0);
  assert.equal(agentRpc.observe('nobody', {}), false);
});

test('an observer that answers an ask writes the answer, draws nothing and reports no waiting', async (t) => {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  const asked = [];
  agentRpc.observe('fake-session', { onAsk: (request) => { asked.push(request.id); return { value: 'Deny' }; } });
  await agentRpc.sendTurn('fake-session', { text: 'ask me', mode: 'prompt' });
  await until(() => opsOf(h).some(o => o.op === 'append' && /answered Deny/.test(JSON.stringify(o.entry))));
  assert.deepEqual(asked, ['q1']);
  assert.ok(!opsOf(h).some(o => o.op === 'ask'), 'no card');
  assert.ok(!h.signals.some(s => s.kind === 'waiting'), 'no waiting report');
  assert.equal((await agentRpc.attach('fake-session')).asks.length, 0, 'nothing is kept for a later view');
});

test('an observer that returns null leaves the ask to the card, as today', async (t) => {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  agentRpc.observe('fake-session', { onAsk: () => null });
  await agentRpc.sendTurn('fake-session', { text: 'ask me', mode: 'prompt' });
  await until(() => opsOf(h).some(o => o.op === 'ask'));
  assert.ok(h.signals.some(s => s.kind === 'waiting'));
  assert.deepEqual(agentRpc.answerAsk('fake-session', 'q1', { value: 'Allow once' }), { ok: true });
});

test('a throwing observer member does not stop the stream', async (t) => {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  agentRpc.observe('fake-session', {
    onBusy: () => { throw new Error('boom'); },
    onEntry: () => { throw new Error('boom'); },
  });
  await agentRpc.sendTurn('fake-session', { text: 'hello', mode: 'prompt' });
  await until(() => h.signals.some(s => s.kind === 'idle'));
  const appended = opsOf(h).filter(o => o.op === 'append').map(o => o.entry.message.role);
  assert.deepEqual(appended, ['user', 'assistant'], 'the view still got every op');
  assert.deepEqual(h.signals.map(s => s.kind), ['busy', 'idle'], 'and the session still reported both edges');
  assert.ok(h.warned.some(l => /observer onBusy failed/.test(l)), 'the throw is logged at warn');
  assert.ok(h.warned.some(l => /observer onEntry failed/.test(l)));
});

test('onExit fires once when the child ends', async (t) => {
  const h = harness();
  await until(() => h.rekeys.length === 1);
  let exits = 0;
  agentRpc.observe('fake-session', { onExit: () => { exits += 1; } });
  await stopped(h);
  await until(() => exits === 1);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(exits, 1);
});

// Every op and signal in full, without the clock: what the view and the inbox get.
const comparable = (value) => JSON.parse(JSON.stringify(value, (k, v) => (k === 'timestamp' || k === 'at' ? undefined : v)));

test('a session watched by an observer that answers nothing sends the same ops and signals as one with none', async (t) => {
  const run = async (observer) => {
    const h = harness();
    t.after(() => stopped(h));
    await until(() => h.rekeys.length === 1);
    if (observer) agentRpc.observe('fake-session', observer);
    await agentRpc.sendTurn('fake-session', { text: 'hello', mode: 'prompt' });
    await until(() => h.signals.some(s => s.kind === 'idle'));
    await agentRpc.sendTurn('fake-session', { text: 'ask me', mode: 'prompt' });
    await until(() => opsOf(h).some(o => o.op === 'ask'));
    return comparable({ ops: opsOf(h), signals: h.signals });
  };
  const plain = await run(null);
  const watched = await run({ onBusy() {}, onEntry() {}, onAsk: () => null, onExit() {} });
  assert.deepEqual(watched, plain);
});

test('a failed model call is no answer: both decoders mark it, and assistantTextOf answers null', () => {
  const claudeProtocol = require('../src/backends/claude-native/rpc-protocol');
  const cd = claudeProtocol.createDecoder({ cwd: '' });
  const cOps = cd.decode({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'Invalid API key' }] }, error: 'authentication_failed' }) || [];
  const cEntry = cOps.find(o => o.op === 'append').entry;
  assert.equal(cEntry._failed, true);
  assert.equal(claudeNative.rpc.assistantTextOf(cEntry), null);
  assert.ok(cOps.some(o => o.op === 'notice' && o.level === 'error'), 'the notice is still said');

  const piProtocol = require('../src/backends/pi-native/rpc-protocol');
  const pd = piProtocol.createDecoder({ cwd: '' });
  const pOps = pd.decode({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'half an ans' }], stopReason: 'error', errorMessage: 'overloaded', timestamp: 1 } }) || [];
  const pEntry = pOps.find(o => o.op === 'append').entry;
  assert.equal(pEntry._failed, true);
  assert.equal(piNative.rpc.assistantTextOf(pEntry), null);
  const okOps = pd.decode({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'fine' }], stopReason: 'stop', timestamp: 2 } }) || [];
  assert.equal(piNative.rpc.assistantTextOf(okOps.find(o => o.op === 'append').entry), 'fine');
});

test('assistantTextOf: the text of an assistant entry, null for a user entry and a tool result, per backend', () => {
  const claude = claudeNative.rpc.assistantTextOf;
  assert.equal(claude({ type: 'assistant', message: { content: [{ type: 'text', text: 'one' }, { type: 'tool_use', id: 't' }, { type: 'text', text: 'two' }] } }), 'one\ntwo');
  assert.equal(claude({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' }] } }), null, 'tool calls only');
  assert.equal(claude({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }), null);
  assert.equal(claude({ type: 'user', message: { content: [{ type: 'tool_result', content: 'out' }] } }), null);
  assert.equal(claude({ type: 'task-notice' }), null);
  assert.equal(claude(null), null);

  const pi = piNative.rpc.assistantTextOf;
  assert.equal(pi({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } }), 'answer');
  assert.equal(pi({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 't' }] } }), null);
  assert.equal(pi({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }), null);
  assert.equal(pi({ type: 'message', message: { role: 'user', content: [{ type: 'toolResult', text: 'out' }] } }), null, 'a tool result is drawn as user');
  assert.equal(pi({ type: 'assistant', message: { content: 'x' } }), null);
  assert.equal(pi(undefined), null);
});
