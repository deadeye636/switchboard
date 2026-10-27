'use strict';
// The static check of external MCP server entries (#789 slice D, plan T4): every state, the sentinel guard
// (no value leaves), the network guard, the cost of many entries on a long PATH, and a thrown error.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const check = require('../src/app/external-mcp-check');
const { checkEntries, REASONS, FAILED } = check;
const { forgetListing } = require('../src/app/path-resolve');

beforeEach(() => forgetListing());

const SEP = ':';
const listOf = (dirs) => dirs.join(SEP);

// A fake fs over { dir: [names] | Error }; counts readdir and stat per path.
function fakeFs(dirs) {
  const counts = { readdir: new Map(), stat: [] };
  return {
    counts,
    promises: {
      async readdir(dir) {
        counts.readdir.set(dir, (counts.readdir.get(dir) || 0) + 1);
        const v = dirs[dir];
        if (v instanceof Error) throw v;
        if (!v) { const e = new Error('gone'); e.code = 'ENOENT'; throw e; }
        return v;
      },
      async stat(p) {
        counts.stat.push(p);
        return { isDirectory: () => false, mode: 0o755 };
      },
    },
  };
}

const errno = (code) => Object.assign(new Error(code), { code });

const DESC = (id, takes, extra = {}) => ({ id, label: `Label ${id}`, enabled: true, status: 'ready', externalMcpTakes: takes, ...extra });
const BACKENDS = [
  DESC('alpha', { transports: ['stdio', 'http'], cwd: false }),
  DESC('beta', { transports: ['stdio', 'http'], cwd: true }),
  DESC('gamma', { transports: ['stdio'], cwd: false }),
  DESC('delta', null),
];

const stdio = (over = {}) => ({ name: 'srv', transport: 'stdio', command: 'tool', args: [], env: {}, ...over });
const http = (over = {}) => ({ name: 'web', transport: 'http', url: 'https://example.invalid/mcp', headers: {}, ...over });

const baseContext = (over = {}) => ({
  projectPath: '/proj',
  env: { PATH: listOf(['/bin1', '/bin2']) },
  backendEnv: {},
  backends: BACKENDS,
  platform: 'linux',
  fs: fakeFs({ '/bin1': ['other'], '/bin2': ['tool'] }),
  ...over,
});

const takesOf = (res) => Object.fromEntries(res.takes.map((t) => [t.id, [t.takes, t.reason]]));

test('Windows references use folded names in the check and the external source', async () => {
  const { externalServersSource } = require('../src/app/mcp-inject');
  const entry = http({ headers: { X: '${PATH}', Y: '${EMPTY:-fallback}' } });
  const env = { Path: 'mixed', Empty: '' };
  const [result] = await checkEntries([entry], baseContext({ env, platform: 'win32' }));
  assert.equal(result.variables.find((v) => v.name === 'PATH').state, 'app');
  assert.equal(result.variables.find((v) => v.name === 'EMPTY').state, 'default');
  assert.deepEqual(takesOf(result).alpha, [true, null]);
  if (process.platform === 'win32') {
    const source = externalServersSource({ backend: BACKENDS[0], projectPath: '/proj', getSetting: () => ({ externalMcpServers: [entry] }), getEnv: () => env });
    assert.deepEqual(source()[0].headers, { X: 'mixed', Y: 'fallback' });
  }
  const [posix] = await checkEntries([http({ headers: { X: '${PATH}' } })], baseContext({ env: { Path: 'mixed' }, platform: 'linux' }));
  assert.deepEqual(takesOf(posix).alpha, [false, 'unset-variable']);
});

test('command: found, missing, unknown and not-applicable', async () => {
  const ctx = baseContext();
  const out = await checkEntries([
    stdio({ name: 'a' }),
    stdio({ name: 'b', command: 'nothing' }),
    http(),
    stdio({ name: 'c', command: '${GONE}/bin' }),
  ], ctx);
  assert.equal(out[0].command.state, 'found');
  assert.equal(out[0].command.resolved, path.posix.join('/bin2', 'tool'));
  assert.deepEqual(out[1].command, { state: 'missing' });
  assert.deepEqual(out[2].command, { state: 'not-applicable' });
  assert.deepEqual(out[3].command, { state: 'unknown', reason: 'unset-variable' });
});

