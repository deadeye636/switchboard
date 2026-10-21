// End to end for a project's external MCP servers (#789, plan T7), against the REAL source, composer and the
// three REAL terminal descriptors. No CLI is started.
//
// WHY THIS EXISTS:
//   Each piece has its own test. This file seeds one `externalMcpServers` list and walks it through
//   `externalServersSource` -> `composeMcpInjection` -> Codex / agy / Claude, then asserts the one property
//   that spans all three emitters: NO secret value lands on any argv (D-S2). The secret may only sit in
//   Codex's spawn env, or in the 0600 file agy and Claude write.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { composeMcpInjection, externalServersSource } = require('../src/app/mcp-inject');
const codex = require('../src/backends/codex');
const agy = require('../src/backends/agy');
const claude = require('../src/backends/claude');

const log = { info() {}, debug() {}, warn() {}, error() {} };

const ENV_SECRET = 'env-secret-value-4f9a1c7e';
const TOKEN_SECRET = 'bearer-secret-value-b81d33a2';
const HEADER_SECRET = 'header-secret-value-0c5e92d4';
const SECRETS = [ENV_SECRET, TOKEN_SECRET, HEADER_SECRET];

const sessionEnv = { SAMPLE_API_KEY: ENV_SECRET, SAMPLE_TOKEN: TOKEN_SECRET, SAMPLE_HDR: HEADER_SECRET };

const SEEDED = [
  { name: 'fs-tool', transport: 'stdio', command: 'sample-server', args: ['--port', '0'], env: { SAMPLE_KEY: '${SAMPLE_API_KEY}' } },
  { name: 'fs-cwd', transport: 'stdio', command: 'other-server', cwd: '/sample/work', env: {} },
  {
    name: 'remote', transport: 'http', url: 'https://mcp.example.test/v1',
    headers: { Authorization: 'Bearer ${SAMPLE_TOKEN}', 'X-Sample-Key': '${SAMPLE_HDR}' },
  },
  { name: 'unset-var', transport: 'stdio', command: 'x-server', env: { K: '${SAMPLE_NOT_SET}' } },
];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-ext-e2e-'));
const projectDir = path.join(scratch, 'project');
const bindingDir = path.join(scratch, 'binding');
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(bindingDir, { recursive: true });
test.after(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

const getSetting = (key) => (key.startsWith('project:') ? { externalMcpServers: SEEDED } : undefined);

async function compose(backend) {
  const injection = await composeMcpInjection({
    backend,
    ctx: { log },
    dir: bindingDir,
    tag: 'e2e',
    cwd: projectDir,
    sources: [externalServersSource({ backend, getSetting, projectPath: projectDir, getEnv: () => sessionEnv, log })],
  });
  assert.ok(injection, `${backend.id}: the composer built an injection`);
  return injection;
}

const noSecret = (text) => SECRETS.every((s) => !String(text).includes(s));

test('the source skips an entry whose variable is unset, and resolves the others', async () => {
  const rows = externalServersSource({ backend: codex, getSetting, projectPath: projectDir, getEnv: () => sessionEnv, log })();
  assert.deepEqual(rows.map((r) => r.name), ['fs-tool', 'fs-cwd', 'remote']);
  assert.equal(rows[0].env.SAMPLE_KEY, ENV_SECRET, 'a ${VAR} reaches the row as its value');
  assert.equal(rows[2].headers.Authorization, `Bearer ${TOKEN_SECRET}`);
});

test('codex: -c overrides carry names only; the values ride the spawn env', async () => {
  const inj = await compose(codex);
  try {
    const joined = inj.args.join('\n');
    for (const key of [
      'mcp_servers.fs-tool.command=', 'mcp_servers.fs-tool.args=', 'mcp_servers.fs-tool.env_vars=',
      'mcp_servers.fs-cwd.cwd=', 'mcp_servers.remote.url=', 'mcp_servers.remote.bearer_token_env_var=',
      'mcp_servers.remote.env_http_headers=',
    ]) assert.ok(joined.includes(key), `argv has ${key}`);
    assert.ok(!joined.includes('mcp_servers.unset-var'), 'the skipped entry never reaches the backend');
    assert.ok(noSecret(joined), 'no secret value on argv');
    const envValues = Object.values(inj.env || {});
    for (const s of SECRETS) assert.ok(envValues.includes(s), 'the secret is in the spawn env');
  } finally {
    inj.release();
  }
});

test('agy: a 0600 bundle holds stdio and http entries without a type key; argv is empty', async () => {
  const inj = await compose(agy);
  try {
    assert.deepEqual(inj.args, []);
    const root = path.join(projectDir, '.agents', 'plugins');
    const bundles = fs.readdirSync(root).filter((n) => n.startsWith('switchboard-'));
    assert.equal(bundles.length, 1);
    const file = path.join(root, bundles[0], 'mcp_config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(config.mcpServers['fs-tool'], {
      command: 'sample-server', args: ['--port', '0'], env: { SAMPLE_KEY: ENV_SECRET },
    });
    assert.equal(config.mcpServers['fs-cwd'].cwd, '/sample/work');
    assert.deepEqual(config.mcpServers.remote, {
      url: 'https://mcp.example.test/v1',
      headers: { Authorization: `Bearer ${TOKEN_SECRET}`, 'X-Sample-Key': HEADER_SECRET },
    });
    for (const entry of Object.values(config.mcpServers)) assert.ok(!('type' in entry), 'no type key');
    assert.ok(!('unset-var' in config.mcpServers));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    inj.release();
  }
  const root = path.join(projectDir, '.agents', 'plugins');
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('switchboard-')), [], 'release removed the bundle');
});

test('claude: --mcp-config points at a 0600 file with typed entries; a cwd row is declined', async () => {
  const inj = await compose(claude);
  assert.equal(inj.args.length, 2);
  assert.equal(inj.args[0], '--mcp-config');
  const file = inj.args[1];
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(config.mcpServers).sort(), ['fs-tool', 'remote']);
    assert.equal(config.mcpServers['fs-tool'].type, 'stdio');
    assert.equal(config.mcpServers['fs-tool'].env.SAMPLE_KEY, ENV_SECRET);
    assert.equal(config.mcpServers.remote.type, 'http');
    assert.equal(config.mcpServers.remote.headers.Authorization, `Bearer ${TOKEN_SECRET}`);
    assert.ok(!('fs-cwd' in config.mcpServers), 'the row with a cwd is declined');
    assert.ok(noSecret(file), 'no secret in the file name');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    inj.release();
  }
  assert.ok(!fs.existsSync(file), 'release removed the file');
});

test('across all three backends no secret value is on any argv', async () => {
  const argvs = {};
  const releases = [];
  for (const backend of [codex, agy, claude]) {
    const inj = await compose(backend);
    releases.push(inj.release);
    argvs[backend.id] = inj.args;
  }
  try {
    for (const [id, args] of Object.entries(argvs)) {
      assert.ok(args.length > 0 || id === 'agy', `${id}: the check ran over a real argv`);
      for (const a of args) {
        for (const s of SECRETS) assert.ok(!String(a).includes(s), `${id}: a secret is on argv`);
      }
    }
  } finally {
    releases.forEach((r) => r());
  }
});
