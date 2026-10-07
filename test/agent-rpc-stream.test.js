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

function streamHarness(t, { lag = false, ignoreEof = false, rpc: extra, timeouts, options, appliedOptions, approvalMemory, backendId } = {}) {
  const dir = tempDataDir(t);
  const transcript = path.join(dir, 'transcript.jsonl');
  const env = { FAKE_TRANSCRIPT: transcript, FAKE_LAG: lag ? '1' : '', FAKE_IGNORE_EOF: ignoreEof ? '1' : '' };
  const h = harness({ rpc: streamRpc(transcript, extra), fixture: FIXTURE, env, timeouts, options, appliedOptions, approvalMemory, backendId });
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

// #662: a turn may carry images, checked against what the runtime declared it takes, whoever sends.
test('images reach the runtime only as it declared it takes them', async (t) => {
  const seen = [];
  const PNG = Buffer.from('fake png bytes').toString('base64');
  const h = streamHarness(t, { rpc: {
    imageInput: { types: ['image/png'], maxBytes: 64 },
    sendCommand: (args) => { seen.push(args); return { type: 'user', text: args.text }; },
  } });
  t.after(() => stopped(h));
  const send = (payload) => agentRpc.sendTurn('launch-id', { mode: 'prompt', ...payload });
  assert.equal((await send({ text: 'look', images: [{ mimeType: 'image/gif', data: PNG }] })).ok, false, 'a type it did not declare');
  assert.equal((await send({ text: 'look', images: [{ mimeType: 'image/png', data: 'A'.repeat(200) }] })).ok, false, 'larger than it takes');
  assert.equal((await send({ text: 'look', images: [{ mimeType: 'image/png', data: 'not base64!' }] })).ok, false, 'not base64');
  assert.equal((await send({ text: 'look', images: [{ mimeType: 'image/png', data: 'AAAAA' }] })).ok, false, 'not a whole base64 length');
  assert.equal((await send({ text: 'look', images: 'nope' })).ok, false, 'not a list');
  assert.equal(seen.length, 0, 'nothing refused was written');
  assert.deepEqual(await send({ text: '', images: [{ mimeType: 'image/png', data: PNG }] }), { ok: true }, 'an image alone is a turn');
  assert.deepEqual(seen[0].images, [{ mimeType: 'image/png', data: PNG }]);
  // Sent once that turn is over: a prompt sent while it runs is held (#702), which is its own test below.
  await until(() => !h.proc._agent.busy);
  await send({ text: 'plain' });
  assert.equal(seen[1].images, undefined, 'a turn without images carries none');
});

test('a runtime that declares no image input refuses a turn with images', async (t) => {
  const h = streamHarness(t);
  t.after(() => stopped(h));
  const res = await agentRpc.sendTurn('launch-id', { text: 'look', mode: 'prompt', images: [{ mimeType: 'image/png', data: 'AAAA' }] });
  assert.deepEqual(res, { ok: false, error: 'This session does not take images.' });
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

// #702: a prompt sent while a turn runs is held by the core, not written, so it can be withdrawn or taken back.
test('a prompt sent during a turn is held, then sent when the turn ends, one per turn', async (t) => {
  const seen = [];
  const h = streamHarness(t, { rpc: { sendCommand: (args) => { seen.push(args.text); return { type: 'user', text: args.text }; } } });
  t.after(() => stopped(h));
  const state = h.proc._agent;
  state.busy = true;   // a turn is running
  const first = await agentRpc.sendTurn('launch-id', { text: 'next one', mode: 'prompt' });
  const second = await agentRpc.sendTurn('launch-id', { text: 'after that', mode: 'prompt' });
  assert.ok(first.ok && first.held && second.held, 'both held');
  assert.deepEqual(seen, [], 'nothing written while the turn runs');
  const lastHeld = () => ops(h).filter((o) => o.op === 'held').pop();
  assert.deepEqual(lastHeld().items.map((i) => i.text), ['next one', 'after that']);
  assert.deepEqual(agentRpc.turnQueueOf('launch-id').queued, 2, 'held prompts are owed turns');
  // The steer is not held: it goes into the running turn. The fake answers it with a result, which ends the
  // turn — and each ending sends the next held prompt, in order, one turn each.
  await agentRpc.sendTurn('launch-id', { text: 'steer now', mode: 'steer' });
  await until(() => seen.includes('after that'));
  assert.deepEqual(seen, ['steer now', 'next one', 'after that']);
  assert.deepEqual(lastHeld().items, [], 'the queue is empty again');
});

test('a held prompt can be withdrawn with its text, and a Stop pauses the rest until one is sent (#702)', async (t) => {
  const seen = [];
  const h = streamHarness(t, { rpc: { sendCommand: (args) => { seen.push(args.text); return { type: 'user', text: args.text }; } } });
  t.after(() => stopped(h));
  const state = h.proc._agent;
  state.busy = true;
  const a = await agentRpc.sendTurn('launch-id', { text: 'keep me', mode: 'prompt' });
  const b = await agentRpc.sendTurn('launch-id', { text: 'rework me', mode: 'prompt' });
  const taken = await agentRpc.heldAction('launch-id', 'withdraw', b.held);
  assert.deepEqual(taken, { ok: true, text: 'rework me', images: [] });
  assert.equal((await agentRpc.heldAction('launch-id', 'withdraw', b.held)).ok, false, 'gone once taken');
  // Stop: the turn ends, and the held prompt waits instead of starting the next turn.
  await agentRpc.abortTurn('launch-id');
  assert.equal(state.heldPaused, true);
  // The fake answers an interrupt without a result, so the stopped turn's end is played here as a settle.
  state.busy = true;
  await agentRpc.sendTurn('launch-id', { text: 'end it', mode: 'steer' });
  await until(() => !state.busy);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!seen.includes('keep me'), 'a paused queue sends nothing by itself');
  assert.equal(agentRpc.turnQueueOf('launch-id').queued, 0, 'a paused queue owes no turn');
  // A new prompt while paused and idle goes at once; the held one still waits.
  await agentRpc.sendTurn('launch-id', { text: 'fresh', mode: 'prompt' });
  assert.ok(seen.includes('fresh') && !seen.includes('keep me'));
  await until(() => !state.busy);
  assert.deepEqual(await agentRpc.heldAction('launch-id', 'send', a.held), { ok: true });
  await until(() => seen.includes('keep me'));
});

// Verifier finding on #702: the pause has to be set before the abort goes out. A runtime that settles the run
// before it answers the abort (Pi's does) would otherwise send the first held prompt on the Stop itself.
test('a Stop pauses the held prompts before the abort goes out, so an early idle edge sends nothing (#702)', async (t) => {
  const seen = [];
  const h = streamHarness(t, { rpc: { sendCommand: (args) => { seen.push(args.text); return { type: 'user', text: args.text }; } } });
  t.after(() => stopped(h));
  const state = h.proc._agent;
  state.busy = true;
  await agentRpc.sendTurn('launch-id', { text: 'wait for me', mode: 'prompt' });
  const stopping = agentRpc.abortTurn('launch-id');
  assert.equal(state.heldPaused, true, 'paused at once, before any answer');
  // The run settles before the abort's answer is read: the fake ends a turn on any user line.
  await agentRpc.sendTurn('launch-id', { text: 'settle', mode: 'steer' });
  await until(() => !state.busy);
  await stopping;
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!seen.includes('wait for me'), 'the held prompt waited');
});

// Verifier finding on #702: a runtime that acknowledges its turns turns busy only when the turn starts, so a
// second flush before that would send the next held prompt into a running turn.
test('only one held prompt is in flight until its turn starts (#702)', async (t) => {
  const seen = [];
  const h = streamHarness(t, { rpc: { sendAcknowledged: true, sendCommand: ({ id, text }) => { seen.push(text); return { type: 'user', request_id: id, text }; } } });
  t.after(() => stopped(h));
  const state = h.proc._agent;
  state.busy = true;
  await agentRpc.sendTurn('launch-id', { text: 'A', mode: 'prompt' });
  await agentRpc.sendTurn('launch-id', { text: 'B', mode: 'prompt' });
  state.busy = false;
  state.flushHeld();
  state.flushHeld();
  // A third prompt sent before A's turn has started joins the queue behind B instead of pulling B out.
  await agentRpc.sendTurn('launch-id', { text: 'C', mode: 'prompt' });
  assert.deepEqual(seen, ['A']);
  assert.deepEqual(state.held.map((x) => x.text), ['B', 'C']);
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

// #691: what runs in the background, the session's figures, stopping one task and reading its output — each a
// declaration of the protocol half, carried by the core without reading any format.
test('background tasks and the context reach the view, the sidebar count reaches the main window, stop and output go by task', async (t) => {
  const dir = tempDataDir(t);
  const outputFile = path.join(dir, 'task.output');
  fs.writeFileSync(outputFile, 'line one\nline two\n');
  const stops = [];
  const h = streamHarness(t, { rpc: {
    createDecoder: () => ({
      decode(msg) {
        if (msg.ev === 'append') return [{ op: 'append', entry: msg.entry }];
        if (msg.ev === 'result') {
          return [{ op: 'tasks', tasks: [{ id: 't1', kind: 'shell', description: 'dev server', detail: 'npm run dev' }, { id: 'a1', kind: 'agent', description: 'review' }] }, { op: 'busy', busy: false }];
        }
        return [];
      },
      currentPartial: () => null,
      taskOutputFile: (id) => (id === 't1' ? outputFile : null),
    }),
    contextCommand: (id) => ({ type: 'ctl', request_id: id, what: 'ctx' }),
    contextFromResponse: (res) => (res.data.what === 'ctx' ? { percent: 42, tokens: 84000, window: 200000, model: 'Test 1.0' } : null),
    stopTaskCommand: (id, taskId) => { stops.push(taskId); return { type: 'ctl', request_id: id, what: `stop ${taskId}` }; },
  } });
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: 'hello', mode: 'prompt' });
  await until(() => ops(h).some((o) => o.op === 'tasks'));
  await until(() => ops(h).filter((o) => o.op === 'context').length >= 2);
  const context = ops(h).filter((o) => o.op === 'context').pop().context;
  assert.equal(context.percent, 42, 'asked at the start and after the settled run');
  const counts = h.sent.filter((m) => m.ch === 'agent-background');
  assert.deepEqual(counts.pop(), { ch: 'agent-background', id: 'launch-id', op: { shells: 1, agents: 1, other: 0 } });
  const attached = await agentRpc.attach('launch-id');
  assert.equal(attached.tasks.length, 2, 'a view mounted later gets the list');
  assert.equal(attached.context.model, 'Test 1.0');
  assert.deepEqual(await agentRpc.stopTask('launch-id', 't1'), { ok: true });
  assert.deepEqual(stops, ['t1']);
  const out = await agentRpc.taskOutput('launch-id', 't1');
  assert.equal(out.ok, true);
  assert.match(out.text, /line two/);
  assert.equal(out.path, undefined, 'the path is not handed to the view');
  assert.equal((await agentRpc.taskOutput('launch-id', 'a1')).ok, false, 'a task the runtime named no file for');
  assert.equal((await agentRpc.taskOutput('launch-id', '../../etc/passwd')).ok, false, 'a name is not a path');
});

// #692: a runtime whose fill answer names no model, but whose state does, shows the state's model on the line.
test('the model comes from the state answer where the fill names none, and follows a change', async (t) => {
  let model = 'Model A';
  const h = streamHarness(t, { rpc: {
    stateCommand: (id) => ({ type: 'ctl', request_id: id, what: 'state' }),
    sessionIdFromState: () => null,
    modelFromState: (res) => (res.data.what === 'state' ? model : null),
    contextCommand: (id) => ({ type: 'ctl', request_id: id, what: 'ctx' }),
    contextFromResponse: (res) => (res.data.what === 'ctx' ? { percent: 7, tokens: 7, window: 100, model: '' } : null),
  } });
  t.after(() => stopped(h));
  await until(() => ops(h).some((o) => o.op === 'context' && o.context.model === 'Model A' && o.context.percent === 7));
  assert.equal((await agentRpc.attach('launch-id')).context.model, 'Model A', 'kept for a view that mounts later');
  model = 'Model B';
  await agentRpc.sendTurn('launch-id', { text: 'hello', mode: 'prompt' });
  await until(() => ops(h).some((o) => o.op === 'context' && o.context.model === 'Model B'));
  const last = ops(h).filter((o) => o.op === 'context').pop().context;
  assert.equal(last.model, 'Model B', 'a model switched inside the session is drawn after the run');
});

// #754: what the spawn path says at the start reaches a view that attaches later — the attach's reset clears
// every notice, so the attach hands these back.
test('a notice from the spawn path is handed to every attach until a turn runs, bounded', async (t) => {
  const h = streamHarness(t);
  t.after(() => stopped(h));
  h.proc.notice('info', 'Resumed on Model A, the model this session last used');
  for (let i = 0; i < 10; i++) h.proc.notice('info', `extra ${i}`);
  const first = await agentRpc.attach('launch-id');
  assert.deepEqual(first.notices[0], { level: 'info', text: 'Resumed on Model A, the model this session last used' });
  assert.ok(first.notices.length <= 4, 'bounded');
  assert.deepEqual((await agentRpc.attach('launch-id')).notices[0], first.notices[0], 'a re-mount gets it again');
  // Once a turn has run, the start is history: a later attach does not draw it under that turn.
  await agentRpc.sendTurn('launch-id', { text: 'hello', mode: 'prompt' });
  await until(() => h.signals.some((s) => s.kind === 'idle'));
  assert.deepEqual((await agentRpc.attach('launch-id')).notices, []);
});

// #755 verifier G1: an attach that ASKS the runtime for the conversation (pi-native's path) notes the documents
// in it, as the transcript attach does — or a resumed session's earlier reads could be drawn but not opened.
test('an attach from the runtime\'s messages notes the documents in them', async (t) => {
  const doc = { type: 'document', path: '/work/report.pdf', kind: 'pdf', name: 'report.pdf', pages: 2 };
  const entry = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [doc] }] } };
  const seen = [];
  const h = streamHarness(t, { rpc: {
    messagesCommand: (id) => ({ type: 'ctl', request_id: id, what: 'messages' }),
    entriesFromMessages: (res, opts) => { seen.push(opts); return res.data.what === 'messages' ? [entry] : []; },
  } });
  t.after(() => stopped(h));
  assert.equal(agentRpc.documentRegistryOf('launch-id').has(doc.path), false, 'nothing before the attach');
  const res = await agentRpc.attach('launch-id');
  assert.equal(res.ok, true);
  assert.equal(agentRpc.documentRegistryOf('launch-id').has(doc.path), true);
  // Verifier L3: the session's directory reaches the backend, so a path it names relative to it can be made whole.
  assert.ok(seen.length && seen.every((o) => o && typeof o.cwd === 'string' && o.cwd), 'entriesFromMessages gets { cwd }');
});

