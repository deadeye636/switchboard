// End to end for the agent-facing session discovery tools, against a STAND-IN client (#507 Phase 1, T8).
//
// WHY THIS EXISTS:
//   Every piece is tested alone (the reader, the tool group, the composer, the descriptors' injection hooks).
//   This file walks the whole chain once: the REAL Codex, agy, Claude and claude-native descriptors (the last two
//   since spec 37, through the `--mcp-config` file), the composer and the "own
//   server" source, the real HTTP listener and bridge, and the real project-scoped reader
//   (`createDiscoveryReader`) over fake cache/meta/backend dependencies that hold TWO projects. A plain Node
//   `http` client plays the CLI by PARSING what the injection produced: the Codex `-c` overrides plus the
//   env token, the agy plugin bundle's `mcp_config.json`, or the Claude `--mcp-config` file. Whether a real CLI sends this traffic is G2's
//   question, not this file's.
//
//   The toggle itself is read in `src/app/terminal/spawn.js` (node-pty at load, so it cannot be required
//   here); `groupsFor` below mirrors those two lines and the descriptor test pins that the option exists.
'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-discovery-e2e-'));
process.env.SWITCHBOARD_STORE_CLAUDE = path.join(tmpHome, 'projects');
fs.mkdirSync(path.join(tmpHome, 'project-a'));
fs.mkdirSync(path.join(tmpHome, 'project-b'));
const projectA = fs.realpathSync(path.join(tmpHome, 'project-a'));
const projectB = fs.realpathSync(path.join(tmpHome, 'project-b'));

const mcpHttp = require('../src/servers/mcp-http');
const bridge = require('../src/servers/mcp-bridge');
const handoffs = require('../src/app/handoffs');
const { composeMcpInjection, ownServerSource } = require('../src/app/mcp-inject');
const { createDiscoveryReader, NO_SUCH_SESSION, NO_SUCH_HANDOFF } = require('../src/app/discovery-reader');
const codex = require('../src/backends/codex');
const agy = require('../src/backends/agy');
const claude = require('../src/backends/claude');
const claudeNative = require('../src/backends/claude-native');

const log = { info() {}, debug() {}, warn() {}, error() {} };
const TOOLS = ['listSessions', 'readSession', 'listHandoffs', 'readHandoff'];

// ---- fixture: two projects, sessions of two (invented) backend ids, one long transcript, handoffs ----------
handoffs.init({
  backends: { list: () => [] },
  db: {
    getProjectStates: () => new Map([[projectA, { registered: true }], [projectB, { registered: true }]]),
    getProjectDisplayNames: () => new Map(),
    readLegacyHandoffs: () => [],
    deleteLegacyHandoff() {},
    dropLegacyHandoffTable: () => true,
  },
  log,
  effectiveSettings: () => ({}),
});
const BIG_HANDOFF = 'x'.repeat(40000);
handoffs.saveHandoff({ projectPath: projectA, label: 'Packet A', content: 'a short packet for project A' });
handoffs.saveHandoff({ projectPath: projectA, label: 'Big A', content: BIG_HANDOFF });
handoffs.saveHandoff({ projectPath: projectB, label: 'Packet B', content: 'SECRET-B packet' });

const rows = [
  { sessionId: 'a-1', projectPath: projectA, backendId: 'alpha', summary: 'A one', firstPrompt: 'hello a1', lastEntryAt: '2026-10-03T10:00:00Z', messageCount: 800, userMessageCount: 400 },
  { sessionId: 'a-2', projectPath: projectA, backendId: 'beta', summary: 'A two', firstPrompt: 'hello a2', lastEntryAt: '2026-10-02T10:00:00Z', messageCount: 2, userMessageCount: 1 },
  { sessionId: 'a-sub', projectPath: projectA, backendId: 'alpha', summary: 'sub', parentSessionId: 'a-1', agentId: 'x' },
  { sessionId: 'b-1', projectPath: projectB, backendId: 'alpha', summary: 'SECRET-B session', firstPrompt: 'hello b1', lastEntryAt: '2026-10-04T10:00:00Z' },
];
const longTranscript = [];
for (let i = 1; i <= 400; i++) {
  longTranscript.push({ role: 'user', text: `question ${i} ` + 'q'.repeat(3000) });
  longTranscript.push({ role: 'assistant', text: `answer ${i} ` + 'a'.repeat(3000) });
}
const digests = {
  alpha: async (row) => (row.sessionId === 'b-1'
    ? { messages: [{ role: 'user', text: 'SECRET-B transcript' }], partial: false }
    : { messages: longTranscript, partial: true }),
  beta: async () => ({ messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }], partial: false }),
};
const backendsFake = {
  get: (id) => (digests[id] ? { id, label: id.toUpperCase(), capabilities: { turnDigest: 'yes' }, readTurnDigest: digests[id] } : null),
};

