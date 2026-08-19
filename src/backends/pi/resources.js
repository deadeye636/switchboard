// backends/pi/resources.js — read-only discovery of Pi packages/resources (#411).
//
// Pi resources are executable or model-steering material (extensions, skills, prompts, themes and
// packages). Switchboard only surfaces what is configured or present in the standard locations; it does
// not install, update, run, or validate the code.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const trust = require('./trust');
const { createExpandResource } = require('../resource-expand');

// Pi's customization directories, and how each is read one level deep (#440). Until then this file
// walked both skill roots inside `listResources` with no cap and no guard, so one unreadable
// subdirectory threw and took the whole listing with it.
//
// Keyed by `source`, which is why the sources below are named per directory: they all used to read
// 'auto-discovery', and a single shared source cannot say whether a directory holds skills or themes.
const EXPAND_RULES = {
  'extensions-directory': { mode: 'flatFiles', kind: 'extension', exts: ['.ts', '.js'], dirWithIndex: 'index.ts' },
  'skills-directory': { mode: 'skillTree', kind: 'skill', rootMarkdown: true },
  'shared-skills-directory': { mode: 'skillTree', kind: 'skill' },
  'prompts-directory': { mode: 'flatFiles', kind: 'prompt-template', exts: ['.md'] },
  'themes-directory': { mode: 'flatFiles', kind: 'theme', exts: ['.json'] },
};

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function add(out, item) {
  if (!item || !item.path && !item.name) return;
  out.push({
    kind: item.kind,
    scope: item.scope,
    name: item.name || path.basename(String(item.path || '')),
    path: item.path || null,
    source: item.source || null,
    description: item.description || null,
  });
}

function configuredValueName(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.source || value.path || value.name || JSON.stringify(value);
  return String(value || '');
}

function addSettings(out, file, scope) {
  if (!isFile(file)) return null;
  add(out, { kind: 'settings', scope, name: path.basename(file), path: file, source: 'settings-file' });
  const data = readJson(file);
  if (!data || typeof data !== 'object') return data;
  for (const [key, kind] of [['packages', 'package'], ['extensions', 'extension'], ['skills', 'skill'], ['prompts', 'prompt-template'], ['themes', 'theme']]) {
    const values = Array.isArray(data[key]) ? data[key] : [];
    for (const value of values) {
      add(out, { kind, scope, name: configuredValueName(value), path: null, source: `${path.basename(file)}:${key}` });
    }
  }
  return data;
}



/** A customization directory as ONE row. Its contents come from `expandResource`. */
function addResourceDir(out, dir, scope, kind, source) {
  if (!isDir(dir)) return;
  add(out, { kind, scope, name: path.basename(dir), path: dir, source });
}

function addPackageDirs(out, root, scope) {
  for (const dir of [path.join(root, 'npm'), path.join(root, 'git')]) {
    if (!isDir(dir)) continue;
    add(out, { kind: 'package', scope, name: path.basename(dir), path: dir, source: 'installed-directory' });
  }
}

// Resolved by trust.js, which is where every Pi path that has to follow the isolated store lives.
const agentSkillsDir = () => trust.agentsSharedSkillsDir();

function listResources({ projectPath } = {}) {
  const resources = [];
  const globalRoot = trust.agentDir();
  addSettings(resources, path.join(globalRoot, 'settings.json'), 'global');
  // Directories, not their contents (#440) — `expandResource` reads one when the user opens it.
  addResourceDir(resources, path.join(globalRoot, 'extensions'), 'global', 'extension', 'extensions-directory');
  addResourceDir(resources, path.join(globalRoot, 'skills'), 'global', 'skill', 'skills-directory');
  addResourceDir(resources, agentSkillsDir(), 'global', 'skill', 'shared-skills-directory');
  addResourceDir(resources, path.join(globalRoot, 'prompts'), 'global', 'prompt-template', 'prompts-directory');
  addResourceDir(resources, path.join(globalRoot, 'themes'), 'global', 'theme', 'themes-directory');
  addPackageDirs(resources, globalRoot, 'global');

  if (projectPath) {
    const piDir = path.join(projectPath, '.pi');
    addSettings(resources, path.join(piDir, 'settings.json'), 'project');
    addResourceDir(resources, path.join(piDir, 'extensions'), 'project', 'extension', 'extensions-directory');
    addResourceDir(resources, path.join(piDir, 'skills'), 'project', 'skill', 'skills-directory');
    addResourceDir(resources, path.join(projectPath, '.agents', 'skills'), 'project', 'skill', 'shared-skills-directory');
    addResourceDir(resources, path.join(piDir, 'prompts'), 'project', 'prompt-template', 'prompts-directory');
    addResourceDir(resources, path.join(piDir, 'themes'), 'project', 'theme', 'themes-directory');
    addPackageDirs(resources, piDir, 'project');
  }

  const seen = new Set();
  const deduped = resources.filter(r => {
    const key = [r.kind, r.scope, r.path || '', r.name, r.source || ''].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ok: true, resources: deduped };
}

const expandResource = createExpandResource(EXPAND_RULES);

module.exports = { listResources, expandResource, EXPAND_RULES, _addSettings: addSettings };
