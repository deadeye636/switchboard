// backends/codex/plugins.js — which Codex plugins are installed here, and where their skills live (#536).
//
// Codex CLI 0.153 installs plugins from marketplaces, and a user's plugins were invisible in Switchboard
// because plugins were a resource kind only Claude declared. The layout answers to the same two questions
// Claude's does, and gets the same two answers — read `backends/claude/plugins.js` beside this one.
//
// **What is installed and ON.** `~/.codex/config.toml` carries one table per plugin, keyed
// `[plugins."<plugin>@<marketplace>"]` with `enabled = true`. A marketplace checkout holds plugins nobody
// installed, and a record can be switched off, so the cache directory alone is not the answer.
//
// **Where its files are.** `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`, and the top level
// is the MARKETPLACE's name rather than the plugin's — which is why the listing entry carries an
// `originLabel`. Inside, `.codex-plugin/plugin.json` names the plugin and `skills/` is a skills tree with
// `SKILL.md` at each leaf, the same shape Claude's plugins have.
//
// **The version is part of the path, and more than one can be cached.** Nothing in the config says which
// one is live, so the highest is taken, compared segment by segment as numbers — `0.1.46` is newer than
// `0.1.3`, and a string compare says the opposite. A version that is not numeric sorts below one that is.
//
// **Global only, and that is a measured gap rather than a decision.** Codex reads a project's own
// `.codex/config.toml` too, but whether a `[plugins."…"]` table there activates a plugin for that project
// was not measured against a real install, so nothing here pretends to know. Everything is reported as
// `global`, which is what the one file this reads actually describes.
//
// Everything resolves from the `codexHome` passed in, never from `os.homedir()`: an isolated instance must
// not read the real CLI's plugins (`test/store-isolation.test.js`).
'use strict';

const fs = require('fs');
const path = require('path');

const toml = require('smol-toml');
// "Is this path inside that one" has exactly one answer in this app (CLAUDE.md rule 13), and it is about
// the REAL path of both sides. A key out of a config file is user input that ends up as a directory, so
// the cheap string check below is a pre-filter, never the guard.
const { isAtOrInside } = require('../../app/path-containment');

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function readToml(file) {
  try { return toml.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * The install keys this home has switched on, as `<plugin>@<marketplace>`.
 *
 * A plugin must be explicitly `true`. An absent flag is what a marketplace leaves behind for something
 * that was fetched but never installed, and treating it as on would offer skills the CLI does not load.
 */
function enabledInstallKeys(codexHome) {
  const config = readToml(path.join(codexHome, 'config.toml'));
  const plugins = config && config.plugins;
  if (!plugins || typeof plugins !== 'object') return [];
  return Object.entries(plugins)
    .filter(([, value]) => value && value.enabled === true)
    .map(([key]) => key);
}

/**
 * `<plugin>@<marketplace>` split at the LAST `@` — a plugin name may contain one, a marketplace suffix is.
 *
 * **Both halves become path segments, so neither may be one.** A key comes out of a file a user edits, and
 * `path.join` resolves `..` without complaint: a table named `[plugins."../../../../elsewhere@mkt"]` would
 * put an arbitrary directory in the listing, and the listing IS the allow-list every other guard consults.
 * Measured before the check existed: the escaped directory was listed, expanded and read.
 *
 * A separator or a `..` segment is refused outright rather than sanitised. A plugin whose name genuinely
 * contains one does not exist — Codex builds the same key from the same two names — so there is nothing to
 * rescue, and a rescued path is a path nobody can reason about.
 */
function isPathSegment(part) {
  const s = String(part || '');
  if (!s || s === '.' || s === '..') return false;
  if (/[\\/]/.test(s)) return false;
  // A drive letter or a UNC prefix survives having no separator in it.
  return !path.isAbsolute(s);
}

function splitInstallKey(key) {
  const s = String(key || '');
  const at = s.lastIndexOf('@');
  if (at <= 0) return null;
  const plugin = s.slice(0, at);
  const marketplace = s.slice(at + 1);
  if (!isPathSegment(plugin) || !isPathSegment(marketplace)) return null;
  return { plugin, marketplace };
}

/**
 * Compare two version directory names, newest first. Numeric per segment; anything non-numeric sorts last.
 *
 * The tie-break at the end is not decoration: two names that are non-numeric all the way through compare
 * equal on every segment, and without it the answer would be whatever order the filesystem happened to
 * return. A stable wrong answer is debuggable; an unstable one is not.
 */
function compareVersions(a, b) {
  const parts = (v) => String(v).split('.').map(s => (/^\d+$/.test(s) ? Number(s) : null));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    if (x === null || x === undefined) return 1;      // non-numeric or shorter loses
    if (y === null || y === undefined) return -1;
    return y - x;
  }
  return String(b).localeCompare(String(a));
}

/**
 * The newest cached version directory of one plugin, or null when nothing is cached for it.
 *
 * `isDir` and not `Dirent.isDirectory()`: the latter answers false for a Windows junction, which is how a
 * junctioned skills directory once became invisible with no error to see (#440). A developer linking a
 * working copy into the cache is the realistic case, and `statSync` follows the reparse point.
 */
function newestVersionDir(pluginDir) {
  let entries = [];
  try { entries = fs.readdirSync(pluginDir, { withFileTypes: true }); } catch { return null; }
  const versions = entries
    .filter(e => isDir(path.join(pluginDir, e.name)))
    .map(e => e.name)
    .sort(compareVersions);
  return versions.length ? path.join(pluginDir, versions[0]) : null;
}

/** The plugin's own name for itself, or the install key's plugin half. */
function pluginName(installDir, installKey) {
  const manifest = readJson(path.join(installDir, '.codex-plugin', 'plugin.json'));
  const declared = manifest && typeof manifest.name === 'string' ? manifest.name.trim() : '';
  if (declared) return declared;
  const split = splitInstallKey(installKey);
  return split ? split.plugin : String(installKey || '');
}

/**
 * Installed, enabled plugins that carry a skills directory.
 *
 * Returns `[{ name, installKey, marketplace, version, skillsDir }]`, sorted by name. A plugin whose cache
 * is missing, whose version directory is empty, or which ships no `skills/` is simply not in the list —
 * there is nothing to offer for it, and an entry pointing at a directory that is not there is worse than
 * no entry.
 */
function installedPluginSkillDirs(codexHome) {
  if (!codexHome) return [];
  const cacheRoot = path.join(codexHome, 'plugins', 'cache');
  const out = [];
  for (const installKey of enabledInstallKeys(codexHome)) {
    const split = splitInstallKey(installKey);
    if (!split) continue;
    const pluginDir = path.join(cacheRoot, split.marketplace, split.plugin);
    // The real-path half of the same question. The segment check above cannot see a junction or a symlink
    // pointing out of the cache, and this directory is handed on to be read from.
    if (!isAtOrInside(pluginDir, cacheRoot)) continue;
    const installDir = newestVersionDir(pluginDir);
    if (!installDir) continue;
    const skillsDir = path.join(installDir, 'skills');
    if (!isDir(skillsDir)) continue;
    out.push({
      name: pluginName(installDir, installKey),
      installKey,
      marketplace: split.marketplace,
      version: path.basename(installDir),
      skillsDir,
    });
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
  _enabledInstallKeys: enabledInstallKeys,
  _splitInstallKey: splitInstallKey,
  _isPathSegment: isPathSegment,
  _compareVersions: compareVersions,
  _pluginName: pluginName,
};