test('command: a directory that cannot be read makes a miss unknown, a hit stays found', async () => {
  const ctx = baseContext({ fs: fakeFs({ '/bin1': errno('EACCES'), '/bin2': ['tool'] }) });
  const out = await checkEntries([stdio({ name: 'a' }), stdio({ name: 'b', command: 'nothing' })], ctx);
  assert.equal(out[0].command.state, 'found');
  assert.deepEqual(out[1].command, { state: 'unknown', reason: 'unreadable' });
});

test('every reason the resolver can give is in the closed set', () => {
  for (const r of ['network', 'unreadable', 'timeout', 'relative-path-entry', 'no-cwd', 'empty-name']) {
    assert.ok(REASONS.command.includes(r), r);
  }
});

test('variables: app, backend-env, declared-unresolved, default and unset', async () => {
  const ctx = baseContext({
    env: { PATH: listOf(['/bin2']), FROM_APP: 'a-value', EMPTY_REF_TARGET: '' },
    backendEnv: {
      alpha: { FROM_BACKEND: 'b-value', FROM_REF: '$MISSING_IN_APP' },
      beta: { FROM_BACKEND: 'b-value' },
    },
    fs: fakeFs({ '/bin2': ['tool'] }),
  });
  const [res] = await checkEntries([stdio({
    args: ['${FROM_APP}', '${FROM_BACKEND}', '${FROM_REF}', '${WITH_DEFAULT:-x}', '${NOWHERE}'],
  })], ctx);
  const by = Object.fromEntries(res.variables.map((v) => [v.name, v]));
  assert.equal(by.FROM_APP.state, 'app');
  assert.equal(by.FROM_BACKEND.state, 'backend-env');
  assert.deepEqual(by.FROM_BACKEND.backendIds, ['alpha', 'beta']);
  assert.equal(by.FROM_REF.state, 'declared-unresolved');
  assert.equal(by.WITH_DEFAULT.state, 'default');
  assert.equal(by.WITH_DEFAULT.hasDefault, true);
  assert.equal(by.NOWHERE.state, 'unset');
  assert.equal(by.NOWHERE.field, 'args');
  assert.equal(res.envGap, true);
  for (const v of res.variables) assert.ok(REASONS.variableStates.includes(v.state));
});

test('a backend variable that is a reference is set only when the app has the referenced one', async () => {
  const ctx = baseContext({
    env: { PATH: listOf(['/bin2']), HOST_KEY: 'k' },
    backendEnv: { alpha: { TOKEN: '$HOST_KEY' }, beta: { TOKEN: '$ABSENT' } },
  });
  const [res] = await checkEntries([stdio({ args: ['${TOKEN}'] })], ctx);
  assert.equal(res.variables[0].state, 'backend-env');
  assert.deepEqual(res.variables[0].backendIds, ['alpha']);
  assert.deepEqual(takesOf(res), { alpha: [true, null], beta: [false, 'unset-variable'], gamma: [false, 'unset-variable'], delta: [false, 'no-channel'] });
});

test('no variable at all: envGap is false', async () => {
  const [res] = await checkEntries([stdio()], baseContext());
  assert.deepEqual(res.variables, []);
  assert.equal(res.envGap, false);
});

test('takes: each reason code', async () => {
  const ctx = baseContext();
  const out = await checkEntries([
    stdio({ name: 'plain' }),
    stdio({ name: 'off', enabled: false }),
    stdio({ name: 'only', backends: ['beta'] }),
    stdio({ name: 'unset', env: { K: '${NOPE}' } }),
    http({ name: 'remote' }),
    stdio({ name: 'dir', cwd: 'sub' }),
    stdio({ name: 'emptycwd', cwd: '${EMPTY:-}' }),
  ], ctx);
  assert.deepEqual(takesOf(out[0]), { alpha: [true, null], beta: [true, null], gamma: [true, null], delta: [false, 'no-channel'] });
  assert.deepEqual(takesOf(out[1]), { alpha: [false, 'entry-disabled'], beta: [false, 'entry-disabled'], gamma: [false, 'entry-disabled'], delta: [false, 'entry-disabled'] });
  assert.deepEqual(takesOf(out[2]), { alpha: [false, 'backend-filter'], beta: [true, null], gamma: [false, 'backend-filter'], delta: [false, 'backend-filter'] });
  assert.deepEqual(takesOf(out[3]), { alpha: [false, 'unset-variable'], beta: [false, 'unset-variable'], gamma: [false, 'unset-variable'], delta: [false, 'no-channel'] });
  assert.deepEqual(takesOf(out[4]), { alpha: [true, null], beta: [true, null], gamma: [false, 'transport'], delta: [false, 'no-channel'] });
  assert.deepEqual(takesOf(out[5]), { alpha: [false, 'cwd'], beta: [true, null], gamma: [false, 'cwd'], delta: [false, 'no-channel'] });
  assert.deepEqual(takesOf(out[6]), { alpha: [true, null], beta: [true, null], gamma: [true, null], delta: [false, 'no-channel'] });
  for (const r of out) for (const t of r.takes) assert.ok(t.reason === null || REASONS.takes.includes(t.reason));
  assert.deepEqual(out[0].takes.map((t) => t.label), BACKENDS.map((b) => b.label));
});

