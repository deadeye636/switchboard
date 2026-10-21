'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateExternalMcpServers, readExternalMcpServers } = require('../src/app/external-mcp');
const { validateImportPayload, mergeImport, buildExportPayload } = require('../src/app/settings-transfer');

const stdio = { name: 'files', transport: 'stdio', command: 'node', args: ['srv.js'], env: { TOKEN: '${GH_TOKEN}' } };
const http = { name: 'remote', transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${T}' } };

test('absent or empty list normalizes to nothing', () => {
  for (const v of [undefined, null, []]) {
    assert.deepStrictEqual(validateExternalMcpServers(v), { servers: [], rejected: [], warnings: [] });
  }
});

test('valid stdio and http entries normalize', () => {
  const { servers, rejected } = validateExternalMcpServers([stdio, http]);
  assert.strictEqual(rejected.length, 0);
  assert.deepStrictEqual(servers[0], { name: 'files', transport: 'stdio', enabled: true, command: 'node', args: ['srv.js'], env: { TOKEN: '${GH_TOKEN}' } });
  assert.deepStrictEqual(servers[1], { name: 'remote', transport: 'http', enabled: true, url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${T}' } });
});

test('enabled and backends are kept as data', () => {
  const { servers } = validateExternalMcpServers([{ ...stdio, enabled: false, backends: ['codex'] }]);
  assert.strictEqual(servers[0].enabled, false);
  assert.deepStrictEqual(servers[0].backends, ['codex']);
});

test('each malformed entry is rejected with a reason, the rest survive', () => {
  const bad = [
    null,
    { transport: 'stdio', command: 'x' },
    { name: 'a b', transport: 'stdio', command: 'x' },
    { name: 'switchboard', transport: 'stdio', command: 'x' },
    { name: 'SwitchBoard', transport: 'stdio', command: 'x' },
    { name: 'a', transport: 'ws', command: 'x' },
    { name: 'a', transport: 'stdio' },
    { name: 'a', transport: 'http' },
    { name: 'a', transport: 'stdio', command: 'x', args: 'no' },
    { name: 'a', transport: 'stdio', command: 'x', args: [1] },
    { name: 'a', transport: 'stdio', command: 'x', env: { K: 1 } },
    { name: 'a', transport: 'http', url: 'u', headers: { K: 1 } },
    { name: 'a', transport: 'stdio', command: 'x', enabled: 'yes' },
    { name: 'a', transport: 'stdio', command: 'x', backends: 'codex' },
    { name: 'a', transport: 'stdio', command: 'x', url: 'u' },
    { name: 'a', transport: 'http', url: 'u', command: 'x' },
  ];
  const { servers, rejected } = validateExternalMcpServers([...bad, stdio]);
  assert.strictEqual(rejected.length, bad.length);
  assert.ok(rejected.every(r => typeof r.reason === 'string' && r.reason));
  assert.deepStrictEqual(servers.map(s => s.name), ['files']);
});

test('a duplicate name is rejected; a non-array value is one rejection', () => {
  assert.strictEqual(validateExternalMcpServers([stdio, stdio]).rejected[0].reason, 'duplicate name');
  assert.strictEqual(validateExternalMcpServers({}).rejected.length, 1);
});

test('a literal secret warns but is not rejected; a ${VAR} reference does not warn', () => {
  const lit = validateExternalMcpServers([{ ...stdio, env: { API_KEY: 'sk-abcdef123456' } }]);
  assert.strictEqual(lit.servers.length, 1);
  assert.strictEqual(lit.warnings.length, 1);
  assert.strictEqual(validateExternalMcpServers([stdio, http]).warnings.length, 0);
});

test('a worktree path reads its project\'s list', () => {
  const sep = require('node:path').sep;
  const project = sep + ['proj', 'app'].join(sep);
  const wt = project + sep + '.claude' + sep + 'worktrees' + sep + 'feature';
  const reads = [];
  const getSetting = key => { reads.push(key); return key === 'project:' + project ? { externalMcpServers: [stdio] } : null; };
  assert.strictEqual(readExternalMcpServers(getSetting, project).servers.length, 1);
  assert.strictEqual(readExternalMcpServers(getSetting, wt).servers.length, 1);
  assert.strictEqual(readExternalMcpServers(getSetting, '').servers.length, 0);
});

test('settings import drops externalMcpServers, export keeps it', () => {
  const blob = { theme: 'dark', externalMcpServers: [stdio] };
  const exported = buildExportPayload(blob, 'now', []);
  assert.deepStrictEqual(exported.global.externalMcpServers, [stdio]);

  const check = validateImportPayload(exported);
  assert.strictEqual(check.ok, true);
  assert.strictEqual('externalMcpServers' in check.global, false);
  assert.deepStrictEqual(check.dropped, ['externalMcpServers']);
  assert.strictEqual(check.global.theme, 'dark');

  const merged = mergeImport({ existing: 1 }, blob);
  assert.strictEqual('externalMcpServers' in merged, false);
  assert.strictEqual(merged.theme, 'dark');
});
