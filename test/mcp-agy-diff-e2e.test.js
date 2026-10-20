// End to end for the agent-facing diff tool, against a STAND-IN for the CLI (T10) — no real agy.
//
// WHY THIS EXISTS:
//   Every piece is tested alone (composer, listener, diff group, bridge window routing). This file walks the
//   whole path once: a fake descriptor that declares the MCP-injection capability goes through the real
//   composer and the "own server" source, which registers on the real HTTP listener; a plain Node `http`
//   client plays the CLI with the url and token it was handed; the file panel is a window stub that records
//   `mcp-open-diff`; the user's answer is driven through `resolvePendingDiff`. It also pins the three ways a
//   waiting call is ended without an answer (window closed, session released, app quit) and that a re-key
//   keeps the token working. Whether a real agy sends this traffic is G2's question, not this file's.
'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Keep Claude's lock-file home in a scratch dir, like the other bridge tests (#241).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-e2e-'));
process.env.SWITCHBOARD_STORE_CLAUDE = path.join(tmpHome, 'projects');
const projectDir = path.join(tmpHome, 'project');
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, 'a.txt'), 'old text\n');

const bridge = require('../src/servers/mcp-bridge');
const mcpHttp = require('../src/servers/mcp-http');
const { composeMcpInjection, ownServerSource } = require('../src/app/mcp-inject');

const log = { info() {}, debug() {}, warn() {}, error() {} };

// The stand-in descriptor: only the capability and the hook. It hands the server row back as env so the
// "CLI" below can read the url and token exactly as a spawned process would.
const standInBackend = {
  id: 'stand-in',
  providesMcpInjection: true,
  acceptsMcpTransports: ['http'],
  buildMcpInjection({ servers }) {
    const row = servers[0];
    return { args: ['--mcp'], env: { SB_URL: row.url, SB_AUTH: row.headers.Authorization }, cleanup: null };
  },
};

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