function readerFor(projectPath, callerSessionId) {
  return createDiscoveryReader({
    projectPath, callerSessionId,
    getCachedSessions: () => rows,
    getSessionMeta: () => new Map(),
    activeSessions: new Map([['a-1', { exited: false }]]),
    backends: backendsFake,
    handoffs,
    isForeignNetworkFile: () => false,
    log,
  });
}

// ---- helpers ------------------------------------------------------------------------------------------------
function treeOf(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      out.push(path.relative(dir, full));
      if (e.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** The bytes of every file too, so a rewrite in place is seen, not only a new name. */
function contentsOf(dir) {
  const out = {};
  for (const rel of treeOf(dir)) {
    const full = path.join(dir, rel);
    if (fs.statSync(full).isFile()) out[rel] = fs.readFileSync(full, 'utf8');
  }
  return out;
}

function rpc(client, body, token = client.token) {
  const u = new URL(client.url);
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: u.hostname, port: u.port, method: 'POST', path: u.pathname, agent: false,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': payload.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* a non-JSON body, e.g. a 401 */ }
        resolve({ status: res.statusCode, json, bytes: Buffer.byteLength(text) });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

let nextRpc = 1;
const call = (client, name, args = {}, token) =>
  rpc(client, { jsonrpc: '2.0', id: nextRpc++, method: 'tools/call', params: { name, arguments: args } }, token);
const listTools = async (client) => (await rpc(client, { jsonrpc: '2.0', id: nextRpc++, method: 'tools/list' })).json.result.tools.map((t) => t.name);
const textOf = (r) => r.json.result.content[0].text;
const dataOf = (r) => JSON.parse(textOf(r));

/**
 * Mirrors the lines of spawn.js that turn the toggles the backend declares into the group list (spec 37, O9). A
 * copy: the real block is exercised by `test/spawn-claude-discovery.test.js` and `test/spawn-mcp-inject.test.js`.
 */
function groupsFor(options, backend) {
  const declares = (id) => backend.configFields.some((f) => f.id === id);
  const groups = [];
  if (options.diffTool === true && declares('diffTool')) groups.push('diff');
  if (options.discoveryTools === true && declares('discoveryTools')) groups.push('discovery');
  return groups;
}

/** The Codex CLI's side: the url out of the `-c` pairs, the token out of the spawn env. */
function codexClient(injection) {
  const pairs = {};
  for (let i = 0; i < injection.args.length; i += 2) {
    assert.equal(injection.args[i], '-c');
    const eq = injection.args[i + 1].indexOf('=');
    pairs[injection.args[i + 1].slice(0, eq)] = JSON.parse(injection.args[i + 1].slice(eq + 1));
  }
  const url = pairs['mcp_servers.switchboard.url'];
  const envVar = pairs['mcp_servers.switchboard.bearer_token_env_var'];
  assert.ok(url && envVar);
  return { url, token: injection.env[envVar] };
}

/** The agy CLI's side: the url and header out of the newest plugin bundle's mcp_config.json. */
function agyClient(projectPath, tag) {
  const root = path.join(projectPath, '.agents', 'plugins');
  const name = fs.readdirSync(root).find((n) => n.startsWith(`switchboard-${tag}-`));
  assert.ok(name, 'the bundle of this session exists');
  const conf = JSON.parse(fs.readFileSync(path.join(root, name, 'mcp_config.json'), 'utf8'));
  const entry = conf.mcpServers.switchboard;
  return { url: entry.url, token: entry.headers.Authorization.replace(/^Bearer /, '') };
}

/**
 * The Claude CLI's side (spec 37): the url and header out of the `--mcp-config` file the launch names. The file
 * holds the token; argv holds only the path, and the env carries nothing.
 */
function claudeClient(injection) {
  assert.equal(injection.args.length, 2);
  assert.equal(injection.args[0], '--mcp-config');
  assert.deepEqual(injection.env, {});
  const file = injection.args[1];
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'owner-only');
  const conf = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(conf.mcpServers), ['switchboard']);
  const entry = conf.mcpServers.switchboard;
  assert.equal(entry.type, 'http', 'without a type Claude would read the row as stdio');
  const token = entry.headers.Authorization.replace(/^Bearer /, '');
  assert.ok(token && !injection.args.join(' ').includes(token), 'the token is never on argv');
  return { url: entry.url, token };
}

// The per-spawn directory a `--mcp-config` file goes to; outside `tmpHome`, whose contents the no-write checks compare.
const bindingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-discovery-bind-'));

const SHAPES = {
  codex: { backend: codex, clientOf: (injection) => codexClient(injection) },
  agy: { backend: agy, clientOf: (injection, projectPath, tag) => agyClient(projectPath, tag) },
  claude: { backend: claude, clientOf: (injection) => claudeClient(injection) },
  'claude-native': { backend: claudeNative, clientOf: (injection) => claudeClient(injection) },
};

/** Spawn path with the real descriptor: compose the injection for the toggles; null when nothing registers. */
async function spawn(shape, { sessionId, projectPath, options, reader }) {
  const { backend, clientOf } = SHAPES[shape];
  const groups = groupsFor(options, backend);
  const injection = await composeMcpInjection({
    backend, ctx: { log }, dir: bindingDir, cwd: projectPath, tag: sessionId, options,
    sources: [ownServerSource({
      backend, groups, discovery: groups.includes('discovery') ? reader : null,
      registerSession: mcpHttp.registerSession, sessionId, projectPath, getWindow: () => null, log,
    })],
  });
  if (!injection) return { injection: null, groups };
  return { injection, groups, client: clientOf(injection, projectPath, sessionId) };
}

after(() => {
  mcpHttp.shutdownListener();
  fs.rmSync(bindingDir, { recursive: true, force: true });
});

for (const shape of Object.keys(SHAPES)) {
  const backend = SHAPES[shape].backend;

  test(`[${shape}] the descriptor declares discoveryTools as a spawn-applied toggle, off by default`, () => {
    const field = backend.configFields.find((f) => f.id === 'discoveryTools');
    assert.ok(field, 'the option exists');
    assert.equal(field.type, 'toggle');
    assert.equal(field.default, false);
    assert.equal(field.appliesAt, 'spawn');
  });

  test(`[${shape}] toggle on: the registration carries the discovery group and tools/list is exactly the four tools`, async () => {
    const reader = readerFor(projectA, `${shape}-list`);
    const s = await spawn(shape, { sessionId: `${shape}-list`, projectPath: projectA, options: { discoveryTools: true }, reader });
    try {
      assert.deepEqual(s.groups, ['discovery']);
      assert.ok(s.injection, 'an injection was built');
      assert.deepEqual(await listTools(s.client), TOOLS, 'no openDiff');
    } finally {
      s.injection.release();
    }
  });

  // The Claude family declares no `diffTool` (spec 37, E2a: diffs stay on `--ide`), so only the "neither" half applies.
  const offersDiff = backend.configFields.some((f) => f.id === 'diffTool');

  test(`[${shape}] ${offersDiff ? 'both toggles: both tool sets; only diff: openDiff only; neither' : 'no diff toggle; discovery off'}: nothing registers`, async () => {
    const reader = readerFor(projectA, `${shape}-combo`);
    if (!offersDiff) {
      const before = [contentsOf(tmpHome), contentsOf(bindingDir)];
      const none = await spawn(shape, { sessionId: `${shape}-none`, projectPath: projectA, options: {}, reader });
      assert.deepEqual(none.groups, []);
      assert.equal(none.injection, null, 'toggle absent: no row, no token, no --mcp-config');
      assert.deepEqual([contentsOf(tmpHome), contentsOf(bindingDir)], before, 'nothing was written');
      return;
    }
    const both = await spawn(shape, { sessionId: `${shape}-both`, projectPath: projectA, options: { diffTool: true, discoveryTools: true }, reader });
    try {
      assert.deepEqual((await listTools(both.client)).sort(), ['openDiff', ...TOOLS].sort());
    } finally {
      both.injection.release();
    }
    const diffOnly = await spawn(shape, { sessionId: `${shape}-diff`, projectPath: projectA, options: { diffTool: true }, reader });
    try {
      assert.deepEqual(await listTools(diffOnly.client), ['openDiff']);
    } finally {
      diffOnly.injection.release();
    }
    const before = contentsOf(tmpHome);
    const none = await spawn(shape, { sessionId: `${shape}-none`, projectPath: projectA, options: { discoveryTools: false, diffTool: false }, reader });
    assert.deepEqual(none.groups, []);
    assert.equal(none.injection, null, 'no row, no token, no injection');
    assert.deepEqual(contentsOf(tmpHome), before, 'nothing was written');
  });

  test(`[${shape}] the four tools answer over HTTP, bounded, and a wrong token gets 401`, async () => {
    const reader = readerFor(projectA, 'a-1');
    const s = await spawn(shape, { sessionId: `${shape}-tools`, projectPath: projectA, options: { discoveryTools: true }, reader });
    try {
      const bad = await call(s.client, 'listSessions', {}, 'not-the-token');
      assert.equal(bad.status, 401);
      const none = await rpc(s.client, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, '');
      assert.equal(none.status, 401);

      const listed = dataOf(await call(s.client, 'listSessions'));
      assert.deepEqual(listed.sessions.map((x) => x.id), ['a-1', 'a-2'], 'the project only, no subagent row');
      assert.deepEqual(listed.sessions.map((x) => x.self), [true, false]);
      assert.deepEqual(listed.sessions.map((x) => x.state), ['running', 'stopped']);
      assert.ok(!JSON.stringify(listed).includes('SECRET-B'));

      const read = await call(s.client, 'readSession', { sessionId: 'a-1', turns: 3, maxCharsPerTurn: 200 });
      assert.equal(read.json.result.isError, undefined);
      const view = dataOf(read);
      assert.equal(view.available, true);
      assert.equal(view.partial, true, 'the transcript was cut at the source');
      assert.ok(view.omitted > 0, 'older turns exist that were not returned');
      assert.ok(view.note);
      assert.equal(view.turns.length, 3);
      assert.ok(read.bytes < 8000, `the answer stays small (${read.bytes} bytes) against ${longTranscript.length} messages`);

      const hl = dataOf(await call(s.client, 'listHandoffs'));
      assert.deepEqual(hl.handoffs.map((h) => h.title).sort(), ['Big A', 'Packet A']);
      assert.ok(hl.handoffs.every((h) => /^\.handoffs\/.+\.md$/.test(h.id) && h.content === undefined));

      const bigId = hl.handoffs.find((h) => h.title === 'Big A').id;
      const page1 = dataOf(await call(s.client, 'readHandoff', { id: bigId, maxChars: 99999999 }));
      assert.ok(page1.returned < BIG_HANDOFF.length + 100 && page1.returned <= 32000, 'capped at the maximum');
      assert.equal(page1.more, true);
      const page2 = dataOf(await call(s.client, 'readHandoff', { id: bigId, offset: page1.returned, maxChars: 99999999 }));
      assert.equal(page2.more, false);
      assert.equal(page1.returned + page2.returned, page1.total);
    } finally {
      s.injection.release();
    }
  });

  test(`[${shape}] project isolation: another project's session and handoff are unreachable, byte-identical to a missing one`, async () => {
    const readerA = readerFor(projectA, 'a-1');
    const sa = await spawn(shape, { sessionId: `${shape}-iso-a`, projectPath: projectA, options: { discoveryTools: true }, reader: readerA });
    const sb = await spawn(shape, { sessionId: `${shape}-iso-b`, projectPath: projectB, options: { discoveryTools: true }, reader: readerFor(projectB, 'b-1') });
    try {
      // The second project is registered on the same listener: it sees its own, and not A's.
      const bList = dataOf(await call(sb.client, 'listSessions'));
      assert.deepEqual(bList.sessions.map((x) => x.id), ['b-1']);
      assert.deepEqual(dataOf(await call(sb.client, 'listHandoffs')).handoffs.map((h) => h.title), ['Packet B']);
      assert.equal((await call(sb.client, 'readSession', { sessionId: 'a-1' })).json.result.isError, true);

      // A's token, B's ids.
      const foreign = await call(sa.client, 'readSession', { sessionId: 'b-1' });
      const missing = await call(sa.client, 'readSession', { sessionId: 'does-not-exist' });
      assert.equal(foreign.json.result.isError, true);
      assert.equal(textOf(foreign), NO_SUCH_SESSION);
      assert.equal(JSON.stringify(foreign.json.result), JSON.stringify(missing.json.result), 'same bytes as a missing id');
      assert.ok(!JSON.stringify(foreign.json).includes('SECRET-B'));

      const bHandoffId = dataOf(await call(sb.client, 'listHandoffs')).handoffs[0].id;
      const noHandoff = await call(sa.client, 'readHandoff', { id: 'nothing-here.md' });
      assert.equal(noHandoff.json.result.isError, true);
      assert.equal(textOf(noHandoff), NO_SUCH_HANDOFF);
      for (const id of [bHandoffId, `../project-b/${bHandoffId}`, path.join(projectB, bHandoffId), bHandoffId.replace('/', '\\'), '.handoffs/missing.md']) {
        const r = await call(sa.client, 'readHandoff', { id });
        assert.equal(r.json.result.isError, true, id);
        assert.equal(JSON.stringify(r.json.result), JSON.stringify(noHandoff.json.result), `${id} answers like a missing packet`);
        assert.ok(!JSON.stringify(r.json).includes('SECRET-B'));
      }
    } finally {
      sa.injection.release();
      sb.injection.release();
    }
  });

  test(`[${shape}] the discovery calls write nothing; a re-key keeps the token and the project`, async () => {
    const reader = readerFor(projectA, 'a-1');
    const s = await spawn(shape, { sessionId: `${shape}-rekey-old`, projectPath: projectA, options: { discoveryTools: true }, reader });
    try {
      // The injection itself (the agy bundle) is already on disk; the calls must add nothing to it.
      // The binding directory too: a Claude launch's `--mcp-config` file lives there.
      const before = [contentsOf(tmpHome), contentsOf(bindingDir)];
      await call(s.client, 'listSessions');
      await call(s.client, 'readSession', { sessionId: 'a-1' });
      const id = dataOf(await call(s.client, 'listHandoffs')).handoffs[0].id;
      await call(s.client, 'readHandoff', { id });
      await call(s.client, 'readHandoff', { id: '../x.md' });
      assert.deepEqual([contentsOf(tmpHome), contentsOf(bindingDir)], before, 'no file or directory created, none rewritten');

      bridge.rekeyMcpServer(`${shape}-rekey-old`, `${shape}-rekey-new`);
      const after = dataOf(await call(s.client, 'listSessions'));
      assert.deepEqual(after.sessions.map((x) => x.id), ['a-1', 'a-2'], 'same token, same project');
      assert.equal((await call(s.client, 'readSession', { sessionId: 'b-1' })).json.result.isError, true);
    } finally {
      s.injection.release();
    }
    const gone = await call(s.client, 'listSessions');
    assert.equal(gone.status, 401, 'release invalidates the token');
    if (s.injection.args[0] === '--mcp-config') assert.equal(fs.existsSync(s.injection.args[1]), false, 'release removes the config file');
  });
}
