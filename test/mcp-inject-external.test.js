'use strict';
// The external-servers source (spec 36, T3): the project's validated list as neutral rows, `${VAR}` expanded
// against the session env, a missing variable skipping the entry, disabled / other-backend / invalid entries out.
const test = require('node:test');
const assert = require('node:assert/strict');
const { externalServersSource, composeMcpInjection, externalServersFor, entryAppliesTo } = require('../src/app/mcp-inject');

const OWNER = '/proj/app';
const make = (list, over = {}) => {
  const logs = [];
  const source = externalServersSource({
    backend: { id: 'codex' },
    getSetting: (k) => (k === 'project:' + OWNER ? { externalMcpServers: list } : {}),
    projectPath: OWNER,
    getEnv: () => ({ TOKEN: 'abc', HOME_DIR: '/home/u' }),
    log: { info: (m) => logs.push(m) },
    ...over,
  });
  return { source, logs };
};

test('an absent or empty list yields no rows', () => {
  assert.deepEqual(make(undefined).source(), []);
  assert.deepEqual(make([]).source(), []);
  assert.deepEqual(externalServersSource({}) (), []);
});

test('stdio and http entries become neutral rows; cwd only when present', () => {
  const { source } = make([
    { name: 'a', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { K: 'v' }, cwd: '/w' },
    { name: 'b', transport: 'stdio', command: 'srv' },
    { name: 'h', transport: 'http', url: 'https://example.invalid/mcp', headers: { X: 'y' } },
  ]);
  assert.deepEqual(source(), [
    { name: 'a', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { K: 'v' }, cwd: '/w' },
    { name: 'b', transport: 'stdio', command: 'srv', args: [], env: {} },
    { name: 'h', transport: 'http', url: 'https://example.invalid/mcp', headers: { X: 'y' } },
  ]);
  assert.equal('cwd' in source()[1], false);
});

test('a cwd that expands to nothing is no cwd', () => {
  const { source } = make([{ name: 'a', transport: 'stdio', command: 'srv', cwd: '${EMPTY_DIR}' }],
    { getEnv: () => ({ EMPTY_DIR: '' }) });
  const rows = source();
  assert.equal(rows.length, 1);
  assert.equal('cwd' in rows[0], false);
});

test('${VAR} expands in command, args, env, cwd, url and headers; a default applies', () => {
  const { source } = make([
    { name: 'a', transport: 'stdio', command: '${HOME_DIR}/bin', args: ['--t=${TOKEN}'], env: { T: '${TOKEN}', D: '${NOPE:-dflt}' }, cwd: '${HOME_DIR}' },
    { name: 'h', transport: 'http', url: 'https://x.invalid/${TOKEN}', headers: { Authorization: 'Bearer ${TOKEN}' } },
  ]);
  const [a, h] = source();
  assert.deepEqual(a, { name: 'a', transport: 'stdio', command: '/home/u/bin', args: ['--t=abc'], env: { T: 'abc', D: 'dflt' }, cwd: '/home/u' });
  assert.deepEqual(h, { name: 'h', transport: 'http', url: 'https://x.invalid/abc', headers: { Authorization: 'Bearer abc' } });
});

test('an entry with a missing variable is skipped and logged by name, never by value', () => {
  const { source, logs } = make([
    { name: 'bad', transport: 'stdio', command: 'srv', env: { K: '${MISSING_ONE}' } },
    { name: 'ok', transport: 'stdio', command: 'srv' },
  ]);
  assert.deepEqual(source().map((r) => r.name), ['ok']);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('bad') && logs[0].includes('MISSING_ONE'));
});

test('a disabled entry, another backend\'s entry and an invalid entry are left out', () => {
  const { source } = make([
    { name: 'off', transport: 'stdio', command: 'srv', enabled: false },
    { name: 'other', transport: 'stdio', command: 'srv', backends: ['claude'] },
    { name: 'mine', transport: 'stdio', command: 'srv', backends: ['codex'] },
    { name: 'broken', transport: 'stdio' },
    { name: 'switchboard', transport: 'http', url: 'https://x.invalid' },
  ]);
  assert.deepEqual(source().map((r) => r.name), ['mine']);
});

test('entryAppliesTo says why an entry does not apply, and honours baseId', () => {
  const codex = { id: 'codex' };
  assert.deepEqual(entryAppliesTo({ name: 'a' }, codex), { applies: true, reason: null });
  assert.deepEqual(entryAppliesTo({ name: 'a', enabled: false, backends: ['codex'] }, codex), { applies: false, reason: 'disabled' });
  assert.deepEqual(entryAppliesTo({ name: 'a', backends: ['claude'] }, codex), { applies: false, reason: 'backend-filter' });
  assert.deepEqual(entryAppliesTo({ name: 'a', backends: ['codex'] }, codex), { applies: true, reason: null });
  assert.deepEqual(entryAppliesTo({ name: 'a', backends: [] }, codex), { applies: false, reason: 'backend-filter' });
  assert.deepEqual(entryAppliesTo({ name: 'a', backends: ['claude'] }, undefined), { applies: true, reason: null });
  assert.deepEqual(entryAppliesTo({ name: 'a', backends: ['claude'] }, { id: 'claude-native', baseId: 'claude' }), { applies: true, reason: null });
  assert.deepEqual(entryAppliesTo({ name: 'a', backends: ['pi'] }, { id: 'claude-native', baseId: 'claude' }), { applies: false, reason: 'backend-filter' });
});

