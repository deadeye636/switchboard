// #633 — another CLI's MCP servers inside a Pi session: the section of the per-spawn resources extension.
//
// The helpers on their own (the same functions the section is written with), then the generated section RUN:
// compiled with esbuild and executed in a vm against a fake `pi`, with a real stdio MCP server as its child,
// because what a client does with a server is exactly what reading its text cannot show.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const mcp = require('../src/backends/pi/mcp-section');
const resourcesExtension = require('../src/backends/pi/resources-extension');
const sessionResources = require('../src/backends/pi/session-resources');

test('a tool name is mcp__<server>__<tool>, cleaned to what every provider accepts and cut at 64', () => {
  assert.equal(mcp.mcpToolName('files', 'read_file'), 'mcp__files__read_file');
  assert.equal(mcp.mcpToolName('my server', 'get.item/v2'), 'mcp__my_server__get_item_v2');
  const long = mcp.mcpToolName('s'.repeat(40), 't'.repeat(40));
  assert.equal(long.length, 64);
  assert.match(long, /^mcp__s+__t+$/);
});

test('a tools/call result becomes Pi content: text, images and resources carried, the rest named, text capped', () => {
  const out = mcp.mcpContent({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
      { type: 'resource', resource: { uri: 'file:///x', text: 'inside' } },
      { type: 'resource_link', uri: 'file:///y' },
      { type: 'audio', data: 'zz' },
    ],
  }, 1000);
  assert.deepEqual(out, [
    { type: 'text', text: 'hello' },
    { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
    { type: 'text', text: 'inside' },
    { type: 'text', text: '[resource file:///y]' },
    { type: 'text', text: '[audio content not shown]' },
  ]);
  assert.deepEqual(mcp.mcpContent({ content: [] }, 10), [{ type: 'text', text: '(no output)' }]);
  assert.deepEqual(mcp.mcpContent({ structuredContent: { a: 1 } }, 100), [{ type: 'text', text: '{"a":1}' }]);
  const capped = mcp.mcpContent({ content: [{ type: 'text', text: 'x'.repeat(30) }, { type: 'text', text: 'more' }] }, 10);
  assert.deepEqual(capped.map((c) => c.text), ['x'.repeat(10), '[Output truncated at 10 characters.]']);
});

test('the env for the spawn names only startable servers, and nothing when there are none', () => {
  assert.equal(mcp.envFor([]), null);
  assert.equal(mcp.envFor([{ name: 'x', command: '' }]), null);
  const env = mcp.envFor([{ name: 'a', command: 'node', args: ['s.js', 3], env: { T: 'secret' }, path: '<home>/cfg', scope: 'global' }]);
  assert.deepEqual(Object.keys(env), [mcp.ENV_KEY]);
  assert.deepEqual(JSON.parse(env[mcp.ENV_KEY]), [{ name: 'a', command: 'node', args: ['s.js', '3'], env: { T: 'secret' } }]);
});

test('the generated extension carries the MCP section and none of a server\'s definition', () => {
  const text = resourcesExtension.extensionSource({ mcp: true });
  assert.match(text, /registerMcpServers\(pi\);/);
  assert.match(text, new RegExp(mcp.ENV_KEY));
  assert.doesNotMatch(text, /execFile\(/, 'test/cli-probe.test.js reads generated text for this');
  assert.equal(resourcesExtension.extensionSource({}), '', 'no section, no file');
  require('esbuild').transformSync(text, { loader: 'ts', format: 'cjs', target: 'node20' });
});

test('Pi gets the extension and the env for its source\'s MCP servers; without a file, neither', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-633-res-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const resolved = { ok: true, skills: [], commands: [], agents: [], dropped: [], mcpServers: [{ name: 'a', scope: 'global', path: '<home>/cfg', command: 'node', args: [], env: { T: 'secret' } }] };
  const built = sessionResources.buildSessionResources({ dir, tag: 'tag633', options: { resourcesFrom: 'src' }, resolveSource: () => resolved });
  assert.deepEqual(built.args.slice(0, 1), ['--extension']);
  assert.ok(built.env && built.env[mcp.ENV_KEY]);
  assert.deepEqual(built.mcpServers, [{ name: 'a', scope: 'global' }], 'the logged answer carries no env');
  const file = built.args[1];
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /secret/);
  const refused = sessionResources.buildSessionResources({ dir: null, tag: 'tag633', options: { resourcesFrom: 'src' }, resolveSource: () => resolved });
  assert.equal(refused.env, null);
  assert.deepEqual(refused.dropped.map((d) => [d.kind, d.name, d.reason]), [['mcp-server', 'a', 'extension-not-written']]);
});