test('a descriptor object is never mutated', async () => {
  const before = JSON.stringify(BACKENDS);
  await checkEntries([stdio({ cwd: 'sub' })], baseContext());
  assert.equal(JSON.stringify(BACKENDS), before);
});

test('rejected entries keep their index and carry no facts', async () => {
  const out = await checkEntries([
    stdio({ name: 'good' }),
    { name: 'bad name', transport: 'stdio', command: 'x' },
    'not an object',
    stdio({ name: 'good' }),
    stdio({ name: 'huge', command: 'x'.repeat(5000) }),
    stdio({ name: 'last' }),
  ], baseContext());
  assert.equal(out.length, 6);
  assert.equal(out[0].name, 'good');
  for (const i of [1, 2, 3, 4]) assert.deepEqual(out[i], { index: i, rejected: true });
  assert.equal(out[5].name, 'last');
  assert.equal(out[5].index, 5);
});

test('same input twice gives the same answer', async () => {
  const entries = [stdio(), http(), stdio({ name: 'u', args: ['${NOPE}'] })];
  const a = await checkEntries(entries, baseContext());
  forgetListing();
  const b = await checkEntries(entries, baseContext());
  assert.deepEqual(a, b);
});

test('G5: a command path and a PATH directory on a foreign share are never handed to fs', async () => {
  const f = fakeFs({ '/bin2': ['tool'] });
  const foreign = (p) => p.startsWith('//nas/') || p.startsWith('/nas/');
  const ctx = baseContext({
    env: { PATH: listOf(['/nas/bin', '/bin2']) },
    fs: f,
    isForeignNetworkPath: foreign,
  });
  const out = await checkEntries([stdio({ command: '/nas/tools/x' }), stdio({ name: 'b', command: 'absent' })], ctx);
  assert.deepEqual(out[0].command, { state: 'unknown', reason: 'network' });
  assert.deepEqual(out[1].command, { state: 'unknown', reason: 'network' });
  assert.equal(f.counts.readdir.has('/nas/bin'), false);
  assert.equal(f.counts.stat.some((p) => p.startsWith('/nas/')), false);
});

test('G5: a share a project is on is checked', async () => {
  const f = fakeFs({ '/bin2': ['tool'] });
  const ctx = baseContext({ fs: f, isForeignNetworkPath: () => false });
  const out = await checkEntries([stdio()], ctx);
  assert.equal(out[0].command.state, 'found');
});

test('G4: many entries on a 100-directory PATH cost one readdir per directory', async () => {
  const dirs = {};
  const names = [];
  for (let i = 0; i < 100; i++) { dirs[`/d${i}`] = [`cmd${i}`]; names.push(`/d${i}`); }
  const f = fakeFs(dirs);
  const entries = [];
  for (let i = 0; i < 40; i++) entries.push(stdio({ name: `e${i}`, command: `cmd${i * 2}` }));
  const out = await checkEntries(entries, baseContext({ env: { PATH: listOf(names) }, fs: f }));
  assert.ok(out.every((r) => r.command.state === 'found'));
  assert.equal(f.counts.readdir.size, 100);
  for (const n of f.counts.readdir.values()) assert.equal(n, 1);
});