// #697: the fill grows with every call inside a turn, so a runtime that answers mid-turn is asked then too.
test('the context is asked again during a turn only where the half declares that its runtime answers then', async (t) => {
  const ctx = { contextCommand: (id) => ({ type: 'ctl', request_id: id, what: 'ctx' }), contextFromResponse: () => ({ percent: 10 }) };
  const timeouts = { contextFollowMs: 30 };
  const during = streamHarness(t, { rpc: { ...ctx, contextDuringTurn: true }, timeouts });
  t.after(() => stopped(during));
  await until(() => ops(during).some((o) => o.op === 'context'));   // the one at the start
  await agentRpc.sendTurn('launch-id', { text: 'ask me', mode: 'prompt' });   // a turn that stays open
  await until(() => ops(during).filter((o) => o.op === 'context').length >= 2);
  assert.ok(!during.signals.some((s) => s.kind === 'idle'), 'asked while the turn still ran');
  await stopped(during);

  const settledOnly = streamHarness(t, { rpc: ctx, timeouts });
  t.after(() => stopped(settledOnly));
  await until(() => ops(settledOnly).some((o) => o.op === 'context'));
  await agentRpc.sendTurn('launch-id', { text: 'ask me', mode: 'prompt' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ops(settledOnly).filter((o) => o.op === 'context').length, 1, 'no ask inside the turn without the declaration');
});

test('a runtime that cannot stop a single task says so, and one that reads no context is not asked', async (t) => {
  const h = streamHarness(t);
  t.after(() => stopped(h));
  assert.equal((await agentRpc.stopTask('launch-id', 't1')).ok, false);
  await agentRpc.sendTurn('launch-id', { text: 'hello', mode: 'prompt' });
  await until(() => h.signals.some((s) => s.kind === 'idle'));
  assert.ok(!ops(h).some((o) => o.op === 'context'));
});

// #696: the permission mode is the session's, switched in the backend's order; a mode the runtime refuses is
// skipped, and a backend without modes switches nothing.
test('the permission mode cycles in the declared order, skips a refused mode, and reaches a later view', async (t) => {
  const asked = [];
  const info = (id) => ({ id, label: `${id} words`, symbol: '', tone: '' });
  const h = streamHarness(t, { rpc: {
    modeCycle: ['one', 'two', 'three'],
    modeInfo: info,
    setModeCommand: (id, mode) => { asked.push(mode); return { type: 'ctl', request_id: id, what: mode === 'two' ? 'fail' : `mode ${mode}` }; },
  } });
  t.after(() => stopped(h));
  const first = await agentRpc.cycleMode('launch-id');
  assert.deepEqual(asked, ['two', 'three'], 'no mode heard yet counts as the first; the refused one is skipped');
  assert.deepEqual(first, { ok: true, mode: info('three') });
  assert.deepEqual(ops(h).filter((o) => o.op === 'mode').pop().mode, info('three'));
  assert.deepEqual((await agentRpc.cycleMode('launch-id')).mode, info('one'), 'past the end it starts over');
  const attached = await agentRpc.attach('launch-id');
  assert.deepEqual(attached.mode, info('one'));
  assert.equal(attached.canSwitchMode, true);
});

test('a backend without permission modes switches nothing and says so', async (t) => {
  const h = streamHarness(t);
  t.after(() => stopped(h));
  const res = await agentRpc.cycleMode('launch-id');
  assert.equal(res.ok, false);
  assert.equal((await agentRpc.attach('launch-id')).canSwitchMode, false);
});

test('a mode outside the declared order goes to the first mode on the next switch', async (t) => {
  const asked = [];
  const info = (id) => ({ id, label: id, symbol: '', tone: '' });
  const h = streamHarness(t, { rpc: {
    createDecoder: () => ({
      decode: (msg) => (msg.ev === 'result' ? [{ op: 'mode', mode: info('outside') }, { op: 'busy', busy: false }] : []),
      currentPartial: () => null,
    }),
    modeCycle: ['one', 'two', 'three'],
    modeInfo: info,
    setModeCommand: (id, mode) => { asked.push(mode); return { type: 'ctl', request_id: id, what: `mode ${mode}` }; },
  } });
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: 'hello', mode: 'prompt' });
  await until(() => ops(h).some((o) => o.op === 'mode'));
  assert.deepEqual((await agentRpc.cycleMode('launch-id')).mode, info('one'));
  assert.deepEqual(asked, ['one']);
});

