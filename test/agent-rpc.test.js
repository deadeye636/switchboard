'use strict';
// src/app/agent-rpc.js (#568) against a real child on a real pipe: the pipe itself, turns, identity,
// questions and the exit path. The child is a stand-in for `pi --mode rpc`
// (test/fixtures/fake-rpc-agent.js) that answers the way Pi was measured to answer, and the protocol half
// is the runtime-driven Pi backend's own — so what is tested is the core moving a real backend's ops, not
// a mock agreeing with itself.
//
// The session commands answered by the app and the `!` shell line have files of their own
// (`agent-rpc-session-commands.test.js`, `agent-rpc-shell.test.js`): every test here costs a real child
// process, and node parallelises across files rather than within one.
const test = require('node:test');
const assert = require('node:assert/strict');

const { harness, stopped, until, agentRpc } = require('./helpers/agent-rpc-harness');

test('the session is re-keyed onto the id the runtime names, through the shared re-key', async (t) => {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  assert.deepEqual(h.rekeys[0], { from: 'launch-id', to: 'fake-session' });
  assert.ok(h.activeSessions.has('fake-session'));
});

test('a typed line and a carriage return are a turn: busy, the ops, then idle through the bind-signal path', async (t) => {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  // What the seed path, the trigger watcher and a launcher all write into a PTY — bracketed paste and CR.
  h.proc.write('\x1b[200~hello\x1b[201~\r');
  await until(() => h.signals.some(s => s.kind === 'idle'));
  const kinds = h.signals.map(s => s.kind);
  assert.deepEqual(kinds, ['busy', 'idle']);
  assert.equal(h.signals[0].turn_start, true, 'a started run is the turn start that releases a held Stop (#495)');
  assert.equal(h.signals[0].sessionId, 'fake-session');

  const ops = h.sent.filter(m => m.ch === 'agent-event').map(m => m.op);
  const appended = ops.filter(o => o.op === 'append').map(o => o.entry.message.role);
  assert.deepEqual(appended, ['user', 'assistant']);
  assert.ok(ops.some(o => o.op === 'busy' && o.busy === true));
  assert.ok(ops.some(o => o.op === 'busy' && o.busy === false));
  // Partials are coalesced, never reordered: whatever partial went out came before the finished turn.
  const lastPartial = ops.map(o => o.op).lastIndexOf('partial');
  const assistantAppend = ops.findIndex(o => o.op === 'append' && o.entry.message.role === 'assistant');
  assert.ok(lastPartial < assistantAppend || ops[lastPartial].entry === null);
});

test('attach answers the conversation from the runtime, and send/abort answer ok', async (t) => {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  assert.deepEqual(await agentRpc.sendTurn('fake-session', { text: 'one', mode: 'prompt' }), { ok: true });
  await until(() => h.signals.some(s => s.kind === 'idle'));
  const snap = await agentRpc.attach('fake-session');
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.entries.map(e => e.message.role), ['user', 'assistant']);
  assert.equal(snap.busy, false);
  assert.deepEqual(await agentRpc.abortTurn('fake-session'), { ok: true });
  assert.equal((await agentRpc.sendTurn('fake-session', { text: '   ' })).ok, false, 'an empty turn is refused here');
  assert.equal((await agentRpc.attach('nobody')).ok, false);
});

test('a question blocks until answered: it is reported as waiting, answered once, and gone', async (t) => {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: 'ask me', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'ask'));
  assert.ok(h.signals.some(s => s.kind === 'waiting' && s.prompt_kind === 'select'));
  const snap = await agentRpc.attach('fake-session');
  assert.equal(snap.asks.length, 1, 'a view mounted while it waits still gets the question');
  assert.deepEqual(agentRpc.answerAsk('fake-session', 'q1', { value: 'Allow once' }), { ok: true });
  assert.equal(agentRpc.answerAsk('fake-session', 'q1', { value: 'Allow once' }).ok, false, 'answered once');
  await until(() => h.sent.some(m => m.op && m.op.op === 'append' && /answered Allow once/.test(JSON.stringify(m.op.entry))));
});

// #642: a question one of pi-native's own commands asks belongs to the command, not to a run. Pi keeps waiting
// on it across a run that starts and settles meanwhile, so the app must too — and when Pi takes it back
// itself, the app closes it and the session stops waiting.
test('a command\'s question outlives a run, and closes when the runtime takes it back', async (t) => {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: 'command ask', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'ask'));
  await agentRpc.sendTurn('fake-session', { text: 'hello', mode: 'prompt' });
  await until(() => h.signals.some(s => s.kind === 'idle'));
  assert.equal((await agentRpc.attach('fake-session')).asks.length, 1, 'the run settling left it open');
  assert.equal(h.signals[h.signals.length - 1].kind, 'waiting', 'and the session is still waiting on the user');
  assert.ok(!h.sent.some(m => m.op && m.op.op === 'answered'));

  await agentRpc.sendTurn('fake-session', { text: 'take it back', mode: 'prompt' });
  await until(() => h.sent.some(m => m.op && m.op.op === 'answered' && m.op.id === 'c1'));
  assert.equal((await agentRpc.attach('fake-session')).asks.length, 0);
  assert.equal(h.signals[h.signals.length - 1].kind, 'idle');
  assert.equal(agentRpc.answerAsk('fake-session', 'c1', { value: 'a' }).ok, false, 'a question taken back cannot be answered');
});

