// backends/agy/resources.js — read-only discovery of Antigravity CLI resources.
//
// agy keeps account credentials, logs, crash reports and binary conversation stores next to user-facing
// configuration. Surface only safe settings/instruction/resource directories; never auth, logs, history,
// conversations, cache, tmp, scratch or crash data.
'use strict';

const fs = require('fs');
const path = require('path');

const { createExpandResource } = require('../resource-expand');

// One level into each listed directory (#440), keyed by the `source` its listing entry carries.
const EXPAND_RULES = {
  'builtin-resources': { mode: 'flatFiles', kind: 'resource', keepExtension: true },
  'implicit-resources': { mode: 'flatFiles', kind: 'resource', keepExtension: true },
  'knowledge-directory': { mode: 'flatFiles', kind: 'memory-store', exts: ['.md'] },
  'plugins-directory': { mode: 'dirs', kind: 'plugin' },
  // ASSUMED, not measured (#611): `skillTree` reports a folder only where it finds a `SKILL.md`, so a
  // global `skills/` holding bare `.md` files would expand to nothing at all — silently, with `ok: true`.
  // The shape is taken from agy's PLUGIN bundles, which are measured (`skills/<name>/SKILL.md`); the
  // global root was empty on every install seen here, so nobody has looked inside one. If it turns out to
  // be flat, this needs `rootMarkdown: true` the way Pi's does — that flag is deliberately NOT set now,
  // because guessing the other layout would trade one silent miss for another.
  'skills-directory': { mode: 'skillTree', kind: 'skill' },
  'project-gemini-directory': { mode: 'flatFiles', kind: 'settings', keepExtension: true },
};

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function add(out, item) {
  if (!item || !item.path) return;
  out.push({
    kind: item.kind,
    scope: item.scope || 'global',
    name: item.name || path.basename(item.path),
    path: item.path,
    source: item.source || null,
    description: item.description || null,
  });
}

function addFile(out, base, rel, kind, source, scope = 'global') {
  const p = path.join(base, rel);
  if (isFile(p)) add(out, { kind, scope, name: path.basename(p), path: p, source });
}

function addDir(out, base, rel, kind, source, scope = 'global') {
  const p = path.join(base, rel);
  if (isDir(p)) add(out, { kind, scope, name: path.basename(p), path: p, source });
}

function createListResources({ conversationsRoot }) {
  return function listResources({ projectPath } = {}) {
    const conversations = conversationsRoot();
    const agyHome = path.dirname(conversations);
    const geminiHome = path.dirname(agyHome);
    const resources = [];

    // Shared Gemini/Antigravity user configuration that is not credential material.
    addFile(resources, geminiHome, 'GEMINI.md', 'memory', 'global-instructions');
    addFile(resources, geminiHome, 'settings.json', 'settings', 'gemini-settings');
    // The CLI's MCP servers (#543). `agy mcp add/remove/list/enable/disable` all work on this one file,
    // and the binary carries the literal path — so without it a user has to leave the app to see which
    // servers their sessions are running with.
    //
    // The FILE, not `config/`, which also holds config.json and a projects/ tree: this module lists named
    // configuration rather than whatever sits beside it. And deliberately not `../antigravity/mcp_config.json`,
    // which exists on the same machine and is the Antigravity IDE's — listing both would put two entries
    // under one name in the settings screen and invite an edit to the one the CLI never reads.
    addFile(resources, geminiHome, path.join('config', 'mcp_config.json'), 'settings', 'gemini-mcp-config');

    // The GLOBAL CUSTOMIZATION ROOT is `config/`, not the agy home (#611). A plugin is
    // `<customization root>/plugins/<name>/` marked by a `plugin.json`, and `skills/` beside it is a
    // global skill root the CLI reads directly. This app used to list `<agy home>/plugins`, a directory
    // the binary carries no path to and that therefore never held anything.
    //
    // THIS LISTING CAN NEVER BE COMPLETE, and it is worth knowing before someone reads an empty panel as
    // an empty install:
    //  - A customization root may carry a `plugins.json` whose `entries` declare plugin directories at
    //    arbitrary absolute, `~/`- or workspace-relative paths, and a declared entry ranks ABOVE
    //    directory discovery in the CLI's own precedence. Such a plugin lives outside every directory
    //    named here.
    //  - A project's own root (`.agents/`, also `.agent/`, `_agents/`, `_agent/`) is found by walking
    //    from the cwd up to the repository root. That walk is deliberately NOT implemented here: it is
    //    unmeasured against a real project install, so this hook stays global-only (#611) rather than
    //    guessing a project row.
    // Enablement is a third thing this does not read: `config/config.json` holds a `plugins` map keyed
    // by the plugin's DIRECTORY name, so a listed directory may belong to a plugin that is switched off.
    // Listing the skills root gives it the SAME reach the other four backends' skill rows have: a listed
    // skill is editable, and `kind: 'skill'` is on the deletable list, where deleting removes the skill's
    // whole FOLDER. That is deliberate parity rather than an oversight — an agy skill is a file the user
    // wrote, like a Claude or Pi one — and it is written down because it is a new way to destroy something
    // in a directory this app did not touch before (#611).
    addDir(resources, geminiHome, path.join('config', 'plugins'), 'plugin', 'plugins-directory');
    addDir(resources, geminiHome, path.join('config', 'skills'), 'skill', 'skills-directory');

    // agy's own configuration and user-facing resource directories. Deliberately not included:
    // conversations/, conversation_summaries.db, history.jsonl, log/, crashes/, cache/, tmp/, scratch/,
    // google_accounts.json, oauth_creds.json, state.json or trustedFolders.json.
    addFile(resources, agyHome, 'settings.json', 'settings', 'agy-settings');
    addDir(resources, agyHome, 'builtin', 'resource', 'builtin-resources');
    addDir(resources, agyHome, 'implicit', 'resource', 'implicit-resources');
    addDir(resources, agyHome, 'knowledge', 'memory-store', 'knowledge-directory');

    if (projectPath) {
      addFile(resources, projectPath, 'GEMINI.md', 'memory', 'project-instructions', 'project');
      addDir(resources, projectPath, '.gemini', 'settings', 'project-gemini-directory', 'project');
    }

    const seen = new Set();
    return {
      ok: true,
      resources: resources.filter(r => {
        const key = [r.scope, r.kind, r.path, r.source || ''].join('\0');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    };
  };
}

const expandResource = createExpandResource(EXPAND_RULES);

module.exports = { createListResources, expandResource, EXPAND_RULES };
