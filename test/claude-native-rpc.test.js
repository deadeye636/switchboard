'use strict';
// src/app/agent-rpc.js driving a child through claude-native's own protocol half (#660). The child is
// `test/fixtures/fake-claude-stream.js`, which writes the line shapes Claude Code 2.1.283 was measured
// writing; what is tested is the whole path a real session takes — the write as the turn start, the stream's
// own busy edges for a turn nothing of ours wrote, the re-key off the ids the stream names, the approval
// answered with its own input, and an attach read back from the transcript under the stream's keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { harness, stopped, until, agentRpc, tempDataDir, SESSION_CWD } = require('./helpers/agent-rpc-harness');
const claude = require('../src/backends/claude');
const native = require('../src/backends/claude-native');
const { encodeProjectPath } = require('../src/session/encode-project-path');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-claude-stream.js');

// Claude's store root pointed at a temp directory for the test, with the project's folder in it — the one an
// attach reads the transcript from.
function claudeHarness(t, { turnMs = 0, forkFrom, before: seed, onSignal } = {}) {
  const root = tempDataDir(t);
  const before = claude._roots();
  claude.setRoots([root]);
  t.after(() => claude.setRoots(before));
  const dir = path.join(root, encodeProjectPath(SESSION_CWD));
  fs.mkdirSync(dir, { recursive: true });
  if (typeof seed === 'function') seed(dir);
  const h = harness({ rpc: native.rpc, fixture: FIXTURE, forkFrom, onSignal, env: { FAKE_TRANSCRIPT_DIR: dir, FAKE_SESSION: 'sess-1', FAKE_TURN_MS: String(turnMs) } });
  t.after(() => stopped(h));
  return h;
}

const ops = (h) => h.sent.filter((m) => m.ch === 'agent-event').map((m) => m.op);
const appended = (h) => ops(h).filter((o) => o.op === 'append').map((o) => o.entry);
const idles = (h) => h.signals.filter((s) => s.kind === 'idle').length;

test('a turn: the write is its start, the stream its end, and the session follows the id the stream names', async (t) => {
  const h = claudeHarness(t);
  assert.deepEqual(await agentRpc.sendTurn('launch-id', { text: 'hello', mode: 'prompt' }), { ok: true });
  await until(() => idles(h) === 1);
  assert.deepEqual(h.signals.map((s) => s.kind), ['busy', 'idle']);
  assert.deepEqual(h.rekeys, [{ from: 'launch-id', to: 'sess-1' }]);
  assert.deepEqual(appended(h).map((e) => [e.type, typeof e.message.content === 'string' ? e.message.content : e.message.content[0].text]),
    [['user', 'hello'], ['assistant', 'echo: hello']]);
  const keyed = ops(h).filter((o) => o.op === 'append');
  assert.ok(keyed.every((o) => o.key === o.entry.uuid), 'every entry carries its uuid as the key');
  assert.ok(!ops(h).some((o) => o.op === 'unsent'), 'an unacknowledged turn is not handed back');
});

test('a line queued behind a running turn is reported busy when it starts, with nothing of ours written', async (t) => {
  const h = claudeHarness(t, { turnMs: 400 });
  await agentRpc.sendTurn('launch-id', { text: 'first', mode: 'prompt' });
  await agentRpc.sendTurn('launch-id', { text: 'second', mode: 'prompt' });
  await until(() => idles(h) === 2);
  assert.deepEqual(h.signals.map((s) => s.kind), ['busy', 'idle', 'busy', 'idle'],
    'the second turn has its own busy edge — from the stream, since the write happened while the first ran');
  assert.deepEqual(appended(h).filter((e) => e.type === 'user').map((e) => e.message.content), ['first', 'second'],
    'the queued line is drawn where it ran, after the first reply');
});

test('an approval is asked in the view and answered with the tool\'s own input', async (t) => {
  const h = claudeHarness(t);
  await agentRpc.sendTurn('launch-id', { text: 'tool', mode: 'prompt' });
  await until(() => ops(h).some((o) => o.op === 'ask'));
  const ask = ops(h).find((o) => o.op === 'ask').request;
  assert.equal(ask.tool, 'Bash');
  assert.ok(h.signals.some((s) => s.kind === 'waiting'), 'a session blocked on the user says so');
  assert.deepEqual(agentRpc.answerAsk('sess-1', ask.id, { value: ask.answers.once }), { ok: true });
  await until(() => idles(h) === 1);
  const result = appended(h).find((e) => e.type === 'user' && Array.isArray(e.message.content));
  assert.equal(result.message.content[0].content, 'ran {"command":"echo hi"}');
  assert.ok(ops(h).some((o) => o.op === 'tool' && o.id === 'toolu_1' && o.status === 'done'));
});

