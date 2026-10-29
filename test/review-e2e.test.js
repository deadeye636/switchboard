// End to end for the review tools, against a STAND-IN client (#507 slice 2b, spec 39).
//
// WHY THIS EXISTS:
//   Every piece is tested alone (the runner, the tool group, the composer, the spawn gate). This file walks the whole
//   chain once: the REAL claude-native descriptor's `--mcp-config` emitter, the composer and the "own server" source,
//   the real HTTP listener and bridge, and the real review runner. Only the review session itself is a stand-in: a fake
//   `openTerminal` / `agentRpc` that plays a scripted session (busy, a refused ask, an assistant entry, idle) when the
//   test says so. A plain Node `http` client plays the calling CLI by parsing the config file the injection wrote.
//   Whether a real CLI sends this traffic, and what a real target answers, is the click test's question (spec 39,
//   "As built").
'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-review-e2e-'));
process.env.SWITCHBOARD_STORE_CLAUDE = path.join(tmpHome, 'projects');
fs.mkdirSync(path.join(tmpHome, 'project'));
const PROJECT = fs.realpathSync(path.join(tmpHome, 'project'));

const mcpHttp = require('../src/servers/mcp-http');
const { composeMcpInjection, ownServerSource } = require('../src/app/mcp-inject');
const { createReviewRunner, forgetRunning, SENTENCES, PREAMBLE } = require('../src/app/review-runner');
const { stopSession } = require('../src/app/terminal/stop-session');
const claudeNative = require('../src/backends/claude-native');

const log = { info() {}, debug() {}, warn() {}, error() {} };
const bindingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-review-e2e-bind-'));

