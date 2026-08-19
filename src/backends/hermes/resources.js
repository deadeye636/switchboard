// backends/hermes/resources.js — read-only discovery of Hermes resources (#411 follow-up).
//
// Hermes has a richer local ecosystem than a plain transcript store: config, skills, skill bundles,
// plugins, hooks, memories and MCP configuration. Switchboard only surfaces what is present on disk; it
// does not run Hermes management commands, install/update anything, or read secret files.
'use strict';

const fs = require('fs');
const path = require('path');

const reader = require('./reader');
const { createExpandResource } = require('../resource-expand');

// Hermes' customization directories, and how each is read one level deep (#440). Until then this file
// walked the whole skills tree inside `listResources`, so every settings-panel open paid for a
// recursive scan of up to 500 skills — and the flat result had no directory row to group them under.
const EXPAND_RULES = {
  'skills-directory': { mode: 'skillTree', kind: 'skill' },
  'skill-bundles': { mode: 'flatFiles', kind: 'skill-bundle', exts: ['.yaml', '.yml', '.json', '.md'] },
  'plugins-directory': { mode: 'dirs', kind: 'plugin' },
  'hooks-directory': { mode: 'flatFiles', kind: 'hook', keepExtension: true },
  'memories-directory': { mode: 'flatFiles', kind: 'memory-store', exts: ['.md'] },
};

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function add(out, item) {
  if (!item || (!item.path && !item.name)) return;
  out.push({
    kind: item.kind,
    scope: 'global',
    name: item.name || path.basename(String(item.path || '')),
    path: item.path || null,
    source: item.source || null,
    description: item.description || null,
  });
}

function addFile(out, root, rel, kind, source) {
  const p = path.join(root, rel);
  if (isFile(p)) add(out, { kind, name: path.basename(p), path: p, source });
}

function addDir(out, root, rel, kind, source) {
  const p = path.join(root, rel);
  if (isDir(p)) add(out, { kind, name: path.basename(p), path: p, source });
}





function listResources() {
  const root = reader.hermesHome();
  const resources = [];

  addFile(resources, root, 'config.yaml', 'settings', 'config');
  addFile(resources, root, 'SOUL.md', 'memory', 'context-file');
  addFile(resources, root, 'shell-hooks-allowlist.json', 'hook-allowlist', 'hooks');
  addFile(resources, root, 'provider_models_cache.json', 'model-catalog', 'models');
  addFile(resources, root, 'models_dev_cache.json', 'model-catalog', 'models');
  addFile(resources, root, 'ollama_cloud_models_cache.json', 'model-catalog', 'models');

  // Directories, not their contents (#440) — `expandResource` reads one when the user opens it.
  addDir(resources, root, 'skills', 'skill', 'skills-directory');
  addDir(resources, root, 'skill-bundles', 'skill-bundle', 'skill-bundles');
  addDir(resources, root, 'plugins', 'plugin', 'plugins-directory');
  addDir(resources, root, 'hooks', 'hook', 'hooks-directory');
  addDir(resources, root, 'memories', 'memory-store', 'memories-directory');

  const seen = new Set();
  return {
    ok: true,
    resources: resources.filter(r => {
      const key = [r.kind, r.path || '', r.name, r.source || ''].join('\0');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

const expandResource = createExpandResource(EXPAND_RULES);

module.exports = { listResources, expandResource, EXPAND_RULES };
