'use strict';
// A `!` line for a runtime that has no shell command of its own (#786): the core runs it itself
// (`src/app/agent-shell.js`), draws it through the same `localCommand` ops a runtime's line gets, and hands the
// finished line to the next turn it writes. Driven against the stream stand-in on a real pipe, with a REAL
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

test('a shell line runs here, is drawn, and starts no turn', async (t) => {
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
  assert.deepEqual(h.written, [], 'nothing was written to the runtime');
  assert.deepEqual(h.signals, [], 'no busy edge: a shell line is not the agent working');
  assert.ok(!ops(h).some((o) => o.op === 'append'), 'and the `!` line is not drawn as a message as well');
});

test('the next turn carries the finished line, once', async (t) => {
  const h = ownShellHarness(t);
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: '!echo carried-out', mode: 'prompt' });
  await until(() => finished(h).length === 1);
  await agentRpc.sendTurn('launch-id', { text: 'what did it print?', mode: 'prompt' });
  await until(() => h.signals.some((s) => s.kind === 'idle'));
  assert.equal(h.written.length, 1);
  assert.equal(h.written[0].shellLines.length, 1);
  assert.equal(h.written[0].shellLines[0].command, 'echo carried-out');
  assert.match(h.written[0].shellLines[0].stdout, /carried-out/);
  assert.equal(h.written[0].shellLines[0].exitCode, 0);

  await agentRpc.sendTurn('launch-id', { text: 'and again', mode: 'prompt' });
  await until(() => h.written.length === 2);
  assert.equal(h.written[1].shellLines, null, 'spent by the turn that took it');
});

test('a `/` line leaves the shell lines for the next prompt', async (t) => {
  const h = ownShellHarness(t);
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: '!echo wait-for-it', mode: 'prompt' });
  await until(() => finished(h).length === 1);
  await agentRpc.sendTurn('launch-id', { text: '/compact', mode: 'prompt' });
  await until(() => h.signals.some((s) => s.kind === 'idle'));
  await agentRpc.sendTurn('launch-id', { text: 'now', mode: 'prompt' });
  await until(() => h.written.length === 2);
  assert.equal(h.written[0].shellLines, null, 'a command takes none');
  assert.equal(h.written[1].shellLines.length, 1, 'the prompt after it does');
});

test('a steer leaves the shell lines for the next prompt', async (t) => {
  const h = ownShellHarness(t);
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: '!echo for-later', mode: 'prompt' });
  await until(() => finished(h).length === 1);
  await agentRpc.sendTurn('launch-id', { text: 'into the running turn', mode: 'steer' });
  await until(() => h.written.length === 1);
  await until(() => h.signals.some((s) => s.kind === 'idle'));
  await agentRpc.sendTurn('launch-id', { text: 'now', mode: 'prompt' });
  await until(() => h.written.length === 2);
  assert.equal(h.written[0].shellLines, null, 'a steer takes none');
  assert.equal(h.written[1].shellLines.length, 1);
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

test('Stop ends a running line, and an attach in between still shows a finished one', async (t) => {
  const h = ownShellHarness(t);
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: `!${LONG}`, mode: 'prompt' });
  await until(() => lineOps(h).length >= 1);
  assert.deepEqual(await agentRpc.abortTurn('launch-id'), { ok: true });
  await until(() => finished(h).length === 1);
  const done = finished(h)[0];
  assert.equal(done.status, 'cancelled');
  assert.match(done.output, /\[cancelled\]/);
  assert.ok(!h.sent.some((m) => m.op && m.op.op === 'busy'), 'the stop went to the line, not to a turn');

  // Not carried yet, so in no transcript: the attach draws it from what the core holds.
  const snap = await agentRpc.attach('launch-id');
  assert.equal(snap.ok, true);
  const own = snap.entries.filter((e) => e.type === 'local-command');
  assert.equal(own.length, 1);
  assert.equal(own[0]._localCmd.cmd, LONG);
});

test('a new conversation drops what the old one would have carried', async (t) => {
  // `replace` is the stand-in's `/clear`; it is told to carry nothing, so the reset is what has to drop the line.
  const h = ownShellHarness(t, { carriesShellLines: (text) => text !== 'replace' });
  t.after(() => stopped(h));
  await agentRpc.sendTurn('launch-id', { text: '!echo old-context', mode: 'prompt' });
  await until(() => finished(h).length === 1);
  await agentRpc.sendTurn('launch-id', { text: 'replace', mode: 'prompt' });
  await until(() => ops(h).some((o) => o.op === 'reset'));
  await until(() => h.signals.some((s) => s.kind === 'idle'));
  await agentRpc.sendTurn('launch-id', { text: 'fresh', mode: 'prompt' });
  await until(() => h.written.length === 2);
  assert.equal(h.written[0].shellLines, null);
  assert.equal(h.written[1].shellLines, null, 'the line belonged to the conversation the reset replaced');
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
