// End to end for the task tools, against a STAND-IN client (#804, spec 41, T6 + T7).
//
// WHY THIS EXISTS:
//   Every piece is tested alone (the runner, the tool group, the composer, the spawn gate). This file walks the whole
//   chain once: the REAL claude-native descriptor's `--mcp-config` emitter, the composer and the "own server" source,
//   the real HTTP listener and bridge, and the real task runner. Only the worktree service, the trust store and the task
//   session are stand-ins: a fake `checkouts`, `projectTrust` and `openTerminal` / `agentRpc` that play a scripted
//   session (busy, an open question, the user's answer, the summary, idle). A plain Node `http` client plays the calling
//   CLI by parsing the config file the injection wrote. Whether a real CLI sends this traffic, and what a real target
//   does, is the click test's question.
'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-task-e2e-'));
process.env.SWITCHBOARD_STORE_CLAUDE = path.join(tmpHome, 'projects');
fs.mkdirSync(path.join(tmpHome, 'project'));
const PROJECT = fs.realpathSync(path.join(tmpHome, 'project'));
const WT = path.join(tmpHome, 'data', 'wt', 'the-task');

const mcpHttp = require('../src/servers/mcp-http');
const { composeMcpInjection, ownServerSource } = require('../src/app/mcp-inject');
const { createTaskRunner, forgetRunning, SENTENCES } = require('../src/app/task-runner');
const { stopSession } = require('../src/app/terminal/stop-session');
const claudeNative = require('../src/backends/claude-native');

const log = { info() {}, debug() {}, warn() {}, error() {} };
const bindingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-task-e2e-bind-'));

after(() => {
  mcpHttp.shutdownListener();
  fs.rmSync(bindingDir, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function rpc(client, body) {
  const u = new URL(client.url);
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: u.hostname, port: u.port, method: 'POST', path: u.pathname, agent: false,
      headers: { authorization: `Bearer ${client.token}`, 'content-type': 'application/json', 'content-length': payload.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

let nextRpc = 1;
const call = (client, name, args = {}) =>
  rpc(client, { jsonrpc: '2.0', id: nextRpc++, method: 'tools/call', params: { name, arguments: args } });
const dataOf = (r) => JSON.parse(r.json.result.content[0].text);

function clientOf(injection) {
  assert.equal(injection.args[0], '--mcp-config');
  const conf = JSON.parse(fs.readFileSync(injection.args[1], 'utf8'));
  const entry = conf.mcpServers.switchboard;
  return { url: entry.url, token: entry.headers.Authorization.replace(/^Bearer /, '') };
}

test('a caller lists the task tools, starts a task in its worktree, sees needs-input, then reads summary and branch', async () => {
  forgetRunning();
  const activeSessions = new Map([['caller-a', { _terminalTag: 'tag-a', exited: false }]]);
  const observers = new Map();
  const sent = [];
  const answered = [];
  const trustSet = [];
  const ctx = {
    activeSessions,
    listTargets: () => [{ id: 'claude-native', label: 'Claude (GUI)', options: claudeNative.taskProfile().options }],
    getAppQuitting: () => false,
    stopSession,
    timeline: { recordLifecycle() {} },
    log,
    projectTrust: () => ({ get: (p) => (p === PROJECT ? true : null), set: (p, v) => { trustSet.push([p, v]); return { ok: true }; } }),
    trustRequired: () => true,
    checkouts: {
      create: async ({ projectPath, taskId }) => ({ ok: true, worktreePath: WT, repoPath: projectPath, branch: `switchboard/task-${taskId}`, baseCommit: 'abc' }),
      remove: async () => ({ ok: true, removed: true }),
    },
    openTerminal: async (id, cwd, isNew, opts) => {
      const s = { _terminalTag: `task-${id}`, exited: false, kills: 0, opts, cwd };
      s.pty = { kill: () => { s.kills += 1; s.exited = true; } };
      activeSessions.set(id, s);
      return { ok: true };
    },
    agentRpc: {
      observe: (id, obs) => { observers.set(id, obs); return true; },
      sendTurn: async (id, payload) => { sent.push({ id, payload }); return { ok: true }; },
      abortTurn: async () => ({ ok: true }),
      answerAsk: (id, requestId, answer) => { answered.push([requestId, answer]); return { ok: true }; },
    },
  };
  const runner = createTaskRunner({ projectPath: PROJECT, callerTag: 'tag-a', ctx });
  const source = ownServerSource({
    backend: claudeNative, groups: ['tasks'], tasks: runner,
    registerSession: mcpHttp.registerSession, sessionId: 'caller-a', projectPath: PROJECT, getWindow: () => null, log,
  });
  const injection = await composeMcpInjection({
    backend: claudeNative, ctx: { log }, dir: bindingDir, cwd: PROJECT, tag: 'caller-a', options: {}, sources: [source],
  });
  assert.ok(injection, 'the tasks group registers and the emitter writes its row');
  const client = clientOf(injection);

  const tools = (await rpc(client, { jsonrpc: '2.0', id: nextRpc++, method: 'tools/list' })).json.result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['startTask', 'taskResult']);
  assert.deepEqual(tools[0].inputSchema.properties.backend.enum, ['claude-native']);

  const started = await call(client, 'startTask', { backend: 'claude-native', prompt: 'Rename helper() to assist().' });
  assert.equal(started.json.result.isError, undefined, JSON.stringify(started.json));
  const accepted = dataOf(started);
  assert.equal(accepted.state, 'running');
  assert.equal(accepted.branch, `switchboard/task-${accepted.id}`);
  const [taskId, session] = [...activeSessions.entries()].find(([id]) => id !== 'caller-a');
  assert.equal(session.cwd, WT, 'the task session starts in its worktree');
  assert.equal(session.opts.spawnKind, 'task');
  assert.equal(session.opts.spawnedBy, 'caller-a', 'depth 1');
  assert.equal(session.opts.permissionMode, 'default');
  assert.equal(session.opts.permissionModeSent, true);
  assert.equal(session.opts.addDirs, '', 'the task profile clears what must not reach a task');
  assert.deepEqual(trustSet, [[WT, true]], 'the worktree inherits the project\'s trust');

  const obs = observers.get(taskId);
  assert.equal(obs.answersFromMemory, false);
  obs.onBusy(true);
  assert.equal(obs.onAsk({ id: 'q1', kind: 'approval', tool: 'Edit' }), null, 'the question goes to the user');
  assert.equal(dataOf(await call(client, 'taskResult', { id: accepted.id })).state, 'needs-input');
  obs.onAskSettled('q1');
  assert.equal(dataOf(await call(client, 'taskResult', { id: accepted.id })).state, 'running');
  obs.onEntry({ type: 'assistant' }, 'Renamed it in two files and committed.');
  obs.onBusy(false, null);
  await new Promise((r) => setImmediate(r));

  const done = dataOf(await call(client, 'taskResult', { id: accepted.id }));
  assert.equal(done.state, 'done');
  assert.equal(done.text, 'Renamed it in two files and committed.');
  assert.equal(done.branch, accepted.branch);
  assert.equal(done.worktreePath, WT);
  assert.equal(session.kills, 1, 'the task session is stopped once its turn ended');
  assert.deepEqual(answered, [], 'nothing was answered for the user');

  injection.release();
  const after = await call(client, 'taskResult', { id: accepted.id });
  assert.equal(after.status, 401, 'the token died with the caller\'s launch');
  assert.equal(typeof SENTENCES.needsInput, 'string');
});
