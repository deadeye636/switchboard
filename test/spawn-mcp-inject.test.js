'use strict';
// The spawn path's MCP injection block (spec 34, T4): one composer call per spawn, args and env merged,
// the release kept and given back on exit, on a refused or raced spawn, and on quit.
//
// Behavioural: `node-pty` and the composer are replaced in the require cache BEFORE `spawn.js` loads, so a
// fresh spawn runs for real up to the fake PTY. (`test/spawn-first-resize.test.js` reads source instead
// because it never needed to observe a spawn; this one has to see what the launch was handed.)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const stub = (file, exports) => {
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

const ptySpawns = [];
let fakePty;
const makeFakePty = () => {
  const exits = [];
  const p = {
    pid: 4242, onData: () => {}, onExit: (cb) => exits.push(cb), write() {}, resize() {}, kill() {}, pause() {}, resume() {},
    exit: (code = 0) => exits.forEach((cb) => cb({ exitCode: code })),
  };
  fakePty = p;
  return p;
};
stub(require.resolve('node-pty'), {
  spawn: (cmd, args, opts) => { ptySpawns.push({ cmd, args, opts }); return makeFakePty(); },
});

let composer = async () => null;
const composerCalls = [];
const realInject = require('../src/app/mcp-inject');
stub(path.join(__dirname, '..', 'src', 'app', 'mcp-inject.js'), {
  ...realInject,
  composeMcpInjection: async (arg) => { composerCalls.push(arg); return composer(arg); },
});

const spawn = require('../src/app/terminal/spawn');

function fakeBackend(over = {}) {
  return {
    id: 'codex', label: 'Codex', axis: 'B', status: 'ready',
    providesMcpInjection: true,
    buildLaunch: () => ({ command: 'codex', args: ['--base'], env: {} }),
    ...over,
  };
}

function setup({ backend = fakeBackend(), userEnv = {}, sessions = [], quitting = () => false } = {}) {
  const sent = [];
  const activeSessions = new Map(sessions);
  const ctx = {
    sent, activeSessions,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } }),
    getAppQuitting: () => quitting(),
    liveStoreRef: new Map(), liveBusy: new Map(), cleanPtyEnv: {}, projectsDir: 'D:/nope', bindingDir: 'D:/nope',
    backends: { get: (id) => (id === backend.id ? backend : null), isLaunchable: () => true, backendCoreEnv: () => ({}) },
    sessionBackends: { get: () => null, record: () => {} },
    getSetting: (k) => (k === 'global' ? { backendEnv: { [backend.id]: userEnv } } : {}),
    effectiveSettings: () => ({ shellProfile: 'auto' }),
    attentionHooksEnabled: () => false,
    classifyShellType: () => 'bash',
    resolveArgvExecutable: () => (backend.transport ? 'agent-bin' : null),
    resolveTerminalShellProfileId: () => 'auto',
    resolveLauncherCwd: (_l, p) => p,
    composeLauncherCommand: () => '',
    resolveSpawnEnv: (e) => e,
    getCachedSession: () => null,
    cleanupSecretRefsForSession: () => {},
    ensureProjectAdded: () => {},
    registerMcpHttpSession: async (o) => { ctx.registered.push(o); return { url: 'http://127.0.0.1:1/mcp', token: 't', release: () => { ctx.registrationReleased++; } }; },
    registered: [], registrationReleased: 0,
    windowForSessionCalls: [], windowsById: new Map(),
    windowForSession: (id) => { ctx.windowForSessionCalls.push(id); return ctx.windowsById.get(id) || null; },
    startMcpServer: async () => null,
    shutdownMcpServer: () => {},
    startAgentProcess: () => makeFakePty(),
    log: { info() {}, warn() {}, error() {}, silly() {}, debug() {} },
  };
  spawn.init(ctx);
  return ctx;
}

const CWD = process.cwd();
const injection = () => {
  const rec = { released: 0 };
  return { rec, value: { args: ['--mcp', 'cfg'], env: { MCP_X: 'injected', SHARED: 'injected' }, release: () => { rec.released++; } } };
};
const reset = () => { ptySpawns.length = 0; composerCalls.length = 0; composer = async () => null; };

test('a backend driven over a pipe never calls the composer', async () => {
  reset();
  const backend = fakeBackend({
    transport: 'stdio', rpc: {},
    buildLaunch: () => ({ command: 'agent-bin', args: [], env: {}, spawnMode: 'argv' }),
  });
  setup({ backend });
  const r = await spawn.openTerminal('p1', CWD, true, { backendId: 'codex' });
  assert.equal(r.ok, true);
  assert.equal(composerCalls.length, 0);
});

test('args and env are merged; the user env still wins over the injected env', async () => {
  reset();
  composer = async () => injection().value;
  setup({ userEnv: { SHARED: 'user' } });
  const r = await spawn.openTerminal('m1', CWD, true, { backendId: 'codex' });
  assert.equal(r.ok, true);
  assert.equal(composerCalls.length, 1);
  assert.equal(composerCalls[0].sources.length, 1, 'the own-server source is supplied');
  const launched = ptySpawns.at(-1);
  const cmdline = [launched.cmd, ...launched.args].join(' ');
  assert.ok(cmdline.includes('--mcp') && cmdline.includes('cfg'), 'the injected args reach the launch');
  assert.ok(cmdline.includes('--base'));
  assert.equal(launched.opts.env.MCP_X, 'injected');
  assert.equal(launched.opts.env.SHARED, 'user', 'the user env still wins');
});

