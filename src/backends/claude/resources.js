// backends/claude/resources.js — read-only discovery of Claude Code resources.
//
// The resource inventory is intentionally conservative: show settings, instructions, commands,
// agents/plugins/hooks/skills and other customization directories, but never expose auth, logs,
// history, transcript stores or Claude's main ~/.claude.json because it can carry credentials.
'use strict';

const fs = require('fs');
const path = require('path');

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

module.exports = { createListResources };
