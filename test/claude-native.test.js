'use strict';
// claude-native (#660): Claude Code driven over its stream-json pipe. This file holds what can be asked without
// a child — the translator, the launch, the version floor, the descriptor's wiring. The core driving a real
// child through this backend's protocol half is `claude-native-rpc.test.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backends = require('../src/backends');
const claude = require('../src/backends/claude');
const protocol = require('../src/backends/claude-native/rpc-protocol');
const version = require('../src/backends/claude-native/version');
const { TRANSPORT_ENTRYPOINT_ENV, TRANSPORT_ENTRYPOINT } = require('../src/backends/claude/transport-marker');
const { encodeProjectPath } = require('../src/session/encode-project-path');

const native = () => backends.get('claude-native');
const decodeAll = (lines) => { const d = protocol.createDecoder(); return lines.flatMap(l => d.decode(l)); };
const opNames = (ops) => ops.map(o => o.op);

// --- the translator ---

test('a streamed reply is drawn as it is written, and each finished block becomes an entry under its uuid', () => {
  const d = protocol.createDecoder();
  const s = { session_id: 's1', parent_tool_use_id: null };
  assert.deepEqual(opNames(d.decode({ ...s, type: 'stream_event', event: { type: 'message_start' } })), ['identity', 'partial']);
  d.decode({ ...s, type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  const delta = d.decode({ ...s, type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } });
  assert.deepEqual(delta[0].entry.message.content, [{ type: 'text', text: 'Hel' }]);
  d.decode({ ...s, type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } } });
  assert.equal(d.currentPartial().message.content[0].text, 'Hello');
  const done = d.decode({ ...s, type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
  assert.deepEqual(opNames(done), ['partial', 'append']);
  assert.equal(done[0].entry, null, 'the finished block leaves the partial, so it is not drawn twice');
  assert.equal(done[1].entry.uuid, 'a1');
  assert.equal(protocol.entryKey(done[1].entry), 'a1');
  // The next block of the same model message streams into an emptied partial.
  d.decode({ ...s, type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Bash' } } });
  const args = d.decode({ ...s, type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"l' } } });
  assert.deepEqual(args[0].entry.message.content, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { _partial: '{"command":"l' } }]);
  assert.deepEqual(d.decode({ ...s, type: 'stream_event', event: { type: 'message_stop' } }), [{ op: 'partial', entry: null }]);
});

test('a tool call runs from its block to its result', () => {
  const ops = decodeAll([
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out', is_error: false }] } },
    { type: 'user', uuid: 'u3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'bad' }], is_error: true }] } },
  ]);
  assert.deepEqual(ops.filter(o => o.op === 'tool'), [
    { op: 'tool', id: 't1', status: 'running', output: '' },
    { op: 'tool', id: 't1', status: 'done', output: 'out' },
    { op: 'tool', id: 't2', status: 'error', output: 'bad' },
  ]);
});

test('every turn opens with system/init and ends with result — the busy edges of a turn nothing of ours wrote', () => {
  const ops = decodeAll([
    { type: 'result', subtype: 'success', is_error: false, result: 'A' },
    { type: 'system', subtype: 'init' },
    { type: 'user', uuid: 'u9', isReplay: true, message: { role: 'user', content: 'queued' } },
    { type: 'result', subtype: 'success', is_error: false, result: 'B' },
  ]);
  assert.deepEqual(ops.filter(o => o.op === 'busy').map(o => o.busy), [false, true, false]);
  assert.equal(ops.find(o => o.op === 'append').entry.message.content, 'queued', 'the queued line is drawn when it runs');
});

test('a failed turn says so, in the CLI\'s own words', () => {
  const ops = decodeAll([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Credit balance is too low'] }]);
  assert.deepEqual(ops, [{ op: 'notice', level: 'error', text: 'Credit balance is too low' }, { op: 'busy', busy: false }]);
  const failedCall = decodeAll([{ type: 'assistant', uuid: 'a1', error: 'authentication_failed', message: { role: 'assistant', content: [{ type: 'text', text: 'Please run /login' }] } }]);
  assert.deepEqual(failedCall.find(o => o.op === 'notice'), { op: 'notice', level: 'error', text: 'Please run /login' });
});

test('a turn ended by Stop is drawn as stopped; a Stop that ended nothing leaves the next failure alone', () => {
  const stopped = protocol.createDecoder();
  stopped.noteSent(protocol.abortCommand('i1'));
  const ops = stopped.decode({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] result_type=user'] });
  assert.deepEqual(ops, [{ op: 'notice', level: 'info', text: 'Stopped.' }, { op: 'busy', busy: false }]);
  const after = stopped.decode({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Credit balance is too low'] });
  assert.equal(after[0].level, 'error', 'the stop is spent by the turn it ended');

  const idleStop = protocol.createDecoder();
  idleStop.noteSent(protocol.abortCommand('i2'));
  idleStop.noteSent(protocol.sendCommand({ text: 'next' }));
  idleStop.decode({ type: 'system', subtype: 'init' });
  const failed = idleStop.decode({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Credit balance is too low'] });
  assert.deepEqual(failed[0], { op: 'notice', level: 'error', text: 'Credit balance is too low' }, 'a turn that starts after the Stop is not the one it stopped');
});

test('a local command\'s <synthetic> reply is an entry, never a shell line of the core\'s', () => {
  const ops = decodeAll([{ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Total cost: $0.00' }] } }]);
  assert.deepEqual(opNames(ops), ['append']);
  assert.ok(!ops.some(o => o.op === 'localCommand'));
});

// #718 — the shapes measured on 2.1.284: a local command's typed line is never played back.
const sentTurn = (d, text, mode) => d.noteSent(protocol.sendCommand({ text, mode }));
const userTexts = (ops) => ops.filter(o => o.op === 'append' && o.entry.message && o.entry.message.role === 'user')
  .map(o => o.entry.message.content);
const synthetic = (uuid, text) => ({ type: 'assistant', uuid, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] } });

test('a local command is drawn as the user\'s line in front of its output, since the stream never plays it back', () => {
  const d = protocol.createDecoder();
  sentTurn(d, '/mcp ', 'prompt');
  const ops = [{ type: 'system', subtype: 'init' }, synthetic('s1', '22 MCP server(s)'), { type: 'result', subtype: 'success' }].flatMap(l => d.decode(l));
  const appends = ops.filter(o => o.op === 'append');
  assert.deepEqual(appends.map(o => (typeof o.entry.message.content === 'string' ? o.entry.message.content : o.entry.message.content[0].text)), ['/mcp', '22 MCP server(s)']);
  assert.equal(appends[0].entry.prompt, true);
  assert.equal(appends[0].entry.uuid, undefined, 'the stream named no uuid for it, so it carries no key');
});

test('/compact is drawn before its first notice, which arrives before the turn\'s init', () => {
  const d = protocol.createDecoder();
  sentTurn(d, '/compact', 'prompt');
  const ops = [
    { type: 'system', subtype: 'status', status: 'compacting' },
    { type: 'system', subtype: 'init' },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'user', uuid: 'sum', isSynthetic: true, message: { role: 'user', content: 'This session is being continued…' } },
    { type: 'user', uuid: 'out', isReplay: true, message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' } },
    { type: 'result', subtype: 'success' },
  ].flatMap(l => d.decode(l));
  const firstVisible = ops.findIndex(o => o.op === 'append' || o.op === 'notice');
  assert.equal(ops[firstVisible].op, 'append');
  assert.equal(ops[firstVisible].entry.message.content, '/compact');
  assert.deepEqual(userTexts(ops).filter(t => t === '/compact'), ['/compact'], 'drawn once');
});

test('a line the stream plays back is not drawn a second time', () => {
  const d = protocol.createDecoder();
  sentTurn(d, '/demo-skill', 'prompt');
  const ops = [
    { type: 'system', subtype: 'init' },
    { type: 'user', uuid: 'u1', isReplay: true, message: { role: 'user', content: '<command-name>/demo-skill</command-name>' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    { type: 'result', subtype: 'success' },
  ].flatMap(l => d.decode(l));
  assert.deepEqual(userTexts(ops), ['/demo-skill']);
  // …and a plain prompt waits for its replay, whatever comes first.
  sentTurn(d, 'hello', 'prompt');
  const plain = [
    { type: 'system', subtype: 'init' },
    { type: 'system', subtype: 'api_retry' },
    { type: 'user', uuid: 'u2', isReplay: true, message: { role: 'user', content: 'hello' } },
    { type: 'result', subtype: 'success' },
  ].flatMap(l => d.decode(l));
  assert.deepEqual(userTexts(plain), ['hello']);
});

test('a command whose turn shows nothing is over with its turn, and does not name the next one', () => {
  const d = protocol.createDecoder();
  sentTurn(d, '/clear', 'prompt');
  [{ type: 'conversation_reset' }, { type: 'system', subtype: 'init', session_id: 'new' }, { type: 'result', subtype: 'success' }].forEach(l => d.decode(l));
  sentTurn(d, '/cost', 'prompt');
  const ops = [{ type: 'system', subtype: 'init' }, synthetic('c1', 'Total cost: $0.00'), { type: 'result', subtype: 'success' }].flatMap(l => d.decode(l));
  assert.deepEqual(userTexts(ops), ['/cost']);
});

test('a follow-up written during a turn waits for its own turn, and a steer is never drawn by the decoder', () => {
  const d = protocol.createDecoder();
  sentTurn(d, 'first', 'prompt');
  d.decode({ type: 'system', subtype: 'init' });
  d.decode({ type: 'user', uuid: 'u1', isReplay: true, message: { role: 'user', content: 'first' } });
  sentTurn(d, '/cost', 'follow_up');
  sentTurn(d, '/context', 'steer');
  const during = d.decode({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } });
  assert.deepEqual(userTexts(during), [], 'nothing is drawn into the running turn');
  d.decode({ type: 'result', subtype: 'success' });
  const next = [{ type: 'system', subtype: 'init' }, synthetic('c1', 'Total cost: $0.00'), { type: 'result', subtype: 'success' }].flatMap(l => d.decode(l));
  assert.deepEqual(userTexts(next), ['/cost']);
});

test('a command whose turn ends only in a failure or a Stop still has its line, in front of that notice', () => {
  const failed = protocol.createDecoder();
  sentTurn(failed, '/foo', 'prompt');
  const ops = [{ type: 'system', subtype: 'init' }, { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] }].flatMap(l => failed.decode(l));
  const at = ops.findIndex(o => o.op === 'notice');
  assert.equal(ops[at - 1].op, 'append');
  assert.equal(ops[at - 1].entry.message.content, '/foo');
  const stopped = protocol.createDecoder();
  sentTurn(stopped, '/context', 'prompt');
  stopped.decode({ type: 'system', subtype: 'init' });
  stopped.noteSent(protocol.abortCommand('x'));
  const stop = stopped.decode({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic]'] });
  assert.deepEqual(userTexts(stop), ['/context']);
});

test('a skill drawn in front of a notice is not drawn again when its replay follows', () => {
  const d = protocol.createDecoder();
  sentTurn(d, '/demo', 'prompt');
  const ops = [
    { type: 'system', subtype: 'init' },
    { type: 'system', subtype: 'api_retry' },
    { type: 'user', uuid: 'u1', isReplay: true, message: { role: 'user', content: '<command-name>/demo</command-name>' } },
    { type: 'result', subtype: 'success' },
  ].flatMap(l => d.decode(l));
  assert.deepEqual(userTexts(ops), ['/demo']);
});

test('a line written between a turn\'s end and a queued follow-up\'s start keeps the follow-up ahead of it', () => {
  const d = protocol.createDecoder();
  sentTurn(d, 'first', 'prompt');
  d.decode({ type: 'system', subtype: 'init' });
  d.decode({ type: 'user', uuid: 'u1', isReplay: true, message: { role: 'user', content: 'first' } });
  sentTurn(d, '/cost', 'follow_up');
  d.decode({ type: 'result', subtype: 'success' });
  sentTurn(d, 'b', 'prompt');
  const next = [{ type: 'system', subtype: 'init' }, synthetic('c1', 'Total cost: $0.00'), { type: 'result', subtype: 'success' }].flatMap(l => d.decode(l));
  assert.deepEqual(userTexts(next), ['/cost']);
  const after = [{ type: 'system', subtype: 'init' }, { type: 'user', uuid: 'u2', isReplay: true, message: { role: 'user', content: 'b' } }, { type: 'result', subtype: 'success' }].flatMap(l => d.decode(l));
  assert.deepEqual(userTexts(after), ['b']);
});

test('a replay that matches no written line still clears the oldest, so a later command is drawn', () => {
  const d = protocol.createDecoder();
  sentTurn(d, 'typed one way', 'prompt');
  [{ type: 'system', subtype: 'init' }, { type: 'user', uuid: 'u1', isReplay: true, message: { role: 'user', content: 'played another' } }].forEach(l => d.decode(l));
  sentTurn(d, '/cost', 'follow_up');
  d.decode({ type: 'result', subtype: 'success' });
  const next = [{ type: 'system', subtype: 'init' }, synthetic('c1', 'Total cost: $0.00'), { type: 'result', subtype: 'success' }].flatMap(l => d.decode(l));
  assert.deepEqual(userTexts(next), ['/cost']);
});

test('a follow-up played back inside the running turn is no longer due, so a later command is drawn', () => {
  const d = protocol.createDecoder();
  sentTurn(d, 'first', 'prompt');
  d.decode({ type: 'system', subtype: 'init' });
  d.decode({ type: 'user', uuid: 'u1', isReplay: true, message: { role: 'user', content: 'first' } });
  sentTurn(d, 'more', 'follow_up');
  d.decode({ type: 'user', uuid: 'u2', isReplay: true, message: { role: 'user', content: 'more' } });
  d.decode({ type: 'result', subtype: 'success' });
  // A plain turn in between changes nothing.
  sentTurn(d, 'x', 'prompt');
  [{ type: 'system', subtype: 'init' }, { type: 'user', uuid: 'u3', isReplay: true, message: { role: 'user', content: 'x' } }, { type: 'result', subtype: 'success' }].forEach(l => d.decode(l));
  sentTurn(d, '/cost', 'prompt');
  const next = [{ type: 'system', subtype: 'init' }, synthetic('c1', 'Total cost: $0.00'), { type: 'result', subtype: 'success' }].flatMap(l => d.decode(l));
  assert.deepEqual(userTexts(next), ['/cost']);
});

test('a failed server\'s error loses the credentials, query and tokens it names', () => {
  const errorOf = (error) => protocol.serverList({ success: true, data: { mcpServers: [{ name: 'x', status: 'failed', error }] } }).rows[0].error;
  assert.equal(errorOf('HTTP 401 from https://user:pw@api.example.invalid/mcp?token=abc#frag after 3 tries'),
    'HTTP 401 from https://api.example.invalid/mcp after 3 tries');
  assert.equal(errorOf('refused https://u:p@ss@h.example.invalid/mcp?key=abc'), 'refused https://h.example.invalid/mcp');
  assert.equal(errorOf('sent Bearer tok123, got 403'), 'sent Bearer …, got 403');
});

test('the MCP servers are rows in words, and a server\'s config never leaves the backend (#719)', () => {
  assert.deepEqual(protocol.appCommandOp('/mcp'), { op: 'servers' });
  assert.deepEqual(protocol.appCommandOp('  /mcp  '), { op: 'servers' });
  assert.equal(protocol.appCommandOp('/mcp reconnect x'), null);
  assert.equal(protocol.appCommandOp('/mcp-builder'), null);
  assert.equal(protocol.appCommandOp('tell me about /mcp'), null);
  assert.deepEqual(protocol.serversCommand('r1'), { type: 'control_request', request_id: 'r1', request: { subtype: 'mcp_status' } });
  const list = protocol.serverList({ success: true, data: { mcpServers: [
    { name: 'a', status: 'pending', scope: 'user', config: { env: { KEY: 'secret' } } },
    { name: 'b', status: 'needs-auth', scope: 'claudeai' },
    { name: 'c', status: 'failed', error: 'No URL configured for this server', scope: 'dynamic' },
    { name: 'd', status: 'something-new' },
    { status: 'connected' },
  ] } });
  assert.deepEqual(list.rows.map(r => [r.name, r.state, r.tone, r.error]), [
    ['a', 'connecting', 'waiting', ''],
    ['b', 'needs sign-in', 'waiting', ''],
    ['c', 'failed', 'failed', 'No URL configured for this server'],
    ['d', 'something-new', 'waiting', ''],
  ]);
  assert.ok(!JSON.stringify(list).includes('secret'));
  assert.equal(protocol.serverList({ success: false, error: 'no answer' }), null);
});

test('each server carries its group, its tools and the actions its state and kind allow (#728)', () => {
  const list = protocol.serverList({ success: true, data: { mcpServers: [
    { name: 'builtin', status: 'connected', scope: 'dynamic', config: { type: 'stdio', command: 'x' }, tools: [{ name: 't', annotations: { readOnly: true } }] },
    { name: 'web', status: 'connected', scope: 'user', config: { type: 'http', url: 'https://h.example.invalid' }, tools: [] },
    { name: 'oauth', status: 'needs-auth', scope: 'project', config: { type: 'sse', url: 'https://h.example.invalid' } },
    { name: 'claude.ai X', status: 'needs-auth', scope: 'claudeai', config: { type: 'claudeai-proxy' } },
    { name: 'local', status: 'needs-auth', scope: 'local', config: { type: 'stdio' } },
    { name: 'off', status: 'disabled', scope: 'user' },
    { name: 'broken', status: 'failed', scope: 'mystery', error: 'x' },
  ] } });
  const byName = Object.fromEntries(list.rows.map(r => [r.name, r]));
  const ids = (n) => byName[n].actions.map(a => a.id);
  assert.deepEqual(list.rows.map(r => [r.name, r.group, r.groupOrder]), [
    ['builtin', 'Built-in MCPs', 7], ['web', 'User MCPs', 2], ['oauth', 'Project MCPs', 0], ['claude.ai X', 'claude.ai', 6],
    ['local', 'Local MCPs', 1], ['off', 'User MCPs', 2], ['broken', 'mystery', 8],
  ]);
  assert.deepEqual(byName.builtin.toolList, [{ name: 't', readOnly: true, destructive: false }]);
  assert.deepEqual(ids('builtin'), ['tools', 'reconnect', 'disable']);
  assert.deepEqual(ids('web'), ['reconnect', 'signOut', 'disable'], 'no tools to view, and a remote server can be signed out of');
  assert.deepEqual(ids('oauth'), ['authenticate', 'disable']);
  assert.deepEqual(ids('claude.ai X'), ['authenticate', 'disable'], 'a connector signs in, and is never offered a sign-out');
  assert.deepEqual(ids('local'), ['disable'], 'a stdio server cannot sign in');
  assert.deepEqual(ids('off'), ['enable']);
  assert.deepEqual(ids('broken'), ['reconnect', 'disable']);
  assert.equal(byName.oauth.needsSignIn, true);
  assert.match(byName.web.actions.find(a => a.id === 'disable').confirm, /whole project.*terminal Claude sessions/);
  assert.ok(!JSON.stringify(list).includes('h.example.invalid'), 'no config reaches a row');
});

test('a server action is the measured control request, and its answer is in the app\'s words (#728)', () => {
  const req = (a, x) => protocol.serverActionCommand('r1', 'srv', a, x);
  assert.deepEqual(req('reconnect').request, { subtype: 'mcp_reconnect', serverName: 'srv' });
  assert.deepEqual(req('enable').request, { subtype: 'mcp_toggle', serverName: 'srv', enabled: true });
  assert.deepEqual(req('disable').request, { subtype: 'mcp_toggle', serverName: 'srv', enabled: false });
  assert.deepEqual(req('authenticate').request, { subtype: 'mcp_authenticate', serverName: 'srv' });
  assert.deepEqual(req('signOut').request, { subtype: 'mcp_clear_auth', serverName: 'srv' });
  assert.deepEqual(req('callback', { callbackUrl: ' http://localhost:1/callback?code=a ' }).request,
    { subtype: 'mcp_oauth_callback_url', serverName: 'srv', callbackUrl: 'http://localhost:1/callback?code=a' });
  assert.equal(req('callback', {}), null);
  assert.equal(req('tools'), null, 'viewing the tools sends nothing');
  assert.equal(req('rm -rf'), null);
  assert.equal(req('reconnect').request_id, 'r1');
  const res = protocol.serverActionResult;
  assert.deepEqual(res({ success: true, data: {} }), { ok: true, error: '', authUrl: '' });
  assert.deepEqual(res({ success: true, data: { authUrl: 'https://a.example.invalid/x', callbackPort: 1 } }), { ok: true, error: '', authUrl: 'https://a.example.invalid/x' });
  assert.equal(res({ success: true, data: { authUrl: 'file:///etc/passwd' } }).authUrl, '', 'only an http(s) page is handed on');
  assert.deepEqual(res({ success: false, error: 'failed https://u:p@h.example.invalid/mcp?token=a' }), { ok: false, error: 'failed https://h.example.invalid/mcp' });
  assert.deepEqual(res(null), { ok: false, error: 'No answer from the session.' });
});

test('/clear: the conversation is reset, and the new id is announced before anything about the new session', () => {
  const ops = decodeAll([
    { type: 'result', session_id: 'old', subtype: 'success', is_error: false },
    { type: 'conversation_reset' },
    { type: 'system', subtype: 'init', session_id: 'new' },
    { type: 'result', session_id: 'new', subtype: 'success', is_error: false },
  ]);
  assert.deepEqual(opNames(ops), ['identity', 'busy', 'partial', 'reset', 'identity', 'busy', 'busy']);
  assert.deepEqual(ops.filter(o => o.op === 'identity').map(o => o.sessionId), ['old', 'new']);
  // The ordering the hooks depend on (#659): the re-key comes first on the line that names the new id, so the
  // busy edge of the new session is already reported under the new id.
  const newAt = ops.findIndex(o => o.op === 'identity' && o.sessionId === 'new');
  assert.equal(ops[newAt + 1].op, 'busy');
  assert.deepEqual(decodeAll([{ type: 'result', session_id: 'x' }, { type: 'result', session_id: 'x' }]).filter(o => o.op === 'identity').length, 1,
    'an id is announced once, not on every line');
});

test('a subagent\'s own stream is not a turn of this conversation', () => {
  const ops = decodeAll([
    { type: 'stream_event', parent_tool_use_id: 't1', event: { type: 'message_start' } },
    { type: 'assistant', parent_tool_use_id: 't1', uuid: 'x', message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] } },
    { type: 'user', parent_tool_use_id: 't1', uuid: 'y', message: { role: 'user', content: 'sub prompt' } },
  ]);
  assert.deepEqual(ops, []);
});

test('an approval arrives as an ask, a withdrawn one closes, and the answer echoes the tool\'s input', () => {
  const [ask] = decodeAll([{ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't1', input: { command: 'ls' }, description: 'List' } }]);
  assert.equal(ask.op, 'ask');
  assert.equal(ask.request.id, 'r1');
  assert.equal(ask.request.kind, 'approval');
  assert.equal(ask.request.toolCallId, 't1');
  assert.equal(ask.request.message, 'List');
  assert.match(ask.request.note, /Claude Code asks this under its own permission rules/,
    'the card says whose question it is — not the pi-native gate\'s "convenience, not a boundary"');
  assert.deepEqual(Object.keys(ask.request.answers), ['once', 'refuse'], 'no suggestion from the CLI, no "for this session"');
  assert.deepEqual(decodeAll([{ type: 'control_cancel_request', request_id: 'r1' }]), [{ op: 'answered', id: 'r1' }]);
  assert.deepEqual(decodeAll([{ type: 'control_request', request_id: 'r2', request: { subtype: 'hook_callback' } }]), []);

  const allow = protocol.answerCommand('r1', { value: ask.request.answers.once }, ask.request);
  assert.deepEqual(allow, { type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { command: 'ls' } } } });
  for (const answer of [{ value: ask.request.answers.refuse }, { cancelled: true }, {}]) {
    const r = protocol.answerCommand('r1', answer, ask.request).response.response;
    assert.equal(r.behavior, 'deny', JSON.stringify(answer));
    assert.ok(r.message);
  }
});

// #661, measured on 2.1.283: a Write with no rule matched carried `setMode acceptEdits` for the session.
test('"allow for this session" is offered only for what the CLI suggested for the session, and hands it back', () => {
  const suggestions = [
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'localSettings' },
  ];
  const [ask] = decodeAll([{ type: 'control_request', request_id: 'w1', request: { subtype: 'can_use_tool', tool_name: 'Write', tool_use_id: 't2', input: { file_path: 'b.txt', content: 'hi' }, permission_suggestions: suggestions } }]);
  assert.deepEqual(Object.keys(ask.request.answers), ['once', 'session', 'project', 'refuse']);
  assert.equal(ask.request.sessionLabel, 'Allow all edits for this session', 'the button says a mode switch reaches every later edit');
  const r = protocol.answerCommand('w1', { value: ask.request.answers.session }, ask.request).response.response;
  assert.equal(r.behavior, 'allow');
  assert.deepEqual(r.updatedInput, { file_path: 'b.txt', content: 'hi' });
  assert.deepEqual(r.updatedPermissions, [suggestions[0]], '"for this session" hands back only what is for the session');

  const [onlyFile] = decodeAll([{ type: 'control_request', request_id: 'w2', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {}, permission_suggestions: [suggestions[1]] } }]);
  assert.deepEqual(Object.keys(onlyFile.request.answers), ['once', 'project', 'refuse'], 'nothing for the session, no session button');
  assert.equal(protocol.answerCommand('w2', { value: protocol.ALLOW_SESSION }, onlyFile.request).response.response.updatedPermissions, undefined);
});

// #674: the lasting allow Claude's own terminal offers — the project's LOCAL settings only.
test('"in this project" hands back only the local-settings allow rule, and names the command', () => {
  const measured = [   // the suggestions a `mkdir` carried, measured on 2.1.283
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'mkdir -p m7dir' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addDirectories', directories: ['/work'], destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ];
  const [ask] = decodeAll([{ type: 'control_request', request_id: 'b1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't9', input: { command: 'mkdir -p m7dir' }, permission_suggestions: measured } }]);
  assert.deepEqual(Object.keys(ask.request.answers), ['once', 'session', 'project', 'refuse']);
  assert.equal(ask.request.projectLabel, 'Always allow “mkdir -p m7dir” in this project');
  assert.match(ask.request.projectNote, /settings\.local\.json/, 'the tooltip says where the rule lands and how it is taken back');
  assert.match(ask.request.projectNote, /^Rule: Bash\(mkdir -p m7dir\)\./, 'and leads with the full rule, which the label may cut short');
  const label = (rules) => decodeAll([{ type: 'control_request', request_id: 'l', request: { subtype: 'can_use_tool', tool_name: 'X', input: {},
    permission_suggestions: [{ type: 'addRules', rules, behavior: 'allow', destination: 'localSettings' }] } }])[0].request.projectLabel;
  assert.equal(label([{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }]), 'Always allow “WebFetch(domain:example.com)” in this project',
    'another tool\'s content is shown with its tool');
  assert.equal(label([{ toolName: 'Bash' }]), 'Always allow every Bash call in this project', 'a rule without content says it allows every call');
  assert.match(label([{ toolName: 'Bash', ruleContent: 'x'.repeat(100) }]), /…” in this project$/, 'a long command is cut in the label');
  const r = protocol.answerCommand('b1', { value: protocol.ALLOW_PROJECT }, ask.request).response.response;
  assert.equal(r.behavior, 'allow');
  assert.deepEqual(r.updatedInput, { command: 'mkdir -p m7dir' });
  assert.deepEqual(r.updatedPermissions, [measured[0]], 'only the project rule, not the session ones');

  // A rule for the shared project settings or the user's settings is not offered, and a crafted ask carrying
  // one cannot hand it back either.
  const wide = [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf x' }], behavior: 'allow', destination: 'projectSettings' },
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' },
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'curl' }], behavior: 'deny', destination: 'localSettings' },
  ];
  const [none] = decodeAll([{ type: 'control_request', request_id: 'b2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'x' }, permission_suggestions: wide } }]);
  assert.deepEqual(Object.keys(none.request.answers), ['once', 'refuse']);
  const crafted = { ...none.request, projectPermissions: wide };
  const c = protocol.answerCommand('b2', { value: protocol.ALLOW_PROJECT }, crafted).response.response;
  assert.equal(c.behavior, 'deny', 'no local allow rule to hand back: the answer is not an allow');
  assert.equal(c.updatedPermissions, undefined);

  // A dismissed card never writes a rule.
  assert.equal(protocol.answerCommand('b1', { cancelled: true, value: protocol.ALLOW_PROJECT }, ask.request).response.response.behavior, 'deny');
});

// Auto mode asks only under an `ask` rule, with no suggestions — the card says why instead of looking broken.
test('an ask under an ask rule says which rule, and why nothing lasting is offered', () => {
  const decisionReason = 'This command changes directory before running a version-control command, which can pick up untrusted hooks or repository configuration from the target directory. Approve only if you trust it.';
  const [compound] = decodeAll([{ type: 'control_request', request_id: 'm1', request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash',
    input: { command: 'cd /work; gh pr merge 1 --merge; git log --oneline -1' }, description: 'cd /work; gh pr merge 1 …',
    decision_reason: decisionReason, decision_reason_type: 'other',
    matched_ask_rule: { source: 'projectSettings', tool_name: 'Bash', rule_content: 'gh pr merge:*' } } }]);   // measured on 2.1.285
  assert.deepEqual(Object.keys(compound.request.answers), ['once', 'refuse']);
  assert.match(compound.request.reason, /“ask” rule Bash\(gh pr merge:\*\) in the project’s \.claude\/settings\.json\./);
  assert.match(compound.request.reason, /no lasting allow/);
  assert.ok(compound.request.reason.endsWith(`Claude Code: ${decisionReason}`), 'Claude\'s own sentence follows');

  const [plain] = decodeAll([{ type: 'control_request', request_id: 'm2', request: { subtype: 'can_use_tool', tool_name: 'Bash',
    input: { command: 'gh pr merge 1 --merge' }, description: 'Merge pull request 1', decision_reason_type: 'rule' } }]);   // measured
  assert.match(plain.request.reason, /^Asked because one of your permission rules says to ask\. An ask rule wins/);

  const reasonOf = (request) => decodeAll([{ type: 'control_request', request_id: 'm3', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, ...request } }])[0].request;
  assert.match(reasonOf({ matched_ask_rule: { source: 'flagSettings', tool_name: 'Bash' } }).reason, /rule Bash \(source: flagSettings\)\./,
    'a source the table does not know is named as Claude spelled it');
  assert.match(reasonOf({ matched_ask_rule: { source: 'cliArg', tool_name: 'Bash' } }).reason, /rule Bash passed on the command line\./);
  assert.match(reasonOf({ matched_ask_rule: { tool_name: 'Bash', rule_content: 'x:*' } }).reason, /^Asked because of the “ask” rule Bash\(x:\*\)\. An ask rule/,
    'no source, no place named');
  assert.equal(reasonOf({ decision_reason: 'Because.' }).reason, 'Claude Code: Because.', 'a sentence alone is drawn alone');

  // Not measured, but the card must not contradict its own buttons: with a lasting allow offered, no "nothing lasting".
  const both = reasonOf({ decision_reason_type: 'rule',
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'x' }], behavior: 'allow', destination: 'localSettings' }] });
  assert.deepEqual(Object.keys(both.answers), ['once', 'project', 'refuse']);
  assert.equal(both.reason, 'Asked because one of your permission rules says to ask.');

  const [none] = decodeAll([{ type: 'control_request', request_id: 'm4', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } }]);
  assert.equal(none.request.reason, undefined, 'no reason given, no reason drawn');
});

test('AskUserQuestion is a question card, and its answers go back in updatedInput', () => {
  const input = { questions: [
    { question: 'Which toppings?', header: 'Toppings', multiSelect: true, options: [{ label: 'Cheese', description: 'Classic' }, { label: 'Ham' }] },
    { question: 'Which size?', header: 'Size', multiSelect: false, options: [{ label: 'Small' }, { label: 'Large' }] },
  ] };
  const [ask] = decodeAll([{ type: 'control_request', request_id: 'a1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 't3', input, requires_user_interaction: true } }]);
  assert.equal(ask.request.kind, 'questions');
  assert.deepEqual(ask.request.questions.map(q => [q.question, q.header, q.multiSelect, q.options.map(o => o.label)]),
    [['Which toppings?', 'Toppings', true, ['Cheese', 'Ham']], ['Which size?', 'Size', false, ['Small', 'Large']]]);
  const r = protocol.answerCommand('a1', { answers: { 'Which toppings?': 'Cheese, Ham', 'Which size?': ' Medium ', 'Not asked': 'x' } }, ask.request).response.response;
  assert.equal(r.behavior, 'allow');
  assert.deepEqual(r.updatedInput, { ...input, answers: { 'Which toppings?': 'Cheese, Ham', 'Which size?': 'Medium' } },
    'the input unchanged, the answers beside it — only for questions that were asked');
  for (const answer of [{ cancelled: true }, { answers: {} }, {}]) {
    assert.equal(protocol.answerCommand('a1', answer, ask.request).response.response.behavior, 'deny', JSON.stringify(answer));
  }
  const [odd] = decodeAll([{ type: 'control_request', request_id: 'a2', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: 'nope' } } }]);
  assert.equal(odd.request.kind, 'approval', 'a question the card cannot draw is still asked, as an approval');
});

// #704, in the shapes read from the CLI's own AskUserQuestion handling on 2.1.283.
test('a note and the picked option\'s preview go back as annotations; "chat about this" declines with the text', () => {
  const input = { questions: [
    { question: 'Which route?', header: 'Route', multiSelect: false, options: [{ label: 'A', preview: '# A\ncode' }, { label: 'B' }] },
    { question: 'Which size?', header: 'Size', multiSelect: false, options: [{ label: 'Small' }, { label: 'Large' }] },
  ] };
  const [ask] = decodeAll([{ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input } }]);
  const r = protocol.answerCommand('q1', { answers: { 'Which route?': 'A', 'Which size?': 'Large' }, notes: { 'Which size?': ' for the demo ' } }, ask.request).response.response;
  assert.equal(r.behavior, 'allow');
  assert.deepEqual(r.updatedInput.annotations, {
    'Which route?': { preview: '# A\ncode' },
    'Which size?': { notes: 'for the demo' },
  });
  const plain = protocol.answerCommand('q1', { answers: { 'Which route?': 'B', 'Which size?': 'Small' } }, ask.request).response.response;
  assert.equal(plain.updatedInput.annotations, undefined, 'nothing to say beside the answers, nothing sent');

  const chat = protocol.answerCommand('q1', { answers: { 'Which route?': 'A', 'Which size?': '' }, notes: {}, chat: 'Neither — what about C?' }, ask.request).response.response;
  assert.equal(chat.behavior, 'deny');
  assert.match(chat.message, /^The user wants to clarify these questions\./);
  assert.match(chat.message, /- "Which route\?"\n {2}Answer: A/);
  assert.match(chat.message, /- "Which size\?"\n {2}\(No answer provided\)/);
  assert.match(chat.message, /What the user wrote:\nNeither — what about C\?$/);
});

// #724, in the shape measured on 2.1.289: the line with the call's result carries what was asked and chosen,
// as `tool_use_result` on the stream and `toolUseResult` in the transcript, under the same uuid.
test('an answered question is the user\'s entry after its call, live and reopened alike, under one key (#724)', () => {
  const asked = { questions: [
    { question: 'Pick a colour', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] },
    { question: 'Pick fruits', header: 'Fruits', multiSelect: true, options: [{ label: 'Apple' }, { label: 'Pear' }] },
    { question: 'Skipped one', header: 'Skip', multiSelect: false, options: [{ label: 'X' }] },
  ] };
  const result = { questions: asked.questions, answers: { 'Pick a colour': 'Red', 'Pick fruits': 'Apple, Pear' },
    annotations: { 'Pick a colour': { notes: 'warm\nand bright' }, 'Pick fruits': { preview: 'ignored' } } };
  const call = { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: asked }] } };
  const content = [{ type: 'tool_result', tool_use_id: 't1', content: 'The user answered: …' }];
  const live = decodeAll([call, { type: 'user', uuid: 'u1', tool_use_result: result, message: { role: 'user', content } }]);
  const appends = live.filter(o => o.op === 'append').map(o => o.entry);
  assert.deepEqual(appends.map(protocol.entryKey), ['a1', 'u1', 'u1:answer']);
  const answer = appends[2];
  assert.equal(answer.type, 'user');
  assert.equal(answer.prompt, true, 'the user\'s own input');
  assert.equal(answer.message.content,
    '- Pick a colour → Red\n  - Note: warm\n    and bright\n- Pick fruits → Apple, Pear',
    'in the order asked, a note under its answer, an unanswered question and a preview left out');
  assert.equal(live.findIndex(o => o.op === 'append' && o.entry === answer) > live.findIndex(o => o.op === 'tool' && o.id === 't1'), true);

  const reopened = protocol.conversationEntries([call, { type: 'user', uuid: 'u1', toolUseResult: result, message: { role: 'user', content } }]);
  assert.deepEqual(reopened.map(protocol.entryKey), ['a1', 'u1', 'u1:answer']);
  assert.deepEqual(reopened[2], { ...answer, timestamp: reopened[2].timestamp });

  // A line break in a question stays inside its list item.
  const [, , twoLines] = protocol.conversationEntries([call, { type: 'user', uuid: 'u2', message: { role: 'user', content },
    toolUseResult: { questions: [{ question: 'First line\nsecond line' }], answers: { 'First line\nsecond line': 'Yes' } } }]);
  assert.equal(twoLines.message.content, '- First line\n  second line → Yes');
});

