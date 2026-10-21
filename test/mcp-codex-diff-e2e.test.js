// End to end for the agent-facing diff tool on the Codex `-c` path, against a STAND-IN for the CLI (#330).
//
// WHY THIS EXISTS:
//   Same walk as test/mcp-agy-diff-e2e.test.js, but through the REAL Codex descriptor: the composer and the
//   "own server" source register on the real HTTP listener, the descriptor's `buildMcpInjection` turns the
//   neutral row into `-c` overrides plus one env variable, and a plain Node `http` client plays Codex by
//   PARSING that result (the url out of the `-c` value, the token out of the spawn env, never argv). The file
//   panel is a window stub recording `mcp-open-diff`. Codex gets no config file and no plugin bundle, so this
//   file also pins that nothing is written to disk and that the token is not on argv. Whether a real Codex
//   sends this traffic is G2's question, not this file's.
'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Keep Claude's lock-file home in a scratch dir, like the other bridge tests (#241).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-codex-e2e-'));
process.env.SWITCHBOARD_STORE_CLAUDE = path.join(tmpHome, 'projects');
const projectDir = path.join(tmpHome, 'project');
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, 'a.txt'), 'old text\n');

const bridge = require('../src/servers/mcp-bridge');
const mcpHttp = require('../src/servers/mcp-http');
const { composeMcpInjection, ownServerSource } = require('../src/app/mcp-inject');
const codex = require('../src/backends/codex');

const log = { info() {}, debug() {}, warn() {}, error() {} };

function fakeWindow() {
  const sent = [];
  return {
    sent,
    isDestroyed() { return false; },
    webContents: {
      send: (channel, ...args) => sent.push({ channel, args }),
      isLoading: () => false,
      once() {},
    },
  };
}

function waitFor(predicate, what) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(check, 5);
    };
    check();
  });
}