test('a template env also wins over the injected env', async () => {
  reset();
  composer = async () => injection().value;
  setup({ backend: fakeBackend({ isProfile: true, baseId: 'codex', templateEnv: { SHARED: 'template' } }) });
  await spawn.openTerminal('m2', CWD, true, { backendId: 'codex' });
  assert.equal(ptySpawns.at(-1).opts.env.SHARED, 'template');
  assert.equal(ptySpawns.at(-1).opts.env.MCP_X, 'injected');
});

test('a composer that answers null still starts the session, launch unchanged', async () => {
  reset();
  setup();
  const r = await spawn.openTerminal('n1', CWD, true, { backendId: 'codex' });
  assert.equal(r.ok, true);
  assert.equal(composerCalls.length, 1);
  const launched = ptySpawns.at(-1);
  assert.ok(![launched.cmd, ...launched.args].join(' ').includes('--mcp'));
});

test('a backend without the capability never asks', async () => {
  reset();
  setup({ backend: fakeBackend({ providesMcpInjection: false }) });
  await spawn.openTerminal('c1', CWD, true, { backendId: 'codex' });
  assert.equal(composerCalls.length, 0);
});

test('a quit during the await releases what was built and does not spawn', async () => {
  reset();
  const inj = injection();
  let quit = false;
  composer = async () => { quit = true; return inj.value; };
  setup({ quitting: () => quit });
  const r = await spawn.openTerminal('q1', CWD, true, { backendId: 'codex' });
  assert.deepEqual(r, { ok: false, error: 'The app is quitting.' });
  assert.equal(inj.rec.released, 1);
  assert.equal(ptySpawns.length, 0);
});

test('a second open that registered the session during the await releases and reattaches', async () => {
  reset();
  const inj = injection();
  const live = { exited: false, outputBuffer: [], isPlainTerminal: false, altScreen: false };
  const ctx = setup();
  composer = async () => { ctx.activeSessions.set('r1', live); return inj.value; };
  const r = await spawn.openTerminal('r1', CWD, true, { backendId: 'codex' });
  assert.equal(r.reattached, true);
  assert.equal(inj.rec.released, 1);
  assert.equal(ptySpawns.length, 0);
});

test('the own-server source registers only when the backend option is on, with the session id', async () => {
  reset();
  const backend = fakeBackend({ acceptsMcpTransports: ['http'] });
  const ctx = setup({ backend });
  await spawn.openTerminal('o1', CWD, true, { backendId: 'codex' });
  assert.deepEqual(await composerCalls[0].sources[0](), []);
  assert.equal(ctx.registered.length, 0, 'option off: nothing registered');
  await spawn.openTerminal('o2', CWD, true, { backendId: 'codex', diffTool: true });
  const rows = await composerCalls[1].sources[0]();
  assert.equal(ctx.registered.length, 1);
  assert.equal(ctx.registered[0].sessionId, 'o2');
  assert.deepEqual(ctx.registered[0].groups, ['diff']);
  assert.equal(rows[0].transport, 'http');
});

test('the own-server getWindow resolves the id the bridge passes, not the launch id (#330 re-key)', async () => {
  reset();
  const backend = fakeBackend({ acceptsMcpTransports: ['http'] });
  const ctx = setup({ backend });
  await spawn.openTerminal('launch-id', CWD, true, { backendId: 'codex', diffTool: true });
  await composerCalls[0].sources[0]();              // run the source so it registers and hands over getWindow
  const getWindow = ctx.registered[0].getWindow;
  assert.equal(typeof getWindow, 'function');
  // A backend that adopts its own session id re-keys the registration; the bridge then calls
  // getWindow(entry.sessionId) with the NEW id. A closure over the launch id would miss the window.
  const rekeyedWindow = { isDestroyed: () => false, webContents: { send() {} } };
  ctx.windowsById.set('rekeyed-id', rekeyedWindow);
  assert.equal(getWindow('rekeyed-id'), rekeyedWindow, 'resolves the window under the passed (re-keyed) id');
  assert.ok(ctx.windowForSessionCalls.includes('rekeyed-id'), 'windowForSession was asked for the re-keyed id');
  // No id (defensive) still falls back to the launch id.
  ctx.windowForSessionCalls.length = 0;
  getWindow();
  assert.deepEqual(ctx.windowForSessionCalls, ['launch-id'], 'falls back to the launch id when none is passed');
});

test('exit releases exactly once', async () => {
  reset();
  const inj = injection();
  composer = async () => inj.value;
  setup();
  const r = await spawn.openTerminal('e1', CWD, true, { backendId: 'codex' });
  assert.equal(r.ok, true);
  assert.equal(inj.rec.released, 0, 'nothing is released while the session lives');
  fakePty.exit(0);
  assert.equal(inj.rec.released, 1);
});