test('a declined or unanswered question draws no answer entry, and neither does a subagent\'s (#724)', () => {
  const content = [{ type: 'tool_result', tool_use_id: 't1', content: 'declined', is_error: true }];
  const declined = { type: 'user', uuid: 'u1', toolUseResult: 'Error: The user wants to clarify these questions.', message: { role: 'user', content } };
  assert.deepEqual(protocol.conversationEntries([declined]).map(protocol.entryKey), ['u1']);
  const empty = { type: 'user', uuid: 'u2', toolUseResult: { questions: [{ question: 'Q' }], answers: {} }, message: { role: 'user', content } };
  assert.deepEqual(protocol.conversationEntries([empty]).map(protocol.entryKey), ['u2']);
  const answered = { questions: [{ question: 'Q' }], answers: { Q: 'A' } };
  const sub = { type: 'user', uuid: 'u3', isSidechain: true, toolUseResult: answered, message: { role: 'user', content } };
  assert.deepEqual(protocol.conversationEntries([sub]), []);
  const subLive = decodeAll([{ type: 'user', uuid: 'u4', parent_tool_use_id: 't0', tool_use_result: answered, message: { role: 'user', content } }]);
  assert.deepEqual(subLive.filter(o => o.op === 'append'), []);
});

test('ExitPlanMode is a plan card: approve lets it start, keep planning ends the turn as kept, not failed', () => {
  const input = { plan: '# Plan\n\n1. Do it', planFilePath: 'plans/x.md' };
  const decoder = protocol.createDecoder();
  const [ask] = decoder.decode({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', tool_use_id: 't4', input } });
  assert.equal(ask.request.kind, 'plan');
  assert.equal(ask.request.plan, input.plan);
  assert.deepEqual(Object.keys(ask.request.answers), ['approve', 'keep'], 'no "approve and accept edits" (#661 E16)');
  assert.deepEqual(protocol.answerCommand('p1', { value: ask.request.answers.approve }, ask.request).response.response,
    { behavior: 'allow', updatedInput: input });
  for (const answer of [{ value: ask.request.answers.keep }, { cancelled: true }]) {
    const r = protocol.answerCommand('p1', answer, ask.request).response.response;
    assert.equal(r.behavior, 'deny');
    assert.equal(r.interrupt, true, 'keep planning ends the turn');
  }
  // Measured: that interrupt ends the turn with the same result a Stop gets.
  decoder.noteSent(protocol.answerCommand('p1', { value: ask.request.answers.keep }, ask.request));
  const ops = decoder.decode({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] result_type=user'] });
  assert.equal(ops[0].level, 'info');
  assert.match(ops[0].text, /Kept planning/);
});

test('the CLI\'s bookkeeping lines are not drawn', () => {
  assert.deepEqual(decodeAll([
    { type: 'user', uuid: 'm', isMeta: true, message: { role: 'user', content: '<local-command-caveat>' } },
    { type: 'rate_limit_event' },
    { type: 'system', subtype: 'status', status: 'requesting' },
    { type: 'system', subtype: 'commands_changed', commands: [] },
  ]), []);
  assert.deepEqual(decodeAll([{ type: 'system', subtype: 'compact_boundary' }]).map(o => o.level), ['info']);
});

// --- commands ---

test('the three send modes map onto Claude\'s priorities', () => {
  assert.equal(protocol.sendCommand({ text: 'a', mode: 'prompt' }).priority, undefined);
  assert.equal(protocol.sendCommand({ text: 'a', mode: 'prompt', busy: true }).priority, undefined, 'a plain line queues by itself');
  assert.equal(protocol.sendCommand({ text: 'a', mode: 'steer' }).priority, 'next');
  assert.equal(protocol.sendCommand({ text: 'a', mode: 'follow_up' }).priority, 'later');
  assert.deepEqual(protocol.sendCommand({ text: 'hi' }).message, { role: 'user', content: 'hi' });
});

test('a turn with images is a content array, text first as the TUI writes it, and a turn without stays a string (#662, #688)', () => {
  const img = { mimeType: 'image/png', data: 'AAAA' };
  const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  assert.deepEqual(protocol.sendCommand({ text: 'what is [Image #1]', images: [img] }).message.content,
    [{ type: 'text', text: 'what is [Image #1]' }, block]);
  const second = { mimeType: 'image/jpeg', data: 'BBBB' };
  assert.deepEqual(protocol.sendCommand({ text: '[Image #1] vs [Image #2]', images: [img, second] }).message.content.slice(1)
    .map(b => b.source.data), ['AAAA', 'BBBB'], 'the images keep their numbered order');
  assert.deepEqual(protocol.sendCommand({ text: '  ', images: [img, img] }).message.content, [block, block],
    'no empty text block beside images alone');
  assert.equal(protocol.sendCommand({ text: 'hi', images: [] }).message.content, 'hi');
  assert.equal(protocol.sendCommand({ text: 'a', mode: 'steer', images: [img] }).priority, 'next', 'images change no priority');
  assert.deepEqual(native().rpc.imageInput, protocol.IMAGE_INPUT, 'the declaration the core and the view read');
  assert.ok(protocol.IMAGE_INPUT.types.includes('image/png') && protocol.IMAGE_INPUT.maxBytes > 0);
});

test('a control response answers the request it names, success and refusal alike', () => {
  assert.deepEqual(protocol.responseOf({ type: 'control_response', response: { subtype: 'success', request_id: 'x', response: { a: 1 } } }),
    { id: 'x', payload: { success: true, data: { a: 1 } } });
  assert.deepEqual(protocol.responseOf({ type: 'control_response', response: { subtype: 'error', request_id: 'x', error: 'no' } }),
    { id: 'x', payload: { success: false, error: 'no' } });
  assert.equal(protocol.responseOf({ type: 'assistant' }), null);
  assert.equal(protocol.abortCommand('i').request.subtype, 'interrupt');
  assert.equal(protocol.commandsCommand('c').request.subtype, 'initialize');
  assert.deepEqual(protocol.commandsFromResponse({ data: { commands: [{ name: 'compact', description: 'a\n  b' }, { name: '' }, null] } }),
    [{ name: 'compact', description: 'a b', kind: 'command', arguments: false }]);
});

test('an attach reads the conversation\'s own lines out of the transcript', () => {
  const lines = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [] } },
    { type: 'user', uuid: 'm1', isMeta: true, message: { role: 'user', content: 'meta' } },
    { type: 'assistant', uuid: 's1', isSidechain: true, message: { role: 'assistant', content: [] } },
    { type: 'attachment', uuid: 'x1' },
    { type: 'queue-operation' },
    { type: 'user', message: { role: 'user', content: 'no uuid' } },
  ];
  assert.deepEqual(protocol.conversationEntries(lines).map(l => l.uuid), ['u1', 'a1']);
});

