// The `tasks` tool group (#804, spec 41, T7): the schemas, the argument checks and the pass-through to the registration's
// task runner, at bridge level, beside the review group. A fake runner on `entry.tasks`, a fake reply; no socket, no db, no
// electron. The runner itself is covered by task-runner.test.js; the group's toggle at spawn by spawn-review.test.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-tasks-'));
process.env.SWITCHBOARD_STORE_CLAUDE = path.join(tmpHome, 'projects');

const bridge = require('../src/servers/mcp-bridge');
const { TASK_TOOL_NAMES, NO_RUNNER, FAILED } = require('../src/servers/task-tools');
const { REVIEW_TOOL_NAMES } = require('../src/servers/review-tools');
const { ownServerSource } = require('../src/app/mcp-inject');

const log = { info() {}, debug() {}, warn() {}, error() {} };
let seq = 0;

function fakeRunner({ targets = [{ id: 'alpha', label: 'Alpha' }], start, answers = {} } = {}) {
  const calls = [];
  return {
    calls,
    releases: 0,
    targets: () => targets,
    start: async (a) => { calls.push(['start', a]); return start ? start(a) : { ok: true, accepted: { id: 't1', backend: a.backend, state: 'running', branch: 'switchboard/task-t1', maxMinutes: 30, pollAfterSeconds: 30 } }; },
    result: (id) => { calls.push(['result', id]); return answers[id] || { ok: false, error: 'There is no task with that id for this session.' }; },
    release() { this.releases += 1; },
  };
}

function open(opts) {
  const entry = bridge.createHttpEntry({ sessionId: `task-${++seq}`, getWindow: () => null, ...opts });
  const frames = [];
  entry.reply = (f) => frames.push(JSON.parse(f));
  const send = async (method, params) => {
    await bridge.dispatchMessage(entry, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), log);
    return frames.pop();
  };
  const call = async (name, args) => (await send('tools/call', { name, arguments: args })).result;
  return { entry, send, call, close: () => bridge.shutdownMcpServer(entry.sessionId, log) };
}

const json = (res) => JSON.parse(res.content[0].text);

test('tools/list offers the two task tools with this registration\'s targets, and says what a task may do', async () => {
  const h = open({ groups: ['tasks'], tasks: fakeRunner({ targets: [{ id: 'alpha' }, { id: 'beta' }] }) });
  const { tools } = (await h.send('tools/list')).result;
  assert.deepEqual(tools.map((t) => t.name), TASK_TOOL_NAMES);
  const [start, poll] = tools;
  assert.deepEqual(start.inputSchema.required, ['backend', 'prompt']);
  assert.deepEqual(start.inputSchema.properties.backend.enum, ['alpha', 'beta']);
  assert.deepEqual(poll.inputSchema.required, ['id']);
  for (const t of tools) assert.match(t.description, /not an instruction/);
  assert.match(start.description, /CHANGE files/);
  assert.match(start.description, /worktree/);
  assert.match(start.description, /nothing is merged/);
  assert.match(start.description, /own account/);
  assert.match(start.description, /10 minutes/);
  assert.match(poll.description, /needs-input/);
  h.close();
});

test('with no target the enum is left out rather than empty, and a registration without a runner lists nothing', async () => {
  const none = open({ groups: ['tasks'], tasks: fakeRunner({ targets: [] }) });
  const { tools } = (await none.send('tools/list')).result;
  assert.equal('enum' in tools[0].inputSchema.properties.backend, false);
  none.close();
  const bare = open({ groups: ['tasks'] });
  assert.deepEqual((await bare.send('tools/list')).result.tools, []);
  bare.close();
});

test('the groups stand apart: review alone offers no task tool, both together offer both', async () => {
  const reviewOnly = open({ groups: ['review'], review: fakeRunner() });
  assert.deepEqual((await reviewOnly.send('tools/list')).result.tools.map((t) => t.name), REVIEW_TOOL_NAMES);
  reviewOnly.close();
  const both = open({ groups: ['review', 'tasks'], review: fakeRunner(), tasks: fakeRunner() });
  assert.deepEqual((await both.send('tools/list')).result.tools.map((t) => t.name), [...REVIEW_TOOL_NAMES, ...TASK_TOOL_NAMES]);
  both.close();
});

test('startTask and taskResult pass through to the runner; every refusal is a sentence', async () => {
  const runner = fakeRunner({ answers: { t1: { ok: true, result: { id: 't1', state: 'needs-input', branch: 'switchboard/task-t1' } } } });
  const h = open({ groups: ['tasks'], tasks: runner });
  const started = await h.call('startTask', { backend: 'alpha', prompt: 'Rename it.' });
  assert.equal(started.isError, undefined);
  assert.deepEqual(json(started), { id: 't1', backend: 'alpha', state: 'running', branch: 'switchboard/task-t1', maxMinutes: 30, pollAfterSeconds: 30 });
  assert.deepEqual(runner.calls[0], ['start', { backend: 'alpha', prompt: 'Rename it.' }]);
  assert.deepEqual(json(await h.call('taskResult', { id: 't1' })), { id: 't1', state: 'needs-input', branch: 'switchboard/task-t1' });
  const unknown = await h.call('taskResult', { id: 'nope' });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.content[0].text, 'There is no task with that id for this session.');
  assert.equal((await h.call('startTask', { backend: '', prompt: 'x' })).content[0].text, 'backend must be a non-empty string');
  assert.equal((await h.call('startTask', { backend: 'alpha', prompt: 3 })).content[0].text, 'prompt must be a string');
  assert.equal((await h.call('taskResult', {})).content[0].text, 'id must be a non-empty string');
  h.close();

  const refusing = open({ groups: ['tasks'], tasks: fakeRunner({ start: () => ({ ok: false, error: 'The target backend does not trust this project yet.' }) }) });
  assert.equal((await refusing.call('startTask', { backend: 'alpha', prompt: 'x' })).content[0].text, 'The target backend does not trust this project yet.');
  refusing.close();
  const throwing = open({ groups: ['tasks'], tasks: fakeRunner({ start: () => { throw new Error('/a/local/path'); } }) });
  const thrown = await throwing.call('startTask', { backend: 'alpha', prompt: 'x' });
  assert.equal(thrown.content[0].text, FAILED, 'a throw never carries its own text');
  throwing.close();
});

test('a task tool on a registration without the group is refused by name', async () => {
  const h = open({ groups: ['review'], review: fakeRunner() });
  const res = await h.send('tools/call', { name: 'startTask', arguments: { backend: 'alpha', prompt: 'x' } });
  assert.ok(res.error || (res.result && res.result.isError), JSON.stringify(res));
  h.close();
  assert.equal(typeof NO_RUNNER, 'string');
});

test('the own-server source hands the task runner to the registration and releases it once with the launch', async () => {
  const runner = fakeRunner();
  const regs = [];
  const source = ownServerSource({
    backend: { acceptsMcpTransports: ['http'] },
    groups: ['tasks'],
    tasks: runner,
    registerSession: async (reg) => { regs.push(reg); return { url: 'http://127.0.0.1:1/mcp', token: 't', release() {} }; },
    sessionId: 's1', projectPath: '/p', getWindow: () => null, log,
  });
  const rows = await source();
  assert.equal(rows.length, 1);
  assert.equal(regs[0].tasks, runner);
  source.release();
  source.release();
  assert.equal(runner.releases, 1, 'the caller\'s launch is over: its task is stopped, once');
});