// #730: the mode a session starts in is drawn before the runtime names it — the launch's first, else one the
// backend can ask for — and never over a mode the runtime has named itself.
test('the mode at the start comes from the launch, else from the backend\'s ask, and the runtime\'s own wins', async (t) => {
  const info = (id) => ({ id, label: id, symbol: '', tone: '' });
  const asked = [];
  const base = {
    modeCycle: ['one', 'two'],
    modeInfo: info,
    setModeCommand: (id, mode) => ({ type: 'ctl', request_id: id, what: mode }),
    launchMode: (opts) => opts.permissionMode || null,
    configuredModeCommand: (id) => { asked.push(id); return { type: 'ctl', request_id: id, what: 'configured' }; },
    configuredModeFromResponse: (res) => res.data.what,
  };

  const launched = streamHarness(t, { rpc: base, options: { permissionMode: 'two' } });
  t.after(() => stopped(launched));
  // Known before the session is even registered, so no view can hear an op for it: the attach carries it.
  assert.deepEqual((await agentRpc.attach('launch-id')).mode, info('two'), 'kept for the view that mounts');
  assert.equal(asked.length, 0, 'a mode the launch set is not asked for');
  assert.deepEqual((await agentRpc.cycleMode('launch-id')).mode, info('one'), 'the switch walks on from the launched mode');
  await stopped(launched);

  const configured = streamHarness(t, { rpc: base });
  t.after(() => stopped(configured));
  await until(() => ops(configured).some((o) => o.op === 'mode'));
  assert.deepEqual(ops(configured).find((o) => o.op === 'mode').mode, info('configured'));
  await stopped(configured);

  let namedRead = false;
  const named = streamHarness(t, { rpc: {
    ...base,
    createDecoder: () => ({ decode: () => [], currentPartial: () => null }),
    configuredModeCommand: (id) => ({ type: 'ctl', request_id: id, what: 'late' }),
    configuredModeFromResponse: () => {
      // The runtime names its mode while the ask is out: the answer arriving after it is dropped.
      named.proc._agent.mode = info('runtime');
      namedRead = true;
      return 'late';
    },
  } });
  t.after(() => stopped(named));
  await until(() => namedRead);
  await new Promise((r) => setImmediate(r));
  assert.ok(!ops(named).some((o) => o.op === 'mode'), 'no mode drawn over the one the runtime named');
  assert.deepEqual(named.proc._agent.mode, info('runtime'));
  await stopped(named);

  // A switch the user made while the ask was out sets the same `state.mode` the runtime's own op does, so the
  // case above covers it. One that arrives after the session ended draws nothing.
  let endedRead = false;
  const ended = streamHarness(t, { rpc: {
    ...base,
    createDecoder: () => ({ decode: () => [], currentPartial: () => null }),
    configuredModeCommand: (id) => ({ type: 'ctl', request_id: id, what: 'late' }),
    configuredModeFromResponse: () => { ended.proc._agent.exited = true; endedRead = true; return 'late'; },
  } });
  t.after(() => stopped(ended));
  await until(() => endedRead);
  await new Promise((r) => setImmediate(r));
  assert.ok(!ops(ended).some((o) => o.op === 'mode'), 'no mode for a session that has exited');
  ended.proc._agent.exited = false;
  await stopped(ended);

  let noneRead = false;
  const none = streamHarness(t, { rpc: { ...base, launchMode: () => null, configuredModeFromResponse: () => { noneRead = true; return null; } } });
  t.after(() => stopped(none));
  await until(() => noneRead);
  await new Promise((r) => setImmediate(r));
  assert.ok(!ops(none).some((o) => o.op === 'mode'), 'nothing known, nothing drawn');
});

