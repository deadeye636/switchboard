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

test('servers meant for the launch that none reached it: no prune, one warning (D-P6)', () => {
  const backend = { id: 'x', providesMcpPrune: true, buildMcpPrune: () => ({ args: ['--p'], env: null }) };
  const log = quietLog();
  assert.equal(composeMcpPrune({ backend, enabled: true, wantedServers: 2, injectedNames: [], log }), null);
  assert.equal(log.lines.warn.length, 1);
  assert.deepEqual(composeMcpPrune({ backend, enabled: true, wantedServers: 2, injectedNames: ['a'] }), { args: ['--p'], env: null },
    'a launch that got some of its servers is pruned');
  assert.deepEqual(composeMcpPrune({ backend, enabled: true, wantedServers: 0, injectedNames: [] }), { args: ['--p'], env: null },
    'a project with no servers still prunes');
});

test('a template forwards the flag and the hook, and prunes like its base', () => {
  const { profileToDescriptor } = require('../src/backends');
  const template = profileToDescriptor({ id: 't-prune', name: 'T', backendId: 'claude' });
  const base = backends.get('claude');
  assert.equal(template.providesMcpPrune, true);
  assert.equal(template.buildMcpPrune, base.buildMcpPrune);
  assert.deepEqual(composeMcpPrune({ backend: template, enabled: true }), composeMcpPrune({ backend: base, enabled: true }));
});

test('real backends: only the wired ones prune when enabled, the rest decline', () => {
  // Claude and claude-native prune (--strict-mcp-config, #789 T4); under scope B every other backend declines
  // for good. Keep this in step with the capability matrix in backend-capabilities.test.js.
  const PRUNERS = new Set(['claude', 'claude-native']);
  for (const b of backends.list()) {
    if (b.status !== 'ready') continue;
    const out = composeMcpPrune({ backend: b, enabled: true, log: quietLog() });
    if (PRUNERS.has(b.id)) {
      assert.ok(out && Array.isArray(out.args) && out.args.length, `${b.id} must prune when enabled`);
    } else {
      assert.equal(out, null, `${b.id} must not prune`);
    }
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

function setup({ backend, prune = false, project = null } = {}) {
  const ctx = {
    activeSessions: new Map(),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    getAppQuitting: () => false,
    liveStoreRef: new Map(), liveBusy: new Map(), cleanPtyEnv: {}, projectsDir: 'D:/nope', bindingDir: 'D:/nope',
    backends: { get: (id) => (id === backend.id ? backend : null), isLaunchable: () => true, backendCoreEnv: () => ({}) },
    sessionBackends: { get: () => null, record: () => {} },
    getSetting: (k) => (k === 'global' ? { backendEnv: {} } : project || (prune ? { externalMcpPrune: true } : {})),
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

const SERVER = { name: 'srv', transport: 'stdio', command: 'node', args: ['srv.js'] };

test('setting on: the injected server names reach the prune hook', async () => {
  ptySpawns.length = 0;
  let seen;
  setup({
    project: { externalMcpPrune: true, externalMcpServers: [SERVER] },
    backend: fakeBackend({
      providesMcpInjection: true, acceptsMcpTransports: ['stdio'],
      buildMcpInjection: () => ({ args: ['--inj'], env: null, cleanup: null }),
      providesMcpPrune: true, buildMcpPrune: (a) => { seen = a.injectedNames; return { args: ['--prune'], env: null }; },
    }),
  });
  const r = await spawn.openTerminal('s5', CWD, true, { backendId: 'codex' });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['srv']);
  assert.ok(launchArgs().includes('--inj') && launchArgs().includes('--prune'));
});

test('setting on: project servers that did not reach the launch leave it unpruned', async () => {
  ptySpawns.length = 0;
  setup({
    project: { externalMcpPrune: true, externalMcpServers: [SERVER] },
    backend: fakeBackend({
      providesMcpInjection: true, acceptsMcpTransports: ['stdio'], buildMcpInjection: () => { throw new Error('boom'); },
      providesMcpPrune: true, buildMcpPrune: () => ({ args: ['--prune'], env: null }),
    }),
  });
  const r = await spawn.openTerminal('s6', CWD, true, { backendId: 'codex' });
  assert.equal(r.ok, true);
  assert.ok(launchArgs().includes('--base'));
  assert.ok(!launchArgs().includes('--prune'));
});

test('real backends: with the key absent or false, no launch carries its prune args or env (G4)', async () => {
  // Only a backend that declares the hook has anything to leak; a declining one is never asked (the composer
  // test above). A runtime-driven backend is left out: its pipe start resolves the real executable, which this
  // fake ctx does not have. claude-native shares terminal Claude's hook, so the terminal run covers the hook.
  let checked = 0;
  for (const b of backends.list()) {
    const desc = backends.get(b.id);
    if (b.status !== 'ready' || desc.providesMcpPrune !== true || desc.transport) continue;
    checked++;
    const pruned = composeMcpPrune({ backend: desc, enabled: true }) || { args: [], env: null };
    for (const project of [{}, { externalMcpPrune: false }]) {
      ptySpawns.length = 0;
      setup({ backend: desc, project });
      const r = await spawn.openTerminal(`g4-${b.id}`, CWD, true, { backendId: b.id });
      assert.equal(r.ok, true, `${b.id} launches`);
      const sent = ptySpawns.at(-1);
      for (const a of pruned.args) assert.ok(!sent.args.join(' ').includes(a), `${b.id} carries ${a} with prune off`);
      for (const k of Object.keys(pruned.env || {})) assert.equal(sent.opts.env[k], undefined, `${b.id} carries ${k} with prune off`);
    }
  }
  assert.ok(checked > 0, 'at least one terminal backend prunes, so the loop checked something');
});
