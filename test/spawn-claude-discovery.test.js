'use strict';
// Spec 37, T3: the `discoveryTools` toggle on Claude and claude-native, through the REAL spawn block, the real
// composer, the real Claude emitter and the real prune hook. Only `node-pty`, the HTTP registration and the
// agent process are stand-ins. The descriptors are the real ones, narrowed to what this question needs: the
// probe, the trust question and the live binding would otherwise run a CLI or write into the user's home.
//
// What is pinned:
//   - toggle on: one registration with the `discovery` group, and `--mcp-config <file>` on the argv;
//   - toggle off or absent: argv and env byte-identical to a launch with no injection at all (the differential);
//   - project prune on: `--strict-mcp-config` once, and the hook keeps `switchboard`;
//   - a stored `diffTool` that the Claude family never declares still registers the diff group (open point O9).
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

const bindingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-claude-discovery-'));
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
  // A template over Claude: its options are read under the base's id (`spawnOptionsFor`), its fields are the base's.
  'claude template': () => narrowed(claude, { id: 'tpl-claude', isProfile: true, baseId: 'claude' }),
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
    registerMcpHttpSession: async (o) => { ctx.registered.push(o); return { url: 'http://127.0.0.1:1/mcp', token: 'tok-e2e', release() {} }; },
    createDiscoveryReader: (scope) => ({ scope }),
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
/** One spawn; answers the argv and env the child was started with, and the registrations made. */
async function launch(backend, sessionOptions = {}, settings) {
  const ctx = setup(backend, settings);
  const id = `cd-${++n}`;
  const r = await spawn.openTerminal(id, CWD, true, { backendId: backend.id, ...sessionOptions });
  assert.equal(r.ok, true, r.error);
  const child = backend.transport ? ctx.agentSpawns.at(-1) : ptySpawns.at(-1);
  // A terminal spawn goes through the shell: the argv is the joined command line there.
  const argv = backend.transport ? child.args : [child.cmd, ...child.args];
  return { ctx, argv, env: child.env || (child.opts && child.opts.env) || {} };
}
// A terminal launch is one shell-quoted command line, a piped one plain argv. Find the file by where the emitter
// writes it rather than by a token pattern, so a temp directory with a space in it does not hide it.
const configFileIn = (argv) => {
  const line = argv.join(' ');
  const start = line.indexOf(path.join(bindingDir, 'claude-mcp-'));
  if (start < 0) return null;
  const end = line.indexOf('.json', start);
  assert.ok(end > start && line.lastIndexOf('--mcp-config', start) >= 0, 'the file follows --mcp-config');
  return line.slice(start, end + '.json'.length);
};

for (const [shape, make] of Object.entries(SHAPES)) {
  test(`[${shape}] toggle on: one discovery registration and --mcp-config on the argv`, async () => {
    const { ctx, argv } = await launch(make(), { discoveryTools: true });
    assert.equal(ctx.registered.length, 1);
    assert.deepEqual(ctx.registered[0].groups, ['discovery']);
    assert.ok(ctx.registered[0].discovery, 'the reader is handed over');
    const file = configFileIn(argv);
    assert.ok(file, `the argv names the config file: ${argv.join(' ')}`);
    const conf = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(conf.mcpServers), ['switchboard']);
    assert.ok(!argv.join(' ').includes('tok-e2e'), 'the token stays in the file');
  });

  test(`[${shape}] toggle off or absent: argv and env byte-identical to a launch with no injection at all`, async () => {
    const absent = await launch(make(), {});
    const without = await launch({ ...make(), providesMcpInjection: false }, {});
    const off = await launch(make(), { discoveryTools: false });
    for (const r of [absent, off]) {
      assert.equal(r.ctx.registered.length, 0, 'nothing registered');
      assert.equal(configFileIn(r.argv), null);
    }
    const strip = (r) => JSON.stringify({ argv: r.argv.map((a) => a.replace(/cd-\d+/g, 'ID')), env: r.env });
    assert.equal(strip(absent), strip(without));
    assert.equal(strip(off), strip(without));
  });

  test(`[${shape}] project prune on: --strict-mcp-config once, and the hook keeps switchboard`, async () => {
    let seen;
    const backend = make();
    const realPrune = backend.buildMcpPrune;
    backend.buildMcpPrune = (a) => { seen = a.injectedNames; return realPrune(a); };
    const { argv } = await launch(backend, { discoveryTools: true }, { project: { externalMcpPrune: true } });
    assert.equal(argv.filter((a) => a.includes('--strict-mcp-config')).length, 1, argv.join(' '));
    assert.deepEqual(seen, ['switchboard']);
    assert.ok(configFileIn(argv), 'the file with the switchboard row is still passed');
  });

  test(`[${shape}] a stored diffTool the family never declares still registers the diff group (O9, pinned)`, async () => {
    // `spawnOptionsFor` layers stored options without asking which fields the descriptor declares. No control
    // sets `diffTool` for Claude, so this needs a hand-edited or imported settings blob. Pinned as it behaves today;
    // on terminal Claude the group then sits beside the `--ide` bridge, which carries diffs as well.
    const backend = make();
    const key = backend.baseId || backend.id;
    const { ctx } = await launch(backend, {}, { global: { backendDefaults: { [key]: { diffTool: true } } } });
    assert.equal(ctx.registered.length, 1);
    assert.deepEqual(ctx.registered[0].groups, ['diff']);
  });
}