// #753: a start mode that depends on the model is decided with the first context answer.
test('the start mode is asked of the backend again with the session\'s context, where it declares that', async (t) => {
  const info = (id) => ({ id, label: id, symbol: '', tone: '' });
  const seen = [];
  const base = {
    modeCycle: ['one', 'two'],
    modeInfo: info,
    setModeCommand: (id, mode) => ({ type: 'ctl', request_id: id, what: mode }),
    configuredModeCommand: (id) => ({ type: 'ctl', request_id: id, what: 'configured' }),
    configuredModeFromResponse: (res) => (res.data.what === 'configured' ? 'maybe' : null),
    contextCommand: (id) => ({ type: 'ctl', request_id: id, what: 'ctx' }),
    contextFromResponse: (res) => (res.data.what === 'ctx' ? { percent: 5, model: 'Big 1', modelId: 'big-1' } : null),
    startModeFor: (id, context) => { seen.push([id, context && context.modelId]); return context && context.modelId === 'big-1' ? 'two' : null; },
  };

  const h = streamHarness(t, { rpc: base });
  t.after(() => stopped(h));
  await until(() => ops(h).some((o) => o.op === 'mode'));
  assert.deepEqual(ops(h).find((o) => o.op === 'mode').mode, info('two'), 'the backend\'s answer for this model');
  assert.deepEqual(seen[seen.length - 1], ['maybe', 'big-1'], 'settled with the model the context named');
  await stopped(h);

  let declined = false;
  const none = streamHarness(t, { rpc: { ...base, startModeFor: () => { declined = true; return null; } } });
  t.after(() => stopped(none));
  await until(() => declined);
  await new Promise((r) => setImmediate(r));
  assert.ok(!ops(none).some((o) => o.op === 'mode'), 'a mode the backend cannot settle for this model is not drawn');
  await stopped(none);

  // A mode that needs no model is drawn without waiting for the context: the context is never answered here.
  const fixed = streamHarness(t, { rpc: {
    ...base,
    launchMode: () => 'one',
    contextCommand: (id) => ({ type: 'never', request_id: id }),
    startModeFor: (id) => (id === 'one' ? 'one' : null),
  }, options: {} });
  t.after(() => stopped(fixed));
  assert.deepEqual((await agentRpc.attach('launch-id')).mode, info('one'), 'drawn at once, not after the context');
  await stopped(fixed);

  // The runtime names its mode while the context is still out: the late answer is dropped.
  let raced = false;
  const race = streamHarness(t, { rpc: {
    ...base,
    contextFromResponse: () => { race.proc._agent.mode = info('runtime'); raced = true; return { percent: 1, modelId: 'big-1' }; },
  } });
  t.after(() => stopped(race));
  await until(() => raced);
  await new Promise((r) => setImmediate(r));
  assert.ok(!ops(race).some((o) => o.op === 'mode'), 'no start mode drawn over the runtime\'s own');
  assert.deepEqual(race.proc._agent.mode, info('runtime'));
});

