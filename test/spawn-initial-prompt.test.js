'use strict';
// #888: a first prompt goes on the CLI's command line through the backend's `initialPromptArgs`, decided in the REAL
// spawn block (`src/app/terminal/spawn.js`), with `node-pty` as the only stand-in. What is pinned:
//   - a fresh terminal launch appends the hook's args last and answers `initialPrompt: 'applied'`;
//   - a resume, a backend without the hook, a hook that declines and a text over the cap answer 'declined' and add
//     nothing; no first prompt answers null;
//   - the prompt never reaches `buildLaunch` as an option;
//   - the cmd.exe guard is there (a source check: the resolved shell cannot be chosen from a test).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after } = require('node:test');
const { stripComments } = require('./helpers/strip-comments');

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

const bindingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-initial-prompt-'));
after(() => { fs.rmSync(bindingDir, { recursive: true, force: true }); });

function fakeBackend(over = {}) {
  const seen = [];
  return {
    id: 'fake', label: 'Fake', axis: 'B', status: 'ready', configFields: [],
    buildLaunch: ({ options }) => { seen.push(options || {}); return { command: 'fake-cli', args: ['--base'], env: {}, spawnMode: 'argv' }; },
    initialPromptArgs: (text) => ['--start', text],
    seen,
    ...over,
  };
}

function setup(backend) {
  const ctx = {
    activeSessions: new Map(),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
    getAppQuitting: () => false,
    liveStoreRef: new Map(), liveBusy: new Map(), cleanPtyEnv: {}, projectsDir: bindingDir, bindingDir,
    backends: { get: (id) => (id === backend.id ? backend : null), isLaunchable: () => true, backendCoreEnv: () => ({}) },
    sessionBackends: { get: () => null, record: () => {} },
    getSetting: (k) => (k === 'global' ? { backendEnv: {} } : {}),
    effectiveSettings: () => ({ shellProfile: 'auto' }),
    attentionHooksEnabled: () => false,
    classifyShellType: () => 'bash',
    resolveArgvExecutable: () => 'fake-cli.exe',
    resolveTerminalShellProfileId: () => 'auto',
    resolveLauncherCwd: (_l, p) => p,
    composeLauncherCommand: () => '',
    resolveSpawnEnv: (e) => e,
    getCachedSession: () => null,
    cleanupSecretRefsForSession: () => {},
    ensureProjectAdded: () => {},
    windowForSession: () => null,
    startMcpServer: async () => null,
    shutdownMcpServer: () => {},
    log: { info() {}, warn() {}, error() {}, silly() {}, debug() {} },
  };
  spawn.init(ctx);
  return ctx;
}

const CWD = process.cwd();
let n = 0;
async function launch(backend, { isNew = true, options = {} } = {}) {
  setup(backend);
  const r = await spawn.openTerminal(`ip-${++n}`, CWD, isNew, { backendId: backend.id, ...options });
  assert.equal(r.ok, true, r.error);
  return { r, args: ptySpawns.at(-1).args };
}

test('a fresh launch puts the first prompt last on the command line and says so', async () => {
  const backend = fakeBackend();
  const { r, args } = await launch(backend, { options: { initialPrompt: 'read the handoff\nthen go' } });
  assert.equal(r.initialPrompt, 'applied');
  assert.deepEqual(args.slice(-2), ['--start', 'read the handoff\nthen go']);
  assert.equal('initialPrompt' in backend.seen.at(-1), false, 'the prompt is not a launch option');
});

test('no first prompt: nothing added, and the answer is null', async () => {
  const { r, args } = await launch(fakeBackend());
  assert.equal(r.initialPrompt, null);
  assert.equal(args.includes('--start'), false);
});

test('declined, and nothing added: a resume, no hook, a hook that declines, a text over the cap', async () => {
  const cases = [
    ['a resume', fakeBackend(), { isNew: false, options: { initialPrompt: 'hi' } }],
    ['no hook', fakeBackend({ initialPromptArgs: null }), { options: { initialPrompt: 'hi' } }],
    ['the hook declines', fakeBackend({ initialPromptArgs: () => null }), { options: { initialPrompt: 'hi' } }],
    ['over the cap', fakeBackend(), { options: { initialPrompt: 'x'.repeat(16001) } }],
  ];
  for (const [name, backend, opts] of cases) {
    const { r, args } = await launch(backend, opts);
    assert.equal(r.initialPrompt, 'declined', name);
    assert.equal(args.includes('--start'), false, name);
  }
});

test('a command line past what Windows takes declines the prompt instead of failing the spawn', async () => {
  // 15 000 quotes: under the character cap, but each one doubles on the command line.
  const quotes = await launch(fakeBackend(), { options: { initialPrompt: '"'.repeat(15000) } });
  assert.equal(quotes.r.initialPrompt, 'declined');
  // The same length of ordinary text fits.
  const plain = await launch(fakeBackend(), { options: { initialPrompt: 'a'.repeat(15000) } });
  assert.equal(plain.r.initialPrompt, 'applied');
});

// The shells cannot be chosen from a test (the resolved shell is the machine's), so the guards are pinned by source.
test('cmd.exe, and a text that PowerShell 5.1, fish or nushell would alter, decline before the hook is asked', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '../src/app/terminal/spawn.js'), 'utf8'));
  assert.match(src, /const cmdShell = \/\^cmd\(\\\.exe\)\?\$\/\.test\(shellBase\);/);
  assert.match(src, /\/\^powershell\(\\\.exe\)\?\$\/\.test\(shellBase\) && wantedPrompt\.includes\('"'\)/);
  assert.match(src, /\/\^\(fish\|nu\)\(\\\.exe\)\?\$\/\.test\(shellBase\)/);
  assert.match(src, /!backend\.transport && !cmdShell && !alteredByShell/);
});