/** The CLI's side: one JSON-RPC POST with the Authorization header it was given in its env. */
function rpc(env, body) {
  const u = new URL(env.SB_URL);
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: u.hostname, port: u.port, method: 'POST', path: u.pathname, agent: false,
      headers: { authorization: env.SB_AUTH, 'content-type': 'application/json', 'content-length': payload.length },
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

/** Spawn path: compose the injection for a session; return the env the "CLI" gets, plus release. */
async function spawnSession(sessionId, win) {
  const injection = await composeMcpInjection({
    backend: standInBackend,
    ctx: { log },
    cwd: projectDir,
    sources: [ownServerSource({
      backend: standInBackend, enabled: true, registerSession: mcpHttp.registerSession,
      sessionId, projectPath: projectDir, getWindow: () => win, log,
    })],
  });
  assert.ok(injection, 'the composer built an injection');
  return injection;
}

let nextRpc = 1;
function callOpenDiff(env, args) {
  return rpc(env, { jsonrpc: '2.0', id: nextRpc++, method: 'tools/call', params: { name: 'openDiff', arguments: args } });
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

test('the spawn path hands the CLI a url and token; initialize and tools/list expose openDiff only', async () => {
  const win = fakeWindow();
  const injection = await spawnSession('e2e-list', win);
  try {
    assert.deepEqual(injection.args, ['--mcp']);
    const init = await rpc(injection.env, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.equal(init.status, 200);
    const list = await rpc(injection.env, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.json.result.tools.map((t) => t.name);
    assert.deepEqual(names, ['openDiff'], 'the diff group, not Claude ide tools');
  } finally {
    injection.release();
  }
});

test('(a) openDiff reaches the window as an mcp-open-diff payload; (b) accept / reject / edit answer the client', async () => {
  const win = fakeWindow();
  const injection = await spawnSession('e2e-answer', win);
  try {
    const newContent = 'new text\n';
    const pending = callOpenDiff(injection.env, { filePath: 'a.txt', newContent, tabName: 'my tab' });
    const seen = await nextOpenDiff(win, 0);
    assert.equal(seen.sessionId, 'e2e-answer');
    assert.equal(seen.payload.oldContent, 'old text\n');
    assert.equal(seen.payload.newContent, newContent);
    assert.equal(seen.payload.tabName, 'my tab');
    assert.equal(seen.payload.oldFilePath, path.resolve(projectDir, 'a.txt'));
    bridge.resolvePendingDiff('e2e-answer', seen.diffId, 'accept');
    assert.equal(textOf(await pending), 'ACCEPTED');

    const second = callOpenDiff(injection.env, { filePath: 'a.txt', newContent });
    const seen2 = await nextOpenDiff(win, 1);
    assert.equal(seen2.payload.tabName, 'a.txt', 'tabName defaults to the file name');
    bridge.resolvePendingDiff('e2e-answer', seen2.diffId, 'reject');
    assert.equal(textOf(await second), 'REJECTED');

    const third = callOpenDiff(injection.env, { filePath: 'a.txt', newContent });
    const seen3 = await nextOpenDiff(win, 2);
    bridge.resolvePendingDiff('e2e-answer', seen3.diffId, 'accept-edited', 'edited\n');
    assert.equal(textOf(await third), 'ACCEPTED_WITH_EDITS\nedited\n');
  } finally {
    injection.release();
  }
});

test('(c) closing the window rejects the pending call', async () => {
  const win = fakeWindow();
  const injection = await spawnSession('e2e-window', win);
  try {
    const pending = callOpenDiff(injection.env, { filePath: 'a.txt', newContent: 'x' });
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
  const injection = await spawnSession('e2e-quit', win);
  const pending = callOpenDiff(injection.env, { filePath: 'a.txt', newContent: 'x' });
  await nextOpenDiff(win, 0);
  bridge.shutdownAll(log);
  assert.equal(textOf(await pending), 'REJECTED');
  assert.ok(win.sent.some((m) => m.channel === 'mcp-close-all-diffs'), 'the renderer is told to clear the card');
  injection.release(); // idempotent after the quit; must not throw
  await assert.rejects(rpc(injection.env, { jsonrpc: '2.0', id: 9, method: 'initialize' }), 'the socket is closed');
});

test('(e) a re-key keeps the same token working under the new session id', async () => {
  const win = fakeWindow();
  const injection = await spawnSession('e2e-old', win);
  try {
    bridge.rekeyMcpServer('e2e-old', 'e2e-new');
    const pending = callOpenDiff(injection.env, { filePath: 'a.txt', newContent: 'x' });
    const seen = await nextOpenDiff(win, 0);
    assert.equal(seen.sessionId, 'e2e-new', 'the window is told the NEW id');
    bridge.resolvePendingDiff('e2e-old', seen.diffId, 'accept'); // the old id no longer answers
    const raced = await Promise.race([pending.then(() => 'answered'), new Promise((r) => setTimeout(() => r('open'), 60))]);
    assert.equal(raced, 'open', 'the old id is gone from the registry');
    bridge.resolvePendingDiff('e2e-new', seen.diffId, 'accept');
    assert.equal(textOf(await pending), 'ACCEPTED');
  } finally {
    injection.release();
  }
});

test('(f) release (the session exited) invalidates the token and rejects an open call', async () => {
  const win = fakeWindow();
  const injection = await spawnSession('e2e-exit', win);
  const pending = callOpenDiff(injection.env, { filePath: 'a.txt', newContent: 'x' });
  await nextOpenDiff(win, 0);
  injection.release();
  assert.equal(textOf(await pending), 'REJECTED');
  const after401 = await rpc(injection.env, { jsonrpc: '2.0', id: 3, method: 'initialize' });
  assert.equal(after401.status, 401);
});

test('a path outside the project is refused to the client, not sent to the window', async () => {
  const win = fakeWindow();
  const injection = await spawnSession('e2e-outside', win);
  try {
    const r = await callOpenDiff(injection.env, { filePath: path.join('..', 'escape.txt'), newContent: 'x' });
    assert.ok(r.json.error, 'a JSON-RPC error');
    assert.equal(win.sent.length, 0);
  } finally {
    injection.release();
  }
});
