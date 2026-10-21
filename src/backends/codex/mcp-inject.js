// backends/codex/mcp-inject.js — hands a Codex session the app's MCP server through launch overrides.
//
// Codex takes `-c key=value` config overrides on its command line, so a streamable-HTTP server is declared
// per launch with no file: `mcp_servers.<name>.url` plus `mcp_servers.<name>.bearer_token_env_var`, which
// names an environment variable the CLI reads the bearer token from. The token therefore travels in the
// child's env and never on argv. Nothing is written to disk, so there is nothing to clean up.
//
// `-c` values are TOML, and the spawn is argv/execFile (reflex 10): the double quotes are literal parts of
// the token string and are not shell-escaped.
'use strict';

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const BEARER = /^Bearer\s+(\S+)$/i;

/** `switchboard` -> `SWITCHBOARD_MCP_TOKEN`. */
function tokenEnvVar(name) {
  return `${String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MCP_TOKEN`;
}

/** A TOML basic string; JSON string escaping is a subset of it. */
function tomlString(s) {
  return JSON.stringify(String(s));
}

/**
 * The hook. `dir` (the app binding dir) and `tag` are not used: there is no file to name.
 * Returns `{ args, env, cleanup: null }` (env is `null` when no row carries a token) or `null` when there is
 * nothing usable to emit.
 */
function buildMcpInjection({ cwd, servers, log } = {}) {
  const lg = { debug() {}, info() {}, warn() {}, ...(log || {}) };
  if (!cwd || typeof cwd !== 'string' || !Array.isArray(servers) || !servers.length) return null;

  const args = [];
  const env = {};
  let emitted = 0;
  for (const row of servers) {
    if (!row || row.transport !== 'http' || !row.url || !row.name || !BARE_KEY.test(String(row.name))) continue;
    const headers = row.headers && typeof row.headers === 'object' ? row.headers : {};
    const auth = headers.Authorization;
    let token = null;
    if (auth !== undefined && auth !== null) {
      const m = BEARER.exec(String(auth));
      if (!m || Object.keys(headers).length !== 1) {
        lg.info(`[codex-mcp] skipped MCP server "${row.name}": header shape cannot be passed as a bearer env var`);
        continue;
      }
      token = m[1];
    } else if (Object.keys(headers).length) {
      lg.info(`[codex-mcp] skipped MCP server "${row.name}": header shape cannot be passed as a bearer env var`);
      continue;
    }
    args.push('-c', `mcp_servers.${row.name}.url=${tomlString(row.url)}`);
    if (token) {
      const envVar = tokenEnvVar(row.name);
      args.push('-c', `mcp_servers.${row.name}.bearer_token_env_var=${tomlString(envVar)}`);
      env[envVar] = token;
    }
    emitted++;
  }
  if (!emitted) return null;
  return { args, env: Object.keys(env).length ? env : null, cleanup: null };
}

/**
 * Nothing is written to disk, so there is nothing to undo. The hook exists only to complete the
 * injection quartet the parity guard requires; the composer calls it with `cleanup: null`.
 */
function releaseMcpInjection() {}

module.exports = { buildMcpInjection, releaseMcpInjection, tokenEnvVar };
