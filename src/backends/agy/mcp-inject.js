// backends/agy/mcp-inject.js — hands a session the app's MCP server through agy's workspace plugin channel
// (spec 34, "Q1 confirmed", agy 1.4.3).
//
// agy has no launch flag and no home variable for MCP, and `agy mcp add` writes the user's shared
// `~/.gemini/config/mcp_config.json`. The channel that stays per launch is a workspace plugin bundle:
//
//   <cwd>/.agents/plugins.json                     { entries: [{ path: '.agents/plugins' }] }  (SHARED, one per project)
//   <cwd>/.agents/plugins/<switchboard-…>/plugin.json
//   <cwd>/.agents/plugins/<switchboard-…>/mcp_config.json   (the token lives here, owner-only)
//   <cwd>/.agents/plugins/<switchboard-…>/.switchboard-owner (the owning pid, for the sweep)
//
// Several sessions can run in one project, so each writes a bundle dir of its OWN and release removes only
// that dir. `plugins.json` points at the `.agents/plugins` DIRECTORY, so one stable file discovers every
// session's bundle: it is ensured present and never rewritten or deleted per session, which would break a
// sibling session. Nothing here touches the CLI's home.
//
// These are ephemeral per-spawn files nobody else writes, so they are plain writes and not `safe-write`
// (CLAUDE.md reflex 11 exemption), except that an EXISTING `plugins.json` belongs to the project and is only
// ever extended by a read-modify-write, never overwritten.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PLUGINS_REL = '.agents/plugins';
const PREFIX = 'switchboard-';
const OWNER_FILE = '.switchboard-owner';

function normEntry(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** A directory name that is safe on every platform and unique per spawn. */
function bundleName(tag) {
  const safe = String(tag || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return `${PREFIX}${safe ? safe + '-' : ''}${crypto.randomBytes(4).toString('hex')}`;
}

function neutralToConfig(servers) {
  const mcpServers = {};
  for (const row of servers || []) {
    if (!row || !row.name) continue;
    // agy reads the transport off the fields (`command` is stdio, `url` is http); a `type` key is
    // "unknown field" to `agy plugin validate` (a failure under --strict), so none is written.
    const has = o => o && typeof o === 'object' && Object.keys(o).length;
    let entry;
    if (row.transport === 'http' && row.url) {
      entry = { url: row.url };
      if (has(row.headers)) entry.headers = { ...row.headers };
    } else if (row.transport === 'stdio' && row.command) {
      entry = { command: row.command };
      if (Array.isArray(row.args) && row.args.length) entry.args = [...row.args];
      if (has(row.env)) entry.env = { ...row.env };   // the bundle file is 0600: the secret-safe channel
      if (row.cwd) entry.cwd = row.cwd;
    } else continue;
    mcpServers[row.name] = entry;
  }
  return Object.keys(mcpServers).length ? { mcpServers } : null;
}

/**
 * Make sure `<cwd>/.agents/plugins.json` discovers `.agents/plugins`. Idempotent: leaves a file that already
 * lists it alone, adds the entry to one that does not, creates it when absent (exclusive create, so two
 * sessions racing cannot truncate each other). A file that does not parse is the project's and is not
 * replaced — returns false and the caller declines.
 */
function ensurePluginsJson(agentsDir, log) {
  const file = path.join(agentsDir, 'plugins.json');
  const fresh = JSON.stringify({ entries: [{ path: PLUGINS_REL }] }, null, 2) + '\n';
  for (let attempt = 0; attempt < 3; attempt++) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') { log.warn(`[agy-mcp] plugins.json unreadable: ${err && err.code}`); return false; }
      try { fs.writeFileSync(file, fresh, { flag: 'wx' }); return true; } catch (e) {
        if (e && e.code === 'EEXIST') continue;   // a sibling session created it first — read it next round
        log.warn(`[agy-mcp] plugins.json could not be created: ${e && e.code}`);
        return false;
      }
    }
    let data;
    try { data = JSON.parse(text); } catch { log.warn('[agy-mcp] plugins.json does not parse; left alone, no injection'); return false; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) { log.warn('[agy-mcp] plugins.json has an unexpected shape; left alone'); return false; }
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (entries.some(e => e && normEntry(e.path) === PLUGINS_REL)) return true;
    data.entries = [...entries, { path: PLUGINS_REL }];
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); return true; } catch (e) {
      log.warn(`[agy-mcp] plugins.json could not be updated: ${e && e.code}`);
      return false;
    }
  }
  return false;
}

