'use strict';
// src/app/agent-rpc.js (#568) against a real child on a real pipe. The child is a stand-in for
// `pi --mode rpc` (test/fixtures/fake-rpc-agent.js) that answers the way Pi was measured to answer, and the
// protocol half is the runtime-driven Pi backend's own — so what is tested is the core moving a real
// backend's ops, not a mock agreeing with itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const agentRpc = require('../src/app/agent-rpc');
const piNative = require('../src/backends/pi-native');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-rpc-agent.js');
const TAG = 'tag-1';

function harness() {
  const activeSessions = new Map();
  const sent = [];
  const signals = [];
  const rekeys = [];
  const window = { isDestroyed: () => false, webContents: { send: (ch, id, op) => sent.push({ ch, id, op }) } };
  agentRpc.init({
    activeSessions,
    getMainWindow: () => window,
    windowForSession: () => window,
    getAppQuitting: () => false,
    // The re-key every live binding goes through, reduced to what it does to the map.
    adoptSessionId: (tag, id) => {
      for (const [key, s] of activeSessions) {
        if (s._terminalTag === tag && key !== id) {
          activeSessions.delete(key);
          activeSessions.set(id, s);
          s.realSessionId = id;
          rekeys.push({ from: key, to: id });
          return { from: key, to: id, kind: 'terminal' };
        }
      }
      return null;
    },
    deliverBindSignal: (sessionId, hook) => signals.push({ sessionId, ...hook }),
    log: { info() {}, warn() {}, debug() {} },
  });
  const proc = agentRpc.start({
    tag: TAG, rpc: piNative.rpc, command: process.execPath, args: [FIXTURE], cwd: __dirname, env: process.env, label: 'Fake',
  });
  activeSessions.set('launch-id', { pty: proc, _terminalTag: TAG, exited: false });
  return { activeSessions, sent, signals, rekeys, proc };
}

const until = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 20));
  }
};

test('the session is re-keyed onto the id the runtime names, through the shared re-key', async (t) => {
  const h = harness();
  t.after(() => h.proc.kill());
  await until(() => h.rekeys.length === 1);
  assert.deepEqual(h.rekeys[0], { from: 'launch-id', to: 'fake-session' });
  assert.ok(h.activeSessions.has('fake-session'));
});

test('a typed line and a carriage return are a turn: busy, the ops, then idle through the bind-signal path', async (t) => {
  const h = harness();
  t.after(() => h.proc.kill());
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
  t.after(() => h.proc.kill());
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
  t.after(() => h.proc.kill());
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

test('a carriage return inside a bracketed paste is text: a pasted CRLF block is one turn', async (t) => {
  const h = harness();
  t.after(() => h.proc.kill());
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
  t.after(() => h.proc.kill());
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