test('externalServersFor keeps the enabled entries meant for the backend, baseId included', () => {
  const list = [
    { name: 'off', transport: 'stdio', command: 'srv', enabled: false },
    { name: 'other', transport: 'stdio', command: 'srv', backends: ['pi'] },
    { name: 'base', transport: 'stdio', command: 'srv', backends: ['claude'] },
    { name: 'all', transport: 'stdio', command: 'srv' },
  ];
  const getSetting = (k) => (k === 'project:' + OWNER ? { externalMcpServers: list } : {});
  const names = (backend) => externalServersFor({ backend, getSetting, projectPath: OWNER }).map((s) => s.name);
  assert.deepEqual(names({ id: 'claude-native', baseId: 'claude' }), ['base', 'all']);
  assert.deepEqual(names({ id: 'codex' }), ['all']);
  assert.deepEqual(names(undefined), ['other', 'base', 'all']);
  assert.deepEqual(externalServersFor({ backend: { id: 'codex' } }), []);
});

test('through the composer: the stdio row is dropped when the backend takes http only', async () => {
  const { source } = make([
    { name: 'a', transport: 'stdio', command: 'srv' },
    { name: 'h', transport: 'http', url: 'https://x.invalid' },
  ]);
  let seen;
  const logs = [];
  const backend = {
    id: 'fake', providesMcpInjection: true, acceptsMcpTransports: ['http'],
    buildMcpInjection: async ({ servers }) => { seen = servers; return { args: ['--x'] }; },
  };
  const out = await composeMcpInjection({ backend, ctx: { log: { info: (m) => logs.push(m) } }, sources: [source] });
  assert.deepEqual(seen.map((s) => s.name), ['h']);
  assert.deepEqual(out.args, ['--x']);
  assert.ok(logs.some((m) => m.includes('"a"')));
});

test('through the composer: externalNames counts only project rows the backend takes (spec 37, O5/O8)', async () => {
  const { source } = make([
    { name: 'withcwd', transport: 'stdio', command: 'srv', cwd: 'sub' },
    { name: 'h', transport: 'http', url: 'https://x.invalid' },
  ]);
  const own = () => [{ name: 'switchboard', transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: {} }];
  let seen;
  const warns = [];
  const mk = (cwd) => ({
    id: 'fake', providesMcpInjection: true, acceptsMcpTransports: ['stdio', 'http'],
    externalMcpTakes: { transports: ['stdio', 'http'], cwd },
    buildMcpInjection: async ({ servers }) => { seen = servers.map((s) => s.name); return { args: ['--x'] }; },
  });
  const ctx = { log: { info() {}, warn: (m) => warns.push(m) } };
  const out = await composeMcpInjection({ backend: mk(false), ctx, sources: [own, source] });
  assert.deepEqual(seen, ['switchboard', 'h'], 'a row with cwd never reaches an emitter that has no per-server cwd');
  assert.deepEqual(out.names, ['switchboard', 'h']);
  assert.deepEqual(out.externalNames, ['h'], 'the own row is not external; the declined row is not counted');
  assert.ok(warns.some((m) => /declined "withcwd": .*cwd/.test(m)));
  const taken = await composeMcpInjection({ backend: mk(true), ctx, sources: [own, source] });
  assert.deepEqual(taken.externalNames, ['withcwd', 'h'], 'a backend that takes a cwd gets the row');
});

test('through the composer: a row whose address expanded to nothing is dropped and not counted', async () => {
  const { source } = make([{ name: 'blank', transport: 'stdio', command: '${EMPTY:-}' }]);
  const backend = {
    id: 'fake', providesMcpInjection: true, acceptsMcpTransports: ['stdio'],
    buildMcpInjection: async () => { throw new Error('must not be asked'); },
  };
  assert.equal(await composeMcpInjection({ backend, ctx: { log: { info() {}, warn() {} } }, sources: [source] }), null);
});

// #794: an entry that writes `${PATH}` against an environment that spells it `Path` (a normal Windows start).
test('on win32 a ${VAR} finds a key that differs only in case; elsewhere the entry is skipped as before', () => {
  const list = [{ name: 'p', transport: 'stdio', command: 'srv', env: { PATH: '${PATH};/extra' } }];
  const env = () => ({ Path: '/bin' });
  const onWin = make(list, { getEnv: env, platform: 'win32' });
  assert.deepEqual(onWin.source().map((r) => r.env), [{ PATH: '/bin;/extra' }]);
  const onLinux = make(list, { getEnv: env, platform: 'linux' });
  assert.deepEqual(onLinux.source(), []);
  assert.ok(onLinux.logs.some((m) => /unset variable PATH/.test(m)));
});
