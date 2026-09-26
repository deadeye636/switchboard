'use strict';
// src/app/agent-rpc.js (#657) driving a runtime that is NOT shaped like Pi: it acknowledges no turn line,
// cannot be asked which session it is on or for its conversation, announces a move itself, answers its
// control requests under a key of its own, and writes a transcript the app reads back. The child is
// `test/fixtures/fake-stream-agent.js`; the protocol half below speaks its format, which belongs to no real
// CLI. What is tested is that every place the core used to assume Pi's shape is now a declaration.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { harness, stopped, until, agentRpc, tempDataDir } = require('./helpers/agent-rpc-harness');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-stream-agent.js');

function streamRpc(transcript, extra) {
  return {
    createDecoder: () => ({
      decode(msg) {
        switch (msg.ev) {
          case 'append': return [{ op: 'append', entry: msg.entry }];
          case 'result': return [{ op: 'busy', busy: false }];
          case 'identity': return [{ op: 'identity', sessionId: msg.id }];
          case 'reset': return [{ op: 'reset', entries: [] }];
          case 'ask': return [{ op: 'ask', request: { id: msg.id, method: 'confirm', title: 'May I?', input: msg.input } }];
          default: return [];
        }
      },
      currentPartial: () => null,
    }),
    responseOf: (m) => (m && m.type === 'ctl_response'
      ? { id: m.request_id, payload: m.ok ? { success: true, data: m.data } : { success: false, error: m.error } }
      : null),
    sendAcknowledged: false,
    sendCommand: ({ text }) => ({ type: 'user', text }),
    abortCommand: (id) => ({ type: 'ctl', request_id: id, what: 'interrupt' }),
    commandsCommand: (id) => ({ type: 'ctl', request_id: id, what: 'commands' }),
    commandsFromResponse: (res) => [{ name: String(res.data.what) }],
    answerCommand: (id, _answer, asked) => ({ type: 'answer', id, echoed: asked ? asked.input : null }),
    entriesFromTranscript: async () => {
      let text = '';
      try { text = await fs.promises.readFile(transcript, 'utf8'); } catch { return []; }
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type !== 'marker');
    },
    entryKey: (e) => (e && e.uuid) || null,
    gracefulStopMs: 1500,
    ...(extra || {}),
  };
}

function streamHarness(t, { lag = false, ignoreEof = false, rpc: extra, timeouts } = {}) {
  const dir = tempDataDir(t);
  const transcript = path.join(dir, 'transcript.jsonl');
  const env = { FAKE_TRANSCRIPT: transcript, FAKE_LAG: lag ? '1' : '', FAKE_IGNORE_EOF: ignoreEof ? '1' : '' };
  const h = harness({ rpc: streamRpc(transcript, extra), fixture: FIXTURE, env, timeouts });
  return { ...h, transcript };
}

const ops = (h) => h.sent.filter((m) => m.ch === 'agent-event').map((m) => m.op);

test('a backend without a state request is not asked, and nothing rejects unhandled', async (t) => {
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  const h = streamHarness(t);
  t.after(() => stopped(h));
  assert.deepEqual(await agentRpc.sendTurn('launch-id', { text: 'hello', mode: 'prompt' }), { ok: true });
  await until(() => h.signals.some((s) => s.kind === 'idle'));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(rejections, []);
  assert.deepEqual(h.rekeys, [], 'nothing named another session, so nothing was re-keyed');
});

test('an unacknowledged turn is sent by the write: busy at once, idle from the stream, never handed back', async (t) => {
  // Short timeouts, so a turn that still waited for an answer would be refused well inside the test.
  const h = streamHarness(t, { timeouts: { responseMs: 200, startupMs: 200 } });
  t.after(() => stopped(h));
  h.proc.write('\x1b[200~typed turn\x1b[201~\r');
  await until(() => h.signals.some((s) => s.kind === 'idle'));
  assert.deepEqual(h.signals.map((s) => s.kind), ['busy', 'idle']);
  assert.equal(h.signals[0].turn_start, true, 'the write is the turn start');
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!ops(h).some((o) => o.op === 'unsent'), 'a turn nobody acknowledges is not handed back as refused');
  assert.deepEqual(ops(h).filter((o) => o.op === 'append').map((o) => o.entry.message.role), ['user', 'assistant']);
});

