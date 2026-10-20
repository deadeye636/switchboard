// The MCP bridge's request handling is transport-neutral, and Claude's WebSocket path is byte-identical
// across the T5 refactor (the reply-callback seam, the `kind`, the tool groups).
//
// WHY THIS EXISTS:
//   T5 split the tool-call logic from the WebSocket write so the same handling can later answer an HTTP
//   transport. The one promise that cannot be allowed to slip is that a Claude CLI, which speaks the
//   WebSocket dialect, sees exactly the same bytes it saw before. So this is a GOLDEN test: the oracle is
//   the ORIGINAL module, read straight out of git (`git show <ORACLE_REF>:src/servers/mcp-bridge.js`) —
//   never the edited file — and the edited module has to produce frame-for-frame identical replies for the
//   five shapes a Claude client exercises: initialize, tools/list, an openDiff accept, an openDiff reject
//   and a timeout. The lock-file content and the auth header are pinned too.
//
//   THE ORACLE REF IS PINNED to the T4 commit — the last state of mcp-bridge.js before T5. It must NOT be
//   `HEAD`: once T5 is committed HEAD would become the edited module and the frame comparison would turn
//   trivially green. A deliberate future change to Claude's wire bytes updates ORACLE_REF with its reason.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const WebSocket = require('ws');

// The bridge writes its lock files under Claude's home; point that at a scratch dir so a test run never
// drops one where a real CLI would find it (#241). ideDir is the parent of the projects store, + 'ide'.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-tn-'));
process.env.SWITCHBOARD_STORE_CLAUDE = path.join(tmpHome, 'projects');
const ideDir = path.join(tmpHome, 'ide');

const repoRoot = path.resolve(__dirname, '..');

// The golden oracle is pinned to the last state of mcp-bridge.js before T5 (the T4 commit), NOT HEAD —
// see the header. A deliberate change to Claude's wire bytes updates this ref with its reason.
const ORACLE_REF = '4c41fc20';

// The edited module under test.
const edited = require('../src/servers/mcp-bridge');

