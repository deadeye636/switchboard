// backends/codex/resources.js — read-only discovery of Codex resources.
//
// Codex keeps auth, logs and transcripts beside customization files. This inventory surfaces only safe
// configuration/instruction resources and directories that describe extensions; it never reads auth.json,
// secret sandboxes, logs or session history.
'use strict';

const fs = require('fs');
const path = require('path');

const { createExpandResource } = require('../resource-expand');
const { installedPluginSkillDirs, pluginSkillsSource, pluginFromSource } = require('./plugins');

// One level into each listed directory (#440), keyed by the `source` its listing entry carries.
const EXPAND_RULES = {
  'plugins-directory': { mode: 'dirs', kind: 'plugin' },
  'skills-directory': { mode: 'skillTree', kind: 'skill' },
  'rules-directory': { mode: 'flatFiles', kind: 'rule', exts: ['.md'] },
  'memories-directory': { mode: 'flatFiles', kind: 'memory-store', exts: ['.md'] },
  'project-rules': { mode: 'flatFiles', kind: 'rule', exts: ['.md'] },
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
    // What a reader should call this directory when its path does not say (#536). A plugin's skills are
    // cached under the MARKETPLACE's name with a version folder in between, so the path names neither the
    // plugin nor anything a person would recognise.
    originLabel: item.originLabel || null,
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

/**
 * One row per installed, enabled plugin that ships skills (#536).
 *
 * The row is the plugin's SKILLS directory, not its checkout: that is the part a reader can act on, and
 * the rest of a plugin's cache is scripts and assets the CLI runs. The source carries the plugin's own
 * name — the cache folder is the MARKETPLACE's name for it, and the version sits between them — so the
 * `originLabel` says which plugin a directory belongs to without anyone having to read the path.
 */
function addPluginSkills(out, home) {
  for (const plugin of installedPluginSkillDirs(home)) {
    add(out, {
      kind: 'skill',
      scope: 'global',
      name: plugin.name,
      path: plugin.skillsDir,
      source: pluginSkillsSource(plugin.name),
      originLabel: `Plugin ${plugin.name}`,
    });
  }
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
    addPluginSkills(resources, home);
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

// Every plugin's skills directory follows the same rule as any other skills tree; only the KEY is not
// known in advance, because it carries the plugin's name (#536, the shape is Claude's #463).
const PLUGIN_SKILLS_RULE = { mode: 'skillTree', kind: 'skill' };
const expandResource = createExpandResource(
  (source) => (pluginFromSource(source) ? PLUGIN_SKILLS_RULE : EXPAND_RULES[source]),
);

module.exports = { createListResources, expandResource, EXPAND_RULES };
