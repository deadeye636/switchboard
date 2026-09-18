// backends/claude/mcp-servers.js — the MCP servers Claude has configured, as neutral rows another backend
// may take over (#633, "Resources from").
//
// Claude keeps them in three places, and which place a server comes from decides whether it may leave:
//   - USER scope: `mcpServers` at the top of `~/.claude.json` — every project;
//   - LOCAL scope: `projects[<key>].mcpServers` in that same file — one project, but written by the user
//     (`claude mcp add` defaults to it), never by a repository;
//   - PROJECT scope: `<project>/.mcp.json` — checked in, so anybody who writes the repository writes it.
//     Claude starts one of those only after the user approved it (measured with Claude Code 2.1.276:
//     `claude mcp list` reports "Pending approval" until then), and so must a target.
// A row's `scope` is what the core's trust rule reads: user and local are `global` (no repository can put
// them there), a `.mcp.json` server is `project`. `origin` keeps Claude's own word for the preview.
//
// Rows come back in Claude's precedence order — local, then project, then user — and the core lets the
// first row of a name decide, which is how Claude resolves a name configured in more than one place.
//
// `${VAR}` and `${VAR:-default}` are expanded here, in the command, the arguments and the env values, as
// Claude does at start. A variable with no value and no default is reported, not guessed: Claude refuses to
// start such a server too.
//
// The rows carry the server's `env`, which routinely holds tokens. They are for the spawn path; the
// settings preview strips them (`src/app/resource-sources.js`).
'use strict';

const fs = require('fs');
const path = require('path');
const claudeConfig = require('./config');

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

function expand(value, env, missing) {
  if (typeof value !== 'string') return value;
  return value.replace(VAR, (_all, name, fallback) => {
    const v = env[name];
    // Shell semantics: `:-` also replaces an EMPTY value; a bare reference to a set-but-empty one is empty.
    if (fallback !== undefined) return v !== undefined && v !== '' ? v : fallback;
    if (v !== undefined) return v;
    missing.add(name);
    return '';
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function names(list) {
  return Array.isArray(list) ? list.filter((n) => typeof n === 'string') : [];
}

/**
 * Which `.mcp.json` servers the user approved for this project. Read from where the USER writes it: the
 * project's blocks in `~/.claude.json` (where Claude's approval dialog records it — every spelling of the
 * project, because where the dialog files it was not measured apart from the servers), the user settings
 * and the project's `settings.local.json`. NOT from the committed `.claude/settings.json`: a repository
 * that approved its own servers would make the approval meaningless. `settings.local.json` is the user's
 * only by convention — it is gitignored, not unwritable — so a repository that commits one can approve its
 * servers there, as it can for Claude itself; what still stands between it and a started process is the
 * target's own trust in the project, which a project server also needs. A disabled entry wins over any enable.
 */
function projectApprovals({ entries, home, projectPath }) {
  const enabled = new Set();
  const disabled = new Set();
  let all = false;
  const blobs = [...entries, readJson(path.join(home, 'settings.json')), readJson(path.join(projectPath, '.claude', 'settings.local.json'))];
  for (const blob of blobs) {
    if (!isObject(blob)) continue;
    if (blob.enableAllProjectMcpServers === true) all = true;
    for (const n of names(blob.enabledMcpjsonServers)) enabled.add(n);
    for (const n of names(blob.disabledMcpjsonServers)) disabled.add(n);
  }
  return (name) => !disabled.has(name) && (all || enabled.has(name));
}

/**
 * The key Claude looks a project's LOCAL servers up under — which is NOT the key it files trust under (#627).
 * Measured with Claude Code 2.1.276 on Windows: `claude mcp add` filed the server under the directory as
 * the shell spelled it (a lower-case folder name, forward slashes), and `claude mcp list` run from the same
 * directory spelled with its on-disk case (an upper-case first letter) did not find it. So: the working directory AS SPELLED, forward slashes, exact case — and
 * nothing else, because a block under another spelling is one Claude would not read from here either. A
 * session is launched with the project path as its working directory, so that spelling is the one it reads.
 */
function spelledKey(projectPath) {
  return String(projectPath).replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
}

/** Every block of this project in `~/.claude.json`, under each spelling Claude uses for it, deduplicated. */
function projectBlocks(projects, projectPath) {
  const keys = [...new Set([spelledKey(projectPath), claudeConfig.cliProjectKey(projectPath), claudeConfig.cliDirKey(projectPath)])];
  return keys.map((k) => (k && isObject(projects[k]) ? projects[k] : null)).filter(Boolean);
}

function toRow(name, def, { origin, scope, file, env, approved }) {
  const transport = typeof def.type === 'string' && def.type ? def.type : (def.url ? 'http' : 'stdio');
  const row = { name, origin, scope, path: file, transport };
  if (approved !== undefined) row.approved = approved;
  if (transport !== 'stdio') return row;
  const missing = new Set();
  row.command = expand(typeof def.command === 'string' ? def.command : '', env, missing);
  row.args = Array.isArray(def.args) ? def.args.map((a) => expand(String(a), env, missing)) : [];
  row.env = {};
  if (isObject(def.env)) {
    for (const [k, v] of Object.entries(def.env)) row.env[k] = expand(String(v), env, missing);
  }
  if (missing.size) row.missingEnv = [...missing].sort();
  return row;
}

function createListSharedMcpServers({ claudeHome, configPath = claudeConfig.claudeConfigPath }) {
  return function listSharedMcpServers({ projectPath = null, env = process.env } = {}) {
    const vars = env || {};
    const file = configPath();
    const cfg = claudeConfig.readClaudeConfig(file);
    const rows = [];
    const add = (servers, meta) => {
      if (!isObject(servers)) return;
      for (const [name, def] of Object.entries(servers)) {
        if (!isObject(def)) continue;
        rows.push(toRow(name, def, { ...meta, env: vars }));
      }
    };
    const projects = projectPath && cfg && isObject(cfg.projects) ? cfg.projects : null;
    const local = projects ? projects[spelledKey(projectPath)] : null;
    if (isObject(local)) add(local.mcpServers, { origin: 'local', scope: 'global', file });
    if (projectPath) {
      const mcpFile = path.join(projectPath, '.mcp.json');
      const blob = readJson(mcpFile);
      if (isObject(blob) && isObject(blob.mcpServers)) {
        const approved = projectApprovals({ entries: projects ? projectBlocks(projects, projectPath) : [], home: claudeHome(), projectPath });
        for (const [name, def] of Object.entries(blob.mcpServers)) {
          if (!isObject(def)) continue;
          rows.push(toRow(name, def, { origin: 'project', scope: 'project', file: mcpFile, env: vars, approved: approved(name) }));
        }
      }
    }
    if (cfg) add(cfg.mcpServers, { origin: 'user', scope: 'global', file });
    return { ok: true, servers: rows };
  };
}

module.exports = { createListSharedMcpServers, _expand: expand };
