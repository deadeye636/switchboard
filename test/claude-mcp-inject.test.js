'use strict';
// Terminal Claude's per-spawn MCP channel (spec 34, plan 789 T6): a 0600 `--mcp-config` file per spawn.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claude = require('../src/backends/claude');
const claudeNative = require('../src/backends/claude-native');

const SECRET = 'sekret-0123456789';
const STDIO = { name: 'files', transport: 'stdio', command: 'node', args: ['srv.js'], env: { API_KEY: SECRET } };
const HTTP = { name: 'remote', transport: 'http', url: 'http://127.0.0.1:4711/mcp', headers: { Authorization: `Bearer ${SECRET}` } };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mcp-')); }
function logger() { const warns = []; return { warns, warn: m => warns.push(m) }; }

test('claude declares the quartet; claude-native forwards the same one (plan 789 T10)', () => {
  assert.equal(claude.providesMcpInjection, true);
  assert.deepEqual(claude.acceptsMcpTransports, ['stdio', 'http']);
  assert.equal(typeof claude.buildMcpInjection, 'function');
  assert.equal(typeof claude.releaseMcpInjection, 'function');
  assert.equal(claudeNative.providesMcpInjection, true);
  assert.deepEqual(claudeNative.acceptsMcpTransports, claude.acceptsMcpTransports);
  assert.equal(claudeNative.buildMcpInjection, claude.buildMcpInjection, 'one implementation, not a fork');
  assert.equal(claudeNative.releaseMcpInjection, claude.releaseMcpInjection);
  assert.equal(claudeNative.capabilities.mcpInject.state, 'limited');
});

test('the discovery offer is one spawn-applied toggle, off by default, Claude\'s own field on claude-native (spec 37)', () => {
  const field = claude.configFields.find(f => f.id === 'discoveryTools');
  assert.ok(field, 'claude declares discoveryTools');
  assert.equal(field.type, 'toggle');
  assert.equal(field.default, false, 'offering tools costs context every turn: off unless chosen');
  assert.equal(field.appliesAt, 'spawn');
  assert.doesNotMatch(field.description, /--ide|bridge/, 'claude-native shares the text and has no bridge');
  assert.equal(claudeNative.configFields.find(f => f.id === 'discoveryTools'), field, 'one declaration, by reference');
  for (const d of [claude, claudeNative]) {
    assert.ok(!d.configFields.some(f => f.id === 'diffTool'), `${d.id}: diffs stay on --ide`);
    assert.equal(d.capabilities.mcpInject.state, 'limited', `${d.id}: no live call checked yet`);
  }
  const argv = (d, options) => d.buildLaunch({ sessionId: 's', options }).args;
  for (const d of [claude, claudeNative]) {
    assert.deepEqual(argv(d, { discoveryTools: true }), argv(d, {}), `${d.id}: the toggle never reaches buildLaunch's argv`);
  }
});

test('claude-native: --mcp-config only when the project has entries; with no group the own server offers it nothing', async () => {
  const { composeMcpInjection, externalServersSource, ownServerSource } = require('../src/app/mcp-inject');
  const dir = tmp();
  const log = { info() {}, debug() {}, warn() {} };
  const run = (servers, groups = []) => composeMcpInjection({
    backend: claudeNative, ctx: { log }, dir, tag: 'cn', cwd: dir,
    sources: [
      ownServerSource({ backend: claudeNative, groups, registerSession: async () => { throw new Error('must not register'); }, log }),
      externalServersSource({ backend: claudeNative, getSetting: () => ({ externalMcpServers: servers }), projectPath: dir, getEnv: () => ({}), log }),
    ],
  });
  assert.equal(await run([]), null, 'no entries: no injection, so the launch argv is unchanged');
  assert.deepEqual(fs.readdirSync(dir), []);
  const inj = await run([{ name: 'docs', transport: 'stdio', command: 'node', args: ['s.js'] }]);
  assert.equal(inj.args[0], '--mcp-config');
  assert.equal(path.dirname(inj.args[1]), dir);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(inj.args[1], 'utf8')).mcpServers), ['docs']);
  inj.release();
  assert.equal(fs.existsSync(inj.args[1]), false);
});

test('a stdio row writes type/command/args/env to a 0600 file; the value is not in argv', () => {
  const dir = tmp();
  const inj = claude.buildMcpInjection({ dir, tag: 't1', servers: [STDIO] });
  assert.equal(inj.args.length, 2);
  assert.equal(inj.args[0], '--mcp-config');
  assert.ok(!inj.args.includes('--strict-mcp-config'));
  assert.ok(!inj.args.join(' ').includes(SECRET));
  const file = inj.args[1];
  assert.equal(path.dirname(file), dir);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(cfg, { mcpServers: { files: { type: 'stdio', command: 'node', args: ['srv.js'], env: { API_KEY: SECRET } } } });
  assert.deepEqual(inj.env, {});
});

test('an http row keeps type and the Bearer header', () => {
  const dir = tmp();
  const inj = claude.buildMcpInjection({ dir, tag: 't2', servers: [HTTP] });
  const cfg = JSON.parse(fs.readFileSync(inj.args[1], 'utf8'));
  assert.deepEqual(cfg.mcpServers.remote, { type: 'http', url: HTTP.url, headers: { Authorization: `Bearer ${SECRET}` } });
});

test('a stdio row with cwd is declined and logged; the others still go through', () => {
  const dir = tmp();
  const log = logger();
  const inj = claude.buildMcpInjection({ dir, tag: 't3', servers: [{ ...STDIO, name: 'withcwd', cwd: '/x' }, HTTP], log });
  const cfg = JSON.parse(fs.readFileSync(inj.args[1], 'utf8'));
  assert.deepEqual(Object.keys(cfg.mcpServers), ['remote']);
  assert.equal(log.warns.length, 1);
  assert.match(log.warns[0], /withcwd/);
  assert.equal(claude.buildMcpInjection({ dir, servers: [{ ...STDIO, cwd: '/x' }], log }), null);
});

test('no usable rows or no dir returns null and writes nothing', () => {
  const dir = tmp();
  assert.equal(claude.buildMcpInjection({ dir, servers: [] }), null);
  assert.equal(claude.buildMcpInjection({ dir, servers: [{ name: 'x', transport: 'sse', url: 'u' }] }), null);
  assert.equal(claude.buildMcpInjection({ servers: [HTTP] }), null);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('release deletes the file and tolerates a missing one', () => {
  const dir = tmp();
  const inj = claude.buildMcpInjection({ dir, tag: 't4', servers: [HTTP] });
  claude.releaseMcpInjection(inj.cleanup);
  assert.equal(fs.existsSync(inj.args[1]), false);
  assert.doesNotThrow(() => claude.releaseMcpInjection(inj.cleanup));
  assert.doesNotThrow(() => claude.releaseMcpInjection(null));
});
