'use strict';
// The runtime-driven Pi backend (#568): its protocol half, its per-spawn extension, the transport marker
// the terminal backend's parser reads, and the registry answer that decides which backend opens a row.
// Event shapes are the ones measured against Pi 0.84.4 (`pi --mode rpc`), not the documentation's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const protocol = require('../src/backends/pi-native/rpc-protocol');
const runtimeExtension = require('../src/backends/pi-native/runtime-extension');
const { TRANSPORT_MARKER_TYPE, transportFromEntry } = require('../src/backends/pi/transport-marker');
const piParser = require('../src/backends/pi/parser');
const { normalizeTranscriptEntries } = require('../src/backends/pi/transcript-view');
const backends = require('../src/backends');

const upd = (ev) => ({ type: 'message_update', assistantMessageEvent: ev });

test('the decoder assembles a streamed turn from deltas and replaces it with the finished one', () => {
  const d = protocol.createDecoder();
  assert.deepEqual(d.decode({ type: 'agent_start' }), [{ op: 'busy', busy: true }]);
  const user = { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 };
  assert.deepEqual(d.decode({ type: 'message_start', message: user }), [], 'a user message has no partial');
  const [appendUser] = d.decode({ type: 'message_end', message: user });
  assert.equal(appendUser.op, 'append');
  assert.equal(appendUser.entry.message.role, 'user');

  d.decode({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 2 } });
  d.decode(upd({ type: 'thinking_start', contentIndex: 0 }));
  d.decode(upd({ type: 'thinking_delta', contentIndex: 0, delta: 'hmm' }));
  d.decode(upd({ type: 'text_start', contentIndex: 1 }));
  d.decode(upd({ type: 'text_delta', contentIndex: 1, delta: 'Hel' }));
  const [partial] = d.decode(upd({ type: 'text_delta', contentIndex: 1, delta: 'lo' }));
  assert.equal(partial.op, 'partial');
  const blocks = partial.entry.message.content;
  assert.deepEqual(blocks.map(b => b.type), ['thinking', 'text']);
  assert.equal(blocks[1].text, 'Hello');
  assert.equal(d.currentPartial().message.content[1].text, 'Hello', 'a view mounted mid-turn gets it');

  // Tool arguments stream as JSON text; until they parse, what arrived so far is shown.
  d.decode(upd({ type: 'toolcall_start', contentIndex: 2, id: 'c1', toolName: 'bash' }));
  const [half] = d.decode(upd({ type: 'toolcall_delta', contentIndex: 2, delta: '{"command":"ec' }));
  assert.equal(half.entry.message.content[2].type, 'tool_use');
  assert.equal(half.entry.message.content[2].input._partial, '{"command":"ec');

  const final = { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], stopReason: 'stop', timestamp: 2 };
  const ops = d.decode({ type: 'message_end', message: final });
  assert.deepEqual(ops.map(o => o.op), ['partial', 'append']);
  assert.equal(ops[0].entry, null);
  assert.equal(d.currentPartial(), null);
  assert.deepEqual(d.decode({ type: 'agent_settled' }), [{ op: 'busy', busy: false }]);
});

test('agent_end is not the end: only agent_settled reports idle (#573 in RPC form)', () => {
  const d = protocol.createDecoder();
  assert.deepEqual(d.decode({ type: 'agent_end', messages: [], willRetry: true }), []);
});

test('a failed model call arrives as an empty assistant turn and is said out loud', () => {
  const d = protocol.createDecoder();
  const ops = d.decode({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'out of extra usage' } });
  const notice = ops.find(o => o.op === 'notice');
  assert.equal(notice.level, 'error');
  assert.match(notice.text, /out of extra usage/);
});