test('/clear resets the conversation and re-keys the session onto the id it continues under', async (t) => {
  const h = claudeHarness(t);
  await agentRpc.sendTurn('launch-id', { text: 'hello', mode: 'prompt' });
  await until(() => idles(h) === 1);
  await agentRpc.sendTurn('sess-1', { text: '/clear', mode: 'prompt' });
  await until(() => idles(h) === 2);
  assert.deepEqual(h.rekeys.map((r) => r.to), ['sess-1', 'sess-1-cleared']);
  assert.ok(ops(h).some((o) => o.op === 'reset'));
  const busyAfterClear = h.signals.filter((s) => s.kind === 'idle').pop();
  assert.equal(busyAfterClear.sessionId, 'sess-1-cleared', 'the turn that ended is reported under the new id');
});

test('a local command\'s reply is drawn as an entry; the command list comes from initialize', async (t) => {
  const h = claudeHarness(t);
  await agentRpc.sendTurn('launch-id', { text: '/cost ', mode: 'prompt' });
  await until(() => idles(h) === 1);
  // #718: the typed command is not played back, so the decoder draws it, in front of the output.
  const [typed, reply] = appended(h);
  assert.equal(typed.message.role, 'user');
  assert.equal(typed.message.content, '/cost');
  assert.equal(typed.prompt, true, 'drawn as the user\'s own line');
  assert.equal(reply.message.model, '<synthetic>');
  assert.equal(appended(h).length, 2);
  // An attach reads the command from the transcript's own markup line, in the same order.
  const res = await agentRpc.attach('sess-1');
  assert.deepEqual(res.entries.map((e) => [e.type, typeof e.message.content === 'string' ? e.message.content : e.message.content[0].text]),
    [['user', '/cost'], ['assistant', 'Total cost: $0.00']]);
  assert.deepEqual(await agentRpc.listCommands('sess-1'), { ok: true, commands: [{ name: 'compact', description: 'Clear the conversation but keep a summary', kind: 'command', arguments: false }] });
  assert.deepEqual(await agentRpc.abortTurn('sess-1'), { ok: true }, 'an interrupt is answered like any control request');
});

const serversOp = (h) => ops(h).find((o) => o.op === 'servers');

test('/mcp is answered by the app from mcp_status: no turn, and no server\'s config (#719, #728)', async (t) => {
  const h = claudeHarness(t);
  assert.deepEqual(await agentRpc.sendTurn('launch-id', { text: ' /mcp ', mode: 'prompt' }), { ok: true });
  await until(() => serversOp(h));
  const [typed] = appended(h);
  assert.equal(typed.message.content, '/mcp');
  assert.equal(typed.prompt, true);
  assert.equal(appended(h).length, 1, 'nothing but the command is drawn into the conversation: the list opens as a manager');
  const { rows } = serversOp(h).list;
  assert.deepEqual(rows.map((r) => [r.name, r.group, r.state, r.tone, r.tools, r.error]), [
    ['docs', 'User MCPs', 'connected', 'ok', 2, ''],
    ['remote', 'Project MCPs', 'failed', 'failed', null, 'getaddrinfo ENOTFOUND example.invalid'],
  ]);
  assert.equal(h.signals.length, 0, 'no turn ran, so no busy edge');
  assert.ok(!JSON.stringify(h.sent).includes('secret-token'), 'nothing of a server\'s config reaches the view');
  assert.ok(!JSON.stringify(h.sent).includes('server.js'), 'nor its command');
  // With arguments it is the CLI's command, written as a turn like any other.
  assert.equal(native.rpc.appCommandOp('/mcp reconnect docs'), null);
});

test('a server is listed again and acted on through main, in the backend\'s words (#728)', async (t) => {
  const h = claudeHarness(t);
  await agentRpc.sendTurn('launch-id', { text: 'hello', mode: 'prompt' });
  await until(() => idles(h) === 1);
  const listed = await agentRpc.listServers('sess-1');
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.list.rows.map((r) => r.name), ['docs', 'remote']);
  assert.deepEqual(await agentRpc.serverAction('sess-1', 'docs', 'reconnect'), { ok: true, error: '', authUrl: '' });
  assert.deepEqual(await agentRpc.serverAction('sess-1', 'remote', 'authenticate'),
    { ok: true, error: '', authUrl: 'https://auth.example.invalid/authorize?state=s' });
  assert.deepEqual(await agentRpc.serverAction('sess-1', 'gone', 'disable'), { ok: false, error: 'Server not found: gone' });
  assert.deepEqual(await agentRpc.serverAction('sess-1', 'docs', 'format-disk'), { ok: false, error: 'This session cannot do that to a server.' });
  assert.deepEqual(await agentRpc.serverAction('sess-1', '', 'reconnect'), { ok: false, error: 'No server or action was named.' });
  assert.deepEqual(await agentRpc.serverAction('nobody', 'docs', 'reconnect'), { ok: false, error: 'This session is not running.' });
});

