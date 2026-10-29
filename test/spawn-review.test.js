'use strict';
// Spec 39, T7: the `reviewTools` toggle on Claude and claude-native, through the REAL spawn block and the real
// composer, in the shape of test/spawn-claude-discovery.test.js. Only `node-pty`, the HTTP registration, the agent
// process and the review runner are stand-ins.
//
// What is pinned:
//   - toggle on: one registration with the `review` group, the runner built for this terminal and handed over;
//   - toggle off or absent: argv and env byte-identical to a launch with no injection at all (the differential);
//   - a stored `reviewTools` under a backend that does not declare it opens nothing;
//   - a session a review started (`spawnedBy`) gets no group of the app's own server, whatever is stored;
//   - releasing the registration releases the runner, once.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stub = (file, exports) => {
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

const ptySpawns = [];
const makeFakePty = () => ({
  pid: 4242, onData: () => {}, onExit: () => {}, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
});
stub(require.resolve('node-pty'), {
  spawn: (cmd, args, opts) => { ptySpawns.push({ cmd, args, opts }); return makeFakePty(); },
});

const spawn = require('../src/app/terminal/spawn');
const claude = require('../src/backends/claude');
const claudeNative = require('../src/backends/claude-native');

const bindingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-claude-review-'));
after(() => { fs.rmSync(bindingDir, { recursive: true, force: true }); });

const PICK = ['id', 'label', 'axis', 'configFields', 'buildLaunch', 'providesMcpInjection', 'acceptsMcpTransports',
  'buildMcpInjection', 'releaseMcpInjection', 'externalMcpTakes', 'providesMcpPrune', 'buildMcpPrune'];
function narrowed(real, over = {}) {
  const d = { status: 'ready' };
  for (const k of PICK) d[k] = real[k];
  return { ...d, ...over };
}
const SHAPES = {
  claude: () => narrowed(claude),
  // The pipe itself is a stand-in (`startAgentProcess`); `rpc: {}` keeps the protocol out of this test.
  'claude-native': () => narrowed(claudeNative, { transport: 'stdio', rpc: {} }),
};

function setup(backend, { project = {}, global = {} } = {}) {
  const ctx = {
    activeSessions: new Map(),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    getAppQuitting: () => false,
    liveStoreRef: new Map(), liveBusy: new Map(), cleanPtyEnv: {}, projectsDir: bindingDir, bindingDir,
    backends: { get: (id) => (id === backend.id ? backend : null), isLaunchable: () => true, backendCoreEnv: () => ({}) },
    sessionBackends: { get: () => null, record: () => {} },
    getSetting: (k) => (k === 'global' ? { backendEnv: {}, ...global } : project),
    effectiveSettings: () => ({ shellProfile: 'auto' }),
    attentionHooksEnabled: () => false,
    classifyShellType: () => 'bash',
    resolveArgvExecutable: () => (backend.transport ? 'claude-bin' : null),
    resolveTerminalShellProfileId: () => 'auto',
    resolveLauncherCwd: (_l, p) => p,
    composeLauncherCommand: () => '',
    resolveSpawnEnv: (e) => e,
    getCachedSession: () => null,
    cleanupSecretRefsForSession: () => {},
    ensureProjectAdded: () => {},
    registered: [],
    registerMcpHttpSession: async (o) => { ctx.registered.push(o); return { url: 'http://127.0.0.1:1/mcp', token: 'tok-e2e', release() { ctx.regReleases += 1; } }; },
    regReleases: 0,
    createDiscoveryReader: (scope) => ({ scope }),
    runners: [],
    createReviewRunner: (scope) => {
      const runner = { scope, releases: 0, targets: () => [], start() {}, result() {}, release() { runner.releases += 1; } };
      ctx.runners.push(runner);
      return runner;
    },
    windowForSession: () => null,
    startMcpServer: async () => null,
    shutdownMcpServer: () => {},
    agentSpawns: [],
    startAgentProcess: (o) => { ctx.agentSpawns.push(o); return makeFakePty(); },
    log: { info() {}, warn() {}, error() {}, silly() {}, debug() {} },
  };
  spawn.init(ctx);
  return ctx;
}