// #643: the input's autocomplete asks the session through the backend's own protocol half — the command list
// in the app's words, one command's arguments (answered beside the prompt response), and the project's files.
test('the autocomplete: commands, a command\'s arguments, and paths inside the session\'s project', async (t) => {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  const listed = await agentRpc.listCommands('fake-session');
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.commands.map(c => [c.name, c.kind, c.arguments]), [
    ['model', 'command', true], ['fix-tests', 'template', false], ['skill:search', 'skill', false],
  ], 'the internal completion command is not offered');
  const args = await agentRpc.completeArguments('fake-session', 'model');
  assert.deepEqual(args, { ok: true, items: [{ value: 'openai-codex/gpt-5.6-sol', description: 'GPT 5.6 (current)' }] });
  assert.ok(!h.sent.some(m => m.op && m.op.op === 'notice'), 'the answer is not drawn as a notice');
  const paths = await agentRpc.completeSessionPaths('fake-session', 'fixtures/fake-rpc');
  assert.deepEqual(paths.items, [{ value: 'fixtures/fake-rpc-agent.js', dir: false }], 'relative to the session\'s own directory');
  assert.deepEqual((await agentRpc.completeSessionPaths('fake-session', '../')).items, [], 'nothing outside it');
  assert.equal((await agentRpc.listCommands('nobody')).ok, false);
});

test('a carriage return inside a bracketed paste is text: a pasted CRLF block is one turn', async (t) => {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  h.proc.write('\x1b[200~line one\r\nline two\x1b[201~');
  h.proc.write('\r');
  await until(() => h.signals.some(s => s.kind === 'idle'));
  const users = h.sent.filter(m => m.op && m.op.op === 'append' && m.op.entry.message.role === 'user');
  assert.equal(users.length, 1);
  assert.match(JSON.stringify(users[0].op.entry), /line one\\nline two/);
});

test('ops are numbered, and attach says which number its snapshot was taken at', async (t) => {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  await agentRpc.sendTurn('fake-session', { text: 'one', mode: 'prompt' });
  await until(() => h.signals.some(s => s.kind === 'idle'));
  const seqs = h.sent.filter(m => m.ch === 'agent-event').map(m => m.op.seq);
  assert.ok(seqs.length > 0 && seqs.every((n, i) => n === i + 1), 'numbered in the order they were sent');
  const snap = await agentRpc.attach('fake-session');
  assert.ok(snap.seq >= seqs[seqs.length - 1], 'a snapshot taken after them covers them');
});

test('kill ends the child and the exit handlers run — the path the stop and the quit rely on', async () => {
  const h = harness();
  let exited = null;
  h.proc.onExit((e) => { exited = e; });
  assert.ok(Number.isInteger(h.proc.pid));
  h.proc.kill();
  await until(() => exited !== null);
  assert.equal(typeof exited.exitCode, 'number');
});

// #647: a view mounts while the runtime is still starting. What it asked waits in the pipe, and the ordinary
// response timeout, measured from the spawn, used to report "did not answer" about a healthy session.
test('a request sent while the runtime is still starting waits for the start, not the response timeout', async (t) => {
  const h = harness({ env: { FAKE_RPC_BOOT_MS: '600' }, timeouts: { responseMs: 150, startupMs: 10000 } });
  t.after(() => stopped(h));
  const snap = await agentRpc.attach('launch-id');
  assert.equal(snap.ok, true, 'answered once the runtime began reading, although that took four response timeouts');
  assert.deepEqual(snap.entries, []);
});

test('a runtime that never starts answering is reported as not started, and the log says when', async (t) => {
  const h = harness({ env: { FAKE_RPC_BOOT_MS: 'never' }, timeouts: { responseMs: 100, startupMs: 400 } });
  t.after(() => stopped(h));
  const snap = await agentRpc.attach('launch-id');
  assert.equal(snap.ok, false);
  assert.match(snap.error, /did not start answering within 1 minute./);
  assert.ok(h.logged.some(l => /attach launch-id failed \(not started\) \d+ ms after the start/.test(l)), h.logged.join('\n'));
});

// #648: a turn written as keys (the seed prompt, a trigger, a launcher) has nobody waiting on its answer, so a
// refusal used to vanish. It is handed back to the view as something still unsent.
test('a written turn the runtime refuses is handed back to the view, unsent', async (t) => {
  const h = harness();
  t.after(() => stopped(h));
  await until(() => h.rekeys.length === 1);
  h.proc.write('\x1b[200~refuse me\x1b[201~\r');
  await until(() => h.sent.some(m => m.op && m.op.op === 'unsent'));
  const op = h.sent.find(m => m.op && m.op.op === 'unsent').op;
  assert.equal(op.text, 'refuse me');
  assert.equal(op.reason, undefined, 'the runtime\'s own words stay in the log');
  h.proc.write('hello\r');
  await until(() => h.signals.some(s => s.kind === 'idle'));
  assert.equal(h.sent.filter(m => m.op && m.op.op === 'unsent').length, 1, 'an accepted turn is not handed back');
});

// A timeout is not a refusal: the line is still in the pipe and runs once the runtime reads it, so handing
// it back would invite the user to send it twice.
test('a written turn that only timed out is not handed back', async (t) => {
  const h = harness({ env: { FAKE_RPC_BOOT_MS: 'never' }, timeouts: { responseMs: 100, startupMs: 300 } });
  t.after(() => stopped(h));
  h.proc.write('hello\r');
  await until(() => h.logged.some(l => /got no answer yet \(not started\)/.test(l)));
  assert.ok(!h.sent.some(m => m.op && m.op.op === 'unsent'));
});
