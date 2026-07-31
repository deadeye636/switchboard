// The MCP bridge addresses a window it resolves per send, not one it captured at spawn (#392).
//
// WHY THIS EXISTS:
//   A bridge lives as long as its session's CLI. A window does not: the main window can be closed and
//   reopened, and a session can be handed to another window. The bridge was given the window ONCE, when
//   the session spawned, and used that value for every notice afterwards — the captured-value shape the
//   ctx rule exists to prevent. After a reopen it addressed a window that no longer existed, and the
//   failure was silent in the worst way: the file never appeared, nothing errored, and a diff sat out
//   its full ten-minute timeout before the CLI heard anything back.
//
//   These tests drive the real WebSocket server the CLI talks to, because the getter only matters at
//   the moment a notice is sent, and a unit call on a handler would not exercise that moment.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

// The bridge writes its lock files under Claude's home; point that at a scratch dir so a test run
// never drops one where a real CLI would find it (#241).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-'));
process.env.SWITCHBOARD_STORE_CLAUDE = path.join(tmpHome, 'projects');

const { startMcpServer, shutdownMcpServer } = require('../src/servers/mcp-bridge');

const log = { info() {}, debug() {}, warn() {}, error() {} };

/** A window that records what was sent to it, and can be told it is gone. */
function fakeWindow(name) {
  const sent = [];
  return {
    name,
    sent,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: { send: (channel, ...args) => sent.push({ channel, args }) },
  };
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

/** Send one openFile call and wait for the bridge's reply, so the assertion cannot race the send. */
function openFile(ws, id, filePath) {
  return new Promise((resolve) => {
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== id) return;
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'openFile', arguments: { filePath } },
    }));
  });
}

test('a notice follows the window the getter names NOW, not the one it named at spawn', async () => {
  const first = fakeWindow('first');
  const second = fakeWindow('second');
  let current = first;

  const server = await startMcpServer('s1', [tmpHome], () => current, log);
  const ws = await connect(server.port, server.authToken);
  try {
    await openFile(ws, 1, __filename);
    assert.equal(first.sent.length, 1, 'the window standing at the time gets it');
    assert.equal(first.sent[0].channel, 'mcp-open-file');

    // What a reopen or a handover looks like from here: the getter starts answering differently.
    current = second;
    await openFile(ws, 2, __filename);

    assert.equal(second.sent.length, 1, 'the next notice follows the getter');
    assert.equal(first.sent.length, 1, 'and the old window hears nothing more');
  } finally {
    ws.close();
    shutdownMcpServer('s1');
  }
});

test('a destroyed window is skipped without throwing, and the CLI still gets its answer', async () => {
  const win = fakeWindow('doomed');
  const server = await startMcpServer('s2', [tmpHome], () => win, log);
  const ws = await connect(server.port, server.authToken);
  try {
    win.destroyed = true;
    const reply = await openFile(ws, 1, __filename);

    assert.equal(win.sent.length, 0);
    assert.equal(reply.result.content[0].text, 'ok',
      'the call is answered either way — an unanswered one hangs the CLI');
  } finally {
    ws.close();
    shutdownMcpServer('s2');
  }
});

test('no window at all is not an error', async () => {
  const server = await startMcpServer('s3', [tmpHome], () => null, log);
  const ws = await connect(server.port, server.authToken);
  try {
    const reply = await openFile(ws, 1, __filename);
    assert.equal(reply.result.content[0].text, 'ok');
  } finally {
    ws.close();
    shutdownMcpServer('s3');
  }
});