/** Every file and directory under `dir`, relative, sorted: a snapshot to compare before and after. */
function treeOf(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      out.push(path.relative(tmpHome, full));
      if (e.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The CLI's side of the hand-over: what Codex does with the launch overrides. Reads the url and the name of
 * the bearer env variable out of the `-c key="value"` pairs (TOML strings), then the token out of the env.
 */
function clientFrom(injection) {
  const pairs = {};
  assert.equal(injection.args.length % 2, 0, 'args are -c / value pairs');
  for (let i = 0; i < injection.args.length; i += 2) {
    assert.equal(injection.args[i], '-c');
    const eq = injection.args[i + 1].indexOf('=');
    pairs[injection.args[i + 1].slice(0, eq)] = JSON.parse(injection.args[i + 1].slice(eq + 1));
  }
  const url = pairs['mcp_servers.switchboard.url'];
  const envVar = pairs['mcp_servers.switchboard.bearer_token_env_var'];
  assert.ok(url && envVar, 'both overrides are present');
  return { url, token: injection.env[envVar], envVar, pairs };
}

/** One JSON-RPC POST with the given bearer token. */
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
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Spawn path: compose the injection for a session with the real Codex descriptor. */
async function spawnSession(sessionId, win) {
  const injection = await composeMcpInjection({
    backend: codex,
    ctx: { log },
    cwd: projectDir,
    sources: [ownServerSource({
      backend: codex, enabled: true, registerSession: mcpHttp.registerSession,
      sessionId, projectPath: projectDir, getWindow: () => win, log,
    })],
  });
  assert.ok(injection, 'the composer built an injection');
  return { injection, client: clientFrom(injection) };
}

let nextRpc = 1;
function callOpenDiff(client, args, token) {
  return rpc(client, { jsonrpc: '2.0', id: nextRpc++, method: 'tools/call', params: { name: 'openDiff', arguments: args } }, token);
}

/** Wait for the call to reach the window; return { diffId, payload, sessionId } from the captured send. */
async function nextOpenDiff(win, from) {
  await waitFor(() => win.sent.length > from, 'the diff to reach the window');
  const m = win.sent[from];
  assert.equal(m.channel, 'mcp-open-diff');
  return { sessionId: m.args[0], diffId: m.args[1], payload: m.args[2] };
}

const textOf = (r) => r.json.result.content[0].text;

after(() => { mcpHttp.shutdownListener(); });

test('the injection is exactly two -c pairs and one env variable; the token is not on argv; nothing is written', async () => {
  const before = treeOf(tmpHome);
  const win = fakeWindow();
  const { injection, client } = await spawnSession('codex-shape', win);
  try {
    assert.deepEqual(injection.args, [
      '-c', `mcp_servers.switchboard.url=${JSON.stringify(client.url)}`,
      '-c', 'mcp_servers.switchboard.bearer_token_env_var="SWITCHBOARD_MCP_TOKEN"',
    ]);
    assert.match(client.url, /^http:\/\/127\.0\.0\.1:\d+\//, 'a loopback listener url');
    assert.deepEqual(Object.keys(injection.env), ['SWITCHBOARD_MCP_TOKEN']);
    assert.equal(client.envVar, 'SWITCHBOARD_MCP_TOKEN');
    assert.ok(client.token && client.token.length >= 16, 'a real token in the env');
    assert.ok(!injection.args.some((a) => a.includes(client.token)), 'the token is not in argv');
    assert.deepEqual(treeOf(tmpHome), before, 'no file or directory was created by the injection');
  } finally {
    injection.release();
  }
  assert.deepEqual(treeOf(tmpHome), before, 'release leaves the tree untouched too');
});

test('initialize and tools/list expose openDiff only', async () => {
  const win = fakeWindow();
  const { injection, client } = await spawnSession('codex-list', win);
  try {
    const init = await rpc(client, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.equal(init.status, 200);
    const list = await rpc(client, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(list.json.result.tools.map((t) => t.name), ['openDiff'], 'the diff group, not Claude ide tools');
  } finally {
    injection.release();
  }
});

test('a wrong bearer token gets HTTP 401', async () => {
  const win = fakeWindow();
  const { injection, client } = await spawnSession('codex-401', win);
  try {
    const r = await callOpenDiff(client, { filePath: 'a.txt', newContent: 'x' }, 'not-the-token');
    assert.equal(r.status, 401);
    assert.equal(win.sent.length, 0, 'nothing reached the window');
  } finally {
    injection.release();
  }
});

test('(a) openDiff reaches the window as an mcp-open-diff payload; (b) accept / reject / edit answer the client', async () => {
  const win = fakeWindow();
  const { injection, client } = await spawnSession('codex-answer', win);
  try {
    const newContent = 'new text\n';
    const pending = callOpenDiff(client, { filePath: 'a.txt', newContent, tabName: 'my tab' });
    const seen = await nextOpenDiff(win, 0);
    assert.equal(seen.sessionId, 'codex-answer');
    assert.equal(seen.payload.oldContent, 'old text\n');
    assert.equal(seen.payload.newContent, newContent);
    assert.equal(seen.payload.tabName, 'my tab');
    assert.equal(seen.payload.oldFilePath, path.resolve(projectDir, 'a.txt'));
    bridge.resolvePendingDiff('codex-answer', seen.diffId, 'accept');
    assert.equal(textOf(await pending), 'ACCEPTED');

    const second = callOpenDiff(client, { filePath: 'a.txt', newContent });
    const seen2 = await nextOpenDiff(win, 1);
    assert.equal(seen2.payload.tabName, 'a.txt', 'tabName defaults to the file name');
    bridge.resolvePendingDiff('codex-answer', seen2.diffId, 'reject');
    assert.equal(textOf(await second), 'REJECTED');

    const third = callOpenDiff(client, { filePath: 'a.txt', newContent });
    const seen3 = await nextOpenDiff(win, 2);
    bridge.resolvePendingDiff('codex-answer', seen3.diffId, 'accept-edited', 'edited\n');
    assert.equal(textOf(await third), 'ACCEPTED_WITH_EDITS\nedited\n');
  } finally {
    injection.release();
  }
});

test('(c) closing the window rejects the pending call', async () => {
  const win = fakeWindow();
  const { injection, client } = await spawnSession('codex-window', win);
  try {
    const pending = callOpenDiff(client, { filePath: 'a.txt', newContent: 'x' });
    await nextOpenDiff(win, 0);
    assert.equal(bridge.hasPendingDiffsForWindow(win), true);
    assert.equal(bridge.rejectPendingDiffsForWindow(win, log), 1);
    assert.equal(textOf(await pending), 'REJECTED');
  } finally {
    injection.release();
  }
});

test('(d) app quit (shutdownAll) rejects the pending call and closes the listener', async () => {
  const win = fakeWindow();
  const { injection, client } = await spawnSession('codex-quit', win);
  const pending = callOpenDiff(client, { filePath: 'a.txt', newContent: 'x' });
  await nextOpenDiff(win, 0);
  bridge.shutdownAll(log);
  assert.equal(textOf(await pending), 'REJECTED');
  assert.ok(win.sent.some((m) => m.channel === 'mcp-close-all-diffs'), 'the renderer is told to clear the card');
  injection.release(); // idempotent after the quit; must not throw
  await assert.rejects(rpc(client, { jsonrpc: '2.0', id: 9, method: 'initialize' }), 'the socket is closed');
});

test('(e) a re-key keeps the same token working under the new session id', async () => {
  const win = fakeWindow();
  const { injection, client } = await spawnSession('codex-old', win);
  try {
    bridge.rekeyMcpServer('codex-old', 'codex-new');
    const pending = callOpenDiff(client, { filePath: 'a.txt', newContent: 'x' });
    const seen = await nextOpenDiff(win, 0);
    assert.equal(seen.sessionId, 'codex-new', 'the window is told the NEW id');
    bridge.resolvePendingDiff('codex-old', seen.diffId, 'accept'); // the old id no longer answers
    const raced = await Promise.race([pending.then(() => 'answered'), new Promise((r) => setTimeout(() => r('open'), 60))]);
    assert.equal(raced, 'open', 'the old id is gone from the registry');
    bridge.resolvePendingDiff('codex-new', seen.diffId, 'accept');
    assert.equal(textOf(await pending), 'ACCEPTED');
  } finally {
    injection.release();
  }
});

test('(f) release (the session exited) invalidates the token and rejects an open call', async () => {
  const win = fakeWindow();
  const { injection, client } = await spawnSession('codex-exit', win);
  const pending = callOpenDiff(client, { filePath: 'a.txt', newContent: 'x' });
  await nextOpenDiff(win, 0);
  injection.release();
  assert.equal(textOf(await pending), 'REJECTED');
  const after401 = await rpc(client, { jsonrpc: '2.0', id: 3, method: 'initialize' });
  assert.equal(after401.status, 401);
});

test('a path outside the project is refused to the client, not sent to the window', async () => {
  const win = fakeWindow();
  const { injection, client } = await spawnSession('codex-outside', win);
  try {
    const r = await callOpenDiff(client, { filePath: path.join('..', 'escape.txt'), newContent: 'x' });
    assert.ok(r.json.error, 'a JSON-RPC error');
    assert.equal(win.sent.length, 0);
  } finally {
    injection.release();
  }
});
