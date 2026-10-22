// backends/claude/mcp-inject.js — hands a terminal Claude session extra MCP servers through `--mcp-config`
// (spec 34, plan 789 T6).
//
// Claude takes a JSON FILE: `{ "mcpServers": { "<name>": { "type": "stdio", command, args, env } } }` or
// `{ "type": "http", url, headers }`. `type` is REQUIRED (a `url` without it is rejected). The file, never
// inline JSON, is passed: env and header values (a Bearer token) live in this 0600 file and never on argv.
// `--strict-mcp-config` is deliberately NOT passed here — it would drop the user's own MCP servers. The one
// place it may be passed is the prune hook (./mcp-prune.js), and only when the project opts in. `--ide` (the
// app's own bridge) is an independent flag and keeps working beside this one.
//
// Claude has no per-server `cwd`: a row that carries one is declined and logged, not wrapped in a shell.
//
// The file is an ephemeral per-spawn file nobody else writes: a plain write, not `safe-write`
// (CLAUDE.md reflex 11 exemption). The app binding dir holds it; release removes it.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const has = o => o && typeof o === 'object' && Object.keys(o).length;

function neutralToConfig(servers, log) {
  const mcpServers = {};
  for (const row of servers || []) {
    if (!row || !row.name) continue;
    let entry;
    if (row.transport === 'http' && row.url) {
      entry = { type: 'http', url: row.url };
      if (has(row.headers)) entry.headers = { ...row.headers };
    } else if (row.transport === 'stdio' && row.command) {
      if (row.cwd) { log.warn(`[claude-mcp] declined "${row.name}": Claude has no per-server cwd`); continue; }
      entry = { type: 'stdio', command: row.command };
      if (Array.isArray(row.args) && row.args.length) entry.args = [...row.args];
      if (has(row.env)) entry.env = { ...row.env };
    } else continue;
    mcpServers[row.name] = entry;
  }
  return Object.keys(mcpServers).length ? { mcpServers } : null;
}

/** Returns `{ args: ['--mcp-config', file], env: {}, cleanup: { file } }` or `null` (nothing usable / unwritable). */
function buildMcpInjection({ dir, tag, servers, log } = {}) {
  const lg = { debug() {}, info() {}, warn() {}, ...(log || {}) };
  if (!dir || typeof dir !== 'string' || !Array.isArray(servers) || !servers.length) return null;
  const config = neutralToConfig(servers, lg);
  if (!config) return null;
  const safe = String(tag || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const file = path.join(dir, `claude-mcp-${safe ? safe + '-' : ''}${crypto.randomBytes(4).toString('hex')}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // The values are in this file: owner-only where the platform has modes.
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  } catch (err) {
    lg.warn(`[claude-mcp] could not write the MCP config: ${err && err.code}`);
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    return null;
  }
  return { args: ['--mcp-config', file], env: {}, cleanup: { file } };
}

/** Removes this session's file only. Best effort; a missing file is fine. */
function releaseMcpInjection(cleanup, log) {
  const file = cleanup && cleanup.file;
  if (!file || !path.basename(file).startsWith('claude-mcp-')) return;
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    if (log && log.warn) log.warn(`[claude-mcp] could not remove the MCP config: ${err && err.code}`);
  }
}

module.exports = { buildMcpInjection, releaseMcpInjection };
