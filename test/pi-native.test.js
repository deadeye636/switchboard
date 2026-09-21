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

// The descriptor's `rpc` object is copied out of the protocol module by hand, and the core reaches the
// protocol ONLY through it — so a function added to the module and forgotten here is unreachable, with no
// error anywhere: the core's feature checks read as "this backend cannot do that" and the feature is simply
// absent. `statsCommand` shipped that way for one test run (#643). Derived, so a new export is covered on
// the day it is written; anything the core is deliberately not given goes in the list with its reason.
test('every part of the protocol the core could use is handed to it', () => {
  // Empty today, and an entry carries the REASON the core must not call that function — not a category.
  const NOT_HANDED_OVER = {};
  const exempt = (k) => Object.prototype.hasOwnProperty.call(NOT_HANDED_OVER, k);
  const exported = Object.keys(protocol).filter(k => typeof protocol[k] === 'function');
  const rpc = backends.get('pi-native').rpc || {};
  // The IDENTITY, not the name: `statsCommand: protocol.stateCommand` passes a name check and would send
  // the core to the wrong command, which is the failure this guard exists to make loud.
  const missing = exported.filter(k => rpc[k] !== protocol[k] && !exempt(k));
  assert.deepEqual(missing, [],
    `rpc-protocol.js exports these and the descriptor's \`rpc\` does not pass them on: ${missing.join(', ')}. `
    + 'Add them there, or name them in NOT_HANDED_OVER with the reason the core must not call them.');
  const stale = Object.keys(NOT_HANDED_OVER).filter(k => !exported.includes(k));
  assert.deepEqual(stale, [], `NOT_HANDED_OVER names something the protocol no longer exports: ${stale.join(', ')}`);
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

test('the approval gate: on by default for bash/edit/write, gone when the option says no (#568 step C)', () => {
  const on = runtimeExtension.extensionSource({ gate: true });
  assert.ok(on.includes('pi.on("tool_call"'));
  assert.ok(on.includes(JSON.stringify(runtimeExtension.GATED_TOOLS)));
  assert.ok(on.includes(runtimeExtension.APPROVAL_PREFIX));
  for (const label of Object.values(runtimeExtension.CHOICES)) assert.ok(on.includes(JSON.stringify(label)));
  const off = runtimeExtension.extensionSource({ gate: false });
  assert.ok(!off.includes('tool_call'), 'switched off, nothing asks');
  assert.ok(off.includes('appendEntry'), 'the marker is written either way');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-gate-'));
  try {
    const read = (options) => fs.readFileSync(runtimeExtension.writeRuntimeExtension({ dir, tag: 't1', options }).cleanup, 'utf8');
    assert.ok(read({}).includes('tool_call'), 'nobody said anything means ON');
    assert.ok(!read({ approvalGate: false }).includes('tool_call'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('our approval question is recognised by its title and drawn as an approval, any other select is not', () => {
  const title = runtimeExtension.APPROVAL_PREFIX + JSON.stringify({ tool: 'bash', id: 'call_1|fc_2' });
  assert.deepEqual(runtimeExtension.parseApprovalTitle(title), { tool: 'bash', id: 'call_1|fc_2', detail: '', by: '' });
  assert.equal(runtimeExtension.parseApprovalTitle('Allow bash?'), null);
  assert.equal(runtimeExtension.parseApprovalTitle(runtimeExtension.APPROVAL_PREFIX + '{broken'), null);

  const d = protocol.createDecoder();
  const [ask] = d.decode({ type: 'extension_ui_request', id: 'q1', method: 'select', title,
    options: Object.values(runtimeExtension.CHOICES) });
  assert.equal(ask.request.kind, 'approval');
  assert.equal(ask.request.tool, 'bash');
  assert.equal(ask.request.toolCallId, 'call_1|fc_2');
  assert.deepEqual(ask.request.answers, {
    once: runtimeExtension.CHOICES.once, session: runtimeExtension.CHOICES.session, refuse: runtimeExtension.CHOICES.refuse,
  });
  const [plain] = d.decode({ type: 'extension_ui_request', id: 'q2', method: 'select', title: 'Pick', options: ['a'] });
  assert.equal(plain.request.kind, undefined);
});

test('the approval option is declared, applied through the runtime extension, and forwarded to templates', () => {
  const d = backends.get('pi-native');
  const f = d.configFields.find(x => x.id === 'approvalGate');
  assert.ok(f, 'a user can switch it off');
  assert.equal(f.default, true);
  assert.equal(f.appliesAt, 'spawn');
  assert.equal(f.appliedBy, 'buildRuntimeExtension');
  assert.match(f.description, /not a security boundary/, 'the setting says what it is not');
  const tpl = backends.profileToDescriptor({ id: 't', name: 'T', backendId: 'pi-native' });
  assert.equal(typeof tpl.buildRuntimeExtension, 'function');
  assert.equal(tpl.transport, 'rpc');
});

// The generated extension RUN, not read: compiled from TypeScript by esbuild (the regex that used to drop the
// annotations broke on the first one that was not `: any`), then handed a fake `pi`. What decides safety is
// behaviour — a cancel, a throw and an unknown answer must block — and a substring check cannot see that.
function loadExtension(options, globals = {}) {
  const vm = require('node:vm');
  const { code } = require('esbuild').transformSync(runtimeExtension.extensionSource(options), { loader: 'ts', format: 'cjs', target: 'node20' });
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, JSON, ...globals });
  mod.exports = mod.exports.default;
  const handlers = {};
  const appended = [];
  const commands = {};
  mod.exports({ on: (ev, fn) => { handlers[ev] = fn; }, appendEntry: (t, d) => appended.push([t, d]),
    registerCommand: (name, def) => { commands[name] = def; } });
  return { handlers, appended, commands };
}

test('the running gate: only an explicit allow lets a gated call through, and the question gets the abort signal', async () => {
  const { handlers } = loadExtension({ gate: true });
  const call = async (toolName, select) => handlers.tool_call({ toolName, toolCallId: 'c1' }, { ui: { select }, signal: 'SIG' });
  let seenOpts = null;
  const blockedOn = async (answer) => call('bash', async (_t, _o, opts) => { seenOpts = opts; if (answer instanceof Error) throw answer; return answer; });
  assert.equal((await blockedOn(undefined)).block, true, 'a dismissed question blocks');
  assert.equal(seenOpts.signal, 'SIG', 'Stop can end the question');
  assert.equal((await blockedOn(new Error('ui gone'))).block, true, 'a question that threw blocks');
  assert.equal((await blockedOn('something else')).block, true, 'an answer it does not know blocks');
  assert.equal((await blockedOn(runtimeExtension.CHOICES.refuse)).block, true);
  assert.equal(await blockedOn(runtimeExtension.CHOICES.once), undefined, 'allow once runs it');
  let asked = 0;
  assert.equal(await call('read', async () => { asked++; }), undefined);
  assert.equal(asked, 0, 'a read-only tool is never asked about');
  assert.equal(await call('powershell', async () => runtimeExtension.CHOICES.session), undefined);
  assert.equal(await call('powershell', async () => { asked++; return undefined; }), undefined, 'allowed for the session');
  assert.equal(asked, 0);
  assert.equal((await call('edit', async () => undefined)).block, true, 'the session allowance is per tool');
});

// #634: a delegation's question carries what the agent may do, asked of the subagent extension through the
// registry symbol at the moment of the call — and a missing or throwing describer leaves the question standing.
test('the running gate: a subagent question carries the agent description, and only that tool asks for one', async () => {
  const { DESCRIBE_KEY } = require('../src/backends/pi/subagent-tool');
  const seen = [];
  const describer = (cwd, name) => { seen.push([cwd, name]); return 'Agent ' + name + ' · tools: ls'; };
  const { handlers } = loadExtension({ gate: true }, { [Symbol.for(DESCRIBE_KEY)]: describer });
  const titles = [];
  const select = async (title) => { titles.push(title); return runtimeExtension.CHOICES.once; };
  await handlers.tool_call({ toolName: 'subagent', toolCallId: 's1', input: { agent: 'counter', task: 't' } }, { ui: { select }, cwd: '<project>' });
  await handlers.tool_call({ toolName: 'bash', toolCallId: 'b1', input: { command: 'ls' } }, { ui: { select }, cwd: '<project>' });
  assert.deepEqual(seen, [['<project>', 'counter']], 'asked once, for the delegation only');
  assert.equal(runtimeExtension.parseApprovalTitle(titles[0]).detail, 'Agent counter · tools: ls');
  assert.equal(runtimeExtension.parseApprovalTitle(titles[1]).detail, '');

  // Allow for this session is per AGENT for a delegation: the question showed one agent's tools, so another
  // agent is asked about again, and the same one is not.
  const perAgent = loadExtension({ gate: true });
  let asks = 0;
  const delegate = (agent, answer) => perAgent.handlers.tool_call({ toolName: 'subagent', toolCallId: 'd', input: { agent, task: 't' } },
    { ui: { select: async () => { asks++; return answer; } }, cwd: '<project>' });
  assert.equal(await delegate('counter', runtimeExtension.CHOICES.session), undefined);
  assert.equal(await delegate('counter', undefined), undefined, 'the same agent runs without asking');
  assert.equal(asks, 1);
  assert.equal((await delegate('writer', undefined)).block, true, 'another agent is asked, and no answer blocks');
  assert.equal(asks, 2);

  const bare = loadExtension({ gate: true }, { [Symbol.for(DESCRIBE_KEY)]: () => { throw new Error('boom'); } });
  const blocked = await bare.handlers.tool_call({ toolName: 'subagent', toolCallId: 's2', input: { agent: 'x' } }, { ui: { select: async () => undefined }, cwd: '<project>' });
  assert.equal(blocked.block, true, 'a describer that throws still leaves a question, and no answer still blocks');
});

test('the running marker: appended once, not again for a session that carries it', async () => {
  const { handlers, appended } = loadExtension({ gate: false });
  assert.equal(handlers.tool_call, undefined, 'the gate is off, nothing asks');
  await handlers.session_start({}, { sessionManager: { getEntries: () => [] } });
  assert.equal(appended.length, 1);
  await handlers.session_start({}, { sessionManager: { getEntries: () => [{ type: 'custom', customType: TRANSPORT_MARKER_TYPE, data: { transport: 'rpc' } }] } });
  assert.equal(appended.length, 1);
});

test('every edit shape Pi itself accepts is drawn as a diff', () => {
  const draw = (args) => normalizeTranscriptEntries([{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'e', name: 'edit', arguments: { path: 'a.js', ...args } }] } }])[0].message.content[0];
  const one = { oldText: 'x', newText: 'y' };
  for (const [label, args] of [
    ['an array', { edits: [one] }],
    ['a JSON string', { edits: JSON.stringify([one]) }],
    ['a single object', { edits: one }],
    ['the legacy top-level pair', { oldText: 'x', newText: 'y' }],
  ]) {
    const b = draw(args);
    assert.equal(b.name, 'Edit', label);
    assert.equal(b.input.old_string, 'x', label);
    assert.equal(b.input.new_string, 'y', label);
  }
  assert.equal(draw({ edits: 'not json' }).name, 'edit', 'a shape nobody can read stays generic');
  const ps = normalizeTranscriptEntries([{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'p', name: 'powershell', arguments: { command: 'dir' } }] } }])[0].message.content[0];
  assert.deepEqual([ps.name, ps.input.command], ['Bash', 'dir']);
});

