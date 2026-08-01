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
  for (const [key, kind] of [['packages', 'package'], ['extensions', 'extension'], ['skills', 'skill'], ['prompts', 'prompt'], ['themes', 'theme']]) {
    const values = Array.isArray(data[key]) ? data[key] : [];
    for (const value of values) {
      add(out, { kind, scope, name: configuredValueName(value), path: null, source: `${path.basename(file)}:${key}` });
    }
  }
  return data;
}

function addFlatFiles(out, dir, scope, kind, exts) {
  if (!isDir(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory() && kind === 'extension' && isFile(path.join(p, 'index.ts'))) {
      add(out, { kind, scope, name: ent.name, path: path.join(p, 'index.ts'), source: 'auto-discovery' });
      continue;
    }
    if (!ent.isFile()) continue;
    if (exts.some(ext => ent.name.toLowerCase().endsWith(ext))) {
      add(out, { kind, scope, name: ent.name.replace(/\.[^.]+$/, ''), path: p, source: 'auto-discovery' });
    }
  }
}

function addSkills(out, dir, scope, includeRootMarkdown) {
  if (!isDir(dir)) return;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const skillFile = path.join(current, 'SKILL.md');
    if (isFile(skillFile)) {
      add(out, { kind: 'skill', scope, name: path.basename(current), path: skillFile, source: 'auto-discovery' });
      continue;
    }
    for (const ent of fs.readdirSync(current, { withFileTypes: true })) {
      const p = path.join(current, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (includeRootMarkdown && current === dir && ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        add(out, { kind: 'skill', scope, name: ent.name.replace(/\.md$/i, ''), path: p, source: 'auto-discovery' });
      }
    }
  }
}

function addPackageDirs(out, root, scope) {
  for (const dir of [path.join(root, 'npm'), path.join(root, 'git')]) {
    if (!isDir(dir)) continue;
    add(out, { kind: 'package', scope, name: path.basename(dir), path: dir, source: 'installed-directory' });
  }
}

function agentSkillsDir() {
  return path.join(os.homedir(), '.agents', 'skills');
}

function listResources({ projectPath } = {}) {
  const resources = [];
  const globalRoot = trust.agentDir();
  addSettings(resources, path.join(globalRoot, 'settings.json'), 'global');
  addFlatFiles(resources, path.join(globalRoot, 'extensions'), 'global', 'extension', ['.ts', '.js']);
  addSkills(resources, path.join(globalRoot, 'skills'), 'global', true);
  addSkills(resources, agentSkillsDir(), 'global', false);
  addFlatFiles(resources, path.join(globalRoot, 'prompts'), 'global', 'prompt', ['.md']);
  addFlatFiles(resources, path.join(globalRoot, 'themes'), 'global', 'theme', ['.json']);
  addPackageDirs(resources, globalRoot, 'global');

  if (projectPath) {
    const piDir = path.join(projectPath, '.pi');
    addSettings(resources, path.join(piDir, 'settings.json'), 'project');
    addFlatFiles(resources, path.join(piDir, 'extensions'), 'project', 'extension', ['.ts', '.js']);
    addSkills(resources, path.join(piDir, 'skills'), 'project', true);
    addSkills(resources, path.join(projectPath, '.agents', 'skills'), 'project', false);
    addFlatFiles(resources, path.join(piDir, 'prompts'), 'project', 'prompt', ['.md']);
    addFlatFiles(resources, path.join(piDir, 'themes'), 'project', 'theme', ['.json']);
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

module.exports = { listResources, _addSettings: addSettings };
