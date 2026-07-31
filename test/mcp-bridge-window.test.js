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

const { startMcpServer, shutdownMcpServer, hasPendingDiffsForWindow, rejectPendingDiffsForWindow } = require('../src/servers/mcp-bridge');

const log = { info() {}, debug() {}, warn() {}, error() {} };

/**
 * A window that records what was sent to it, can be told it is gone, and can be caught mid-load —
 * Electron drops a send to a renderer that has not loaded yet, silently, which is a real path here
 * (a window restored at launch registers its sessions before it finishes loading).
 */
function fakeWindow(name) {
  const sent = [];
  const loadListeners = [];
  const win = {
    name,
    sent,
    destroyed: false,
    loading: false,
    isDestroyed() { return win.destroyed; },
    finishLoad() {
      win.loading = false;
      loadListeners.splice(0).forEach((fn) => fn());
    },
    waitingForLoad: () => loadListeners.length,
    webContents: {
      send: (channel, ...args) => sent.push({ channel, args }),
      isLoading: () => win.loading,
      once: (event, fn) => { if (event === 'did-finish-load') loadListeners.push(fn); },
    },
  };
  return win;
}

/**
 * Wait for something the bridge does asynchronously — the call travels over a real socket, so a single
 * turn of the loop is not enough and a fixed sleep would be a race dressed up as a delay.
 */
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

// --- #393: a diff opens where the session is, and a dying window answers for it -------------------
//
// While a diff could only live in the main window, nothing had to answer for it: that window's only
// death was the app quitting, and quit resolves everything on its way out. Opening the review where
// the user is looking breaks that accident — a window of its own is closed by hand, or auto-closed
// when its last session leaves, while the CLI's tools/call is still open. Nobody else can answer it,
// and the fallback is ten minutes of silence.

/** Drive one openDiff and hand back the promise, so the test can act while the call is still open. */
function openDiff(ws, id, filePath) {
  const replies = [];
  const onMessage = (raw) => replies.push(JSON.parse(raw.toString()));
  ws.on('message', onMessage);
  ws.send(JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'openDiff', arguments: { old_file_path: filePath, new_file_contents: 'x', tab_name: 't' } },
  }));
  return {
    replies,
    /** Resolve once the bridge answers this call — the whole point is that it does. */
    answered: () => new Promise((resolve) => {
      const check = () => {
        const hit = replies.find((m) => m.id === id);
        if (hit) { ws.off('message', onMessage); resolve(hit); }
        else setImmediate(check);
      };
      check();
    }),
  };
}

test('a diff is sent to the window that renders the session, not to the main one', async () => {
  const main = fakeWindow('main');
  const owner = fakeWindow('owner');
  const server = await startMcpServer('d1', [tmpHome], () => owner, log);
  const ws = await connect(server.port, server.authToken);
  try {
    const call = openDiff(ws, 1, __filename);
    // The call stays open until someone answers it; only the SEND has to have happened by now.
    await waitFor(() => owner.sent.length > 0, "the diff to reach the owning window");
    assert.equal(owner.sent.length, 1);
    assert.equal(owner.sent[0].channel, 'mcp-open-diff');
    assert.equal(main.sent.length, 0, 'the review belongs where the user is looking');

    rejectPendingDiffsForWindow(owner, log);
    await call.answered();
  } finally {
    ws.close();
    shutdownMcpServer('d1');
  }
});

test('closing the window holding a diff answers the CLI instead of leaving it waiting', async () => {
  const owner = fakeWindow('owner');
  const server = await startMcpServer('d2', [tmpHome], () => owner, log);
  const ws = await connect(server.port, server.authToken);
  try {
    const call = openDiff(ws, 1, __filename);
    await waitFor(() => owner.sent.length > 0, "the diff to be sent");

    owner.destroyed = true;                       // the user clicked the title-bar X
    const answered = rejectPendingDiffsForWindow(owner, log);
    assert.equal(answered, 1, 'the diff it was showing is answered, not orphaned');

    const reply = await call.answered();
    assert.match(JSON.stringify(reply.result), /DIFF_REJECTED|reject/i,
      'and the CLI is told it was rejected rather than sitting out the timeout');
  } finally {
    ws.close();
    shutdownMcpServer('d2');
  }
});