// #731: an approval the user already gave is answered by the core without a card — from the mode, from what was
// allowed for the session, from the project's rules — and an answer the user gives is kept for the next one.
function approvalRpc(extra) {
  return {
    createDecoder: () => ({
      decode(msg) {
        if (msg.ev === 'ask') {
          return [{ op: 'ask', request: { id: msg.id, kind: 'approval', method: 'select', tool: 'bash', approvalKey: 'bash',
            input: msg.input, answers: { once: 'once', session: 'session', project: 'project', refuse: 'refuse' } } }];
        }
        if (msg.ev === 'result') return [{ op: 'busy', busy: false }];
        if (msg.ev === 'append') return [{ op: 'append', entry: msg.entry }];
        return [];
      },
      currentPartial: () => null,
    }),
    approvalRulesOption: 'rules',
    modeCycle: ['ask', 'all'],
    modeInfo: (id) => ({ id, label: id, symbol: '', tone: '' }),
    modeLocal: true,
    launchMode: () => 'ask',
    approvalAutoAnswer: (ask, memory) => (memory.mode === 'all' || memory.sessionKeys.has(ask.approvalKey)
      || memory.projectRules.includes('bash') ? { value: 'once' } : null),
    approvalRecord: (ask, answer) => (answer.value === 'session' ? { session: ask.approvalKey }
      : answer.value === 'project' ? { project: 'bash' } : null),
    ...(extra || {}),
  };
}