// #632, N1: a command the user ran asks through the gate with an allowance of its own. "Allow for this
// session" on its shell line must not unlock the agent's `bash` tool, nor the other way round, and the card
// says who is asking.
test('the running gate: a command\'s own allowance is not the agent\'s bash, and the question names the command', async () => {
  const bridge = require('../src/backends/pi/command-bridge');
  const g = {};
  const { handlers } = loadExtension({ gate: true }, { globalThis: g });
  const askGate = g[Symbol.for(bridge.APPROVAL_ASK_KEY)];
  assert.equal(typeof askGate, 'function', 'the gate publishes its question');
  const titles = [];
  const select = (answer) => async (title) => { titles.push(title); return answer; };
  assert.equal(await askGate('bash', 'git status', { ui: { select: select(runtimeExtension.CHOICES.session) } }, { key: 'command:greet', by: '/greet' }), true);
  assert.deepEqual(runtimeExtension.parseApprovalTitle(titles[0]), { tool: 'bash', id: null, detail: 'git status', by: '/greet' });
  // The same command again: allowed for the session, not asked.
  assert.equal(await askGate('bash', 'git status', { ui: { select: select(undefined) } }, { key: 'command:greet', by: '/greet' }), true);
  assert.equal(titles.length, 1);
  // The agent's own bash is still asked about…
  const r = await handlers.tool_call({ toolName: 'bash', toolCallId: 'c9' }, { ui: { select: select(undefined) } });
  assert.equal(r.block, true, 'a command\'s allowance does not reach the agent\'s bash tool');
  // …and another command is asked about too.
  assert.equal(await askGate('bash', 'ls', { ui: { select: select(undefined) } }, { key: 'command:other', by: '/other' }), false);
});

