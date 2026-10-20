// The app-wide streamable-HTTP MCP listener (T6), driven by a plain Node http client — NOT by agy.
//
// WHY THIS EXISTS:
//   mcp-http.js serves the SAME request handling as the WebSocket bridge (mcp-bridge.js) over one
//   loopback HTTP listener for the whole app, with a session identified by a Bearer token instead of by
//   a socket. These tests pin the listener's security and lifecycle against a stand-in client: the token
//   gate, the DNS-rebinding guard (Host/Origin), the body cap, per-session isolation, the re-key, the
//   release/shutdown rejection of open diffs, the handler-wrap, server/discover, and the OAuth 404s.
//   Whether agy ever calls the tool is unproven until T8-T10 / G2 (spec, O-T6c / O-BUILD-standin).
'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Point Claude's lock-file home at a scratch dir, like the other bridge tests — the http path does not
// write one, but shutdownMcpServer is shared and this keeps a run from ever touching the real home (#241).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-http-'));
process.env.SWITCHBOARD_STORE_CLAUDE = path.join(tmpHome, 'projects');

const bridge = require('../src/servers/mcp-bridge');
const mcpHttp = require('../src/servers/mcp-http');

const log = { info() {}, debug() {}, warn() {}, error() {} };

/** A window that records what was sent to it — the diff's id travels to the test through `mcp-open-diff`. */
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

/** Did the promise settle within a short grace window? Used to assert a parked call is still open. */
function settledSoon(p) {
  return Promise.race([
    p.then(() => true, () => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 80)),
  ]);
}

/**
 * One HTTP request against the listener. Returns a promise of { status, headers, body } that resolves
 * when the response ends — so a parked openDiff keeps the promise pending, which is the point.
 */
