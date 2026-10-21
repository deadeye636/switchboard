// The `discovery` tool group at bridge level (#507, spec 35): a fake reader on `entry.discovery`, a fake
// reply. No socket, no db, no electron. The reader itself is covered by discovery-reader.test.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-disc-'));
process.env.SWITCHBOARD_STORE_CLAUDE = path.join(tmpHome, 'projects');

const bridge = require('../src/servers/mcp-bridge');
const { DISCOVERY_TOOLS } = require('../src/servers/discovery-tools');

const log = { info() {}, debug() {}, warn() {}, error() {} };
const NAMES = ['listSessions', 'readSession', 'listHandoffs', 'readHandoff'];
let seq = 0;

function fakeReader(overrides = {}) {
  const calls = [];
  const make = (m, res) => (args) => { calls.push([m, args]); return overrides[m] ? overrides[m](args) : res; };
  return {
    calls,
    listSessions: make('listSessions', { ok: true, total: 1, sessions: [{ id: 'a' }] }),
    readSession: make('readSession', { ok: true, turns: [] }),
    listHandoffs: make('listHandoffs', { ok: true, handoffs: [] }),
    readHandoff: make('readHandoff', { ok: true, text: 'x', more: false }),
  };
}

function open(opts) {
  const entry = bridge.createHttpEntry({ sessionId: `disc-${++seq}`, getWindow: () => null, ...opts });
  const frames = [];
  entry.reply = (f) => frames.push(JSON.parse(f));
  const send = async (method, params) => {
    await bridge.dispatchMessage(entry, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), log);
    return frames.pop();
  };
  return { entry, send, close: () => bridge.shutdownMcpServer(entry.sessionId, log) };
}

test('tools/list exposes exactly the four discovery tools when the entry carries a reader', async () => {
  const h = open({ groups: ['discovery'], discovery: fakeReader() });
  const res = await h.send('tools/list');
  assert.deepEqual(res.result.tools.map((t) => t.name), NAMES);
  assert.deepEqual(res.result.tools, DISCOVERY_TOOLS);
  for (const t of res.result.tools) assert.match(t.description, /read-only/i);
  h.close();
});

test('an entry without a reader hides the group and refuses its tools', async () => {
  const h = open({ groups: ['discovery'] });
  assert.deepEqual((await h.send('tools/list')).result.tools, []);
  const call = await h.send('tools/call', { name: 'listSessions', arguments: {} });
  assert.equal(call.error.code, -32602);
  h.close();
  const diffOnly = open({ groups: ['diff'], discovery: fakeReader() });
  assert.deepEqual((await diffOnly.send('tools/list')).result.tools.map((t) => t.name), ['openDiff']);
  diffOnly.close();
});

test('diff and discovery together list both sets', async () => {
  const h = open({ groups: ['diff', 'discovery'], discovery: fakeReader() });
  assert.deepEqual((await h.send('tools/list')).result.tools.map((t) => t.name), ['openDiff', ...NAMES]);
  h.close();
});

test('each tool routes to its reader method with the args mapped; success is one compact-JSON text item', async () => {
  const reader = fakeReader();
  const h = open({ groups: ['discovery'], discovery: reader });
  const r1 = await h.send('tools/call', { name: 'listSessions', arguments: { limit: 5 } });
  assert.equal(r1.result.isError, undefined);
  assert.equal(r1.result.content.length, 1);
  assert.equal(r1.result.content[0].text, JSON.stringify({ total: 1, sessions: [{ id: 'a' }] }));
  await h.send('tools/call', { name: 'readSession', arguments: { sessionId: 's1', turns: 3, roles: 'user', maxCharsPerTurn: 100 } });
  await h.send('tools/call', { name: 'listHandoffs', arguments: { limit: 2 } });
  await h.send('tools/call', { name: 'readHandoff', arguments: { id: 'p.md', offset: 10, maxChars: 50 } });
  assert.deepEqual(reader.calls, [
    ['listSessions', { limit: 5 }],
    ['readSession', { sessionId: 's1', turns: 3, roles: 'user', maxCharsPerTurn: 100 }],
    ['listHandoffs', { limit: 2 }],
    ['readHandoff', { id: 'p.md', offset: 10, maxChars: 50 }],
  ]);
  h.close();
});

test('{ ok:false, error } becomes an isError result carrying the sentence', async () => {
  const reader = fakeReader({ readSession: () => ({ ok: false, error: 'No such session.' }) });
  const h = open({ groups: ['discovery'], discovery: reader });
  const res = await h.send('tools/call', { name: 'readSession', arguments: { sessionId: 'x' } });
  assert.equal(res.error, undefined);
  assert.equal(res.result.isError, true);
  assert.equal(res.result.content[0].text, 'No such session.');
  h.close();
});

test('bad arguments are isError results and never reach the reader', async () => {
  const reader = fakeReader();
  const h = open({ groups: ['discovery'], discovery: reader });
  const bad = [
    ['readSession', {}],
    ['readSession', { sessionId: 42 }],
    ['readSession', { sessionId: 's', turns: 'many' }],
    ['readSession', { sessionId: 's', roles: 'assistant' }],
    ['listSessions', { limit: -1 }],
    ['listHandoffs', { limit: 'x' }],
    ['readHandoff', { id: '' }],
    ['readHandoff', { id: 'a.md', offset: 'start' }],
  ];
  for (const [name, args] of bad) {
    const res = await h.send('tools/call', { name, arguments: args });
    assert.equal(res.result.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.ok(res.result.content[0].text.length > 0);
  }
  assert.deepEqual(reader.calls, []);
  h.close();
});

test('an unknown tool name is a JSON-RPC error, not an isError result', async () => {
  const h = open({ groups: ['discovery'], discovery: fakeReader() });
  const res = await h.send('tools/call', { name: 'openFile', arguments: { filePath: 'x' } });
  assert.equal(res.result, undefined);
  assert.equal(res.error.code, -32602);
  h.close();
});

test('a throw (sync or async) inside the reader is contained as an isError result', async () => {
  const reader = fakeReader({
    listSessions: () => { throw new Error('secret path C:/x'); },
    readSession: async () => { throw new Error('boom'); },
  });
  const h = open({ groups: ['discovery'], discovery: reader });
  for (const name of ['listSessions', 'readSession']) {
    const res = await h.send('tools/call', { name, arguments: { sessionId: 's' } });
    assert.equal(res.result.isError, true);
    assert.doesNotMatch(res.result.content[0].text, /secret|boom/);
  }
  h.close();
});

test('the group names no backend id and no tool name is shared with another group', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'servers', 'discovery-tools.js'), 'utf8');
  assert.doesNotMatch(src, /\b(claude|codex|hermes|agy|pi)\b/i);
  assert.ok(!NAMES.includes('openDiff'));
});