// #633 (M5): every MCP tool taken over from another CLI is asked about, per TOOL, with the line the MCP section
// of the resources extension publishes about it. Its name only carries the prefix; the section says what it is.
test('the running gate: an MCP tool is asked about, per tool, with the MCP section\'s line about it', async () => {
  const { DESCRIBE_KEY, TOOL_PREFIX } = require('../src/backends/pi/mcp-section');
  assert.equal(runtimeExtension.MCP_TOOL_PREFIX, TOOL_PREFIX);
  const describer = (name) => (name === 'mcp__files__read' ? 'Tool read of the MCP server files, taken over from another CLI.' : '');
  const { handlers } = loadExtension({ gate: true }, { [Symbol.for(DESCRIBE_KEY)]: describer });
  const titles = [];
  let answer = runtimeExtension.CHOICES.session;
  const call = (toolName) => handlers.tool_call({ toolName, toolCallId: 'm1', input: {} },
    { ui: { select: async (title) => { titles.push(title); return answer; } }, cwd: '<project>' });
  assert.equal(await call('mcp__files__read'), undefined, 'allowed for the session');
  const asked = runtimeExtension.parseApprovalTitle(titles[0]);
  assert.equal(asked.tool, 'mcp__files__read');
  assert.equal(asked.detail, 'Tool read of the MCP server files, taken over from another CLI.');
  answer = undefined;
  assert.equal(await call('mcp__files__read'), undefined, 'the same tool runs without asking again');
  assert.equal(titles.length, 1);
  assert.equal((await call('mcp__files__write')).block, true, 'another MCP tool is asked about, and no answer blocks');
  assert.equal(titles.length, 2);
  assert.equal(runtimeExtension.parseApprovalTitle(titles[1]).detail, '', 'a tool the section does not know goes without a line');
  const bare = loadExtension({ gate: true });
  const blocked = await bare.handlers.tool_call({ toolName: 'mcp__x__y', toolCallId: 'm2', input: {} }, { ui: { select: async () => undefined } });
  assert.equal(blocked.block, true, 'without the section, still asked, and no answer still blocks');
  const off = loadExtension({ gate: false });
  assert.equal(off.handlers.tool_call, undefined, 'the gate switched off asks about nothing');
});