test('tool execution becomes running/done ops with the live output', () => {
  const d = protocol.createDecoder();
  assert.deepEqual(d.decode({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} }),
    [{ op: 'tool', id: 'c1', status: 'running', output: '' }]);
  assert.deepEqual(d.decode({ type: 'tool_execution_update', toolCallId: 'c1', partialResult: { content: [{ type: 'text', text: 'hi\n' }] } }),
    [{ op: 'tool', id: 'c1', status: 'running', output: 'hi\n' }]);
  assert.equal(d.decode({ type: 'tool_execution_end', toolCallId: 'c1', result: { content: [] }, isError: true })[0].status, 'error');
  const [result] = d.decode({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'hi' }] } });
  assert.equal(result.entry.message.content[0].type, 'tool_result');
  assert.equal(result.entry.message.content[0].tool_use_id, 'c1');
});

test('an extension dialog becomes an ask; notify becomes a notice; an extension error names no detail', () => {
  const d = protocol.createDecoder();
  const [ask] = d.decode({ type: 'extension_ui_request', id: 'u1', method: 'select', title: 'Allow bash?', options: ['Allow once', 'Refuse'] });
  assert.equal(ask.op, 'ask');
  assert.deepEqual(ask.request.options, ['Allow once', 'Refuse']);
  assert.deepEqual(d.decode({ type: 'extension_ui_request', id: 'u2', method: 'setStatus', statusKey: 'x' }), []);
  assert.equal(d.decode({ type: 'extension_ui_request', id: 'u3', method: 'notify', message: 'hey', notifyType: 'warning' })[0].level, 'warning');
  const [err] = d.decode({ type: 'extension_error', event: 'tool_call', error: "ENOENT: open '<project>/secret.key'" });
  assert.ok(!/secret|ENOENT/.test(err.text), 'a thrown message can name any path — it is not passed on (#444)');
});

test('commands: a busy session turns a prompt into a follow-up instead of an error Pi would answer', () => {
  assert.deepEqual(protocol.sendCommand({ id: 'a', text: 'x', mode: 'prompt', busy: false }), { id: 'a', type: 'prompt', message: 'x' });
  assert.deepEqual(protocol.sendCommand({ id: 'a', text: 'x', mode: 'prompt', busy: true }), { id: 'a', type: 'prompt', message: 'x', streamingBehavior: 'followUp' });
  assert.equal(protocol.sendCommand({ text: 'x', mode: 'steer' }).type, 'steer');
  assert.equal(protocol.sendCommand({ text: 'x', mode: 'follow_up' }).type, 'follow_up');
  assert.deepEqual(protocol.answerCommand('q', { value: 'Allow once' }), { type: 'extension_ui_response', id: 'q', value: 'Allow once' });
  assert.deepEqual(protocol.answerCommand('q', { confirmed: false }), { type: 'extension_ui_response', id: 'q', confirmed: false });
  assert.deepEqual(protocol.answerCommand('q', { cancelled: true }), { type: 'extension_ui_response', id: 'q', cancelled: true });
  assert.equal(protocol.sessionIdFromState({ data: { sessionId: 'abc' } }), 'abc');
  assert.equal(protocol.sessionIdFromState({ success: false }), null);
});