test('G3: no value appears in the reply', async () => {
  const S = (tag) => `SENTINEL-${tag}-9f3a`;
  const ctx = baseContext({
    env: { PATH: listOf(['/bin2']), APP_SECRET: S('process'), OTHER: S('process2') },
    backendEnv: { alpha: { BACKEND_SECRET: S('backend') } },
  });
  const entries = [
    stdio({
      name: 'a', args: [S('arg'), '${APP_SECRET}', '${BACKEND_SECRET}'], env: { TOKEN: S('envval'), K2: '${OTHER}' }, cwd: S('cwd'),
    }),
    http({ headers: { Authorization: `Bearer ${S('header')}`, X: '${APP_SECRET}' }, url: `https://example.invalid/${S('url')}?k=${S('query')}` }),
  ];
  const out = await checkEntries(entries, ctx);
  const text = JSON.stringify(out);
  assert.ok(!text.includes('SENTINEL'), text);
  assert.ok(text.includes('APP_SECRET'), 'the variable NAME is reported');
});

test('IPC: a request that is not a list within the cap is refused with the fixed sentence', async () => {
  const lines = [];
  const log = { debug: (m) => lines.push(m), info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
  let handler = null;
  check.init({ backends: { list: () => BACKENDS }, getSetting: () => ({}), isForeignNetworkFile: () => false, log });
  check.registerIpc({ handle: (channel, fn) => { assert.equal(channel, 'external-mcp-check'); handler = fn; } });
  assert.deepEqual(await handler({}, { projectPath: '/p', entries: 'nope' }), { ok: false, reason: FAILED });
  assert.deepEqual(await handler({}, { projectPath: '/p', entries: new Array(65).fill(stdio()) }), { ok: false, reason: FAILED });
  assert.deepEqual(await handler({}, null), { ok: false, reason: FAILED });
});

test('IPC: only enabled, ready, non-template backends get a verdict; the reply is ok', async () => {
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  let handler = null;
  const list = [
    DESC('alpha', { transports: ['stdio'], cwd: false }),
    DESC('off', { transports: ['stdio'], cwd: false }, { enabled: false }),
    DESC('planned', { transports: ['stdio'], cwd: false }, { status: 'planned' }),
    DESC('tmpl', { transports: ['stdio'], cwd: false }, { isProfile: true }),
  ];
  check.init({ backends: { list: () => list }, getSetting: () => ({ backendEnv: { alpha: { A_VAR: 'v' } } }), isForeignNetworkFile: () => false, log });
  check.registerIpc({ handle: (_c, fn) => { handler = fn; } });
  const reply = await handler({}, { projectPath: '/p', entries: [stdio({ args: ['${A_VAR}'] })] });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.results[0].takes, [{ id: 'alpha', label: 'Label alpha', takes: true, reason: null }]);
});

test('a thrown error is logged and answered with a fixed sentence', async () => {
  const lines = [];
  const push = (...a) => lines.push(a.join(' '));
  const log = { debug: push, info: push, warn: push, error: push };
  let handler = null;
  const RAW = 'ENOTRAW-secret-path-text';
  check.init({ backends: { list: () => { throw new Error(RAW); } }, getSetting: () => ({}), isForeignNetworkFile: () => false, log });
  check.registerIpc({ handle: (_c, fn) => { handler = fn; } });
  const reply = await handler({}, { projectPath: '/p', entries: [stdio()] });
  assert.deepEqual(reply, { ok: false, reason: 'The check could not run.' });
  assert.ok(!JSON.stringify(reply).includes(RAW));
  assert.ok(lines.some((l) => l.includes(RAW)), 'the raw text is in the log');
});

test('IPC: no sentinel in the reply or any log line (process env and backend variable)', async () => {
  const lines = [];
  const push = (...a) => lines.push(a.join(' '));
  const log = { debug: push, info: push, warn: push, error: push };
  let handler = null;
  process.env.SB_TEST_PROC = 'SENTINEL-proc-77c1';
  try {
    check.init({
      backends: { list: () => [DESC('alpha', { transports: ['stdio'], cwd: false })] },
      getSetting: () => ({ backendEnv: { alpha: { SB_TEST_BE: 'SENTINEL-be-77c1' } } }),
      isForeignNetworkFile: () => false,
      log,
    });
    check.registerIpc({ handle: (_c, fn) => { handler = fn; } });
    const reply = await handler({}, { projectPath: '/p', entries: [stdio({ args: ['${SB_TEST_PROC}', '${SB_TEST_BE}', 'SENTINEL-arg-77c1'], env: { T: 'SENTINEL-env-77c1' } })] });
    assert.equal(reply.ok, true);
    assert.ok(!JSON.stringify(reply).includes('SENTINEL'));
    assert.ok(!lines.join('\n').includes('SENTINEL'));
  } finally {
    delete process.env.SB_TEST_PROC;
  }
});

