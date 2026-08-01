// backends/codex/resources.js — read-only discovery of Codex resources.
//
// Codex keeps auth, logs and transcripts beside customization files. This inventory surfaces only safe
// configuration/instruction resources and directories that describe extensions; it never reads auth.json,
// secret sandboxes, logs or session history.
'use strict';

const fs = require('fs');
const path = require('path');

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

function addProfileFiles(out, home) {
  let entries = [];
  try { entries = fs.readdirSync(home, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (!ent.isFile() || !/^[^.][^\\/]*\.config\.toml$/i.test(ent.name)) continue;
    add(out, { kind: 'profile', scope: 'global', name: ent.name.replace(/\.config\.toml$/i, ''), path: path.join(home, ent.name), source: 'profile-config' });
  }
}

function createListResources({ codexHome }) {
  return function listResources({ projectPath } = {}) {
    const home = codexHome();
    const resources = [];

    addFile(resources, home, 'config.toml', 'settings', 'config');
    addFile(resources, home, 'AGENTS.md', 'memory', 'global-instructions');
    addFile(resources, home, 'models_cache.json', 'model-catalog', 'models');
    addDir(resources, home, 'plugins', 'plugin', 'plugins-directory');
    addDir(resources, home, 'skills', 'skill', 'skills-directory');
    addDir(resources, home, 'rules', 'rule', 'rules-directory');
    addDir(resources, home, 'memories', 'memory-store', 'memories-directory');
    addProfileFiles(resources, home);

    if (projectPath) {
      addFile(resources, projectPath, 'AGENTS.md', 'memory', 'project-instructions', 'project');
      addDir(resources, projectPath, '.codex', 'settings', 'project-codex-directory', 'project');
      addFile(resources, path.join(projectPath, '.codex'), 'config.toml', 'settings', 'project-config', 'project');
      addDir(resources, path.join(projectPath, '.codex'), 'rules', 'rule', 'project-rules', 'project');
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

module.exports = { createListResources };