test('a skill the model loads is more output of its Skill call, live and reopened alike, never a user entry (#710)', () => {
  // The shapes measured on Claude Code 2.1.284: the stream sends the skill's text as an `isSynthetic` user line
  // naming no call, right after the call's result; the transcript keeps it under the same uuid with `isMeta`
  // and `sourceToolUseID`.
  const body = 'Base directory for this skill: <home>/skills/demo\n\n# Demo\nDo the thing.';
  const call = { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'sk1', name: 'Skill', input: { skill: 'demo' } }] } };
  const result = { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sk1', content: 'Launching skill: demo' }] } };
  const expected = [{ type: 'tool_result', tool_use_id: 'sk1', content: `Launching skill: demo\n\n${body}` }];

  const live = decodeAll([call, result,
    { type: 'user', uuid: 'k1', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: body }] } }]);
  const appended = live.filter(o => o.op === 'append').map(o => o.entry);
  assert.equal(appended.length, 3);
  assert.equal(appended[2].uuid, 'k1');
  assert.deepEqual(appended[2].message.content, expected);

  const reopened = protocol.conversationEntries([call, result,
    { type: 'user', uuid: 'k1', isMeta: true, sourceToolUseID: 'sk1', message: { role: 'user', content: [{ type: 'text', text: body }] } }]);
  assert.deepEqual(reopened.map(e => e.uuid), ['a1', 'r1', 'k1'], 'the same key the live stream used');
  assert.deepEqual(reopened[2].message.content, expected);
});

