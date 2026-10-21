'use strict';
// Codex's per-spawn MCP channel (plan 330 T1): launch `-c` overrides plus one env var for the token.
// Nothing is written to disk and the token never reaches argv.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { buildMcpInjection, releaseMcpInjection } = require('../src/backends/codex/mcp-inject');

const TOKEN = 'tok-0123456789abcdef';
const ROW = { name: 'switchboard', transport: 'http', url: 'http://127.0.0.1:4711/mcp', headers: { Authorization: `Bearer ${TOKEN}` } };
const CWD = '/some/project';

test('maps a switchboard http row to two -c pairs and the token env var', () => {
  const out = buildMcpInjection({ dir: '/d', tag: 'abc', cwd: CWD, servers: [ROW], options: {}, log: {} });
  assert.deepEqual(out.args, [
    '-c', 'mcp_servers.switchboard.url="http://127.0.0.1:4711/mcp"',
    '-c', 'mcp_servers.switchboard.bearer_token_env_var="SWITCHBOARD_MCP_TOKEN"',
  ]);
  assert.deepEqual(out.env, { SWITCHBOARD_MCP_TOKEN: TOKEN });
  assert.equal(out.cleanup, null);
});

test('the token is nowhere in argv', () => {
  const out = buildMcpInjection({ cwd: CWD, servers: [ROW] });
  assert.ok(!JSON.stringify(out.args).includes(TOKEN));
});

test('writes nothing to disk', () => {
  const realWrite = fs.writeFileSync;
  const realOpen = fs.openSync;
  const realMkdir = fs.mkdirSync;
  let touched = 0;
  fs.writeFileSync = function (...a) { touched++; return realWrite.apply(this, a); };
  fs.openSync = function (...a) { touched++; return realOpen.apply(this, a); };
  fs.mkdirSync = function (...a) { touched++; return realMkdir.apply(this, a); };
  try {
    assert.ok(buildMcpInjection({ cwd: CWD, servers: [ROW] }));
  } finally {
    fs.writeFileSync = realWrite;
    fs.openSync = realOpen;
    fs.mkdirSync = realMkdir;
  }
  assert.equal(touched, 0);
});

test('a row without an Authorization header emits the url pair only, no env', () => {
  const out = buildMcpInjection({ cwd: CWD, servers: [{ name: 'switchboard', transport: 'http', url: ROW.url }] });
  assert.deepEqual(out.args, ['-c', 'mcp_servers.switchboard.url="http://127.0.0.1:4711/mcp"']);
  assert.equal(out.env, null);
  assert.equal(out.cleanup, null);
});

test('a row with a non-Bearer Authorization is skipped, its value never reaches argv', () => {
  const lines = [];
  const bad = { ...ROW, headers: { Authorization: 'Basic c2VjcmV0' } };
  assert.equal(buildMcpInjection({ cwd: CWD, servers: [bad], log: { info: m => lines.push(m) } }), null);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('c2VjcmV0'));
  // a bad row does not take a good sibling down with it
  const good = { ...ROW, name: 'other' };
  const out = buildMcpInjection({ cwd: CWD, servers: [bad, good] });
  assert.deepEqual(out.args, [
    '-c', 'mcp_servers.other.url="http://127.0.0.1:4711/mcp"',
    '-c', 'mcp_servers.other.bearer_token_env_var="OTHER_MCP_TOKEN"',
  ]);
  assert.deepEqual(out.env, { OTHER_MCP_TOKEN: TOKEN });
});

test('declines without servers or cwd', () => {
  assert.equal(buildMcpInjection({ cwd: CWD, servers: [] }), null);
  assert.equal(buildMcpInjection({ cwd: CWD }), null);
  assert.equal(buildMcpInjection({ servers: [ROW] }), null);
  assert.equal(buildMcpInjection(), null);
});

test('a name that is not a bare TOML key declines', () => {
  for (const name of ['has.dot', 'has"quote', 'has space', 'a=b']) {
    assert.equal(buildMcpInjection({ cwd: CWD, servers: [{ ...ROW, name }] }), null, name);
  }
});

test('a stdio-only list declines (only http is accepted here)', () => {
  assert.equal(buildMcpInjection({ cwd: CWD, servers: [{ ...ROW, transport: 'stdio' }] }), null);
});

test('releaseMcpInjection is a no-op that never throws', () => {
  assert.equal(typeof releaseMcpInjection, 'function');
  assert.doesNotThrow(() => releaseMcpInjection(null));
  assert.doesNotThrow(() => releaseMcpInjection(undefined, { info() {} }));
});