function fakeMemory() {
  const sessions = new Map();
  const rules = [];
  return {
    sessions, rules, carried: [],
    sessionKeys: (b, s) => new Set(sessions.get(`${b}:${s}`) || []),
    rememberSession: (b, s, k) => sessions.set(`${b}:${s}`, [...(sessions.get(`${b}:${s}`) || []), k]),
    carrySession(b, from, to) { this.carried.push([b, from, to]); },
    projectRules: () => rules.slice(),
    rememberProjectRule: (b, p, opt, rule) => { rules.push(rule); return true; },
  };
}

test('an approval already given is answered by the core, and the user\'s answer is kept for the next one', async (t) => {
  const memory = fakeMemory();
  const h = streamHarness(t, { rpc: approvalRpc(), approvalMemory: memory, backendId: 'b' });
  t.after(() => stopped(h));
  const cards = () => ops(h).filter((o) => o.op === 'ask');

  await agentRpc.sendTurn('launch-id', { text: 'ask me', mode: 'prompt' });
  await until(() => cards().length === 1);
  assert.equal((await agentRpc.answerAsk('launch-id', 'a1', { value: 'session' })).ok, true);
  assert.deepEqual([...memory.sessionKeys('b', 'launch-id')], ['bash'], 'the session allow is kept under the session id');
  await until(() => !h.proc._agent.busy);

  await agentRpc.sendTurn('launch-id', { text: 'ask me', mode: 'prompt' });
  await until(() => ops(h).filter((o) => o.op === 'append').length >= 4);
  assert.equal(cards().length, 1, 'the second question never reached the view');
  assert.equal(h.proc._agent.asks.size, 0);
});