function request(port, { method = 'POST', path: urlPath = '/mcp', token, accept, origin, host, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
    if (accept) headers['accept'] = accept;
    if (origin !== undefined) headers['origin'] = origin;
    if (host !== undefined) headers['host'] = host;
    let payload;
    if (body !== undefined) {
      payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      headers['content-type'] = 'application/json';
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** A GET that opens the SSE channel: resolve as soon as the response headers arrive, then abort. */
function openGet(port, { token, accept = 'text/event-stream' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { accept };
    if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/mcp', headers, agent: false }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers, abort: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

const portOf = (url) => Number(new URL(url).port);
const jsonBody = (r) => JSON.parse(r.body);
const sseData = (r) => {
  const line = r.body.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(line.slice('data:'.length).trim());
};

/** Fire a tools/call openDiff (Claude's `ide` shape); return { done, diffId() } without awaiting the reply. */
function openDiff(port, token, win, id = 1) {
  const base = win.sent.length;
  const done = request(port, {
    token,
    body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'openDiff', arguments: { old_file_path: __filename, new_file_contents: 'x', tab_name: 't' } } },
  });
  return {
    done,
    diffId: async () => {
      await waitFor(() => win.sent.length > base, 'the diff to reach the window');
      return win.sent[win.sent.length - 1].args[1];
    },
  };
}

after(() => { mcpHttp.shutdownListener(); });

test('wrong or absent token is 401; a valid one is let through', async () => {
  const win = fakeWindow();
  const reg = await mcpHttp.registerSession({ sessionId: 's-auth', getWindow: () => win, groups: ['ide'], log });
  const port = portOf(reg.url);
  try {
    assert.equal((await request(port, { body: { jsonrpc: '2.0', id: 1, method: 'initialize' } })).status, 401, 'no token');
    assert.equal((await request(port, { token: 'nope', body: { jsonrpc: '2.0', id: 1, method: 'initialize' } })).status, 401, 'wrong token');
    const ok = await request(port, { token: reg.token, body: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
    assert.equal(ok.status, 200);
    assert.match(jsonBody(ok).result.protocolVersion, /2025-03-26/, 'the valid token reaches the shared handler');
  } finally {
    reg.release();
  }
});

test("a non-loopback Host and any Origin header are refused (the DNS-rebinding guard)", async () => {
  const win = fakeWindow();
  const reg = await mcpHttp.registerSession({ sessionId: 's-guard', getWindow: () => win, groups: ['ide'], log });
  const port = portOf(reg.url);
  try {
    const msg = { jsonrpc: '2.0', id: 1, method: 'initialize' };
    assert.equal((await request(port, { token: reg.token, host: 'evil.example:9999', body: msg })).status, 403, 'foreign Host');
    assert.equal((await request(port, { token: reg.token, origin: 'http://evil.example', body: msg })).status, 403, 'any Origin present');
    // And the guard is not blanket: the loopback Host with no Origin passes.
    assert.equal((await request(port, { token: reg.token, body: msg })).status, 200);
  } finally {
    reg.release();
  }
});

test('an oversize body is refused with 413', async () => {
  const win = fakeWindow();
  const reg = await mcpHttp.registerSession({ sessionId: 's-big', getWindow: () => win, groups: ['ide'], log });
  const port = portOf(reg.url);
  try {
    const big = Buffer.alloc(mcpHttp.MAX_BODY_BYTES + 1024, 0x20);
    assert.equal((await request(port, { token: reg.token, body: big })).status, 413);
    // A body under the cap is still served.
    assert.equal((await request(port, { token: reg.token, body: { jsonrpc: '2.0', id: 1, method: 'initialize' } })).status, 200);
  } finally {
    reg.release();
  }
});

test('the reply shape is a seam: JSON body and SSE event both carry the same result', async () => {
  const win = fakeWindow();
  const reg = await mcpHttp.registerSession({ sessionId: 's-shape', getWindow: () => win, groups: ['ide'], log });
  const port = portOf(reg.url);
  try {
    const asJson = await request(port, { token: reg.token, accept: 'application/json', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.match(String(asJson.headers['content-type']), /application\/json/);
    assert.ok(jsonBody(asJson).result.tools.some((t) => t.name === 'openDiff'), 'json body carries the manifest');

    const asSse = await request(port, { token: reg.token, accept: 'text/event-stream', body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    assert.match(String(asSse.headers['content-type']), /text\/event-stream/);
    assert.match(asSse.body, /^event: message\r?\ndata: /, 'the SSE reply is an `event: message` frame');
    assert.ok(sseData(asSse).result.tools.some((t) => t.name === 'openDiff'), 'and carries the same manifest');
  } finally {
    reg.release();
  }
});

test('two sessions register concurrently and each resolves to its own entry and window', async () => {
  const winA = fakeWindow();
  const winB = fakeWindow();
  const [a, b] = await Promise.all([
    mcpHttp.registerSession({ sessionId: 's-A', getWindow: () => winA, groups: ['ide'], log }),
    mcpHttp.registerSession({ sessionId: 's-B', getWindow: () => winB, groups: ['ide'], log }),
  ]);
  assert.equal(portOf(a.url), portOf(b.url), 'one shared listener, one port');
  const port = portOf(a.url);
  try {
    // A's token drives a diff into A's window; B's into B's — token names the entry, nothing is shared.
    const callA = openDiff(port, a.token, winA, 1);
    await callA.diffId();
    assert.equal(winA.sent.length, 1, 'A reached A');
    assert.equal(winB.sent.length, 0, "and not B");

    const callB = openDiff(port, b.token, winB, 1);
    await callB.diffId();
    assert.equal(winB.sent.length, 1, 'B reached B');

    // Releasing A rejects only A's open diff; B's stays parked.
    a.release();
    assert.match(jsonBody(await callA.done).result.content.map((c) => c.text).join(' '), /DIFF_REJECTED/);
    assert.equal(await settledSoon(callB.done), false, "A's release does not touch B's pending diff");

    b.release();
    assert.match(jsonBody(await callB.done).result.content.map((c) => c.text).join(' '), /DIFF_REJECTED/);
  } finally {
    a.release();
    b.release();
  }
});

test('a re-key moves the token to the new session id (shared rekeyMcpServer)', async () => {
  const win = fakeWindow();
  const reg = await mcpHttp.registerSession({ sessionId: 's-old', getWindow: () => win, groups: ['ide'], log });
  const port = portOf(reg.url);
  try {
    const call = openDiff(port, reg.token, win, 1);
    const diffId = await call.diffId();

    bridge.rekeyMcpServer('s-old', 's-new');

    // The same token still reaches the (re-keyed) entry.
    const list = await request(port, { token: reg.token, body: { jsonrpc: '2.0', id: 9, method: 'tools/list' } });
    assert.equal(list.status, 200);
    assert.ok(jsonBody(list).result.tools.some((t) => t.name === 'openDiff'));

    // And a renderer answer under the NEW id resolves the parked call.
    bridge.resolvePendingDiff('s-new', diffId, 'accept', null);
    assert.match(jsonBody(await call.done).result.content.map((c) => c.text).join(' '), /TAB_CLOSED/);
  } finally {
    bridge.shutdownMcpServer('s-new', log);
  }
});

test('release rejects the open diff and invalidates the token', async () => {
  const win = fakeWindow();
  const reg = await mcpHttp.registerSession({ sessionId: 's-rel', getWindow: () => win, groups: ['ide'], log });
  const port = portOf(reg.url);
  const call = openDiff(port, reg.token, win, 1);
  await call.diffId();

  reg.release();
  assert.match(jsonBody(await call.done).result.content.map((c) => c.text).join(' '), /DIFF_REJECTED/, 'the open diff is rejected');
  assert.equal((await request(port, { token: reg.token, body: { jsonrpc: '2.0', id: 2, method: 'initialize' } })).status, 401, 'the token is now invalid');
});

test('app shutdownAll rejects open diffs and closes the listener', async () => {
  const win = fakeWindow();
  const reg = await mcpHttp.registerSession({ sessionId: 's-quit', getWindow: () => win, groups: ['ide'], log });
  const port = portOf(reg.url);
  const call = openDiff(port, reg.token, win, 1);
  await call.diffId();

  bridge.shutdownAll(log);
  assert.match(jsonBody(await call.done).result.content.map((c) => c.text).join(' '), /DIFF_REJECTED/, 'the diff is rejected on quit');
  // The socket is gone: a new connection is refused.
  await assert.rejects(request(port, { token: reg.token, body: { jsonrpc: '2.0', id: 2, method: 'initialize' } }), /ECONNREFUSED|socket hang up/);
});

test('a handler that throws answers an error and the listener still serves the next request', async () => {
  const win = fakeWindow();
  const reg = await mcpHttp.registerSession({ sessionId: 's-throw', getWindow: () => win, groups: ['ide'], log });
  const port = portOf(reg.url);
  const original = bridge.dispatchMessage;
  try {
    bridge.dispatchMessage = () => { throw new Error('boom'); };
    const errored = await request(port, { token: reg.token, body: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
    assert.equal(errored.status, 200);
    assert.equal(jsonBody(errored).error.code, -32603, 'the throw is answered as a JSON-RPC error');

    bridge.dispatchMessage = original;
    const ok = await request(port, { token: reg.token, body: { jsonrpc: '2.0', id: 2, method: 'initialize' } });
    assert.equal(ok.status, 200, 'and the listener still serves the next request');
    assert.match(jsonBody(ok).result.protocolVersion, /2025-03-26/);
  } finally {
    bridge.dispatchMessage = original;
    reg.release();
  }
});

test('server/discover returns the manifest and the OAuth well-known paths 404', async () => {
  const win = fakeWindow();
  const reg = await mcpHttp.registerSession({ sessionId: 's-disc', getWindow: () => win, groups: ['ide'], log });
  const port = portOf(reg.url);
  try {
    const disc = await request(port, { token: reg.token, body: { jsonrpc: '2.0', id: 1, method: 'server/discover' } });
    assert.equal(disc.status, 200);
    assert.ok(jsonBody(disc).result.tools.some((t) => t.name === 'openDiff'), 'discover carries the tool manifest');

    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const probe = await request(port, { method: 'GET', path: p, token: reg.token });
      assert.equal(probe.status, 404, `${p} is 404`);
    }
  } finally {
    reg.release();
  }
});

test('a GET opens the server-to-client SSE channel rather than 405', async () => {
  const win = fakeWindow();
  const reg = await mcpHttp.registerSession({ sessionId: 's-get', getWindow: () => win, groups: ['ide'], log });
  const port = portOf(reg.url);
  try {
    const stream = await openGet(port, { token: reg.token });
    assert.equal(stream.status, 200, 'the channel opens (not 405)');
    assert.match(String(stream.headers['content-type']), /text\/event-stream/);
    stream.abort();
    // A GET without a token is still gated.
    await assert.rejects(
      openGet(port, { token: undefined }).then((s) => { if (s.status !== 200) throw new Error(String(s.status)); }),
      /401/,
    );
  } finally {
    reg.release();
  }
});