/**
 * The hook. `dir` (the app binding dir) is not used: the channel is the project tree, under `cwd`.
 * Returns `{ args: [], env: {}, cleanup }` or `null` when there is nothing to write or it cannot be written.
 */
function buildMcpInjection({ tag, cwd, servers, log } = {}) {
  const lg = { debug() {}, info() {}, warn() {}, ...(log || {}) };
  if (!cwd || typeof cwd !== 'string' || !Array.isArray(servers) || !servers.length) return null;
  const config = neutralToConfig(servers);
  if (!config) return null;

  const agentsDir = path.join(cwd, '.agents');
  const root = path.join(agentsDir, 'plugins');
  // Clear dead siblings before writing ours: a crashed or force-killed run (e.g. `npm run stop:dev`) never
  // reaches releaseMcpInjection, so its bundle — token included — would linger. Sweeping the project we are
  // about to write into reclaims it exactly where it matters, with no boot cost and no project enumeration.
  sweepStaleBundles([cwd], lg);
  const name = bundleName(tag);
  const bundle = path.join(root, name);
  try {
    fs.mkdirSync(bundle, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(bundle, 'plugin.json'), JSON.stringify({ name, version: '0.0.1' }, null, 2) + '\n');
    // The token is in this file: owner-only where the platform has modes.
    fs.writeFileSync(path.join(bundle, 'mcp_config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(bundle, OWNER_FILE), JSON.stringify({ pid: process.pid }) + '\n');
    if (!ensurePluginsJson(agentsDir, lg)) {
      fs.rmSync(bundle, { recursive: true, force: true });
      return null;
    }
  } catch (err) {
    lg.warn(`[agy-mcp] could not write the plugin bundle: ${err && err.code}`);
    try { fs.rmSync(bundle, { recursive: true, force: true }); } catch { /* best effort */ }
    return null;
  }
  return { args: [], env: {}, cleanup: { bundle } };
}

/** Removes this session's bundle dir only. Never `plugins.json`, never a sibling's dir. */
function releaseMcpInjection(cleanup, log) {
  const bundle = cleanup && cleanup.bundle;
  if (!bundle || !path.basename(bundle).startsWith(PREFIX)) return;
  try {
    fs.rmSync(bundle, { recursive: true, force: true });
  } catch (err) {
    if (log && log.warn) log.warn(`[agy-mcp] could not remove the plugin bundle: ${err && err.code}`);
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Sweep orphaned bundles (a crashed run leaves its bundle behind, token included): removes every
 * `<cwd>/.agents/plugins/switchboard-*` dir whose recorded pid is dead, for each project path given.
 * A live pid's dir, a dir without a readable owner record, and anything not named `switchboard-*` are kept.
 * Returns the removed dir names. Called by buildMcpInjection on the project it is about to write into, so an
 * orphan is reclaimed the next time agy launches there; also exported for a wider sweep should one be wired.
 */
function sweepStaleBundles(cwds, log) {
  const removed = [];
  for (const cwd of Array.isArray(cwds) ? cwds : []) {
    if (!cwd || typeof cwd !== 'string') continue;
    const root = path.join(cwd, '.agents', 'plugins');
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith(PREFIX)) continue;
      const bundle = path.join(root, n);
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(bundle, OWNER_FILE), 'utf8'));
        if (!rec || typeof rec.pid !== 'number' || pidAlive(rec.pid)) continue;
        fs.rmSync(bundle, { recursive: true, force: true });
        removed.push(n);
        if (log && log.info) log.info(`[agy-mcp] cleaned stale plugin bundle ${n} (pid ${rec.pid} dead)`);
      } catch { /* not ours or unreadable — keep */ }
    }
  }
  return removed;
}

module.exports = { buildMcpInjection, releaseMcpInjection, sweepStaleBundles, PLUGINS_REL };