const CWD = process.cwd();
let n = 0;
/** One spawn; answers the argv and env the child was started with, the registrations made and the session. */
async function launch(backend, sessionOptions = {}, settings) {
  const ctx = setup(backend, settings);
  const id = `rv-${++n}`;
  const r = await spawn.openTerminal(id, CWD, true, { backendId: backend.id, ...sessionOptions });
  assert.equal(r.ok, true, r.error);
  const child = backend.transport ? ctx.agentSpawns.at(-1) : ptySpawns.at(-1);
  const argv = backend.transport ? child.args : [child.cmd, ...child.args];
  return { ctx, argv, env: child.env || (child.opts && child.opts.env) || {}, session: ctx.activeSessions.get(id) };
}
const hasMcpConfig = (argv) => argv.join(' ').includes(path.join(bindingDir, 'claude-mcp-'));

for (const [shape, make] of Object.entries(SHAPES)) {
  test(`[${shape}] toggle on: one review registration, the runner built for this terminal and handed over`, async () => {
    const { ctx, argv, session } = await launch(make(), { reviewTools: true });
    assert.equal(ctx.registered.length, 1);
    assert.deepEqual(ctx.registered[0].groups, ['review']);
    assert.equal(ctx.runners.length, 1);
    assert.equal(ctx.registered[0].review, ctx.runners[0], 'the runner is handed to the registration');
    assert.deepEqual(ctx.runners[0].scope, { projectPath: CWD, callerTag: session._terminalTag });
    assert.ok(hasMcpConfig(argv), argv.join(' '));
    assert.equal(session._review, false);
    assert.equal(session._spawnedBy, null);
    const both = await launch(make(), { reviewTools: true, discoveryTools: true });
    assert.deepEqual(both.ctx.registered[0].groups, ['discovery', 'review']);
  });

  test(`[${shape}] toggle off or absent: argv and env byte-identical to a launch with no injection at all`, async () => {
    const absent = await launch(make(), {});
    const without = await launch({ ...make(), providesMcpInjection: false }, {});
    const off = await launch(make(), { reviewTools: false });
    for (const r of [absent, off]) {
      assert.equal(r.ctx.registered.length, 0, 'nothing registered');
      assert.equal(r.ctx.runners.length, 0, 'no runner built');
      assert.equal(hasMcpConfig(r.argv), false);
    }
    const strip = (r) => JSON.stringify({ argv: r.argv.map((a) => a.replace(/rv-\d+/g, 'ID')), env: r.env });
    assert.equal(strip(absent), strip(without));
    assert.equal(strip(off), strip(without));
  });

  test(`[${shape}] a stored reviewTools under a backend that does not declare it opens nothing`, async () => {
    const backend = make();
    backend.configFields = backend.configFields.filter((f) => f.id !== 'reviewTools');
    const stored = { global: { backendDefaults: { [backend.id]: { reviewTools: true } } } };
    const { ctx, argv } = await launch(backend, {}, stored);
    assert.equal(ctx.registered.length, 0);
    assert.equal(ctx.runners.length, 0);
    assert.equal(hasMcpConfig(argv), false);
  });

  test(`[${shape}] a session a review started gets no group of the app's own server, whatever is stored`, async () => {
    const backend = make();
    const stored = { global: { backendDefaults: { [backend.id]: { reviewTools: true, discoveryTools: true } } } };
    const { ctx, argv, session } = await launch(backend, { spawnedBy: 'caller-1', reviewTools: false }, stored);
    assert.equal(ctx.registered.length, 0, 'no registration');
    assert.equal(ctx.runners.length, 0, 'no runner');
    assert.equal(hasMcpConfig(argv), false, 'no --mcp-config for the own server');
    assert.equal(session._review, true);
    assert.equal(session._spawnedBy, 'caller-1');
    // Without `spawnedBy` the same stored values open both groups: the stored defaults are what was refused.
    const caller = await launch(backend, {}, stored);
    assert.deepEqual(caller.ctx.registered[0].groups, ['discovery', 'review']);
  });

  test(`[${shape}] releasing the registration releases the runner, once`, async () => {
    const { ctx, session } = await launch(make(), { reviewTools: true });
    assert.equal(typeof session._mcpInjectionRelease, 'function');
    session._mcpInjectionRelease();
    session._mcpInjectionRelease();
    assert.equal(ctx.regReleases, 1);
    assert.equal(ctx.runners[0].releases, 1);
  });
}

test('without a runner factory the review group is dropped, and nothing else changes', async () => {
  const backend = SHAPES.claude();
  const ctx = setup(backend);
  delete ctx.createReviewRunner;
  spawn.init(ctx);
  const r = await spawn.openTerminal(`rv-${++n}`, CWD, true, { backendId: backend.id, reviewTools: true, discoveryTools: true });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(ctx.registered[0].groups, ['discovery']);
});
