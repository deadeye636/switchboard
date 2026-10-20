// The agent-facing `diff` tool group (T7), driven by a plain Node http client — NOT by agy.
//
// WHY THIS EXISTS:
//   An http registration may open the `diff` group: one tool, `openDiff`, with its own schema
//   (`filePath`, `newContent`, `tabName?`) and text answers ACCEPTED / REJECTED / ACCEPTED_WITH_EDITS.
//   It reuses the pending-diff lifecycle of Claude's `ide` openDiff but is stricter about paths (the path
//   is the model's) and never writes a file. Claude's own group is pinned elsewhere
//   (mcp-bridge-transport-neutral.test.js, mcp-bridge-window.test.js).
'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-diff-'));
process.env.SWITCHBOARD_STORE_CLAUDE = path.join(tmpHome, 'projects');

const bridge = require('../src/servers/mcp-bridge');
const mcpHttp = require('../src/servers/mcp-http');

const log = { info() {}, debug() {}, warn() {}, error() {} };

const project = fs.mkdtempSync(path.join(tmpHome, 'project-'));
const outside = fs.mkdtempSync(path.join(tmpHome, 'outside-'));
fs.writeFileSync(path.join(project, 'a.txt'), 'old a\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');

function fakeWindow() {
  const sent = [];
  return {
    sent,
    isDestroyed() { return false; },
    webContents: { send: (channel, ...args) => sent.push({ channel, args }), isLoading: () => false, once() {} },
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

function post(port, token, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/mcp', agent: false,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function setup(extra = {}) {
  const win = fakeWindow();
  const sessionId = `diff-${Math.random().toString(36).slice(2)}`;
  const reg = await mcpHttp.registerSession({
    sessionId, projectPath: project, getWindow: () => win, groups: ['diff'], log, ...extra,
  });
  assert.ok(reg.url, 'registered');
  const port = Number(new URL(reg.url).port);
  const call = (args, id = 1) => post(port, reg.token, {
    jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'openDiff', arguments: args },
  });
  return { win, sessionId, reg, port, call };
}

/** Wait for the n-th diff to reach the window; return its id and payload. */
async function nthDiff(win, n) {
  await waitFor(() => win.sent.filter((s) => s.channel === 'mcp-open-diff').length >= n, `diff ${n}`);
  const s = win.sent.filter((x) => x.channel === 'mcp-open-diff')[n - 1];
  return { diffId: s.args[1], payload: s.args[2] };
}

const textOf = (r) => r.json.result.content[0].text;

after(() => {
  bridge.shutdownAll(log);
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

test('tools/list exposes only the agent-facing openDiff', async () => {
  const { reg, port } = await setup();
  const r = await post(port, reg.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = r.json.result.tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'openDiff');
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties), ['filePath', 'newContent', 'tabName']);
  assert.deepEqual(tools[0].inputSchema.required, ['filePath', 'newContent']);
  assert.match(tools[0].description, /does NOT write the file/);
  reg.release();
});

test('(a)(f) a relative path resolves against the project; tab name defaults to the file name', async () => {
  const { win, sessionId, reg, call } = await setup();
  const done = call({ filePath: 'a.txt', newContent: 'new a\n' });
  const { diffId, payload } = await nthDiff(win, 1);
  assert.equal(payload.oldFilePath, path.join(project, 'a.txt'));
  assert.equal(payload.oldContent, 'old a\n');
  assert.equal(payload.newContent, 'new a\n');
  assert.equal(payload.tabName, 'a.txt');
  bridge.resolvePendingDiff(sessionId, diffId, 'accept', null);
  assert.equal(textOf(await done), 'ACCEPTED');
  reg.release();
});

test('an explicit tabName is kept', async () => {
  const { win, sessionId, reg, call } = await setup();
  const done = call({ filePath: 'a.txt', newContent: 'x', tabName: 'My review' });
  const { diffId, payload } = await nthDiff(win, 1);
  assert.equal(payload.tabName, 'My review');
  bridge.resolvePendingDiff(sessionId, diffId, 'reject', null);
  await done;
  reg.release();
});

test('(b) a path outside the project is refused with an error and no diff', async () => {
  const { win, reg, call } = await setup();
  for (const filePath of [path.join(outside, 'secret.txt'), path.join('..', path.basename(outside), 'secret.txt')]) {
    const r = await call({ filePath, newContent: 'x' });
    assert.ok(r.json.error, `refused: ${filePath}`);
    assert.equal(r.json.error.code, -32602);
  }
  assert.equal(win.sent.length, 0);
  reg.release();
});

test('(b) a link out of the project is outside it (real-path containment)', async (t) => {
  const link = path.join(project, 'escape');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch {
    return t.skip('cannot create a link here');
  }
  const { win, reg, call } = await setup();
  const r = await call({ filePath: 'escape/secret.txt', newContent: 'x' });
  assert.ok(r.json.error);
  assert.equal(win.sent.length, 0);
  reg.release();
  fs.rmSync(link, { recursive: true, force: true });
});

test('(c) a foreign network path is refused with an error', async () => {
  const { win, reg, call } = await setup();
  const r = await call({ filePath: '\\\\evil-host\\share\\f.txt', newContent: 'x' });
  assert.ok(r.json.error);
  assert.equal(r.json.error.code, -32602);
  assert.equal(win.sent.length, 0);
  reg.release();
});

test('bad arguments are an error', async () => {
  const { reg, call } = await setup();
  assert.ok((await call({ newContent: 'x' })).json.error);
  assert.ok((await call({ filePath: 'a.txt' })).json.error);
  reg.release();
});

test('(d) accept, reject and accept-with-edits give the specified text', async () => {
  const { win, sessionId, reg, call } = await setup();
  const cases = [['accept', null, 'ACCEPTED'], ['reject', null, 'REJECTED'], ['accept-edited', 'edited body', 'ACCEPTED_WITH_EDITS\nedited body']];
  let n = 0;
  for (const [action, content, expected] of cases) {
    n++;
    const done = call({ filePath: 'a.txt', newContent: 'x' }, n);
    const { diffId } = await nthDiff(win, n);
    bridge.resolvePendingDiff(sessionId, diffId, action, content);
    assert.equal(textOf(await done), expected);
  }
  reg.release();
});

test('(e) two diffs in flight for one session both resolve', async () => {
  const { win, sessionId, reg, call } = await setup();
  const first = call({ filePath: 'a.txt', newContent: '1' }, 1);
  const second = call({ filePath: 'a.txt', newContent: '2' }, 2);
  const d1 = await nthDiff(win, 1);
  const d2 = await nthDiff(win, 2);
  assert.notEqual(d1.diffId, d2.diffId);
  bridge.resolvePendingDiff(sessionId, d2.diffId, 'reject', null);
  bridge.resolvePendingDiff(sessionId, d1.diffId, 'accept', null);
  assert.equal(textOf(await first), 'ACCEPTED');
  assert.equal(textOf(await second), 'REJECTED');
  reg.release();
});

test('(g) the server writes nothing to disk', async () => {
  const before = fs.readdirSync(project).sort();
  const { win, sessionId, reg, call } = await setup();
  const done = call({ filePath: 'a.txt', newContent: 'changed' });
  const { diffId } = await nthDiff(win, 1);
  bridge.resolvePendingDiff(sessionId, diffId, 'accept-edited', 'edited');
  await done;
  const newFile = call({ filePath: 'brand-new.txt', newContent: 'fresh' }, 2);
  const d2 = await nthDiff(win, 2);
  assert.equal(d2.payload.oldContent, '');
  bridge.resolvePendingDiff(sessionId, d2.diffId, 'accept', null);
  await newFile;
  assert.equal(fs.readFileSync(path.join(project, 'a.txt'), 'utf8'), 'old a\n');
  assert.deepEqual(fs.readdirSync(project).sort(), before);
  reg.release();
});

test('(h) a registration-set wait cap shorter than the default is honoured', async () => {
  const { reg, call } = await setup({ diffTimeoutMs: 40 });
  const started = Date.now();
  const r = await call({ filePath: 'a.txt', newContent: 'x' });
  assert.equal(textOf(r), 'REJECTED');
  assert.ok(Date.now() - started < 2000);
  reg.release();
});
