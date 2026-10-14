'use strict';
// A `!` line for a runtime that has no shell command of its own (#786): the core runs it itself
// (`src/app/agent-shell.js`), draws it through the same `localCommand` ops a runtime's line gets, and hands the
// finished line to the model: with the next prompt the user writes, else as a turn of its own once the session is
// idle (#788). Driven against the stream stand-in on a real pipe, with a REAL
// shell — the one the core falls back to with no terminal profile to ask (cmd on Windows, /bin/sh elsewhere),
// so every command here is one both of those read the same way.
//
// The protocol half is the stand-in's, with claude-native's own answers for the three things this is about:
// which composer line is a shell line, how a finished line is worded, and which turn may carry it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { harness, stopped, until, agentRpc, tempDataDir } = require('./helpers/agent-rpc-harness');
const claudeProtocol = require('../src/backends/claude-native/rpc-protocol');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-stream-agent.js');
const LONG = process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'sleep 30';

function ownShellHarness(t, extra) {
  const dir = tempDataDir(t);
  const transcript = path.join(dir, 'transcript.jsonl');
  const written = [];
  const rpc = {
    createDecoder: () => ({
      decode(msg) {
        switch (msg.ev) {
          case 'append': return [{ op: 'append', entry: msg.entry }];
          case 'result': return [{ op: 'busy', busy: false }];
          case 'reset': return [{ op: 'reset', entries: [] }];
          case 'ask': return [{ op: 'ask', request: { id: msg.id, method: 'confirm', title: 'May I?', input: msg.input } }];
          default: return [];
        }
      },
      currentPartial: () => null,
    }),
    responseOf: (m) => (m && m.type === 'ctl_response' ? { id: m.request_id, payload: { success: !!m.ok, data: m.data } } : null),
    sendAcknowledged: false,
    // What the turn carried is written into its text, so the stand-in plays it back where a test can read it.
    sendCommand: ({ text, shellLines }) => {
      written.push({ text, shellLines: shellLines || null });
      const carried = (shellLines || []).map(l => `[${l.command} => ${String(l.stdout).trim()}]`).join('');
      return { type: 'user', text: carried ? `${carried} ${text}` : text };
    },
    abortCommand: (id) => ({ type: 'ctl', request_id: id, what: 'interrupt' }),
    answerCommand: (id) => ({ type: 'answer', id }),
    entriesFromTranscript: async () => {
      let text = '';
      try { text = await fs.promises.readFile(transcript, 'utf8'); } catch { return []; }
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type !== 'marker');
    },
    entryKey: (e) => (e && e.uuid) || null,
    appCommandOp: claudeProtocol.appCommandOp,
    shellLineResult: claudeProtocol.shellLineResult,
    carriesShellLines: claudeProtocol.carriesShellLines,
    ...(extra || {}),
  };
  const h = harness({ rpc, fixture: FIXTURE, env: { FAKE_TRANSCRIPT: transcript } });
  return { ...h, written };
}

const ops = (h) => h.sent.filter((m) => m.ch === 'agent-event').map((m) => m.op);
const lineOps = (h) => ops(h).filter((o) => o.op === 'localCommand');
const finished = (h) => lineOps(h).filter((o) => o.status !== 'running');