test('a skill\'s text pairs across stream and system lines, and each of two calls gets its own (#710)', () => {
  const result = (id) => ({ type: 'user', uuid: `r-${id}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Launching skill: ${id}` }] } });
  const synth = (uuid, text) => ({ type: 'user', uuid, isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text }] } });
  const appended = decodeAll([
    { type: 'assistant', uuid: 'a0', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 's1', name: 'Skill', input: {} }, { type: 'tool_use', id: 's2', name: 'Skill', input: {} }] } },
    result('s1'), result('s2'),
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'system', subtype: 'status', status: 'requesting' },
    synth('k1', 'one'), synth('k2', 'two'),
  ]).filter(o => o.op === 'append').map(o => o.entry);
  assert.deepEqual(appended.slice(3).map(e => [e.uuid, e.message.content[0].tool_use_id, e.message.content[0].content]),
    [['k1', 's1', 'Launching skill: s1\n\none'], ['k2', 's2', 'Launching skill: s2\n\ntwo']]);
});

test('a failed Skill call, or the turn ending, leaves the next synthetic line alone (#710)', () => {
  const skill = { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: {} }] } };
  const synth = { type: 'user', uuid: 'k1', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: 'x' }] } };
  const failed = decodeAll([skill,
    { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'no', is_error: true }] } },
    synth]).filter(o => o.op === 'append').map(o => o.entry);
  assert.deepEqual(failed[2].message.content, [{ type: 'text', text: 'x' }]);
  const ended = decodeAll([skill,
    { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'ok' }] } },
    { type: 'result', subtype: 'error_during_execution', is_error: true },
    synth]).filter(o => o.op === 'append').map(o => o.entry);
  assert.deepEqual(ended[2].message.content, [{ type: 'text', text: 'x' }]);
});