test('the runtime extension is written per spawn, carries the marker, and is removed by name only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-ext-'));
  try {
    assert.equal(runtimeExtension.writeRuntimeExtension({ dir, tag: '../escape' }), null, 'a tag is a plain token');
    const built = runtimeExtension.writeRuntimeExtension({ dir, tag: 'abc-123' });
    assert.deepEqual(built.args, ['--extension', built.cleanup]);
    const src = fs.readFileSync(built.cleanup, 'utf8');
    assert.ok(src.includes(JSON.stringify(TRANSPORT_MARKER_TYPE)));
    assert.ok(src.includes('pi.appendEntry('));
    const foreign = path.join(dir, 'someone-else.ts');
    fs.writeFileSync(foreign, '');
    runtimeExtension.removeRuntimeExtension(foreign);
    assert.ok(fs.existsSync(foreign), 'a file this module did not write is not deleted');
    runtimeExtension.removeRuntimeExtension(built.cleanup);
    assert.ok(!fs.existsSync(built.cleanup));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the marker: Pi\'s parser records the transport, the history view hides it', () => {
  const marker = { type: 'custom', customType: TRANSPORT_MARKER_TYPE, data: { transport: 'rpc' }, id: 'm', parentId: null, timestamp: '2026-09-18T00:00:00.000Z' };
  assert.equal(transportFromEntry(marker), 'rpc');
  assert.equal(transportFromEntry({ ...marker, data: { transport: '../x' } }), null, 'a value that is not a token is ignored');
  assert.equal(transportFromEntry({ ...marker, customType: 'other' }), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-marker-'));
  try {
    const file = path.join(dir, '2026-09-18T00-00-00-000Z_0000.jsonl');
    const lines = [
      { type: 'session', version: 3, id: 's1', timestamp: '2026-09-18T00:00:00.000Z', cwd: dir },
      marker,
      { type: 'message', id: 'u', parentId: 'm', timestamp: '2026-09-18T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    ];
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    const row = piParser.parseSession({ kind: 'file', path: file });
    assert.equal(row.backendId, 'pi', 'the row stays the owner\'s — the scan reconciles by owner');
    assert.equal(row.transport, 'rpc');
    const unmarked = lines.filter(l => l !== marker);
    fs.writeFileSync(file, unmarked.map(l => JSON.stringify(l)).join('\n') + '\n');
    assert.equal(piParser.parseSession({ kind: 'file', path: file }).transport, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(normalizeTranscriptEntries([marker]), [], 'bookkeeping, not conversation');
});

test('openerFor: a marked row opens where it was driven — while that backend can launch', () => {
  const on = { backendEnabled: { pi: true, 'pi-native': true } };
  const off = { backendEnabled: { pi: true, 'pi-native': false } };
  try {
    backends.init({ getGlobalSettings: () => on });
    assert.equal(backends.openerFor({ backendId: 'pi', transport: 'rpc' }), 'pi-native');
    assert.equal(backends.openerFor({ backendId: 'pi' }), 'pi', 'an unmarked row is its owner\'s');
    assert.equal(backends.openerFor({ backendId: 'codex', transport: 'rpc' }), 'codex', 'nobody drives codex rows');
    backends.init({ getGlobalSettings: () => off });
    assert.equal(backends.openerFor({ backendId: 'pi', transport: 'rpc' }), 'pi',
      'switched off, the row goes back to the backend that runs the same binary over the same file');
  } finally {
    backends.init({ getGlobalSettings: () => ({}) });
  }
});

test('the record owner answers for a backend that only drives another\'s binary', () => {
  const native = backends.get('pi-native');
  const pi = backends.get('pi');
  assert.equal(native.liveRefFor, undefined);
  assert.equal(backends.recordOwnerOf(native), pi, 'whether Pi has written a session is Pi\'s store\'s answer');
  assert.equal(backends.recordOwnerOf(pi), pi);
  assert.equal(backends.recordOwnerOf(null), null);
  assert.ok(!native.configFields.some(f => f.id === 'preLaunchCmd'), 'no shell, so no pre-launch command');
});

test('spawn.js hands a disabled driver\'s session back to the row\'s opener (source check — node-pty has no seam)', () => {
  const { stripComments } = require('./helpers/strip-comments');
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js'), 'utf8'));
  assert.match(src, /recordedBackend\.transcriptsOf[\s\S]{0,160}isLaunchable/, 'a switched-off driver is detected');
  assert.match(src, /!recorded \|\| !recordedBackend \|\| driverOff/, 'and falls through to the cache answer');
  assert.match(src, /recordOwnerOf\(backend\)/, 'the fork/resume guards ask the record owner');
});

test('the launch is Pi\'s own, over RPC, without a shell and without the TUI-only options', () => {
  const d = backends.get('pi-native');
  const launch = d.buildLaunch({ cwd: '/p', options: { model: 'm1', models: 'a,b', useTheme: 'dark' } });
  const args = launch.args.join(' ');
  assert.match(args, /--mode rpc/);
  assert.match(args, /--model m1/);
  assert.ok(!/--models|--use-theme/.test(args), 'the Ctrl+P list and the TUI theme mean nothing here');
  assert.equal(launch.spawnMode, 'argv');
  assert.ok(!d.configFields.some(f => f.id === 'models' || f.id === 'useTheme'));
});