test('a line written while a turn runs does not start a second busy edge', async (t) => {
  const h = streamHarness(t);
  t.after(() => stopped(h));
  const state = h.proc._agent;
  state.busy = true;   // a turn is running
  assert.deepEqual(await agentRpc.sendTurn('launch-id', { text: 'steer', mode: 'steer' }), { ok: true });
  await until(() => h.signals.some((s) => s.kind === 'idle'));
  assert.deepEqual(h.signals.map((s) => s.kind), ['idle'], 'only the stream ended it; the write added no busy');
});

test('a move the runtime announces re-keys the session through the shared re-key', async (t) => {
  const h = streamHarness(t);
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: 'rename', mode: 'prompt' });
  await until(() => h.rekeys.length === 1);
  assert.deepEqual(h.rekeys[0], { from: 'launch-id', to: 'renamed-session' });
  assert.ok(!ops(h).some((o) => o.op === 'identity'), 'the identity op is the core\'s, not drawn');
});

test('a response is recognised by the backend\'s own spelling, success and refusal alike', async (t) => {
  const h = streamHarness(t);
  t.after(() => stopped(h));
  assert.deepEqual(await agentRpc.listCommands('launch-id'), { ok: true, commands: [{ name: 'commands' }] });
  assert.deepEqual(await agentRpc.abortTurn('launch-id'), { ok: true });
  const refused = await h.proc._agent.request((id) => ({ type: 'ctl', request_id: id, what: 'fail' }));
  assert.equal(refused.success, false);
  assert.equal(refused.error, 'nope');
});

test('the answer to a question is built with the question it answers', async (t) => {
  const h = streamHarness(t);
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: 'ask me', mode: 'prompt' });
  await until(() => ops(h).some((o) => o.op === 'ask'));
  assert.deepEqual(agentRpc.answerAsk('launch-id', 'a1', { value: 'yes' }), { ok: true });
  await until(() => ops(h).some((o) => o.op === 'append' && /answered with/.test(JSON.stringify(o.entry))));
  const reply = ops(h).filter((o) => o.op === 'append').pop();
  assert.match(JSON.stringify(reply.entry), /x\.txt/, 'the request\'s own input came back in the answer');
});

test('attach reads the transcript, and adds what the file does not have yet without repeating anything', async (t) => {
  const h = streamHarness(t, { lag: true });
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: 'one', mode: 'prompt' });
  await until(() => h.signals.some((s) => s.kind === 'idle'));
  const onDisk = fs.readFileSync(h.transcript, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(onDisk, 1, 'the file is one entry behind the pipe');
  const snap = await agentRpc.attach('launch-id');
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.entries.map((e) => e.uuid), ['e1', 'e2'], 'the reply the file lacks comes from what was sent');
  assert.deepEqual(snap.keys, ['e1'], 'only the file\'s entries are named: the added one\'s op is never replayed');
  assert.equal(snap.seq, h.proc._agent.seq, 'the number is taken after the read, so the view replays nothing already in it');
  assert.equal(snap.busy, false);
});

test('every append op carries its key, and the snapshot names the keys it holds', async (t) => {
  const h = streamHarness(t);
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: 'keys', mode: 'prompt' });
  await until(() => h.signals.some((s) => s.kind === 'idle'));
  assert.deepEqual(ops(h).filter((o) => o.op === 'append').map((o) => o.key), ['e1', 'e2']);
  const snap = await agentRpc.attach('launch-id');
  assert.deepEqual(snap.keys, ['e1', 'e2'], 'the view needs these to skip an op the file was ahead of');
});