test('a project answer is written as a rule, and the local mode answers open approvals at once', async (t) => {
  const memory = fakeMemory();
  const h = streamHarness(t, { rpc: approvalRpc(), approvalMemory: memory, backendId: 'b' });
  t.after(() => stopped(h));
  assert.equal((await agentRpc.attach('launch-id')).mode.id, 'ask', 'a session starts in the launch\'s mode');

  await agentRpc.sendTurn('launch-id', { text: 'ask me', mode: 'prompt' });
  await until(() => ops(h).some((o) => o.op === 'ask'));
  await agentRpc.answerAsk('launch-id', 'a1', { value: 'project' });
  assert.deepEqual(memory.rules, ['bash'], 'the project rule the backend named is written');
  await until(() => !h.proc._agent.busy);

  memory.rules.length = 0;
  await agentRpc.sendTurn('launch-id', { text: 'ask me', mode: 'prompt' });
  await until(() => ops(h).filter((o) => o.op === 'ask').length === 2);
  const res = await agentRpc.cycleMode('launch-id');
  assert.equal(res.ok, true);
  assert.equal(res.mode.id, 'all', 'switched in the app, with no request');
  await until(() => h.proc._agent.asks.size === 0);
  assert.ok(ops(h).some((o) => o.op === 'answered' && o.id === 'a1'), 'the open question was answered by the new mode');
});