test('/mcp sent while a turn runs is answered at once, not held behind it (#719)', async (t) => {
  // Long enough that the turn cannot end under the suite's own load before the list arrives.
  const h = claudeHarness(t, { turnMs: 30000 });
  await agentRpc.sendTurn('launch-id', { text: 'long', mode: 'prompt' });
  await until(() => h.signals.some((s) => s.kind === 'busy'));
  assert.deepEqual(await agentRpc.sendTurn('launch-id', { text: '/mcp', mode: 'prompt' }), { ok: true });
  await until(() => serversOp(h));
  assert.equal(idles(h), 0, 'the running turn is still running');
  assert.ok(!ops(h).some((o) => o.op === 'held' && Array.isArray(o.items) && o.items.length), 'nothing was held');
});

test('an attach reads the conversation from the transcript, keyed the way the stream keys it', async (t) => {
  const h = claudeHarness(t);
  await agentRpc.sendTurn('launch-id', { text: 'hello', mode: 'prompt' });
  await until(() => idles(h) === 1);
  const res = await agentRpc.attach('sess-1');
  assert.equal(res.ok, true);
  assert.deepEqual(res.entries.map((e) => e.uuid), appended(h).map((e) => e.uuid));
  assert.deepEqual(res.keys, res.entries.map((e) => e.uuid));
  assert.equal(res.busy, false);
});

test('Stop ends the running turn as stopped, not as a failed one', async (t) => {
  const h = claudeHarness(t, { turnMs: 5000 });
  await agentRpc.sendTurn('launch-id', { text: 'long', mode: 'prompt' });
  await until(() => h.rekeys.length === 1);
  assert.deepEqual(await agentRpc.abortTurn('sess-1'), { ok: true });
  await until(() => idles(h) === 1);
  const notices = ops(h).filter((o) => o.op === 'notice');
  assert.deepEqual(notices.map((n) => [n.level, n.text]), [['info', 'Stopped.']],
    'the result that follows an interrupt carries an error subtype, and is drawn as the stop it is');
});

test('a fork attached before its first turn shows the conversation it was forked from', async (t) => {
  const parent = [
    { type: 'user', uuid: 'p1', timestamp: '2026-09-01T00:00:00.000Z', message: { role: 'user', content: 'earlier question' } },
    { type: 'assistant', uuid: 'p2', timestamp: '2026-09-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] } },
  ];
  claudeHarness(t, {
    forkFrom: 'parent-1',
    before: (dir) => fs.writeFileSync(path.join(dir, 'parent-1.jsonl'), parent.map((l) => JSON.stringify(l)).join('\n') + '\n'),
  });
  const res = await agentRpc.attach('launch-id');
  assert.equal(res.ok, true);
  assert.deepEqual(res.entries.map((e) => e.uuid), ['p1', 'p2'], 'the fork writes no file until its first turn, so the parent\'s answers');
  assert.deepEqual(res.keys, ['p1', 'p2']);
});

test('a line written while a turn runs is owed until its turn starts, so the idle between them can be held', async (t) => {
  const atIdle = [];
  const h = claudeHarness(t, {
    turnMs: 400,
    onSignal: (sessionId, hook) => { if (hook.kind === 'idle') atIdle.push(agentRpc.turnQueueOf(sessionId, 0).queued); },
  });
  await agentRpc.sendTurn('launch-id', { text: 'first', mode: 'prompt' });
  await until(() => h.rekeys.length === 1);
  assert.deepEqual(agentRpc.turnQueueOf('sess-1'), { queued: 0, turnStarted: false });
  await agentRpc.sendTurn('sess-1', { text: 'second', mode: 'follow_up' });
  assert.equal(agentRpc.turnQueueOf('sess-1').queued, 1);
  await until(() => idles(h) === 2);
  assert.deepEqual(atIdle, [1, 0], 'the first idle still owes the queued turn; the second owes nothing');
  assert.equal(agentRpc.turnQueueOf('sess-1', 1).turnStarted, true);
  assert.equal(agentRpc.turnQueueOf('no-such-session'), null, 'a session this module does not run cannot be told');
});