test('the user\'s own line is marked as a prompt, live and reopened; what the CLI injected is not (#709)', () => {
  // Live: the line played back (`isReplay`) is the user's; a tool result is not.
  const live = decodeAll([
    { type: 'user', uuid: 'u1', isReplay: true, message: { role: 'user', content: 'hello' } },
    { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } },
  ]).filter(o => o.op === 'append').map(o => [o.entry.uuid, o.entry.prompt === true]);
  assert.deepEqual(live, [['u1', true], ['r1', false]]);
  // Reopened: the shapes measured in real transcripts.
  const reopened = protocol.conversationEntries([
    { type: 'user', uuid: 'p1', promptSource: 'typed', message: { role: 'user', content: 'typed' } },
    { type: 'user', uuid: 'p2', promptSource: 'queued', message: { role: 'user', content: [{ type: 'text', text: 'queued' }] } },
    { type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/model</command-name>\n<command-message>model</command-message>' } },
    { type: 'user', uuid: 's1', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued' } },
    { type: 'user', uuid: 'x1', interruptedMessageId: 'm', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    { type: 'user', uuid: 'y1', promptSource: 'system', message: { role: 'user', content: 'injected' } },
  ]).map(e => [e.uuid, e.prompt === true]);
  assert.deepEqual(reopened, [['p1', true], ['p2', true], ['c1', true], ['s1', false], ['x1', false], ['y1', false]]);
});

test('a compaction\'s summary is a note, live and reopened, and its played-back output is no prompt (#712)', () => {
  // The shapes measured on Claude Code 2.1.284 with `/compact`.
  const summary = 'This session is being continued from a previous conversation.';
  const live = decodeAll([
    { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } },
    { type: 'user', uuid: 'cs1', isReplay: false, isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: summary }] } },
    { type: 'user', uuid: 'out1', isReplay: true, message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' } },
    { type: 'result', subtype: 'success', is_error: false },
  ]);
  const appended = live.filter(o => o.op === 'append').map(o => o.entry);
  assert.deepEqual(appended.map(e => [e.uuid, e.type, e.prompt === true]), [['cs1', 'transcript-meta', false], ['out1', 'user', false]]);
  assert.equal(appended[0].label, 'Compaction summary');
  assert.equal(appended[0].content, summary);
  assert.equal(protocol.entryKey(appended[0]), 'cs1');

  const reopened = protocol.conversationEntries([
    { type: 'system', subtype: 'compact_boundary', uuid: 'b1', content: 'Conversation compacted' },
    { type: 'user', uuid: 'cs1', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: summary } },
  ]);
  assert.deepEqual(reopened.map(e => [e.uuid, e.type, e.content]), [['cs1', 'transcript-meta', summary]]);

  // A synthetic line after the turn ended is not taken for a summary.
  const later = decodeAll([
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'result', subtype: 'success', is_error: false },
    { type: 'user', uuid: 'x', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: 'x' }] } },
  ]).filter(o => o.op === 'append').map(o => o.entry.type);
  assert.deepEqual(later, ['user']);
});

test('a synthetic line that follows no Skill result is left as it was', () => {
  const bash = { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } };
  const res = { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } };
  const synth = { type: 'user', uuid: 'k1', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: 'x' }] } };
  const appended = decodeAll([bash, res, synth]).filter(o => o.op === 'append').map(o => o.entry);
  assert.deepEqual(appended[2].message.content, [{ type: 'text', text: 'x' }]);
  const reopened = protocol.conversationEntries([bash, res,
    { type: 'user', uuid: 'k1', isMeta: true, sourceToolUseID: 't1', message: { role: 'user', content: 'x' } }]);
  assert.deepEqual(reopened.map(e => e.uuid), ['a1', 'r1'], 'another tool\'s meta line stays out');
});

test('a reopened session shows a local command\'s output as the same entry the live stream sent (#681)', () => {
  // The shapes measured on Claude Code 2.1.283 for `/cost`: the stream sends a synthetic assistant line, the
  // transcript keeps a system/local_command line under the same uuid.
  const text = 'You are currently using your subscription to power your Claude Code usage';
  const transcript = [
    { type: 'user', uuid: 'cav', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat: …</local-command-caveat>' } },
    { type: 'user', uuid: 'cmd', message: { role: 'user', content: '<command-name>/usage</command-name>\n            <command-message>usage</command-message>\n            <command-args></command-args>' } },
    { type: 'system', subtype: 'local_command', uuid: 'out', level: 'info', isMeta: false, timestamp: '2026-09-27T21:00:00.000Z', content: `<local-command-stdout>${text}</local-command-stdout>` },
    { type: 'system', subtype: 'local_command', uuid: 'empty', content: '<local-command-stdout></local-command-stdout>' },
    { type: 'system', subtype: 'local_command', content: `<local-command-stdout>${text}</local-command-stdout>` },
    { type: 'system', subtype: 'compact_boundary', uuid: 'cb', content: 'Conversation compacted' },
    { type: 'system', subtype: 'local_command', uuid: 'meta', isMeta: true, content: `<local-command-stdout>${text}</local-command-stdout>` },
    { type: 'system', subtype: 'local_command', uuid: 'side', isSidechain: true, content: `<local-command-stdout>${text}</local-command-stdout>` },
    // A command typed while a turn ran is written as a system line of command markup; it reads as typed.
    { type: 'system', subtype: 'local_command', uuid: 'queued', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>' },
  ];
  const attached = protocol.conversationEntries(transcript);
  assert.deepEqual(attached.map(e => e.uuid), ['cmd', 'out', 'queued'],
    'the empty output, the uuid-less, meta and sidechain lines and other system lines stay out');
  assert.equal(attached[2].type, 'user');
  assert.equal(attached[2].message.content, '/model opus');

  const live = decodeAll([
    { type: 'assistant', uuid: 'out', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] } },
  ]).find(o => o.op === 'append').entry;
  const reopened = attached[1];
  assert.equal(protocol.entryKey(reopened), protocol.entryKey(live), 'one key, so the view never draws it twice');
  assert.equal(reopened.type, live.type);
  assert.deepEqual(reopened.message.content, live.message.content);
  assert.equal(reopened.message.model, '<synthetic>');
});

test('slash-command markup reads as the command, and a local command\'s output as its text (#680)', () => {
  const clear = '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>';
  const lines = [
    { type: 'user', uuid: 'c1', message: { role: 'user', content: clear } },
    { type: 'user', uuid: 'o1', message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } },
    { type: 'user', uuid: 'o2', message: { role: 'user', content: '<local-command-stdout>Total cost: $0.01</local-command-stdout>' } },
    { type: 'user', uuid: 'c2', message: { role: 'user', content: [{ type: 'text', text: '<command-name>/model</command-name><command-args>opus</command-args>' }] } },
    { type: 'user', uuid: 'p1', message: { role: 'user', content: 'what does <command-name> mean?' } },
    { type: 'user', uuid: 'c3', message: { role: 'user', content: '<command-name>/clear</command-name><command-message>clear</command-message><command-args/>' } },
    { type: 'user', uuid: 'e1', message: { role: 'user', content: '<local-command-stderr>Error: unknown model</local-command-stderr>' } },
    { type: 'user', uuid: 'c4', message: { role: 'user', content: '<command-name>/cost</command-name><local-command-stdout>Total cost: $0.02</local-command-stdout>' } },
    // A skill invocation expands into markup AND prose: that is a real prompt, and it is left as written.
    { type: 'user', uuid: 's1', message: { role: 'user', content: '<command-name>/review</command-name>\nReview the diff for bugs.' } },
  ];
  const shown = protocol.conversationEntries(lines);
  assert.deepEqual(shown.map(l => [l.uuid, l.message.content]), [
    ['c1', '/clear'],
    // An empty output says nothing and is left out.
    ['o2', 'Total cost: $0.01'],
    // A command the user gave arguments to reads as they typed it, arguments included.
    ['c2', '/model opus'],
    ['p1', 'what does <command-name> mean?'],
    // The self-closing form of an empty argument list.
    ['c3', '/clear'],
    // An error a local command printed reads as its text, like its output does.
    ['e1', 'Error: unknown model'],
    // A line carrying the command and what it printed keeps both.
    ['c4', '/cost\nTotal cost: $0.02'],
    ['s1', '<command-name>/review</command-name>\nReview the diff for bugs.'],
  ]);
  assert.equal(lines[0].message.content, clear, 'the transcript line itself is not changed');

  // The live stream draws the same line the same way, and an empty output appends nothing.
  const ops = decodeAll([
    { type: 'user', uuid: 'c1', message: { role: 'user', content: clear } },
    { type: 'user', uuid: 'o1', message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } },
  ]);
  const appended = ops.filter(o => o.op === 'append').map(o => o.entry.message.content);
  assert.deepEqual(appended, ['/clear']);
});