after(() => {
  mcpHttp.shutdownListener();
  fs.rmSync(bindingDir, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

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

let nextRpc = 1;
const call = (client, name, args = {}, token) =>
  rpc(client, { jsonrpc: '2.0', id: nextRpc++, method: 'tools/call', params: { name, arguments: args } }, token);
const dataOf = (r) => JSON.parse(r.json.result.content[0].text);

// The calling CLI's side: the url and token out of the `--mcp-config` file the launch names.
function clientOf(injection) {
  assert.equal(injection.args[0], '--mcp-config');
  const conf = JSON.parse(fs.readFileSync(injection.args[1], 'utf8'));
  const entry = conf.mcpServers.switchboard;
  return { url: entry.url, token: entry.headers.Authorization.replace(/^Bearer /, '') };
}

// A world: the caller's live session, the stand-in review session, the runner, and a registration on the real listener.
async function world(tag) {
  const activeSessions = new Map([[`caller-${tag}`, { _terminalTag: `tag-${tag}`, exited: false }]]);
  const observers = new Map();
  const sent = [];
  const answers = [];
  const ctx = {
    activeSessions,
    listTargets: () => [{ id: 'pi-native', label: 'Pi (native)', options: { approvalGate: true } }],
    getAppQuitting: () => false,
    stopSession,
    timeline: { recordLifecycle() {} },
    log,
    openTerminal: async (id, projectPath, isNew, opts) => {
      const s = { _terminalTag: `rev-${id}`, exited: false, kills: 0, opts, projectPath };
      s.pty = { kill: () => { s.kills += 1; s.exited = true; } };
      activeSessions.set(id, s);
      return { ok: true };
    },
    agentRpc: {
      observe: (id, obs) => { observers.set(id, obs); return true; },
      sendTurn: async (id, payload) => { sent.push({ id, payload }); return { ok: true }; },
      abortTurn: async () => ({ ok: true }),
    },
  };
  const runner = createReviewRunner({ projectPath: PROJECT, callerTag: `tag-${tag}`, ctx });
  const source = ownServerSource({
    backend: claudeNative, groups: ['review'], review: runner,
    registerSession: mcpHttp.registerSession, sessionId: `caller-${tag}`, projectPath: PROJECT, getWindow: () => null, log,
  });
  const injection = await composeMcpInjection({
    backend: claudeNative, ctx: { log }, dir: bindingDir, cwd: PROJECT, tag: `caller-${tag}`, options: {}, sources: [source],
  });
  assert.ok(injection, 'the review group registers and the emitter writes its row');
  const reviewSession = () => [...activeSessions.entries()].find(([id]) => !id.startsWith('caller-'));
  // The scripted turn: busy, an ask the runner refuses, the reply, idle.
  const play = (reply) => {
    const [id] = reviewSession();
    const obs = observers.get(id);
    obs.onBusy(true);
    answers.push(obs.onAsk({ id: 'q1', kind: 'approval' }));
    obs.onEntry({ type: 'assistant' }, reply);
    obs.onBusy(false, null);
  };
  return { client: clientOf(injection), injection, runner, sent, answers, reviewSession, play, release: () => injection.release() };
}

test('a caller lists the two tools, starts a review, polls running, then reads the answer', async () => {
  forgetRunning();
  const w = await world('a');
  const list = await rpc(w.client, { jsonrpc: '2.0', id: nextRpc++, method: 'tools/list' });
  const tools = list.json.result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['startReview', 'reviewResult']);
  assert.deepEqual(tools[0].inputSchema.properties.backend.enum, ['pi-native']);

  const started = await call(w.client, 'startReview', { backend: 'pi-native', prompt: 'Review src/a.js.' });
  assert.equal(started.json.result.isError, undefined, JSON.stringify(started.json));
  const accepted = dataOf(started);
  assert.equal(accepted.state, 'running');
  assert.equal(w.sent[0].payload.text, PREAMBLE + 'Review src/a.js.');
  const [reviewId, session] = w.reviewSession();
  assert.equal(session.opts.spawnedBy, 'caller-a', 'the launch names its caller (depth 1)');
  assert.equal(session.opts.approvalGate, true, 'with the target\'s read-only profile');

  const running = dataOf(await call(w.client, 'reviewResult', { id: accepted.id }));
  assert.equal(running.state, 'running');
  assert.equal(running.pollAfterSeconds, 30);

  const second = await call(w.client, 'startReview', { backend: 'pi-native', prompt: 'again' });
  assert.equal(second.json.result.isError, true);
  assert.match(second.json.result.content[0].text, new RegExp(accepted.id), 'the running id is named');

  w.play('The file is fine.');
  await new Promise((r) => setImmediate(r));
  const done = dataOf(await call(w.client, 'reviewResult', { id: accepted.id }));
  assert.equal(done.state, 'done');
  assert.equal(done.text, 'The file is fine.');
  assert.equal(done.refusedActions, 1);
  assert.equal(done.sessionId, reviewId);
  assert.deepEqual(w.answers, [{ cancelled: true }], 'the ask was refused');
  assert.equal(session.kills, 1, 'the review session is stopped once');
  w.release();
});

test('another registration\'s token reads nothing of this one, and a bad token is refused', async () => {
  forgetRunning();
  const a = await world('b');
  const b = await world('c');
  const started = dataOf(await call(a.client, 'startReview', { backend: 'pi-native', prompt: 'x' }));
  const foreign = await call(a.client, 'reviewResult', { id: started.id }, b.client.token);
  assert.equal(foreign.json.result.isError, true);
  assert.equal(foreign.json.result.content[0].text, SENTENCES.unknownId);
  const bad = await call(a.client, 'reviewResult', { id: started.id }, 'not-a-token');
  assert.equal(bad.status, 401);
  a.release();
  b.release();
});

test('releasing the caller\'s registration stops a running review and closes the door', async () => {
  forgetRunning();
  const w = await world('d');
  const started = dataOf(await call(w.client, 'startReview', { backend: 'pi-native', prompt: 'x' }));
  const [, session] = w.reviewSession();
  w.release();
  assert.equal(session.kills, 1, 'the running review is stopped');
  const after = await call(w.client, 'reviewResult', { id: started.id });
  assert.equal(after.status, 401, 'the token went with the registration');
  w.release();
  assert.equal(session.kills, 1, 'a second release does nothing');
});
