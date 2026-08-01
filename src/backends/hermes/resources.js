// backends/hermes/resources.js — read-only discovery of Hermes resources (#411 follow-up).
//
// Hermes has a richer local ecosystem than a plain transcript store: config, skills, skill bundles,
// plugins, hooks, memories and MCP configuration. Switchboard only surfaces what is present on disk; it
// does not run Hermes management commands, install/update anything, or read secret files.
'use strict';

const fs = require('fs');
const path = require('path');

const reader = require('./reader');

const MAX_SKILLS = 500;

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

function addSkillFiles(out, dir) {
  if (!isDir(dir)) return;
  const stack = [dir];
  let n = 0;
  while (stack.length && n < MAX_SKILLS) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    const skill = entries.find(e => e.isFile() && e.name === 'SKILL.md');
    if (skill) {
      add(out, {
        kind: 'skill',
        name: path.basename(current),
        path: path.join(current, 'SKILL.md'),
        source: 'skills-directory',
      });
      n++;
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (ent.isDirectory()) stack.push(path.join(current, ent.name));
    }
  }
  if (stack.length) {
    add(out, {
      kind: 'resource-note',
      name: `Only the first ${MAX_SKILLS} skills are shown`,
      path: dir,
      source: 'skills-directory',
    });
  }
}

function addBundleFiles(out, dir) {
  if (!isDir(dir)) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!/\.(ya?ml|json|md)$/i.test(ent.name)) continue;
    add(out, { kind: 'skill-bundle', name: ent.name.replace(/\.[^.]+$/, ''), path: path.join(dir, ent.name), source: 'skill-bundles' });
  }
}

function addPluginDirs(out, dir) {
  if (!isDir(dir)) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.isDirectory() && !ent.name.startsWith('.')) {
      add(out, { kind: 'plugin', name: ent.name, path: path.join(dir, ent.name), source: 'plugins-directory' });
    }
  }
}

function addHookFiles(out, dir) {
  if (!isDir(dir)) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.isFile()) add(out, { kind: 'hook', name: ent.name, path: path.join(dir, ent.name), source: 'hooks-directory' });
  }
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

  addSkillFiles(resources, path.join(root, 'skills'));
  addBundleFiles(resources, path.join(root, 'skill-bundles'));
  addPluginDirs(resources, path.join(root, 'plugins'));
  addHookFiles(resources, path.join(root, 'hooks'));
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

module.exports = { listResources, _MAX_SKILLS: MAX_SKILLS };