test('entriesFromTranscript finds the session under the project\'s folder, and by its id when the folder differs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-claude-native-'));
  const before = claude._roots();
  claude.setRoots([root]);
  t.after(() => { claude.setRoots(before); fs.rmSync(root, { recursive: true, force: true }); });
  const cwd = path.join(root, 'work', 'proj');
  const line = (uuid) => JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: uuid } });
  fs.mkdirSync(path.join(root, encodeProjectPath(cwd)), { recursive: true });
  fs.writeFileSync(path.join(root, encodeProjectPath(cwd), 's1.jsonl'), line('u1') + '\n{"half\n');
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.writeFileSync(path.join(root, 'elsewhere', 's2.jsonl'), line('u2') + '\n');
  const read = native().rpc.entriesFromTranscript;
  assert.deepEqual((await read({ sessionId: 's1', cwd })).map(e => e.uuid), ['u1'], 'a half-written line is skipped');
  assert.deepEqual((await read({ sessionId: 's2', cwd })).map(e => e.uuid), ['u2']);
  assert.deepEqual(await read({ sessionId: 'nothing-yet', cwd }), [], 'no file yet is an empty conversation');
  assert.deepEqual((await read({ sessionId: 'fork-1', cwd, forkFrom: 's1' })).map(e => e.uuid), ['u1'],
    'a fork with no file of its own yet reads the one it was forked from');
  fs.writeFileSync(path.join(root, encodeProjectPath(cwd), 'fork-1.jsonl'), line('u1') + '\n' + line('u3') + '\n');
  assert.deepEqual((await read({ sessionId: 'fork-1', cwd, forkFrom: 's1' })).map(e => e.uuid), ['u1', 'u3'],
    'once the fork has written its file, that file answers');
});

// --- the descriptor ---