test('a reset during the transcript read makes the attach read again rather than answer the old conversation', async (t) => {
  const h = streamHarness(t);
  t.after(() => stopped(h));
  const state = h.proc._agent;
  await agentRpc.sendTurn('launch-id', { text: 'before', mode: 'prompt' });
  await until(() => h.signals.some((s) => s.kind === 'idle'));
  assert.ok(state.recentAppends.length > 0);
  let reads = 0;
  const original = state.rpc.entriesFromTranscript;
  state.rpc.entriesFromTranscript = async (arg) => {
    reads += 1;
    if (reads === 1) {
      // The runtime replaces the conversation while this read runs: a real reset op, through the stream.
      const before = state.resets;
      await agentRpc.sendTurn('launch-id', { text: 'replace', mode: 'prompt' });
      await until(() => state.resets === before + 1);
      assert.deepEqual(state.recentAppends, [], 'what was kept described the old conversation');
    }
    return original(arg);
  };
  const snap = await agentRpc.attach('launch-id');
  assert.equal(snap.ok, true);
  assert.equal(reads, 2, 'read once more after the reset');
  state.rpc.entriesFromTranscript = async (arg) => { state.resets += 1; return original(arg); };
  const again = await agentRpc.attach('launch-id');
  assert.equal(again.ok, false, 'replaced during both reads: a refusal, not a stale conversation');
});

test('after a real turn has settled, a line written starts the next turn with a busy edge of its own', async (t) => {
  const h = streamHarness(t);
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: 'first', mode: 'prompt' });
  await until(() => h.signals.filter((s) => s.kind === 'idle').length === 1);
  await agentRpc.sendTurn('launch-id', { text: 'second', mode: 'prompt' });
  await until(() => h.signals.filter((s) => s.kind === 'idle').length === 2);
  assert.deepEqual(h.signals.map((s) => s.kind), ['busy', 'idle', 'busy', 'idle']);
});

test('attach does not repeat an entry the file already has', async (t) => {
  const h = streamHarness(t);
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: 'two', mode: 'prompt' });
  await until(() => h.signals.some((s) => s.kind === 'idle'));
  const snap = await agentRpc.attach('launch-id');
  assert.deepEqual(snap.entries.map((e) => e.uuid), ['e1', 'e2']);
});

test('attach of a session that has written nothing yet is an empty conversation, not a failure', async (t) => {
  const h = streamHarness(t);
  t.after(() => stopped(h));
  const snap = await agentRpc.attach('launch-id');
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.entries, []);
});

test('a graceful stop closes stdin and lets the runtime finish writing before it goes', async (t) => {
  const h = streamHarness(t);
  const exited = new Promise((resolve) => h.proc.onExit(resolve));
  await agentRpc.sendTurn('launch-id', { text: 'three', mode: 'prompt' });
  await until(() => h.signals.some((s) => s.kind === 'idle'));
  h.proc.kill();
  await exited;
  const last = fs.readFileSync(h.transcript, 'utf8').split('\n').filter(Boolean).pop();
  assert.equal(JSON.parse(last).uuid, 'flushed', 'the line written on the way out reached the file');
});

test('while a stop waits, nothing more is written, and a second stop does not wait again', async (t) => {
  const h = streamHarness(t, { ignoreEof: true, rpc: { gracefulStopMs: 5000 } });
  const exited = new Promise((resolve) => h.proc.onExit(resolve));
  const started = Date.now();
  h.proc.kill();
  assert.equal((await agentRpc.sendTurn('launch-id', { text: 'too late', mode: 'prompt' })).ok, false,
    'a turn written into a closed stdin is not reported as sent');
  h.proc.kill();
  await exited;
  assert.ok(Date.now() - started < 4000, 'the second stop took the tree at once instead of waiting out 5 s');
});

test('a runtime that ignores the closed stdin is taken down once the wait is over', async (t) => {
  const h = streamHarness(t, { ignoreEof: true, rpc: { gracefulStopMs: 300 } });
  const started = Date.now();
  const exited = new Promise((resolve) => h.proc.onExit(resolve));
  h.proc.kill();
  await exited;
  assert.ok(Date.now() - started >= 250, 'it was given the wait');
  assert.ok(Date.now() - started < 10000, 'and then stopped');
});

test('a backend that names no response spelling is refused at start', () => {
  // Initialised here as well, so the refusal tested is the protocol check even when this test runs alone.
  agentRpc.init({ activeSessions: new Map(), getMainWindow: () => null, log: { info() {}, warn() {}, debug() {} } });
  const noResponse = { createDecoder: () => ({ decode: () => [], currentPartial: () => null }) };
  assert.throws(() => agentRpc.start({ tag: 't', rpc: noResponse, command: process.execPath, args: [FIXTURE], cwd: __dirname }), /declares no protocol/);
});
