'use strict';
// Claude's per-spawn MCP prune (spec 36, plan 789 T4): `--strict-mcp-config`, only when the project opts in.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const claude = require('../src/backends/claude');
const claudeNative = require('../src/backends/claude-native');
const { buildMcpPrune } = require('../src/backends/claude/mcp-prune');
const { composeMcpPrune } = require('../src/app/mcp-prune');

test('buildMcpPrune answers --strict-mcp-config and no env', () => {
  assert.deepEqual(buildMcpPrune(), { args: ['--strict-mcp-config'], env: null });
});

test('claude declares the prune; claude-native forwards the same hook', () => {
  assert.equal(claude.providesMcpPrune, true);
  assert.equal(claude.buildMcpPrune, buildMcpPrune);
  assert.equal(claudeNative.providesMcpPrune, true);
  assert.equal(claudeNative.buildMcpPrune, claude.buildMcpPrune, 'one implementation, not a fork');
  assert.equal(claude.capabilities.mcpPrune.state, 'yes');
  assert.equal(claudeNative.capabilities.mcpPrune.state, 'yes');
});

test('the composed launch carries --strict-mcp-config only when the project opted in', () => {
  for (const backend of [claude, claudeNative]) {
    assert.deepEqual(composeMcpPrune({ backend, enabled: true }), { args: ['--strict-mcp-config'], env: null });
    assert.equal(composeMcpPrune({ backend, enabled: false }), null);
    assert.equal(composeMcpPrune({ backend }), null);
  }
});
