// backends/codex/mcp-inject.js — hands a Codex session the app's MCP server through launch overrides.
//
// Codex takes `-c key=value` config overrides on its command line, so a server is declared per launch with
// no file. Switchboard's own server is streamable-HTTP (`mcp_servers.<name>.url` plus
// `mcp_servers.<name>.bearer_token_env_var`). A project's external servers (#789) ride the same channel:
// a stdio server adds `command`/`args`/`cwd`, an http one a `url`; and for both, every secret value — the
// stdio env, an http header, the bearer token — travels in the child's env, named on argv through
// `env_vars` / `env_http_headers` / `bearer_token_env_var`, never as a value on argv. Nothing is written to
// disk, so there is nothing to clean up.
//
// `-c` values are TOML, and the spawn is argv/execFile (reflex 10): the double quotes are literal parts of
// the string and are not shell-escaped.
'use strict';

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const BEARER =/^Bearer\s+(\S+)$/i;

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
    if (!row || !row.name || !BARE_KEY.test(String(row.name))) continue;
    const rowArgs = [];
    const rowEnv = {}; // committed to `env` only if no key collides with a different value (O10)
    if (row.transport === 'stdio') {
      if (!row.command || typeof row.command !== 'string') continue;
      const envEntries = row.env && typeof row.env === 'object' ? Object.entries(row.env) : [];
      if (envEntries.some(([k]) => !ENV_KEY.test(k))) {
        lg.info(`[codex-mcp] skipped MCP server "${row.name}": an env key is not a valid variable name`);
        continue;
      }
      rowArgs.push('-c', `mcp_servers.${row.name}.command=${tomlString(row.command)}`);
      if (Array.isArray(row.args) && row.args.length) {
        rowArgs.push('-c', `mcp_servers.${row.name}.args=[${row.args.map(tomlString).join(',')}]`);
      }
      if (row.cwd && typeof row.cwd === 'string') {
        rowArgs.push('-c', `mcp_servers.${row.name}.cwd=${tomlString(row.cwd)}`);
      }
      // A value never goes on argv (D-S2): it rides the child's environment and `env_vars` forwards it by name.
      if (envEntries.length) {
        for (const [k, v] of envEntries) rowEnv[k] = String(v);
        rowArgs.push('-c', `mcp_servers.${row.name}.env_vars=[${envEntries.map(([k]) => tomlString(k)).join(',')}]`);
      }
    } else if (row.transport === 'http' && row.url) {
      const headers = row.headers && typeof row.headers === 'object' ? row.headers : {};
      const auth = headers.Authorization;
      let token = null;
      if (auth !== undefined && auth !== null) {
        const m = BEARER.exec(String(auth));
        if (!m) {
          lg.info(`[codex-mcp] skipped MCP server "${row.name}": header shape cannot be passed as a bearer env var`);
          continue;
        }
        token = m[1];
      }
      const others = Object.entries(headers).filter(([h]) => h !== 'Authorization');
      if (others.some(([h]) => !HEADER_NAME.test(h))) {
        lg.info(`[codex-mcp] skipped MCP server "${row.name}": a header name cannot be passed`);
        continue;
      }
      rowArgs.push('-c', `mcp_servers.${row.name}.url=${tomlString(row.url)}`);
      if (token) {
        const envVar = tokenEnvVar(row.name);
        rowArgs.push('-c', `mcp_servers.${row.name}.bearer_token_env_var=${tomlString(envVar)}`);
        rowEnv[envVar] = token;
      }
      // Header values may be secrets, so they ride env vars too: `env_http_headers` maps header -> variable name.
      if (others.length) {
        const pairs = others.map(([h, v]) => {
          const envVar = `${tokenEnvVar(row.name).replace(/_MCP_TOKEN$/, '')}_MCP_HDR_${h.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
          rowEnv[envVar] = String(v);
          return `${tomlString(h)}=${tomlString(envVar)}`;
        });
        rowArgs.push('-c', `mcp_servers.${row.name}.env_http_headers={${pairs.join(',')}}`);
      }
    } else {
      continue;
    }
    const clash = Object.keys(rowEnv).find(k => Object.prototype.hasOwnProperty.call(env, k) && env[k] !== rowEnv[k]);
    if (clash) {
      lg.info(`[codex-mcp] skipped MCP server "${row.name}": env key ${clash} is already set to a different value by another server`);
      continue;
    }
    Object.assign(env, rowEnv);
    args.push(...rowArgs);
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