// The oracle: the ORIGINAL module, straight from git. It is written to a scratch file so it loads as its
// own module instance (its own `servers` Map, independent of the edited one). Its relative requires are
// rewritten to absolute paths of the real repo modules so the copy resolves them from anywhere on disk.
function loadOracle() {
  let src = execFileSync('git', ['show', `${ORACLE_REF}:src/servers/mcp-bridge.js`], { cwd: repoRoot }).toString();
  const abs = (p) => JSON.stringify(path.resolve(repoRoot, p));
  src = src
    .replace("require('ws')", `require(${JSON.stringify(require.resolve('ws'))})`)
    .replace("require('../perf')", `require(${abs('src/perf.js')})`)
    .replace("require('../app/network-path')", `require(${abs('src/app/network-path.js')})`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-oracle-'));
  const file = path.join(dir, 'mcp-bridge-oracle.js');
  fs.writeFileSync(file, src, 'utf8');
  return require(file);
}

const log = { info() {}, debug() {}, warn() {}, error() {} };

/** A window that records what was sent to it — the diff's id travels to the test through `mcp-open-diff`. */
function fakeWindow() {
  const sent = [];
  const win = {
    sent,
    isDestroyed() { return false; },
    webContents: {
      send: (channel, ...args) => sent.push({ channel, args }),
      isLoading: () => false,
      once() {},
    },
  };
  return win;
}

/** Connect as the CLI does: the `mcp` subprotocol plus the auth header from the lock file. */
function connect(port, authToken) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, 'mcp', {
    headers: { 'x-claude-code-ide-authorization': authToken },
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Send a request and resolve with the RAW reply string for its id — the bytes, not a parsed object. */
function rpc(ws, msg) {
  return new Promise((resolve) => {
    const onMessage = (raw) => {
      const text = raw.toString();
      if (JSON.parse(text).id !== msg.id) return;
      ws.off('message', onMessage);
      resolve(text);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(msg));
  });
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

// The bridge's diff timeout is ten minutes. To exercise the timeout frame without waiting it out, a long
// timer is briefly shortened — applied identically to both modules, so whatever it does cancels out in the
// oracle-vs-edited comparison. Only delays this large exist in this window (ws sets no multi-minute timer),
// so nothing else is touched. The threshold mirrors DIFF_TIMEOUT_MS (10 * 60 * 1000) in the module.
const realSetTimeout = global.setTimeout;
function withShortenedDiffTimeout(fn) {
  global.setTimeout = function (cb, delay, ...rest) {
    return realSetTimeout(cb, delay >= 60000 ? 15 : delay, ...rest);
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => { global.setTimeout = realSetTimeout; });
}

/** Drive one openDiff, hand the renderer-side action through `resolvePendingDiff`, return the RAW reply. */
async function openDiffResolved(mod, ws, id, win, sessionId, action) {
  const base = win.sent.length;
  const reply = rpc(ws, {
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'openDiff', arguments: { old_file_path: __filename, new_file_contents: 'x', tab_name: 't' } },
  });
  await waitFor(() => win.sent.length > base, 'the diff to reach the window');
  const diffId = win.sent[win.sent.length - 1].args[1];
  mod.resolvePendingDiff(sessionId, diffId, action, null);
  return reply;
}

/** Capture the five reply frames (and the lock file) a Claude client gets from a given module. */
async function capture(mod, sessionId) {
  const win = fakeWindow();
  const server = await mod.startMcpServer(sessionId, [tmpHome], () => win, log);
  const lock = JSON.parse(fs.readFileSync(path.join(ideDir, `${server.port}.lock`), 'utf8'));
  const ws = await connect(server.port, server.authToken);
  try {
    const initialize = await rpc(ws, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const toolsList = await rpc(ws, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const accept = await openDiffResolved(mod, ws, 3, win, sessionId, 'accept');
    const acceptText = await accept;
    const reject = await openDiffResolved(mod, ws, 4, win, sessionId, 'reject');
    const rejectText = await reject;

    // The timeout path, with the long timer shortened.
    const timeoutText = await withShortenedDiffTimeout(() => {
      const base = win.sent.length;
      const reply = rpc(ws, {
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'openDiff', arguments: { old_file_path: __filename, new_file_contents: 'x', tab_name: 't' } },
      });
      return waitFor(() => win.sent.length > base, 'the timeout diff to be sent').then(() => reply);
    });

    return { initialize, toolsList, accept: acceptText, reject: rejectText, timeout: timeoutText, lock };
  } finally {
    ws.close();
    mod.shutdownMcpServer(sessionId);
  }
}

test('a Claude WebSocket client sees byte-identical frames before and after the seam', async () => {
  const oracle = loadOracle();
  const before = await capture(oracle, 'oracle-1');
  const after = await capture(edited, 'edited-1');

  assert.equal(after.initialize, before.initialize, 'initialize reply is byte-identical');
  assert.equal(after.toolsList, before.toolsList, 'tools/list reply is byte-identical');
  assert.equal(after.accept, before.accept, 'openDiff accept reply is byte-identical');
  assert.equal(after.reject, before.reject, 'openDiff reject reply is byte-identical');
  assert.equal(after.timeout, before.timeout, 'openDiff timeout reply is byte-identical');

  // And the frames really are the Claude shapes, so a byte match is a match to something real.
  assert.match(after.initialize, /"protocolVersion":"2025-03-26"/);
  assert.match(after.toolsList, /"openDiff"/);
  assert.match(after.accept, /TAB_CLOSED/);
  assert.match(after.reject, /DIFF_REJECTED/);
  assert.match(after.timeout, /DIFF_REJECTED/);
});

test('the lock file content is untouched by the seam', async () => {
  const oracle = loadOracle();
  const before = await capture(oracle, 'oracle-2');
  const after = await capture(edited, 'edited-2');

  // The auth token is random per server, so compare everything else. `transport: 'ws'`, the ideName and
  // the rest of the shape are what a Claude client reads to connect.
  const strip = (lock) => { const { authToken, ...rest } = lock; return rest; };
  assert.deepEqual(strip(after.lock), strip(before.lock), 'the lock file shape is unchanged');
  assert.equal(after.lock.transport, 'ws');
  assert.equal(after.lock.ideName, 'Switchboard');
  assert.equal(after.lock.runningInWindows, false);
  assert.equal(typeof after.lock.authToken, 'string', 'and it still carries an auth token');
});

test('the auth header is untouched — the exact header name still gates the connection', async () => {
  // A successful connect in the tests above already uses `x-claude-code-ide-authorization`; here the other
  // half: a wrong token on that header is refused, so the header the bridge checks is unchanged.
  const server = await edited.startMcpServer('auth-1', [tmpHome], () => fakeWindow(), log);
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, 'mcp', {
      headers: { 'x-claude-code-ide-authorization': 'not-the-token' },
    });
    const code = await new Promise((resolve) => {
      ws.once('close', (c) => resolve(c));
      ws.once('error', () => {});
    });
    assert.equal(code, 4001, 'a bad token is closed with 4001 Unauthorized');
  } finally {
    edited.shutdownMcpServer('auth-1');
  }
});