test('a window that holds no diff answers nothing, and other windows keep theirs', async () => {
  const winA = fakeWindow('A');
  const winB = fakeWindow('B');
  let current = winA;
  const server = await startMcpServer('d3', [tmpHome], () => current, log);
  const ws = await connect(server.port, server.authToken);
  try {
    const call = openDiff(ws, 1, __filename);
    await waitFor(() => winA.sent.length > 0, "the diff to be sent");

    assert.equal(rejectPendingDiffsForWindow(winB, log), 0, 'B was showing nothing');
    assert.equal(rejectPendingDiffsForWindow(null, log), 0, 'and no window at all is not an error');

    assert.equal(rejectPendingDiffsForWindow(winA, log), 1, 'A was');
    await call.answered();
  } finally {
    ws.close();
    shutdownMcpServer('d3');
  }
});

test('a diff stays answerable in the window it opened in, even after the session moves', async () => {
  // The view does not follow the session. Only the window actually showing it can answer for it, so
  // "which window renders the session now" is the wrong question once the diff is on screen.
  const opened = fakeWindow('opened');
  const moved = fakeWindow('moved');
  let current = opened;
  const server = await startMcpServer('d4', [tmpHome], () => current, log);
  const ws = await connect(server.port, server.authToken);
  try {
    const call = openDiff(ws, 1, __filename);
    await waitFor(() => opened.sent.length > 0, "the diff to be sent");
    current = moved;                              // move-session-to-window happened meanwhile

    assert.equal(rejectPendingDiffsForWindow(moved, log), 0, 'the new window never showed it');
    assert.equal(rejectPendingDiffsForWindow(opened, log), 1, 'the one that did still answers');
    await call.answered();
  } finally {
    ws.close();
    shutdownMcpServer('d4');
  }
});

test('a window still loading gets the diff once it has loaded, rather than never', async () => {
  const win = fakeWindow('loading');
  win.loading = true;
  const server = await startMcpServer('d5', [tmpHome], () => win, log);
  const ws = await connect(server.port, server.authToken);
  try {
    const call = openDiff(ws, 1, __filename);
    await waitFor(() => win.waitingForLoad() > 0, "the send to be deferred until the load");
    assert.equal(win.sent.length, 0, 'a send to a renderer that does not exist yet is dropped silently');

    win.finishLoad();
    assert.equal(win.sent.length, 1, 'so it waits for the load instead');
    assert.equal(win.sent[0].channel, 'mcp-open-diff');

    rejectPendingDiffsForWindow(win, log);
    await call.answered();
  } finally {
    ws.close();
    shutdownMcpServer('d5');
  }
});

test('a window showing an unanswered review says so, so it is not taken down under one', async () => {
  // Answering afterwards is the safety net. Not destroying the window mid-decision is the behaviour —
  // and in grid mode nothing else knows the diff is there, because that mode reports no views at all.
  const win = fakeWindow('holder');
  const other = fakeWindow('other');
  const server = await startMcpServer('d6', [tmpHome], () => win, log);
  const ws = await connect(server.port, server.authToken);
  try {
    assert.equal(hasPendingDiffsForWindow(win), false, 'nothing open yet');

    const call = openDiff(ws, 1, __filename);
    await waitFor(() => win.sent.length > 0, 'the diff to be sent');

    assert.equal(hasPendingDiffsForWindow(win), true);
    assert.equal(hasPendingDiffsForWindow(other), false, 'and only the window actually showing it');
    assert.equal(hasPendingDiffsForWindow(null), false);

    rejectPendingDiffsForWindow(win, log);
    assert.equal(hasPendingDiffsForWindow(win), false, 'answered means no longer held');
    await call.answered();
  } finally {
    ws.close();
    shutdownMcpServer('d6');
  }
});