// A line that finished while a turn waits on a question: kept, and not written into the running turn.
async function waitingLine(h, command = 'echo for-later') {
  await agentRpc.sendTurn('launch-id', { text: 'ask me', mode: 'prompt' });   // a turn that stays open
  await until(() => ops(h).some((o) => o.op === 'ask'));
  await agentRpc.sendTurn('launch-id', { text: `!${command}`, mode: 'prompt' });
  await until(() => finished(h).length === 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(h.written.length, 1, 'nothing goes into a running turn');
}
const carryOnly = (h) => h.written.filter((w) => w.text === '' && w.shellLines);

test('a shell line runs here, is drawn, and its output goes to the model as a turn of its own', async (t) => {
  const h = ownShellHarness(t);
  t.after(() => stopped(h));
  assert.deepEqual(await agentRpc.sendTurn('launch-id', { text: '!echo shell-hi', mode: 'prompt' }), { ok: true });
  await until(() => finished(h).length === 1);
  const drawn = lineOps(h);
  assert.equal(drawn[0].status, 'running');
  assert.equal(drawn[0].command, 'echo shell-hi');
  const done = finished(h)[0];
  assert.equal(done.status, 'done');
  assert.match(done.output, /shell-hi/);
  assert.equal(new Set(drawn.map((o) => o.id)).size, 1, 'one id throughout');
  assert.ok(!ops(h).some((o) => o.op === 'append' && /!echo/.test(JSON.stringify(o.entry))), 'the `!` line is not drawn as a message');

  // The session was idle, so the finished line went out at once: a turn with no text of its own (#788).
  await until(() => h.written.length === 1);
  assert.equal(h.written[0].text, '');
  assert.equal(h.written[0].shellLines.length, 1);
  assert.equal(h.written[0].shellLines[0].command, 'echo shell-hi');
  assert.match(h.written[0].shellLines[0].stdout, /shell-hi/);
  assert.equal(h.written[0].shellLines[0].exitCode, 0);
  await until(() => h.signals.some((s) => s.kind === 'idle'));

  await agentRpc.sendTurn('launch-id', { text: 'and again', mode: 'prompt' });
  await until(() => h.written.length === 2);
  assert.equal(h.written[1].shellLines, null, 'spent by the turn that took it');
});

test('a line that finishes during a turn goes to the model at that turn\'s end', async (t) => {
  const h = ownShellHarness(t);
  t.after(() => stopped(h));
  await waitingLine(h, 'echo mid-turn');

  // Not carried yet, so in no transcript: an attach draws it from what the core holds.
  const snap = await agentRpc.attach('launch-id');
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.entries.filter((e) => e.type === 'local-command').map((e) => e._localCmd.cmd), ['echo mid-turn']);

  assert.equal((await agentRpc.answerAsk('launch-id', 'a1', { value: 'yes' })).ok, true);
  await until(() => h.written.length === 2);
  assert.equal(h.written[1].text, '');
  assert.equal(h.written[1].shellLines[0].command, 'echo mid-turn');
});

test('a prompt held behind the turn takes the line with it, and no turn of its own follows', async (t) => {
  const h = ownShellHarness(t);
  t.after(() => stopped(h));
  await waitingLine(h, 'echo carried-out');
  assert.ok((await agentRpc.sendTurn('launch-id', { text: 'what did it print?', mode: 'prompt' })).held, 'held behind the turn');

  await agentRpc.answerAsk('launch-id', 'a1', { value: 'yes' });
  await until(() => h.written.length === 2);
  assert.equal(h.written[1].text, 'what did it print?');
  assert.equal(h.written[1].shellLines.length, 1);
  assert.match(h.written[1].shellLines[0].stdout, /carried-out/);
  await until(() => h.signals.filter((s) => s.kind === 'idle').length >= 2);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.written.length, 2, 'the line was spent by the prompt');
});

test('a `/` line leaves the shell lines, and they follow as a turn of their own', async (t) => {
  const h = ownShellHarness(t);
  t.after(() => stopped(h));
  await waitingLine(h);
  assert.ok((await agentRpc.sendTurn('launch-id', { text: '/compact', mode: 'prompt' })).held);
  await agentRpc.answerAsk('launch-id', 'a1', { value: 'yes' });
  await until(() => carryOnly(h).length === 1);
  const command = h.written.find((w) => w.text === '/compact');
  assert.equal(command.shellLines, null, 'a command takes none');
  assert.ok(h.written.indexOf(command) < h.written.indexOf(carryOnly(h)[0]), 'the lines go after it');
});

test('a steer leaves the shell lines, and they follow as a turn of their own', async (t) => {
  const h = ownShellHarness(t);
  t.after(() => stopped(h));
  await waitingLine(h);
  await agentRpc.sendTurn('launch-id', { text: 'into the running turn', mode: 'steer' });
  await until(() => h.written.length === 2);
  assert.equal(h.written[1].shellLines, null, 'a steer takes none');
  await agentRpc.answerAsk('launch-id', 'a1', { value: 'yes' });
  await until(() => carryOnly(h).length === 1);
  assert.equal(carryOnly(h)[0].shellLines[0].command, 'echo for-later');
});

test('a failing line says so, and the model is told how it ended', async (t) => {
  const h = ownShellHarness(t);
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: '!exit 3', mode: 'prompt' });
  await until(() => finished(h).length === 1);
  const done = finished(h)[0];
  assert.equal(done.status, 'error');
  assert.match(done.output, /Exit code 3/);
});

