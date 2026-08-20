// backends/claude/resources.js — read-only discovery of Claude Code resources.
//
// The resource inventory is intentionally conservative: show settings, instructions, commands,
// agents/plugins/hooks/skills and other customization directories, but never expose auth, logs,
// history, transcript stores or Claude's main ~/.claude.json because it can carry credentials.
'use strict';

const fs = require('fs');
const path = require('path');

const { createExpandResource } = require('../resource-expand');

const FILES = [
  ['settings.json', 'settings', 'settings'],
  ['settings.local.json', 'settings', 'settings'],
  ['CLAUDE.md', 'memory', 'context-file'],
];

const DIRS = [
  ['commands', 'command', 'commands-directory'],
  ['agents', 'agent', 'agents-directory'],
  ['plugins', 'plugin', 'plugins-directory'],
  ['hooks', 'hook', 'hooks-directory'],
  ['skills', 'skill', 'skills-directory'],
  ['extensions', 'extension', 'extensions-directory'],
  ['output-styles', 'output-style', 'output-styles-directory'],
  ['workflows', 'workflow', 'workflows-directory'],
  ['themes', 'theme', 'themes-directory'],
  ['keybindings', 'keybinding', 'keybindings-directory'],
  ['plans', 'plan-store', 'plans-directory'],
];

// How each listed directory is read one level deep (#440), keyed by the `source` its listing entry
// carries — `source` is what tells `commands` from `agents` when both are flat markdown.
const EXPAND_RULES = {
  'commands-directory': { mode: 'flatFiles', kind: 'command', exts: ['.md'] },
  'agents-directory': { mode: 'flatFiles', kind: 'agent', exts: ['.md'] },
  'plugins-directory': { mode: 'dirs', kind: 'plugin' },
  'hooks-directory': { mode: 'flatFiles', kind: 'hook', keepExtension: true },
  'skills-directory': { mode: 'skillTree', kind: 'skill' },
  'output-styles-directory': { mode: 'flatFiles', kind: 'output-style', exts: ['.md'] },
  'workflows-directory': { mode: 'flatFiles', kind: 'workflow', exts: ['.md'] },
  'plans-directory': { mode: 'flatFiles', kind: 'plan-store', exts: ['.md'] },
  'project-commands': { mode: 'flatFiles', kind: 'command', exts: ['.md'] },
  'project-agents': { mode: 'flatFiles', kind: 'agent', exts: ['.md'] },
  'project-skills': { mode: 'skillTree', kind: 'skill' },
  'project-hooks': { mode: 'flatFiles', kind: 'hook', keepExtension: true },
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

function addHomeResources(out, home) {
  for (const [rel, kind, source] of FILES) addFile(out, home, rel, kind, source);
  for (const [rel, kind, source] of DIRS) addDir(out, home, rel, kind, source);
}

function addProjectResources(out, projectPath) {
  if (!projectPath) return;
  addFile(out, projectPath, 'CLAUDE.md', 'memory', 'project-context', 'project');
  addFile(out, path.join(projectPath, '.claude'), 'settings.json', 'settings', 'project-settings', 'project');
  addFile(out, path.join(projectPath, '.claude'), 'settings.local.json', 'settings', 'project-settings', 'project');
  addDir(out, projectPath, '.claude', 'settings', 'project-claude-directory', 'project');
  addDir(out, path.join(projectPath, '.claude'), 'commands', 'command', 'project-commands', 'project');
  addDir(out, path.join(projectPath, '.claude'), 'agents', 'agent', 'project-agents', 'project');
  addDir(out, path.join(projectPath, '.claude'), 'skills', 'skill', 'project-skills', 'project');
  addDir(out, path.join(projectPath, '.claude'), 'hooks', 'hook', 'project-hooks', 'project');
}

function createListResources({ claudeHome }) {
  return function listResources({ projectPath } = {}) {
    const resources = [];
    addHomeResources(resources, claudeHome());
    addProjectResources(resources, projectPath || null);

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

/**
 * The `plansDirectory` a project has set for Claude, or null (#450).
 *
 * Claude merges several settings files; the two a project owns are `.claude/settings.json` (typically
 * committed, so the choice reaches every collaborator) and `.claude/settings.local.json` (this machine
 * only). Local wins, which is the order Claude itself applies.
 *
 * The value is returned raw and project-relative, exactly as it was written. Resolving it — and deciding
 * whether Claude will actually accept it — belongs to the caller: Claude refuses a path outside the
 * project root, one with a symlink component and one whose realpath disagrees, and it does so silently.
 * Pretending here that the setting took would be the same mistake in a different file.
 */
function projectPlansDirectory(projectPath) {
  if (!projectPath) return null;
  for (const name of ['settings.local.json', 'settings.json']) {
    try {
      const file = path.join(projectPath, '.claude', name);
      if (!fs.existsSync(file)) continue;
      const blob = JSON.parse(fs.readFileSync(file, 'utf8'));
      const value = blob && typeof blob.plansDirectory === 'string' ? blob.plansDirectory.trim() : '';
      if (value) return value;
    } catch { /* an unreadable or malformed settings file is not a plans directory */ }
  }
  return null;
}

const expandResource = createExpandResource(EXPAND_RULES);

module.exports = { createListResources, expandResource, EXPAND_RULES, projectPlansDirectory };
