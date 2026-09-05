// backends/claude/plugins.js — which plugins are actually installed here, and what they are called (#463).
//
// A plugin's skills sit under its cached checkout, and offering them means answering two questions the
// directory layout cannot:
//
// **What is the plugin CALLED.** The invocation is `/<plugin>:<skill>`, and the plugin name is not the
// folder it happens to be cached in — that folder is the marketplace's name for it. The manifest
// (`.claude-plugin/plugin.json`) carries the real one, and the install record's key
// (`<plugin>@<marketplace>`) is the fallback when a manifest is missing or unreadable. Reading the
// directory name would work on the machine it was written on and quietly produce a slash command the CLI
// answers with an error anywhere else.
//
// **Whether it is INSTALLED AND ON.** A marketplace checkout holds plugins that were never installed, and
// `installed_plugins.json` holds ones that are installed but switched off. Both would otherwise be
// offered as runnable skills. So a plugin has to be in the install record for a scope that applies here
// AND enabled in the settings that govern that scope.
//
// Everything is resolved from the `claudeHome` passed in, never from `os.homedir()`: an isolated instance
// must not read the real CLI's plugins (the rule `test/store-isolation.test.js` exists for).
'use strict';

const fs = require('fs');
const path = require('path');

// "Is this path that path" has exactly one answer in this app (CLAUDE.md rule 13), and it is about the
// REAL path of both sides. This one decides a listing entry's SCOPE, which makes the two ways it used to
// be wrong both silent (#545): a project reached through a junction, a symlink or a `subst` drive is
// spelled differently from where its plugin was installed, so its skills simply vanished from the
// listing; and lowercasing unconditionally called two different Linux directories one project.
const { samePath } = require('../../app/path-containment');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * `enabledPlugins` as the CLI reads it for this scope: the user's settings, then the project's, then the
 * project's local file — later ones win, which is Claude's own order.
 *
 * A plugin must be explicitly `true` somewhere to count. "Installed but never enabled" is the state a
 * marketplace leaves behind, and treating an absent flag as on is what would put a slash command the CLI
 * refuses into the picker.
 */
function enabledPluginMap(claudeHome, projectPath) {
  const files = [path.join(claudeHome, 'settings.json')];
  if (projectPath) {
    files.push(path.join(projectPath, '.claude', 'settings.json'));
    files.push(path.join(projectPath, '.claude', 'settings.local.json'));
  }
  const merged = {};
  for (const file of files) {
    const blob = readJson(file);
    const map = blob && blob.enabledPlugins;
    if (!map || typeof map !== 'object') continue;
    for (const [key, value] of Object.entries(map)) merged[key] = value;
  }
  return merged;
}

/** The plugin's own name for itself, or the install key's plugin half. */
function pluginName(installPath, installKey) {
  const manifest = readJson(path.join(installPath, '.claude-plugin', 'plugin.json'));
  const declared = manifest && typeof manifest.name === 'string' ? manifest.name.trim() : '';
  if (declared) return declared;
  const key = String(installKey || '');
  const at = key.indexOf('@');
  return (at > 0 ? key.slice(0, at) : key).trim();
}

/**
 * Installed, enabled plugins that carry a skills directory, for this scope.
 *
 * `scope: 'user'` records apply to every session; a `local` record applies only to the project it was
 * installed for, so a plugin installed in one repository does not surface in another.
 *
 * Returns `[{ name, installKey, skillsDir, scope }]`, sorted by name.
 */
function installedPluginSkillDirs(claudeHome, projectPath) {
  if (!claudeHome) return [];
  const record = readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json'));
  const plugins = record && record.plugins && typeof record.plugins === 'object' ? record.plugins : null;
  if (!plugins) return [];
  const enabled = enabledPluginMap(claudeHome, projectPath);

  const out = [];
  for (const [installKey, installs] of Object.entries(plugins)) {
    if (enabled[installKey] !== true) continue;
    for (const install of Array.isArray(installs) ? installs : []) {
      if (!install || typeof install.installPath !== 'string') continue;
      const localScope = install.scope === 'local' || install.scope === 'project';
      if (localScope && !samePath(install.projectPath, projectPath)) continue;
      const skillsDir = path.join(install.installPath, 'skills');
      if (!isDir(skillsDir)) continue;
      out.push({
        name: pluginName(install.installPath, installKey),
        installKey,
        skillsDir,
        scope: localScope ? 'project' : 'global',
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** The source a plugin's skills directory is listed under, and the plugin it names. */
const PLUGIN_SKILLS_SOURCE = 'plugin-skills';

function pluginSkillsSource(name) {
  return `${PLUGIN_SKILLS_SOURCE}:${name}`;
}

/** The plugin a `plugin-skills:<name>` source names, or '' for any other source. */
function pluginFromSource(source) {
  const s = String(source || '');
  if (!s.startsWith(PLUGIN_SKILLS_SOURCE + ':')) return '';
  return s.slice(PLUGIN_SKILLS_SOURCE.length + 1);
}

module.exports = {
  installedPluginSkillDirs,
  pluginSkillsSource,
  pluginFromSource,
  PLUGIN_SKILLS_SOURCE,
  _pluginName: pluginName,
  _enabledPluginMap: enabledPluginMap,
};