// ── The section, run against a real stdio server ─────────────────────────────────────────────────────
//
// Modelled on what Pi does, read in its 0.84.4 dist: the module is evaluated once per process (again on
// /reload), and its default export is called once per RUNTIME — /new, /resume and /fork each build a new
// extension instance with no tools. So a test of a restart uses a SECOND fake `pi`, never the first one again.

const LATE_MS = mcp.START_CAP_MS + 1000;
const SERVER = `
'use strict';
const mode = process.argv[2] || 'ok';
if (mode === 'crash') { process.stderr.write('boom: bad config\\n'); process.exit(3); }
const tools = [
  { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'secret', description: 'Report whether the token arrived', inputSchema: { type: 'object', properties: {} } },
  { name: 'pid', description: 'The server process id', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Never answers', inputSchema: { type: 'object', properties: {} } },
];
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    if (m.method === 'initialize') {
      const answer = () => send({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 't', version: '1' } });
      if (mode === 'late') setTimeout(answer, ${LATE_MS}); else answer();
    }
    else if (m.method === 'tools/list') send({ tools });
    else if (m.method === 'tools/call') {
      const n = m.params.name;
      if (n === 'echo') send({ content: [{ type: 'text', text: 'echo:' + m.params.arguments.text }] });
      else if (n === 'secret') send({ content: [{ type: 'text', text: process.env.T633 || 'absent' }] });
      else if (n === 'pid') send({ content: [{ type: 'text', text: String(process.pid) }] });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

let compiled = null;
function code() {
  if (!compiled) compiled = require('esbuild').transformSync(resourcesExtension.extensionSource({ mcp: true }), { loader: 'ts', format: 'cjs', target: 'node20' }).code;
  return compiled;
}

// One Pi process: a vm context whose global is the process's global, evaluated once per module load.
function newProcess() {
  return vm.createContext({ require, process, Buffer, JSON, setTimeout, clearTimeout, Symbol, Promise, Map, Set, Error, Array, String, Math, Object });
}
// A module scope of its own per evaluation, as Pi's loader gives one: the same global, fresh top-level names.
function evaluate(context) {
  const mod = { exports: {} };
  vm.runInContext('(function (module, exports) {\n' + code() + '\n})', context)(mod, mod.exports);
  return mod.exports.default;
}
// One runtime: a fresh extension instance, as Pi builds for every session.
function runtime(factory) {
  const tools = new Map();
  const handlers = new Map();
  const notices = [];
  factory({ registerTool: (t) => tools.set(t.name, t), on: (ev, fn) => handlers.set(ev, fn), registerCommand: () => {} });
  const ctx = { cwd: os.tmpdir(), ui: { notify: (text, level) => notices.push([level, text]) } };
  return {
    tools, notices,
    start: (event = {}) => handlers.get('session_start')(event, ctx),
    shutdown: () => handlers.get('session_shutdown')({}, ctx),
  };
}
function runSection({ servers }) {
  process.env[mcp.ENV_KEY] = JSON.stringify(servers);
  const context = newProcess();
  const factory = evaluate(context);
  return { context, factory, envLeft: process.env[mcp.ENV_KEY], rt: runtime(factory) };
}

// A value built in the vm's realm is not deepStrictEqual to one built here (other prototypes).
const plain = (v) => JSON.parse(JSON.stringify(v));
const text = async (tool, params = {}) => (await tool.execute('x', params, undefined)).content[0].text;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gone(pid) {
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    await sleep(100);
  }
  return false;
}

function serverFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-633-srv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'server.js');
  fs.writeFileSync(file, SERVER);
  return file;
}

test('the section starts the server, registers its tools, calls them with the server\'s own env, and ends the process', async (t) => {
  const file = serverFile(t);
  const { rt, envLeft } = runSection({ servers: [{ name: 'demo', command: process.execPath, args: [file], env: { T633: 'tok' } }] });
  assert.equal(envLeft, undefined, 'the list is gone from the environment once the section is loaded');
  await rt.start();
  assert.deepEqual([...rt.tools.keys()].sort(), ['mcp__demo__echo', 'mcp__demo__pid', 'mcp__demo__secret', 'mcp__demo__slow']);
  const echo = rt.tools.get('mcp__demo__echo');
  assert.match(echo.description, /Echo text \(MCP server demo\)/);
  assert.deepEqual(plain(echo.parameters.required), ['text'], 'the schema is passed through');
  const r = await echo.execute('1', { text: 'hi' }, undefined);
  assert.deepEqual(plain(r.content), [{ type: 'text', text: 'echo:hi' }]);
  assert.equal(r.isError, false);
  assert.equal(await text(rt.tools.get('mcp__demo__secret')), 'tok');
  assert.deepEqual(rt.notices, [], 'a server that started says nothing');

  const ac = new AbortController();
  const pending = rt.tools.get('mcp__demo__slow').execute('3', {}, ac.signal);
  ac.abort();
  await assert.rejects(pending, /aborted/);

  const pid = Number(await text(rt.tools.get('mcp__demo__pid')));
  rt.shutdown();
  assert.ok(await gone(pid), 'the server process is gone after session_shutdown');
  const after = await echo.execute('4', { text: 'x' }, undefined);
  assert.equal(after.isError, true);
  assert.match(after.content[0].text, /not running/);
});

test('a server that cannot start is said, with its reason, and the others still come', async (t) => {
  const file = serverFile(t);
  const { rt } = runSection({ servers: [
    { name: 'broken', command: process.execPath, args: [file, 'crash'], env: {} },
    { name: 'missing', command: 'no-such-command-633', args: [], env: {} },
    { name: 'good', command: process.execPath, args: [file], env: {} },
  ] });
  await rt.start();
  assert.ok(rt.tools.has('mcp__good__echo'));
  assert.ok(![...rt.tools.keys()].some((n) => n.startsWith('mcp__broken__') || n.startsWith('mcp__missing__')));
  const texts = rt.notices.map(([level, msg]) => level + ' ' + msg).join('\n');
  assert.match(texts, /warning MCP server broken did not start: .*code 3.*boom: bad config/);
  assert.match(texts, /warning MCP server missing did not start: command not found: no-such-command-633/);
  rt.shutdown();
});

test('every new runtime (/new, /resume, /fork) gets the tools registered again, reaching the NEW server', async (t) => {
  const file = serverFile(t);
  const run = runSection({ servers: [{ name: 'demo', command: process.execPath, args: [file], env: {} }] });
  await run.rt.start();
  const firstPid = await text(run.rt.tools.get('mcp__demo__pid'));
  run.rt.shutdown();
  const next = runtime(run.factory);
  await next.start({ reason: 'new' });
  assert.ok(next.tools.has('mcp__demo__echo'), 'a new extension instance has its own tools');
  const secondPid = await text(next.tools.get('mcp__demo__pid'));
  assert.notEqual(secondPid, firstPid, 'a new server process');
  assert.equal(await text(next.tools.get('mcp__demo__echo'), { text: 'again' }), 'echo:again');
  next.shutdown();
});

test('/reload evaluates the module again with the variable gone, and the servers still come', async (t) => {
  const file = serverFile(t);
  const run = runSection({ servers: [{ name: 'demo', command: process.execPath, args: [file], env: { T633: 'kept' } }] });
  await run.rt.start();
  run.rt.shutdown();
  assert.equal(process.env[mcp.ENV_KEY], undefined);
  const reloaded = runtime(evaluate(run.context));
  await reloaded.start({ reason: 'reload' });
  assert.equal(await text(reloaded.tools.get('mcp__demo__secret')), 'kept', 'the list, env included, outlived the evaluation');
  reloaded.shutdown();
});

test('a server slower than the start cap does not hold the session, and is announced when it answers', async (t) => {
  const file = serverFile(t);
  const { rt } = runSection({ servers: [{ name: 'late', command: process.execPath, args: [file, 'late'], env: {} }] });
  const started = Date.now();
  await rt.start();
  const waited = Date.now() - started;
  assert.ok(waited >= mcp.START_CAP_MS - 100 && waited < mcp.START_CAP_MS + 2000, `waited ${waited} ms`);
  assert.match(rt.notices.map((n) => n[1]).join('\n'), /still starting/);
  assert.equal(rt.tools.size, 0);
  for (let i = 0; i < 40 && !rt.tools.size; i++) await sleep(100);
  assert.ok(rt.tools.has('mcp__late__echo'), 'registered once it answered');
  assert.match(rt.notices.map((n) => n[1]).join('\n'), /late is ready; its tools are offered from the next prompt on/);
  rt.shutdown();
});

test('a start still in flight when the session ends stops only itself, and says nothing to the next session', async (t) => {
  const file = serverFile(t);
  const run = runSection({ servers: [{ name: 'late', command: process.execPath, args: [file, 'late'], env: {} }] });
  const firstStart = run.rt.start();
  await sleep(200);
  run.rt.shutdown();
  const next = runtime(run.factory);
  const secondStart = next.start({ reason: 'new' });
  await Promise.all([firstStart, secondStart]);
  for (let i = 0; i < 40 && !next.tools.size; i++) await sleep(100);
  assert.ok(next.tools.has('mcp__late__echo'), 'the new session\'s server was not stopped by the old start');
  assert.equal(await text(next.tools.get('mcp__late__echo'), { text: 'ok' }), 'echo:ok');
  assert.equal(run.rt.tools.size, 0, 'the old instance registered nothing');
  assert.doesNotMatch(next.notices.map((n) => n[1]).join('\n'), /did not start/);
  next.shutdown();
});

test('a server that fails before the cap is still said when a slower one keeps the start past it', async (t) => {
  const file = serverFile(t);
  const { rt } = runSection({ servers: [
    { name: 'broken', command: process.execPath, args: [file, 'crash'], env: {} },
    { name: 'late', command: process.execPath, args: [file, 'late'], env: {} },
  ] });
  await rt.start();
  const said = () => rt.notices.map(([level, msg]) => level + ' ' + msg).join('\n');
  assert.match(said(), /warning MCP server broken did not start: .*code 3/, 'said when the cap decides, not lost');
  assert.match(said(), /still starting/);
  for (let i = 0; i < 40 && !rt.tools.size; i++) await sleep(100);
  assert.ok(rt.tools.has('mcp__late__echo'));
  assert.equal(rt.notices.filter(([, msg]) => /broken did not start/.test(msg)).length, 1, 'said once');
  rt.shutdown();
});

test('on Windows, a .cmd named as the command is refused by Node, and the notice says how to start it', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-633-cmd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'tool.cmd');
  fs.writeFileSync(shim, '@echo off\r\n');
  const { rt } = runSection({ servers: [{ name: 'shim', command: shim, args: [], env: {} }] });
  await rt.start();
  assert.match(rt.notices.map((n) => n[1]).join('\n'), /MCP server shim did not start: cannot be started without a shell: .*cmd \/c/);
  rt.shutdown();
});

test('the MCP section compiles beside the subagent and command sections, with one merged import', () => {
  const text = resourcesExtension.extensionSource({ mcp: true, subagent: { agentsDir: '' }, commands: [{ path: '<home>/commands', scope: 'global', dialect: {} }] });
  assert.equal((text.match(/from "node:child_process"/g) || []).length, 1);
  for (const call of ['registerSubagent(pi);', 'registerSourceCommands(pi);', 'registerMcpServers(pi);']) assert.ok(text.includes(call), call);
  require('esbuild').transformSync(text, { loader: 'ts', format: 'cjs', target: 'node20' });
});

test('every tool name carries the prefix the pi-native gate matches, and the section describes what it registered', async (t) => {
  assert.ok(mcp.mcpToolName('a', 'b').startsWith(mcp.TOOL_PREFIX));
  const file = serverFile(t);
  const run = runSection({ servers: [{ name: 'demo', command: process.execPath, args: [file], env: {} }] });
  await run.rt.start();
  const describe = vm.runInContext('globalThis', run.context)[Symbol.for(mcp.DESCRIBE_KEY)];
  assert.equal(describe('mcp__demo__echo'), 'Tool echo of the MCP server demo, taken over from another CLI: Echo text');
  assert.equal(describe('bash'), '');
  run.rt.shutdown();
});