test('Stop ends a running line, and the model is told it was cancelled', async (t) => {
  const h = ownShellHarness(t);
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: `!${LONG}`, mode: 'prompt' });
  await until(() => lineOps(h).length >= 1);
  assert.deepEqual(await agentRpc.abortTurn('launch-id'), { ok: true });
  await until(() => finished(h).length === 1);
  const done = finished(h)[0];
  assert.equal(done.status, 'cancelled');
  assert.match(done.output, /\[cancelled\]/);
  // A stopped line goes to the model too (owner decision, #788): it learns the command did not finish.
  await until(() => carryOnly(h).length === 1);
  assert.equal(h.written.length, 1, 'the Stop itself went to the line, not to a turn');
  assert.equal(carryOnly(h)[0].shellLines[0].command, LONG);
  assert.equal(carryOnly(h)[0].shellLines[0].cancelled, true);
});

test('Stop on a turn and a running line: the cancelled line follows as a turn once the turn is over', async (t) => {
  // Owner decision (#788): the model is told about a stopped line even when the Stop also ended a turn.
  const h = ownShellHarness(t);
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: 'ask me', mode: 'prompt' });
  await until(() => ops(h).some((o) => o.op === 'ask'));
  await agentRpc.sendTurn('launch-id', { text: `!${LONG}`, mode: 'prompt' });
  await until(() => lineOps(h).length >= 1);
  await agentRpc.abortTurn('launch-id');
  await until(() => finished(h).length === 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(carryOnly(h).length, 0, 'not into the turn still running');
  await agentRpc.answerAsk('launch-id', 'a1', { value: 'yes' });
  await until(() => carryOnly(h).length === 1);
  assert.equal(carryOnly(h)[0].shellLines[0].cancelled, true);
});

test('a Stop that pauses held prompts keeps the line until the queue is moved', async (t) => {
  const h = ownShellHarness(t);
  t.after(() => stopped(h));
  await waitingLine(h);
  const held = (await agentRpc.sendTurn('launch-id', { text: 'later', mode: 'prompt' })).held;
  assert.ok(held);
  await agentRpc.abortTurn('launch-id');
  await agentRpc.answerAsk('launch-id', 'a1', { value: 'yes' });
  await until(() => !h.proc._agent.busy);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(carryOnly(h).length, 0, 'the paused queue holds the line too');
  assert.equal(agentRpc.heldAction('launch-id', 'withdraw', held).ok, true);
  await until(() => carryOnly(h).length === 1, 'withdrawing the last held prompt lets it go');
});

test('a new conversation drops what the old one would have carried', async (t) => {
  // `replace` is the stand-in's `/clear`; it is told to carry nothing, so the reset is what has to drop the line.
  const h = ownShellHarness(t, { carriesShellLines: (text) => text !== 'replace' });
  t.after(() => stopped(h));
  await waitingLine(h);
  assert.ok((await agentRpc.sendTurn('launch-id', { text: 'replace', mode: 'prompt' })).held);
  await agentRpc.answerAsk('launch-id', 'a1', { value: 'yes' });
  await until(() => ops(h).some((o) => o.op === 'reset'));
  await until(() => !h.proc._agent.busy);
  await new Promise((r) => setTimeout(r, 100));
  await agentRpc.sendTurn('launch-id', { text: 'fresh', mode: 'prompt' });
  await until(() => h.written.some((w) => w.text === 'fresh'));
  assert.equal(h.written.find((w) => w.text === 'replace').shellLines, null);
  assert.equal(h.written.find((w) => w.text === 'fresh').shellLines, null, 'the line belonged to the conversation the reset replaced');
  assert.equal(carryOnly(h).length, 0, 'and no turn of its own took it either');
});

test('a `!` line written into the session from elsewhere is a turn, not a command', async (t) => {
  // The app answers only a line its composer sent (`appCommandOp` is asked by `sendTurn` alone); keys written
  // by a trigger or a launcher reach the runtime as they are.
  const h = ownShellHarness(t);
  t.after(() => stopped(h));
  h.proc.write('!echo from-a-trigger\r');
  await until(() => h.written.length === 1);
  assert.equal(h.written[0].text, '!echo from-a-trigger');
  assert.deepEqual(lineOps(h), [], 'nothing was run');
});
