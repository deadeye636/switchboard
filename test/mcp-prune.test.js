'use strict';
// The per-spawn MCP prune seam (spec 36, "Prune"): the composer in `src/app/mcp-prune.js` and the spawn block that
// calls it. Behavioural: `node-pty` is replaced in the require cache BEFORE `spawn.js` loads, as in
// `test/spawn-mcp-inject.test.js`.
const test = require('node:test');
const assert = require('node:assert/strict');

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

const { composeMcpPrune } = require('../src/app/mcp-prune');
const spawn = require('../src/app/terminal/spawn');
const backends = require('../src/backends');

const quietLog = () => {
  const lines = { info: [], warn: [] };
  return { lines, info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m), debug() {} };
};

// ---- the composer ----

test('composeMcpPrune answers null unless enabled is exactly true', () => {
  const backend = { id: 'x', providesMcpPrune: true, buildMcpPrune: () => ({ args: ['--p'], env: null }) };
  for (const enabled of [undefined, false, 'true', 1, null]) {
    assert.equal(composeMcpPrune({ backend, enabled }), null);
  }
  assert.deepEqual(composeMcpPrune({ backend, enabled: true }), { args: ['--p'], env: null });
});

test('a declining backend gets null and one info line', () => {
  const log = quietLog();
  assert.equal(composeMcpPrune({ backend: { id: 'x', providesMcpPrune: false }, enabled: true, log }), null);
  assert.equal(log.lines.info.length, 1);
  assert.equal(composeMcpPrune({ backend: { id: 'x', providesMcpPrune: true }, enabled: true, log }), null, 'a flag without the hook declines');
});

test('a hook that throws or answers nothing is a null, never a throw', () => {
  const log = quietLog();
  const mk = (fn) => ({ id: 'x', providesMcpPrune: true, buildMcpPrune: fn });
  assert.equal(composeMcpPrune({ backend: mk(() => { throw new Error('boom'); }), enabled: true, log }), null);
  assert.equal(log.lines.warn.length, 1);
  assert.equal(composeMcpPrune({ backend: mk(() => null), enabled: true, log }), null);
  assert.equal(composeMcpPrune({ backend: mk(() => ({ args: [], env: null })), enabled: true, log }), null);
});

test('the hook is handed the injected names, env, cwd and options', () => {
  let seen;
  const backend = { id: 'x', providesMcpPrune: true, buildMcpPrune: (a) => { seen = a; return { args: ['--p'], env: { K: 'v' } }; } };
  const out = composeMcpPrune({ backend, enabled: true, injectedNames: ['a'], env: { E: '1' }, cwd: 'proj', options: { o: 1 } });
  assert.deepEqual(out, { args: ['--p'], env: { K: 'v' } });
  assert.deepEqual(seen.injectedNames, ['a']);
  assert.deepEqual(seen.env, { E: '1' });
  assert.equal(seen.cwd, 'proj');
  assert.deepEqual(seen.options, { o: 1 });
});

test('every real backend declines for now: enabled prune changes nothing', () => {
  for (const b of backends.list()) {
    if (b.status !== 'ready') continue;
    assert.equal(composeMcpPrune({ backend: b, enabled: true, log: quietLog() }), null, `${b.id} must not prune yet`);
  }
});

// ---- the spawn seam ----

function fakeBackend(over = {}) {
  return {
    id: 'codex', label: 'Codex', axis: 'B', status: 'ready',
    buildLaunch: () => ({ command: 'codex', args: ['--base'], env: {} }),
    ...over,
  };
}

function setup({ backend, prune = false } = {}) {
  const ctx = {
    activeSessions: new Map(),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    getAppQuitting: () => false,
    liveStoreRef: new Map(), liveBusy: new Map(), cleanPtyEnv: {}, projectsDir: 'D:/nope', bindingDir: 'D:/nope',
    backends: { get: (id) => (id === backend.id ? backend : null), isLaunchable: () => true, backendCoreEnv: () => ({}) },
    sessionBackends: { get: () => null, record: () => {} },
    getSetting: (k) => (k === 'global' ? { backendEnv: {} } : (prune ? { externalMcpPrune: true } : {})),
    effectiveSettings: () => ({ shellProfile: 'auto' }),
    attentionHooksEnabled: () => false,
    classifyShellType: () => 'bash',
    resolveArgvExecutable: () => null,
    resolveTerminalShellProfileId: () => 'auto',
    resolveLauncherCwd: (_l, p) => p,
    composeLauncherCommand: () => '',
    resolveSpawnEnv: (e) => e,
    getCachedSession: () => null,
    cleanupSecretRefsForSession: () => {},
    ensureProjectAdded: () => {},
    registerMcpHttpSession: async () => null,
    createDiscoveryReader: () => null,
    windowForSession: () => null,
    startMcpServer: async () => null,
    shutdownMcpServer: () => {},
    log: { info() {}, warn() {}, error() {}, silly() {}, debug() {} },
  };
  spawn.init(ctx);
  return ctx;
}

const CWD = process.cwd();
const launchArgs = () => ptySpawns.at(-1).args.join(' ');

test('setting off: a hook-declaring backend is not asked and the argv is unchanged', async () => {
  ptySpawns.length = 0;
  let asked = 0;
  setup({ backend: fakeBackend({ providesMcpPrune: true, buildMcpPrune: () => { asked++; return { args: ['--prune'], env: null }; } }) });
  const r = await spawn.openTerminal('s1', CWD, true, { backendId: 'codex' });
  assert.equal(r.ok, true);
  assert.equal(asked, 0);
  assert.ok(!launchArgs().includes('--prune'));
});

test('setting on: a backend with no injection quartet still prunes; args and env reach the launch', async () => {
  ptySpawns.length = 0;
  setup({
    prune: true,
    backend: fakeBackend({ providesMcpPrune: true, buildMcpPrune: () => ({ args: ['--prune'], env: { PRUNE_X: '1' } }) }),
  });
  const r = await spawn.openTerminal('s2', CWD, true, { backendId: 'codex' });
  assert.equal(r.ok, true);
  assert.ok(launchArgs().includes('--base') && launchArgs().includes('--prune'));
  assert.equal(ptySpawns.at(-1).opts.env.PRUNE_X, '1');
});

test('setting on: a declining backend launches exactly as before', async () => {
  ptySpawns.length = 0;
  setup({ prune: true, backend: fakeBackend({ providesMcpPrune: false }) });
  const r = await spawn.openTerminal('s3', CWD, true, { backendId: 'codex' });
  assert.equal(r.ok, true);
  assert.ok(launchArgs().includes('--base'));
  assert.ok(!launchArgs().includes('--prune'));
});

test('setting on: a throwing hook never fails the launch', async () => {
  ptySpawns.length = 0;
  setup({ prune: true, backend: fakeBackend({ providesMcpPrune: true, buildMcpPrune: () => { throw new Error('boom'); } }) });
  const r = await spawn.openTerminal('s4', CWD, true, { backendId: 'codex' });
  assert.equal(r.ok, true);
  assert.ok(launchArgs().includes('--base'));
});