test('modes a launch does not offer cannot be switched', async (t) => {
  const h = streamHarness(t, { rpc: approvalRpc({ modesOffered: (opts) => opts.gate !== false }), options: {}, appliedOptions: { gate: false } });
  t.after(() => stopped(h));
  assert.equal((await agentRpc.attach('launch-id')).canSwitchMode, false);
  assert.equal((await agentRpc.cycleMode('launch-id')).ok, false);
});

// #725: a task notice names its output file to the CORE. The view gets `hasOutput` and never the path, and the
// output reads by task id — for a notice drawn live and for one an attach read back from the transcript.
test('a task notice\'s output file stays in main: the view gets hasOutput, the output reads by task id', async (t) => {
  const dir = tempDataDir(t);
  const file = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
  const full = file('full.output', 'built\n');
  const empty = file('empty.output', '');
  const odd = file('not-an-output.txt', 'secret\n');
  const back = file('back.output', 'from the transcript\n');
  const notice = (id, outputFile) => ({ type: 'task-notice', uuid: `n-${id}`, _task: { id, kind: 'shell', outputFile } });
  const h = streamHarness(t, { rpc: {
    createDecoder: () => ({
      decode(msg) {
        if (msg.ev !== 'result') return [];
        return [
          { op: 'append', entry: notice('live', full) },
          { op: 'append', entry: notice('quiet', empty) },
          { op: 'append', entry: notice('odd', odd) },
          { op: 'append', entry: notice('unc', '\\\\host\\share\\x.output') },
          { op: 'busy', busy: false },
        ];
      },
      currentPartial: () => null,
    }),
  } });
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: 'hello', mode: 'prompt' });
  await until(() => ops(h).filter((o) => o.op === 'append').length >= 4);
  const drawn = Object.fromEntries(ops(h).filter((o) => o.op === 'append').map((o) => [o.entry._task.id, o.entry._task]));
  for (const task of Object.values(drawn)) assert.ok(!('outputFile' in task), 'no path reaches the view');
  assert.equal(drawn.live.hasOutput, true);
  assert.equal(drawn.quiet.hasOutput, false, 'an empty file offers nothing');
  assert.equal(drawn.odd.hasOutput, false, 'only a file of the shape a runtime names is read');
  assert.equal(drawn.unc.hasOutput, false, 'a network path is refused before anything asks the host');
  assert.match((await agentRpc.taskOutput('launch-id', 'live')).text, /built/);
  assert.equal((await agentRpc.taskOutput('launch-id', 'odd')).ok, false);

  fs.appendFileSync(h.transcript, JSON.stringify(notice('back', back)) + '\n');
  const attached = await agentRpc.attach('launch-id');
  const read = attached.entries.find((e) => e.type === 'task-notice' && e._task.id === 'back');
  assert.equal(read._task.hasOutput, true, 'a card read back from the transcript still offers its output');
  assert.ok(!('outputFile' in read._task));
  assert.match((await agentRpc.taskOutput('launch-id', 'back')).text, /from the transcript/);
});
