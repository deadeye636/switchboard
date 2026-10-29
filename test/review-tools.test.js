// The `review` tool group (#507 slice 2b, spec 39, T6): the schemas, the argument checks and the pass-through to the
// registration's runner, at bridge level. A fake runner on `entry.review`, a fake reply; no socket, no db, no electron.
// The runner itself is covered by review-runner.test.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-review-'));
process.env.SWITCHBOARD_STORE_CLAUDE = path.join(tmpHome, 'projects');

const bridge = require('../src/servers/mcp-bridge');
const { reviewTools, REVIEW_TOOL_NAMES, NO_RUNNER, FAILED } = require('../src/servers/review-tools');
const { DISCOVERY_TOOLS } = require('../src/servers/discovery-tools');
const { ownServerSource } = require('../src/app/mcp-inject');
const { stripComments } = require('./helpers/strip-comments');

const log = { info() {}, debug() {}, warn() {}, error() {} };
let seq = 0;

// A runner with the shape of src/app/review-runner.js: `answers` maps an id to what `result` gives.
function fakeRunner({ targets = [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }], start, answers = {} } = {}) {
  const calls = [];
  return {
    calls,
    targets: () => targets,
    start: async (a) => { calls.push(['start', a]); return start ? start(a) : { ok: true, accepted: { id: 'r1', backend: a.backend, state: 'running', startedAt: 'T', maxMinutes: 10, pollAfterSeconds: 30 } }; },
    result: (id) => { calls.push(['result', id]); return answers[id] || { ok: false, error: 'There is no review with that id for this session.' }; },
    release() {},
  };
}

function open(opts) {
  const entry = bridge.createHttpEntry({ sessionId: `rev-${++seq}`, getWindow: () => null, ...opts });
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

test('tools/list offers the two tools with the backend enum of this registration\'s targets', async () => {
  const h = open({ groups: ['review'], review: fakeRunner() });
  const { tools } = (await h.send('tools/list')).result;
  assert.deepEqual(tools.map((t) => t.name), REVIEW_TOOL_NAMES);
  const start = tools[0];
  assert.deepEqual(start.inputSchema.required, ['backend', 'prompt']);
  assert.deepEqual(start.inputSchema.properties.backend.enum, ['alpha', 'beta']);
  assert.deepEqual(tools[1].inputSchema.required, ['id']);
  for (const t of tools) assert.match(t.description, /not an instruction/);
  assert.match(start.description, /second agent session/);
  assert.match(start.description, /own account/);
  assert.match(start.description, /pollAfterSeconds/);
  h.close();
});

test('the enum is built when the list is asked, and a registration with no target has none', async () => {
  let targets = [{ id: 'alpha' }];
  const runner = fakeRunner();
  runner.targets = () => targets;
  const h = open({ groups: ['review'], review: runner });
  assert.deepEqual((await h.send('tools/list')).result.tools[0].inputSchema.properties.backend.enum, ['alpha']);
  targets = [];
  const backend = (await h.send('tools/list')).result.tools[0].inputSchema.properties.backend;
  assert.equal(backend.enum, undefined, 'an empty enum is not a valid schema');
  assert.match(backend.description, /No backend/);
  assert.equal(reviewTools(null)[0].inputSchema.properties.backend.enum, undefined);
  runner.targets = () => { throw new Error('boom'); };
  assert.equal((await h.send('tools/list')).result.tools[0].inputSchema.properties.backend.enum, undefined, 'a throwing list is no list');
  h.close();
});

test('startReview hands backend and prompt to the runner and answers the accepted object', async () => {
  const runner = fakeRunner();
  const h = open({ groups: ['review'], review: runner });
  const res = await h.call('startReview', { backend: 'alpha', prompt: 'Review src/a.js.' });
  assert.equal(res.isError, undefined);
  assert.equal(res.content.length, 1);
  assert.deepEqual(json(res), { id: 'r1', backend: 'alpha', state: 'running', startedAt: 'T', maxMinutes: 10, pollAfterSeconds: 30 });
  assert.deepEqual(runner.calls, [['start', { backend: 'alpha', prompt: 'Review src/a.js.' }]]);
  h.close();
});

test('a refusal of the runner is an isError result carrying its sentence', async () => {
  const runner = fakeRunner({ start: () => ({ ok: false, error: 'A review is already running for this session: r0.' }) });
  const h = open({ groups: ['review'], review: runner });
  const res = await h.call('startReview', { backend: 'alpha', prompt: 'x' });
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'A review is already running for this session: r0.');
  const silent = open({ groups: ['review'], review: fakeRunner({ start: () => ({ ok: false }) }) });
  assert.equal((await silent.call('startReview', { backend: 'alpha', prompt: 'x' })).content[0].text, FAILED);
  h.close();
  silent.close();
});