test('the module makes no synchronous fs call', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'external-mcp-check.js'), 'utf8');
  assert.ok(!/\b\w+Sync\s*\(/.test(src));
  assert.ok(!/require\(['"]\.\.?\/(?:\.\.\/)?db\//.test(src));
});

test('F2: a PATH set by a backend variable or the entry makes a miss unknown, a hit stays found', async () => {
  const f = () => fakeFs({ '/bin1': ['other'], '/bin2': ['tool'] });
  const viaBackend = await checkEntries([stdio({ command: 'nothing' }), stdio({ name: 'b' })],
    baseContext({ fs: f(), backendEnv: { alpha: { PATH: '/elsewhere' } } }));
  assert.deepEqual(viaBackend[0].command, { state: 'unknown', reason: 'path-overridden' });
  assert.equal(viaBackend[1].command.state, 'found');
  const viaEntry = await checkEntries([stdio({ command: 'nothing', env: { PATH: '/x' } })], baseContext({ fs: f() }));
  assert.deepEqual(viaEntry[0].command, { state: 'unknown', reason: 'path-overridden' });
  const drive = `C:${String.fromCharCode(92)}bin`;
  const winFold = await checkEntries([stdio({ command: 'nothing', env: { Path: 'x' } })], baseContext({ fs: fakeFs({ [drive]: [] }), platform: 'win32', env: { PATH: drive } }));
  assert.equal(winFold[0].command.reason, 'path-overridden');
  const plain = await checkEntries([stdio({ command: 'nothing' })], baseContext({ fs: f() }));
  assert.deepEqual(plain[0].command, { state: 'missing' });
  assert.ok(REASONS.command.includes('path-overridden'));
});

test('F3: Windows names use the value passed to the child when spellings collide', async () => {
  const ctx = baseContext({
    platform: 'win32',
    env: { Path: 'C:/none', Mixed: 'app' },
    backendEnv: { alpha: { MIXED: 'be' } },
    backends: [DESC('alpha', { transports: ['stdio'], cwd: false })],
  });
  const [res] = await checkEntries([stdio({ args: ['${Mixed}', '${MIXED}'] })], ctx);
  const by = Object.fromEntries(res.variables.map((v) => [v.name, v.state]));
  assert.equal(by.Mixed, 'backend-env');
  assert.equal(by.MIXED, 'backend-env');
  assert.deepEqual(takesOf(res), { alpha: [true, null] });
});

test('Windows backend empty override remains visible when another backend inherits the app', async () => {
  const ctx = baseContext({ platform: 'win32', env: { Path: 'app' }, backendEnv: { alpha: { PATH: '' } }, backends: BACKENDS.slice(0, 2) });
  const [result] = await checkEntries([http({ headers: { X: '${PATH:-fallback}' } })], ctx);
  assert.equal(result.variables[0].state, 'mixed');
  assert.equal(result.variables[0].backendIds, undefined);
  assert.equal(result.envGap, true);
  assert.deepEqual(takesOf(result).alpha, [true, null]);
});

test('commands and working directories that vary by backend are not reported as a single path', async () => {
  const context = baseContext({ platform: 'win32', env: { Dir: 'C:/app' }, backendEnv: { alpha: { DIR: '' } }, backends: BACKENDS.slice(0, 2) });
  const out = await checkEntries([
    stdio({ command: '${DIR}/tool' }),
    stdio({ name: 'cwd', command: './tool', cwd: '${DIR}', backends: ['alpha', 'beta'] }),
    stdio({ name: 'filtered', command: '${DIR}/tool', backends: ['beta'] }),
  ], context);
  assert.deepEqual(out[0].command, { state: 'unknown', reason: 'backend-env-varies' });
  assert.deepEqual(out[1].command, { state: 'unknown', reason: 'backend-env-varies' });
  assert.notEqual(out[2].command.reason, 'backend-env-varies');
  assert.equal(out[2].variables[0].state, 'app');
});

test('Windows empty backend override falls back instead of claiming a backend value', async () => {
  const context = baseContext({ platform: 'win32', env: { Dir: 'C:/app' }, backendEnv: { alpha: { DIR: '' } }, backends: [BACKENDS[0]] });
  const [result] = await checkEntries([http({ headers: { X: '${DIR:-fallback}' } })], context);
  assert.equal(result.variables[0].state, 'default');
  assert.deepEqual(takesOf(result).alpha, [true, null]);
});

test('Windows folds a backend bundle before dropping unresolved references', async () => {
  const entry = http({ headers: { X: '${THING}' } });
  const context = baseContext({ platform: 'win32', env: {}, backends: [BACKENDS[0]] });
  context.backendEnv = { alpha: { Thing: 'literal', THING: '$ABSENT' } };
  let [result] = await checkEntries([entry], context);
  assert.equal(result.variables[0].state, 'declared-unresolved');
  assert.deepEqual(takesOf(result).alpha, [false, 'unset-variable']);
  context.backendEnv = { alpha: { THING: '$ABSENT', Thing: 'literal' } };
  [result] = await checkEntries([entry], context);
  assert.equal(result.variables[0].state, 'backend-env');
  assert.deepEqual(takesOf(result).alpha, [true, null]);
});


test('F4: a relative cwd resolves against the project before the command is looked up', async () => {
  const f = fakeFs({});
  f.promises.stat = async (p) => {
    f.counts.stat.push(p);
    if (p === '/proj/sub/bin/tool') return { isDirectory: () => false, mode: 0o755 };
    const e = new Error('gone'); e.code = 'ENOENT'; throw e;
  };
  const out = await checkEntries([stdio({ command: './bin/tool', cwd: 'sub' }), stdio({ name: 'b', command: './bin/tool', cwd: 'sub' })],
    baseContext({ fs: f }));
  assert.equal(out[0].command.state, 'found');
  assert.equal(out[0].command.resolved, '/proj/sub/bin/tool');
  const none = await checkEntries([stdio({ command: './bin/tool', cwd: 'sub' })], baseContext({ projectPath: null, fs: f }));
  assert.deepEqual(none[0].command, { state: 'unknown', reason: 'no-cwd' });
});

test('a ${VAR:-d} whose backend reference is dropped reads default, and the backend still takes the entry', async () => {
  const ctx = baseContext({ backendEnv: { alpha: { OPT: '$NOT_IN_APP' } } });
  const [res] = await checkEntries([stdio({ args: ['${OPT:-d}'] }), stdio({ name: 'b', args: ['${OPT}'] })], ctx);
  assert.equal(res.variables[0].state, 'default');
  assert.equal(takesOf(res).alpha[0], true);
  assert.equal(res.envGap, false);
  const [, strict] = await checkEntries([stdio({ args: ['${OPT:-d}'] }), stdio({ name: 'b', args: ['${OPT}'] })], ctx);
  assert.equal(strict.variables[0].state, 'declared-unresolved');
  assert.equal(takesOf(strict).alpha[1], 'unset-variable');
});

test('F2 precision: only a PATH that reaches a launch overrides', async () => {
  const f = () => fakeFs({ '/bin1': ['other'], '/bin2': ['tool'] });
  // (a) a PATH reference the app cannot fill is dropped at launch
  const dropped = await checkEntries([stdio({ command: 'nothing' })], baseContext({ fs: f(), backendEnv: { alpha: { PATH: '$NOT_IN_APP' } } }));
  assert.deepEqual(dropped[0].command, { state: 'missing' });
  // (b) a backend that does not take the entry does not count
  const notTaking = await checkEntries([stdio({ command: 'nothing', backends: ['beta'] })], baseContext({ fs: f(), backendEnv: { alpha: { PATH: '/elsewhere' } } }));
  assert.deepEqual(notTaking[0].command, { state: 'missing' });
  const taking = await checkEntries([stdio({ command: 'nothing', backends: ['alpha'] })], baseContext({ fs: f(), backendEnv: { alpha: { PATH: '/elsewhere' } } }));
  assert.deepEqual(taking[0].command, { state: 'unknown', reason: 'path-overridden' });
  // (c) a command given as a path is not looked up on PATH, so another PATH changes nothing
  const gone = f();
  gone.promises.stat = async () => { throw errno('ENOENT'); };
  const asPath = await checkEntries([stdio({ command: '/opt/gone/tool', env: { PATH: '/elsewhere' } })], baseContext({ fs: gone }));
  assert.equal(asPath[0].command.state, 'missing');
});