test('the launch: print mode, stream-json both ways, approvals over the pipe, the marker, no shell', () => {
  const d = native();
  const fresh = d.buildLaunch({ cwd: '/p', sessionId: 'abc', options: {} });
  assert.deepEqual(fresh.args.slice(0, 10), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio']);
  assert.ok(fresh.args.includes('--session-id=abc'), 'a value is joined to its flag');
  assert.equal(fresh.spawnMode, 'argv');
  assert.deepEqual(fresh.env, { [TRANSPORT_ENTRYPOINT_ENV]: TRANSPORT_ENTRYPOINT });
  assert.ok(d.buildLaunch({ sessionId: 'abc', resume: true }).args.includes('--resume=abc'));
  const fork = d.buildLaunch({ sessionId: 'new', forkFrom: 'old' }).args;
  assert.ok(fork.includes('--resume=old') && fork.includes('--fork-session'));
  assert.ok(fork.includes('--session-id=new'), 'a fork is started under the id its tab is keyed on (measured: the CLI takes it)');
});

test('the permission mode is sent only when chosen, and the skip flag is not offered (#653 E6)', () => {
  const d = native();
  const argsFor = (options) => d.buildLaunch({ sessionId: 's', options }).args;
  assert.ok(!argsFor({}).includes('--permission-mode'), 'unset: Claude\'s own defaultMode applies');
  assert.ok(!argsFor({ permissionMode: 'default' }).includes('--permission-mode'));
  const planned = argsFor({ permissionMode: 'plan', model: 'haiku' });
  assert.deepEqual(planned.slice(planned.indexOf('--permission-mode'), planned.indexOf('--permission-mode') + 4), ['--permission-mode', 'plan', '--model', 'haiku']);
  assert.ok(!argsFor({ permissionMode: 'dangerously-skip', dangerouslySkipPermissions: true }).some(a => /dangerously|permission-mode/.test(a)));
  const field = d.configFields.find(f => f.id === 'permissionMode');
  assert.ok(!field.choices.includes('dangerously-skip'));
  assert.equal(field.default, 'default');
  assert.ok(!d.configFields.some(f => f.appliesAt === 'spawn'), 'nothing here is applied at a terminal spawn site');
});

test('prompt suggestions are on unless switched off, and a suggestion becomes the app\'s op (#693)', () => {
  const d = native();
  const argsFor = (options) => d.buildLaunch({ sessionId: 's', options }).args;
  assert.ok(argsFor({}).includes('--prompt-suggestions'), 'on by default');
  assert.ok(!argsFor({ promptSuggestionsOff: true }).includes('--prompt-suggestions'), 'an explicit off leaves it out');
  const field = d.configFields.find(f => f.id === 'promptSuggestionsOff');
  assert.equal(field.default, false, 'an opt-out whose default sends nothing');
  assert.deepEqual(protocol.createDecoder().decode({ type: 'prompt_suggestion', suggestion: ' write it ', uuid: 'x', session_id: '' }).filter(o => o.op === 'suggestion'), [{ op: 'suggestion', text: 'write it' }]);
  assert.deepEqual(protocol.createDecoder().decode({ type: 'prompt_suggestion', suggestion: '', session_id: '' }).filter(o => o.op === 'suggestion'), []);
});

test('the terminal backend\'s argv options are offered and sent; the two spawn-site ones are not (#685)', () => {
  const d = native();
  const argsFor = (options) => d.buildLaunch({ sessionId: 's', options }).args;
  const ids = d.configFields.map(f => f.id);
  for (const id of ['worktree', 'worktreeName', 'chrome', 'addDirs', 'restricted', 'autocompact']) assert.ok(ids.includes(id), id);
  for (const id of ['mcpEmulation', 'afkTimeoutSec']) assert.ok(!ids.includes(id), `${id} needs a terminal`);
  assert.equal(d.configFields.find(f => f.id === 'worktreeName').requires, 'worktree', 'Claude\'s declaration, taken as it is');
  assert.doesNotMatch(d.configFields.find(f => f.id === 'restricted').description, /attention hook/, 'no hook to lose on a pipe');
  assert.deepEqual(argsFor({}).filter(a => /worktree|chrome|add-dir|restricted|autocompact/.test(a)), [], 'nothing unchosen is sent');
  assert.ok(argsFor({ worktree: true }).includes('--worktree'));
  assert.ok(argsFor({ worktree: true, worktreeName: 'b1' }).includes('--worktree=b1'));
  assert.ok(!argsFor({ worktreeName: 'b1' }).some(a => a.startsWith('--worktree')), 'a name alone means nothing');
  assert.deepEqual(argsFor({ addDirs: 'a, b' }).filter(a => a.startsWith('--add-dir')), ['--add-dir=a', '--add-dir=b']);
  const all = argsFor({ chrome: true, restricted: true, autocompact: '500k' });
  for (const flag of ['--chrome', '--restricted', '--autocompact=500k']) assert.ok(all.includes(flag), flag);
});

test('the descriptor drives Claude\'s rows: the marker, the trust gate, off by default, Claude\'s store answers', () => {
  const d = native();
  assert.equal(d.transport, 'rpc');
  assert.equal(d.transcriptsOf, 'claude');
  assert.equal(d.trustBeforeStart, true);
  assert.equal(d.rpc.sendAcknowledged, false);
  assert.equal(d.rpc.stateCommand, undefined, 'the stream names the session itself');
  assert.equal(d.rpc.gracefulStopMs, undefined, 'measured: nothing is lost on an immediate stop');
  for (const k of ['projectTrust', 'transcriptPathFor', 'deleteSessions', 'rewriteProjectPath', 'resolveLineage', 'contextWindow', 'PARSER_SCHEMA_VERSION', 'cliHomeEnv', 'listResources']) {
    assert.strictEqual(d[k], claude[k], `${k} is Claude's own answer, forwarded`);
  }
  for (const k of ['supportsLiveRebinding', 'buildLiveBinding', 'projectMeta', 'usage', 'liveOwnersCached', 'discoverSessions', 'parseSession']) {
    assert.ok(!d[k], `${k} stays with the terminal backend`);
  }
  assert.equal(backends.isEnabled(d, {}), false, 'off until the user switches it on');
  try {
    backends.init({ getGlobalSettings: () => ({ backendEnabled: { 'claude-native': true } }) });
    assert.equal(backends.openerFor({ backendId: 'claude', transport: 'rpc' }), 'claude-native');
    assert.equal(backends.openerFor({ backendId: 'claude' }), 'claude');
    backends.init({ getGlobalSettings: () => ({ backendEnabled: { 'claude-native': false } }) });
    assert.equal(backends.openerFor({ backendId: 'claude', transport: 'rpc' }), 'claude', 'switched off, the row is the terminal backend\'s');
  } finally {
    backends.init({ getGlobalSettings: () => ({}) });
  }
});

// "Every part of the protocol is handed to the core" is one loop over every runtime-driven backend now, in
// `test/runtime-backends.test.js` (#664).

// What hangs off `launch.command === 'claude'` in the spawn path is about a terminal, and claude-native's
// command IS `claude`. A source check, because node-pty is required at module load and there is no seam that
// reaches the spawn site (the same answer `spawn-first-resize.test.js` gives).
test('spawn.js gives a pipe-driven session no MCP bridge, no OSC-title heuristic and no AFK variable', () => {
  const { stripComments } = require('./helpers/strip-comments');
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js'), 'utf8'));
  assert.match(src, /const isClaudeBinary = launch\.command === 'claude' && !backend\.transport;/);
  assert.match(src, /if \(!backend\.transport\) \{\s*const g = \(\(ctx\.getSetting\('global'\)/, 'the AFK block is skipped for a piped child (#653 E11)');
});

// --- the version floor ---

test('a Claude Code older than the one this was measured against is refused; one that cannot be read is not', async (t) => {
  assert.deepEqual(version.parseVersion('2.1.283 (Claude Code)'), [2, 1, 283]);
  assert.equal(version.parseVersion('nonsense'), null);
  assert.equal(version.olderThan([2, 1, 282]), true);
  assert.equal(version.olderThan([2, 1, 283]), false);
  assert.equal(version.olderThan([2, 2, 0]), false);
  assert.equal(version.olderThan([1, 99, 999]), true);

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cn-ver-')), 'claude.exe');
  fs.writeFileSync(file, 'x');
  t.after(() => { version.resetCache(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  let runs = 0;
  const run = (out, status = 0) => async () => { runs += 1; return { status, stdout: out }; };
  version.resetCache();
  assert.deepEqual(await version.installedVersion(file, { run: run('2.1.300 (Claude Code)') }), [2, 1, 300]);
  assert.deepEqual(await version.installedVersion(file, { run: run('9.9.9') }), [2, 1, 300], 'an answer is kept while the binary is the same file');
  assert.equal(runs, 1);
  fs.writeFileSync(file, 'xy');
  assert.deepEqual(await version.installedVersion(file, { run: run('2.1.301') }), [2, 1, 301], 'a changed binary is asked again');
  version.resetCache();
  assert.equal(await version.installedVersion(file, { run: run('', 1) }), null, 'a failed probe asserts nothing');
});

// F4 of the #660 review: `list()` asks every registered backend's probe on the scan path, switched on or not,
// so the probe it gets may not start a child. Only the spawn path's `{ launch: true }` reaches the version.
test('the registry\'s probe walks PATH only; the version is asked only for a launch', async (t) => {
  const d = native();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cn-probe-')), process.platform === 'win32' ? 'claude.exe' : 'claude');
  fs.writeFileSync(file, 'x');
  const { findOnPath } = require('../src/backends/file-store');
  const realPath = process.env.PATH;
  process.env.PATH = path.dirname(file);
  t.after(() => {
    process.env.PATH = realPath;
    version.resetCache();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
  assert.equal(String(findOnPath('claude')).toLowerCase(), file.toLowerCase(), 'the stand-in is what the probe finds (PATHEXT spells the extension its own way)');
  version.resetCache();
  assert.deepEqual(d.probe(), { ok: true }, 'the registry\'s answer is synchronous');
  // Nothing was asked: the version cache is still empty, so the next read runs its child.
  let runs = 0;
  await version.installedVersion(file, { run: async () => { runs += 1; return { status: 1, stdout: '' }; } });
  assert.equal(runs, 1, 'the registry\'s probe started no child');
  version.resetCache();
  const launch = d.probe({ launch: true });
  assert.equal(typeof launch.then, 'function', 'a launch gets a Promise');
  assert.deepEqual(await launch, { ok: true }, 'a version that could not be read does not refuse the launch');
});

// #691, in the shapes measured on 2.1.283 (spec 32, "Background tasks and session figures").
test('background tasks: the running list is Claude\'s own, a start adds the call behind it, the notice replaces the tags', () => {
  const d = protocol.createDecoder();
  const all = (line) => d.decode(line);
  all({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }] } });
  all({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Command running in background with ID: b1. Output is being written to: /tmp/x/tasks/b1.output' }] } });
  let tasks = all({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'Dev server' }] });
  assert.deepEqual(tasks.map(o => o.op), ['tasks']);
  tasks = all({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_1', description: 'Dev server', task_type: 'local_bash', is_backgrounded: true });
  const [t1] = tasks[0].tasks;
  assert.equal(t1.kind, 'shell');
  assert.equal(t1.detail, 'npm run dev', 'the command the call ran');
  assert.equal(t1.toolUseId, 'toolu_1');
  assert.ok(Number.isFinite(t1.startedAt));
  assert.equal(d.taskOutputFile('b1'), '/tmp/x/tasks/b1.output', 'readable while it still runs');
  // The live notice comes from the system line: the injected user line is not sent on the pipe (measured).
  const live = all({ type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_1', status: 'completed', output_file: '/tmp/x/tasks/b1-final.output', summary: 'Background command "Dev server" completed (exit code 0)' });
  assert.equal(d.taskOutputFile('b1'), '/tmp/x/tasks/b1-final.output', 'the notification\'s file wins');
  assert.equal(live.length, 1);
  assert.equal(live[0].entry.type, 'task-notice');
  assert.deepEqual({ ...live[0].entry._task, tokens: undefined, toolUses: undefined, durationMs: undefined }, {
    id: 'b1', toolUseId: 'toolu_1', kind: 'shell', subagentId: null, status: 'completed', description: 'Dev server',
    summary: 'Background command "Dev server" completed (exit code 0)', result: '', exitCode: 0,
    tokens: undefined, toolUses: undefined, durationMs: undefined,
    // #725: the notice names its file for the CORE, which takes it off before the view sees the entry.
    outputFile: '/tmp/x/tasks/b1-final.output',
  });
  assert.deepEqual(all({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })[0].tasks, []);
  const injected = {
    type: 'user', uuid: 'u3', origin: { kind: 'task-notification' },
    message: { role: 'user', content: '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>/tmp/x</output-file>\n<status>completed</status>\n<summary>Background command "Dev server" completed (exit code 0)</summary>\n</task-notification>' },
  };
  assert.deepEqual(all(injected), [], 'the injected line for a task already drawn is not drawn again');
  // A decoder that never saw the system line (a line replayed on its own) draws it from the user line, keyed.
  const alone = protocol.createDecoder().decode(injected);
  assert.equal(alone[0].entry.type, 'task-notice');
  assert.equal(alone[0].entry.uuid, 'u3');
  // One key for the live notice and the one read back, so an attach neither loses nor doubles it.
  assert.equal(protocol.entryKey(live[0].entry), 'task-notice:b1');
  assert.equal(protocol.entryKey(alone[0].entry), 'task-notice:b1');
  assert.equal(protocol.entryKey({ type: 'user', uuid: 'u9' }), 'u9', 'every other entry keeps its uuid');
});

// #695, measured on 2.1.283: the task id of a `local_agent` task IS the agentId of its subagent transcript.
test('an agent task names its subagent, live and in its notice; a shell names none', () => {
  const d = protocol.createDecoder();
  d.decode({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { subagent_type: 'general-purpose', run_in_background: true } }] } });
  d.decode({ type: 'system', subtype: 'task_started', task_id: 'a276f270c03197f1c', tool_use_id: 'toolu_a', description: 'bg date', task_type: 'local_agent', is_backgrounded: true });
  const [t] = d.decode({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a276f270c03197f1c', task_type: 'local_agent', description: 'bg date' }] })[0].tasks;
  assert.equal(t.kind, 'agent');
  assert.equal(t.subagentId, 'a276f270c03197f1c');
  const [live] = d.decode({ type: 'system', subtype: 'task_notification', task_id: 'a276f270c03197f1c', tool_use_id: 'toolu_a', status: 'completed', summary: 'done' });
  assert.equal(live.entry._task.subagentId, 'a276f270c03197f1c');
  const shell = protocol.createDecoder().decode({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'x' }] })[0].tasks[0];
  assert.equal(shell.subagentId, null);
});

// #768, measured on 2.1.293: a foreground agent gets `task_started` (`is_backgrounded: false`) and a `task_updated`
// that ends it, but never a place in `background_tasks_changed`.
test('a foreground agent is counted from its start to its end, beside the background list', () => {
  const d = protocol.createDecoder();
  d.decode({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'Dev server' }] });
  d.decode({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_f', name: 'Agent', input: { subagent_type: 'verifier' } }] } });
  const start = d.decode({ type: 'system', subtype: 'task_started', task_id: 'af1', tool_use_id: 'toolu_f', description: 'Review', subagent_type: 'verifier', task_type: 'local_agent', is_backgrounded: false });
  assert.deepEqual(start.map(o => o.op), ['tasks']);
  assert.deepEqual(start[0].tasks.map(t => [t.id, t.kind]), [['b1', 'shell'], ['af1', 'agent']]);
  const [fg] = start[0].tasks.slice(-1);
  assert.equal(fg.description, 'Review');
  assert.equal(fg.subagentId, 'af1', 'Open finds its transcript');
  assert.equal(fg.toolUseId, 'toolu_f');
  // The background list changing keeps it.
  const list = d.decode({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.deepEqual(list[0].tasks.map(t => t.id), ['af1']);
  assert.deepEqual(d.decode({ type: 'system', subtype: 'task_progress', task_id: 'af1' }), [], 'progress changes nothing');
  const end = d.decode({ type: 'system', subtype: 'task_updated', task_id: 'af1', patch: { status: 'completed' } });
  assert.deepEqual(end.map(o => o.op), ['tasks']);
  assert.deepEqual(end[0].tasks, []);
  // The notification after it still draws the notice, and no second list.
  const notice = d.decode({ type: 'system', subtype: 'task_notification', task_id: 'af1', tool_use_id: 'toolu_f', status: 'completed', summary: 'ok' });
  assert.deepEqual(notice.map(o => o.op), ['append']);
  // A background task's own `task_updated` is not read: its end is the list shrinking.
  assert.deepEqual(d.decode({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'completed' } }), []);
});

test('a stopped foreground agent drops out, and so does one whose end never came once its turn is over', () => {
  const d = protocol.createDecoder();
  const started = (id) => d.decode({ type: 'system', subtype: 'task_started', task_id: id, description: id, task_type: 'local_agent', is_backgrounded: false });
  started('k1');
  // Measured: `stop_task` on a foreground agent answers `killed`, then a `stopped` notification.
  assert.deepEqual(d.decode({ type: 'system', subtype: 'task_updated', task_id: 'k1', patch: { status: 'killed' } })[0].tasks, []);
  // A notification alone ends it too.
  started('n1');
  const viaNotice = d.decode({ type: 'system', subtype: 'task_notification', task_id: 'n1', status: 'completed', summary: '' });
  assert.deepEqual(viaNotice.map(o => o.op), ['tasks', 'append']);
  assert.deepEqual(viaNotice[0].tasks, []);
  // A foreground agent cannot outlive its turn.
  started('lost');
  const result = d.decode({ type: 'result', subtype: 'success', is_error: false, result: '' });
  const last = result.filter(o => o.op === 'tasks').pop();
  assert.deepEqual(last && last.tasks, []);
  // A turn that ends with nothing running sends no list.
  assert.equal(d.decode({ type: 'result', subtype: 'success', is_error: false, result: '' }).some(o => o.op === 'tasks'), false);
  // A BACKGROUND agent's start is not counted here: it comes with the list.
  assert.deepEqual(d.decode({ type: 'system', subtype: 'task_started', task_id: 'bg', task_type: 'local_agent', is_backgrounded: true }), []);
});

test('an agent\'s notice from the transcript carries its kind and cost, and stop and the figures are control requests', () => {
  const lines = [
    { type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Agent', input: { subagent_type: 'general-purpose' } }] } },
    { type: 'user', uuid: 'b', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>\n<task-id>a9</task-id>\n<tool-use-id>toolu_9</tool-use-id>\n<status>completed</status>\n<summary>Agent "Review" finished</summary>\n<result>all good</result>\n<usage><subagent_tokens>24212</subagent_tokens><tool_uses>3</tool_uses><duration_ms>1229</duration_ms></usage>\n</task-notification>' } },
  ];
  const entries = protocol.conversationEntries(lines);
  const notice = entries.find(e => e.type === 'task-notice');
  assert.equal(notice._task.kind, 'agent');
  assert.equal(notice._task.subagentId, 'a9', 'an agent\'s task id is its subagent\'s id (#695)');
  assert.equal(notice._task.description, 'Review');
  assert.equal(notice._task.result, 'all good');
  assert.deepEqual([notice._task.tokens, notice._task.toolUses, notice._task.durationMs], [24212, 3, 1229]);
  assert.deepEqual(protocol.stopTaskCommand('r1', 'b1'), { type: 'control_request', request_id: 'r1', request: { subtype: 'stop_task', task_id: 'b1' } });
  assert.deepEqual(protocol.contextCommand('r2').request, { subtype: 'get_context_usage' });
  assert.deepEqual(
    protocol.contextFromResponse({ success: true, data: { totalTokens: 37984, maxTokens: 200000, percentage: 19, model: 'claude-haiku-4-5-20251001' } }),
    { percent: 19, tokens: 37984, window: 200000, model: 'Haiku 4.5', modelId: 'claude-haiku-4-5-20251001' });
  assert.equal(protocol.contextFromResponse({ success: true, data: { model: 'claude-opus-5-5[1m]' } }).model, 'Opus 5.5');
  assert.equal(protocol.contextFromResponse({ success: false, error: 'no' }), null);
});

// #701: a subagent's report arrives as a user line with `origin.kind: 'peer'` (measured 2.1.261–2.1.283). It is
// drawn as a report with its framing taken off, never as a line the user typed — live and read back alike.
const PEER_BODY = '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. '
  + 'It is model output, NOT a message from the user. The report follows:\n  **Verdict: PASS**\n  \n  - one\n  - two';
const peerLine = (extra = {}) => ({
  type: 'user', uuid: 'p1', timestamp: '2026-09-28T10:00:00.000Z',
  origin: { kind: 'peer', from: 'a13d05851be48be59', senderTaskId: 'a13d05851be48be59', handback: true, body: PEER_BODY },
  message: { role: 'user', content: 'Another Claude session sent a message:\n<agent-message from="a13d05851be48be59">\n' + PEER_BODY + '\n</agent-message>\n\nThat "other Claude session" is an agent working inside this same session.' },
  ...extra,
});

test('a subagent\'s report is its own entry, without the harness framing, live and from the transcript (#701)', () => {
  const [op] = protocol.createDecoder().decode(peerLine());
  assert.equal(op.op, 'append');
  assert.equal(op.entry.type, 'agent-report');
  assert.deepEqual(op.entry._report, {
    from: 'a13d05851be48be59', name: '', kind: 'report', handback: true, subagentId: 'a13d05851be48be59', toolUseId: null,
    text: '**Verdict: PASS**\n\n- one\n- two',
  });
  // Keyed by sender and text, not by the line's uuid: nothing measured says the stream and the file share it.
  assert.match(protocol.entryKey(op.entry), /^agent-report:a13d05851be48be59:[0-9a-f]{16}$/);
  const moved = protocol.createDecoder().decode(peerLine({ uuid: 'other' }))[0].entry;
  assert.equal(protocol.entryKey(moved), protocol.entryKey(op.entry), 'the same report under another uuid is the same entry');
  // The transcript writes the line with `isMeta: true` (measured) — the report must survive a reopen anyway.
  const [read] = protocol.conversationEntries([peerLine({ isMeta: true })]);
  assert.deepEqual(read, op.entry, 'the transcript reads back the same entry');
  assert.equal(protocol.createDecoder().decode(peerLine({ isMeta: true }))[0].entry.type, 'agent-report', 'live too');
  assert.ok(!JSON.stringify(read).includes('Another Claude session'), 'the wrapping for the model stays out');
});

test('a report on a line with no origin is recognised by its text, and an ordinary user line is not (#701)', () => {
  const bare = peerLine({ origin: undefined });
  const [op] = protocol.createDecoder().decode(bare);
  assert.equal(op.entry.type, 'agent-report');
  assert.equal(op.entry._report.from, 'a13d05851be48be59');
  assert.equal(op.entry._report.subagentId, null, 'no sender task without the origin');
  assert.equal(op.entry._report.text, '**Verdict: PASS**\n\n- one\n- two');
  const [plain] = protocol.createDecoder().decode({ type: 'user', uuid: 'u', message: { role: 'user', content: 'please review this' } });
  assert.equal(plain.entry.type, 'user');
  // A prompt that only BEGINS with the sentence is the user's, not a report.
  const [typed] = protocol.createDecoder().decode({ type: 'user', uuid: 'v', message: { role: 'user', content: 'Another Claude session sent a message: why?' } });
  assert.equal(typed.entry.type, 'user');
});

test('who wrote it: the session\'s agent mid-task, another session, and the call behind a report (#701)', () => {
  const mid = protocol.createDecoder().decode(peerLine({ origin: { kind: 'peer', from: 'a1', senderTaskId: 'a1', name: 'reviewer', body: 'halfway there' } }))[0].entry._report;
  assert.deepEqual([mid.kind, mid.name, mid.text], ['agent', 'reviewer', 'halfway there']);
  const other = protocol.createDecoder().decode(peerLine({ origin: { kind: 'peer', from: 'session-x', body: 'hello' } }))[0].entry._report;
  assert.deepEqual([other.kind, other.subagentId], ['session', null]);
  // Live, the decoder knows which call started the agent, so Open can fall back to it.
  const d = protocol.createDecoder();
  d.decode({ type: 'system', subtype: 'task_started', task_id: 'a13d05851be48be59', tool_use_id: 'toolu_r', description: 'review', task_type: 'local_agent' });
  assert.equal(d.decode(peerLine())[0].entry._report.toolUseId, 'toolu_r');
});

// #696, in the shapes measured on 2.1.283.
test('the permission mode: named by init and by the status line after a change, switched by a control request', () => {
  const d = protocol.createDecoder();
  const init = d.decode({ type: 'system', subtype: 'init', permissionMode: 'default', session_id: 's1' });
  assert.deepEqual(init.find(o => o.op === 'mode').mode, { id: 'default', label: 'manual mode', symbol: '⏸', tone: '' });
  const status = d.decode({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits', session_id: 's1' });
  assert.deepEqual(status, [{ op: 'mode', mode: { id: 'acceptEdits', label: 'accept edits', symbol: '⏵⏵', tone: 'accept' } }]);
  assert.deepEqual(d.decode({ type: 'system', subtype: 'status', status: 'compacting', session_id: 's1' }).map(o => o.op), ['notice'], 'a status without a mode names none');
  assert.deepEqual(protocol.setModeCommand('r2', 'plan'), { type: 'control_request', request_id: 'r2', request: { subtype: 'set_permission_mode', mode: 'plan' } });
  assert.deepEqual(protocol.MODE_CYCLE, ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'], 'the TUI\'s order; dontAsk is never entered');
  assert.deepEqual(protocol.modeInfo('someNewMode'), { id: 'someNewMode', label: 'someNewMode', symbol: '', tone: '' }, 'an unknown mode is shown by its name');
  assert.equal(protocol.modeInfo(undefined), null);
  // A refusal carries the CLI's sentence, and the cycle reads it as "skip this one".
  const refused = protocol.responseOf({ type: 'control_response', response: { subtype: 'error', request_id: 'r4', error: 'Cannot set permission mode to auto: auto mode unavailable for this model', error_code: 'auto_mode_model' } });
  assert.equal(refused.payload.success, false);
});

// #730: the mode before the first turn — the launch's when it sent one, else the settings' default, never `auto`
// from the settings (measured: a model can refuse it and start in `default`).
test('the mode at the start is the launch\'s, else the settings\' default without auto', () => {
  const d = native();
  for (const options of [{}, { permissionMode: 'default' }, { permissionMode: 'plan' }, { permissionMode: 'nonsense' }]) {
    const args = d.buildLaunch({ sessionId: 's', options }).args;
    const flag = args.includes('--permission-mode') ? args[args.indexOf('--permission-mode') + 1] : null;
    assert.equal(d.rpc.launchMode(options), flag, `launchMode agrees with the flag for ${JSON.stringify(options)}`);
  }
  assert.equal(d.rpc.launchMode({ restricted: true }), 'default', 'restricted ignores the settings, so no flag means default');
  assert.equal(d.rpc.launchMode({ restricted: true, permissionMode: 'plan' }), 'plan');
  assert.deepEqual(protocol.configuredModeCommand('r1'), { type: 'control_request', request_id: 'r1', request: { subtype: 'get_settings' } });
  const settings = (defaultMode) => protocol.responseOf({ type: 'control_response', response: { subtype: 'success', request_id: 'r1',
    response: { effective: { permissions: { allow: [], ...(defaultMode ? { defaultMode } : {}) } }, sources: [], applied: {} } } }).payload;
  assert.equal(protocol.configuredModeFromResponse(settings('plan')), 'plan');
  assert.equal(protocol.configuredModeFromResponse(settings('acceptEdits')), 'acceptEdits');
  assert.equal(protocol.configuredModeFromResponse(settings('auto')), 'auto', 'auto is answered; the model decides what it becomes');
  // #753, measured on 2.1.292: a refused `auto` runs in `default`, on Haiku from the settings and from the flag.
  const ctxOf = (modelId) => ({ percent: 1, model: '', modelId });
  assert.equal(protocol.startModeFor('auto', ctxOf('claude-opus-5-5[1m]')), 'auto');
  assert.equal(protocol.startModeFor('auto', ctxOf('claude-sonnet-5-5')), 'auto');
  assert.equal(protocol.startModeFor('auto', ctxOf('claude-haiku-4-5-20251001')), 'default', 'Haiku refuses auto');
  assert.equal(protocol.startModeFor('auto', ctxOf('claude-fable-5-1')), null, 'a family not measured waits for the first turn');
  assert.equal(protocol.startModeFor('auto', null), null, 'no model yet, no guess');
  assert.equal(protocol.startModeFor('plan', null), 'plan', 'any other mode needs no model');
  assert.equal(protocol.startModeFor(null, ctxOf('claude-opus-5-5')), null);
  assert.equal(protocol.configuredModeFromResponse(settings(null)), 'default', 'no default in the settings is the CLI\'s own');
  assert.equal(protocol.configuredModeFromResponse({ success: true, data: {} }), null, 'an answer without settings says nothing');
  assert.equal(protocol.configuredModeFromResponse({ success: false, error: 'refused' }), null);
});

// #725: a card read back from the transcript names its output file — the notification's own, else the one the
// shell call's result named — so the output still opens after a restart. The core takes the path off.
test('a notice read back from the transcript names its output file, from the tag or from the call\'s result', () => {
  const call = (id) => ({ type: 'assistant', uuid: `a-${id}`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'x', run_in_background: true } }] } });
  const result = (id, file) => ({ type: 'user', uuid: `r-${id}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: b. Output is being written to: ${file}` }] } });
  const notice = (task, toolUse, file) => ({
    type: 'user', uuid: `n-${task}`, origin: { kind: 'task-notification' },
    message: { role: 'user', content: `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${toolUse}</tool-use-id>\n${file ? `<output-file>${file}</output-file>\n` : ''}<status>completed</status>\n<summary>Background command "x" completed (exit code 0)</summary>\n</task-notification>` },
  });
  const entries = protocol.conversationEntries([
    call('toolu_1'), result('toolu_1', '/tmp/x/tasks/b1.output'), notice('b1', 'toolu_1', '/tmp/x/tasks/b1-final.output'),
    call('toolu_2'), result('toolu_2', '/tmp/x/tasks/b2.output'), notice('b2', 'toolu_2', ''),
  ]);
  const byId = Object.fromEntries(entries.filter((e) => e.type === 'task-notice').map((e) => [e._task.id, e._task]));
  assert.equal(byId.b1.outputFile, '/tmp/x/tasks/b1-final.output', 'the notification\'s file wins');
  assert.equal(byId.b2.outputFile, '/tmp/x/tasks/b2.output', 'else the file the call\'s result named');
  // The history viewer hands its entries straight to the renderer, so its notice carries no path at all.
  const history = require('../src/backends/claude/transcript-view').normalizeTranscriptEntries([call('toolu_1'), notice('b1', 'toolu_1', '/tmp/x/tasks/b1-final.output')]);
  assert.ok(!JSON.stringify(history).includes('/tmp/x'));
});