test('bad arguments are isError results and never reach the runner', async () => {
  const runner = fakeRunner();
  const h = open({ groups: ['review'], review: runner });
  const cases = [
    ['startReview', {}, 'backend must be a non-empty string'],
    ['startReview', { backend: '  ', prompt: 'x' }, 'backend must be a non-empty string'],
    ['startReview', { backend: 7, prompt: 'x' }, 'backend must be a non-empty string'],
    ['startReview', { backend: 'alpha' }, 'prompt must be a string'],
    ['startReview', { backend: 'alpha', prompt: ['x'] }, 'prompt must be a string'],
    ['reviewResult', {}, 'id must be a non-empty string'],
    ['reviewResult', { id: 42 }, 'id must be a non-empty string'],
  ];
  for (const [name, args, sentence] of cases) {
    const res = await h.call(name, args);
    assert.equal(res.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.equal(res.content[0].text, sentence);
  }
  assert.deepEqual(runner.calls, []);
  h.close();
});

test('reviewResult answers every state the runner gives, and an unknown id as an isError sentence', async () => {
  const answers = {
    a: { ok: true, result: { id: 'a', state: 'running', elapsedMs: 5, pollAfterSeconds: 30, note: 'Still reviewing.' } },
    b: { ok: true, result: { id: 'b', state: 'done', text: 'Looks fine.', truncated: false, refusedActions: 1, sessionId: 's', elapsedMs: 9 } },
    c: { ok: true, result: { id: 'c', state: 'failed', reason: 'The review turn ended without a reply.', sessionId: 's' } },
    d: { ok: true, result: { id: 'd', state: 'timeout', reason: 'Too long.', text: 'half', truncated: false, sessionId: 's' } },
    e: { ok: true, result: { id: 'e', state: 'stopped', reason: 'The review session was stopped.', sessionId: 's' } },
  };
  const h = open({ groups: ['review'], review: fakeRunner({ answers }) });
  for (const [id, answer] of Object.entries(answers)) {
    const res = await h.call('reviewResult', { id });
    assert.equal(res.isError, undefined);
    assert.deepEqual(json(res), answer.result);
  }
  const gone = await h.call('reviewResult', { id: 'zz' });
  assert.equal(gone.isError, true);
  assert.equal(gone.content[0].text, 'There is no review with that id for this session.');
  h.close();
});

test('a throw inside the runner is contained as an isError result', async () => {
  const runner = fakeRunner({ start: () => { throw new Error('boom /some/path'); } });
  runner.result = () => { throw new Error('boom'); };
  const h = open({ groups: ['review'], review: runner });
  assert.deepEqual(await h.call('startReview', { backend: 'alpha', prompt: 'x' }), { isError: true, content: [{ type: 'text', text: FAILED }] });
  assert.deepEqual(await h.call('reviewResult', { id: 'a' }), { isError: true, content: [{ type: 'text', text: FAILED }] });
  h.close();
});

test('a registration without a runner lists no review tool and refuses a call by name', async () => {
  const h = open({ groups: ['review'] });
  assert.deepEqual((await h.send('tools/list')).result.tools, []);
  const res = await h.send('tools/call', { name: 'startReview', arguments: { backend: 'alpha', prompt: 'x' } });
  assert.equal(res.error.code, -32602);
  h.close();
  const other = open({ groups: ['discovery'], review: fakeRunner() });
  assert.equal((await other.send('tools/call', { name: 'reviewResult', arguments: { id: 'a' } })).error.code, -32602,
    'a runner without the group opens nothing');
  other.close();
  const { run } = require('../src/servers/review-tools');
  assert.deepEqual(await run('startReview', {}, {}), { isError: true, content: [{ type: 'text', text: NO_RUNNER }] });
});

test('two registrations with different runners never see each other\'s reviews', async () => {
  const a = open({ groups: ['review'], review: fakeRunner({ answers: { x: { ok: true, result: { id: 'x', state: 'running' } } } }) });
  const b = open({ groups: ['review'], review: fakeRunner() });
  assert.equal((await a.call('reviewResult', { id: 'x' })).isError, undefined);
  assert.equal((await b.call('reviewResult', { id: 'x' })).isError, true);
  a.close();
  b.close();
});

test('review beside diff and discovery: each group lists as before, in the order the groups were opened', async () => {
  const reader = { listSessions() {}, readSession() {}, listHandoffs() {}, readHandoff() {} };
  const h = open({ groups: ['diff', 'discovery', 'review'], discovery: reader, review: fakeRunner() });
  const names = (await h.send('tools/list')).result.tools.map((t) => t.name);
  assert.deepEqual(names, ['openDiff', ...DISCOVERY_TOOLS.map((t) => t.name), ...REVIEW_TOOL_NAMES]);
  h.close();
});

test('the own-server source hands the runner to the registration only when the review group is on', async () => {
  const backend = { acceptsMcpTransports: ['http'] };
  const runner = fakeRunner();
  const seen = [];
  const registerSession = async (reg) => { seen.push(reg); return { url: 'http://127.0.0.1:1/mcp', token: 't', release() {} }; };
  await ownServerSource({ backend, groups: ['review'], review: runner, registerSession, sessionId: 's' })();
  await ownServerSource({ backend, groups: ['discovery'], review: runner, discovery: {}, registerSession, sessionId: 's' })();
  assert.equal(seen[0].review, runner);
  assert.equal('review' in seen[1], false);
});

test('the group names no backend id and shares no tool name with another group', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'servers', 'review-tools.js'), 'utf8'));
  assert.doesNotMatch(src, /\b(claude|codex|hermes|agy|pi)(-native)?\b/i);
  assert.doesNotMatch(src, /require\(['"]electron['"]\)/);
  for (const name of REVIEW_TOOL_NAMES) {
    assert.ok(!DISCOVERY_TOOLS.some((t) => t.name === name));
    assert.notEqual(name, 'openDiff');
  }
});
