'use strict';
// #536 — a Codex user's plugins were invisible, because plugins were a resource kind only Claude declared.
//
// The layout answers the same two questions Claude's does (`test/claude-plugin-skills.test.js` is the
// twin), and the assertions that matter are the ones about what must NOT be offered:
//
//   - a plugin in a marketplace checkout that nobody installed;
//   - one that is installed but switched off;
//   - one whose cache is missing, or which ships no skills at all.
//
// Each of those would put a skill in the picker that the CLI does not load. The other half is the VERSION:
// `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/` can hold more than one, nothing in the config
// says which is live, and a string compare puts 0.1.3 above 0.1.46.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plugins = require('../src/backends/codex/plugins');
const codexResources = require('../src/backends/codex/resources');

/**
 * A Codex home with a config and a plugin cache.
 *
 * `installed` is what goes into `config.toml`; `cached` is what is on disk. They are separate arguments on
 * purpose — every interesting case here is one of them without the other.
 */
function makeHome({ installed = [], cached = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plug-'));
  const lines = installed.map(({ key, enabled = true }) => `[plugins."${key}"]\nenabled = ${enabled}\n`);
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "gpt-5"\n\n${lines.join('\n')}`);

  for (const entry of cached) {
    const { marketplace, plugin, version, skills = ['demo'], manifestName } = entry;
    const installDir = path.join(home, 'plugins', 'cache', marketplace, plugin, version);
    fs.mkdirSync(installDir, { recursive: true });
    if (manifestName !== null) {
      fs.mkdirSync(path.join(installDir, '.codex-plugin'), { recursive: true });
      fs.writeFileSync(path.join(installDir, '.codex-plugin', 'plugin.json'),
        JSON.stringify({ name: manifestName || plugin, version }));
    }
    for (const skill of skills) {
      fs.mkdirSync(path.join(installDir, 'skills', skill), { recursive: true });
      fs.writeFileSync(path.join(installDir, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\n`);
    }
    if (!skills.length) fs.mkdirSync(path.join(installDir, 'assets'), { recursive: true });
  }
  return home;
}

const ONE = {
  installed: [{ key: 'documents@openai-primary-runtime' }],
  cached: [{ marketplace: 'openai-primary-runtime', plugin: 'documents', version: '1.0.0' }],
};

test('an installed, enabled plugin with skills is offered (#536)', () => {
  const home = makeHome(ONE);
  const found = plugins.installedPluginSkillDirs(home);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'documents');
  assert.equal(found[0].marketplace, 'openai-primary-runtime');
  assert.equal(found[0].version, '1.0.0');
  assert.ok(fs.existsSync(path.join(found[0].skillsDir, 'demo', 'SKILL.md')));
});

test('a plugin that is cached but not in the config is NOT offered (#536)', () => {
  // What a marketplace leaves behind: fetched, never installed. The cache directory is not the answer.
  const home = makeHome({ installed: [], cached: ONE.cached });
  assert.deepEqual(plugins.installedPluginSkillDirs(home), []);
});

test('a plugin switched off is NOT offered (#536)', () => {
  // `enabled = false` is a state a user chose, and an absent flag is one nobody chose. Both are "no".
  const off = makeHome({ installed: [{ key: 'documents@openai-primary-runtime', enabled: false }], cached: ONE.cached });
  assert.deepEqual(plugins.installedPluginSkillDirs(off), []);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plug-bare-'));
  fs.writeFileSync(path.join(home, 'config.toml'), '[plugins."documents@openai-primary-runtime"]\n');
  assert.deepEqual(plugins.installedPluginSkillDirs(home), [], 'no flag is not a yes');
});

test('a plugin with no cache, and one with no skills, are both skipped (#536)', () => {
  const noCache = makeHome({ installed: ONE.installed, cached: [] });
  assert.deepEqual(plugins.installedPluginSkillDirs(noCache), [], 'nothing on disk to point at');

  const noSkills = makeHome({
    installed: ONE.installed,
    cached: [{ marketplace: 'openai-primary-runtime', plugin: 'documents', version: '1.0.0', skills: [] }],
  });
  assert.deepEqual(plugins.installedPluginSkillDirs(noSkills), [], 'a plugin can ship scripts and no skills');
});

test('the newest cached version wins, counted as numbers (#536)', () => {
  // The one a string compare gets wrong: '0.1.46' sorts below '0.1.3' as text.
  const home = makeHome({
    installed: [{ key: 'sites@openai-bundled' }],
    cached: [
      { marketplace: 'openai-bundled', plugin: 'sites', version: '0.1.3' },
      { marketplace: 'openai-bundled', plugin: 'sites', version: '0.1.46' },
      { marketplace: 'openai-bundled', plugin: 'sites', version: '0.1.9' },
    ],
  });
  assert.equal(plugins.installedPluginSkillDirs(home)[0].version, '0.1.46');
  assert.deepEqual(['0.1.3', '0.1.46', '0.1.9'].sort(plugins._compareVersions), ['0.1.46', '0.1.9', '0.1.3']);
  assert.deepEqual(['1.0.0', 'nightly', '2.0.0'].sort(plugins._compareVersions), ['2.0.0', '1.0.0', 'nightly'],
    'a version that is not numeric sorts below one that is');
});

test('the plugin is named by its manifest, and by the install key when there is none (#536)', () => {
  // The cache folder is the MARKETPLACE's name for the plugin. Reading it would work on the machine it
  // was written on and produce the wrong name anywhere else.
  const named = makeHome({
    installed: [{ key: 'folder-name@mkt' }],
    cached: [{ marketplace: 'mkt', plugin: 'folder-name', version: '1.0.0', manifestName: 'real-name' }],
  });
  assert.equal(plugins.installedPluginSkillDirs(named)[0].name, 'real-name');

  const bare = makeHome({
    installed: [{ key: 'folder-name@mkt' }],
    cached: [{ marketplace: 'mkt', plugin: 'folder-name', version: '1.0.0', manifestName: null }],
  });
  assert.equal(plugins.installedPluginSkillDirs(bare)[0].name, 'folder-name');
});

test('an install key is split at the LAST @ (#536)', () => {
  // A plugin name may contain one; the marketplace suffix is the one at the end.
  assert.deepEqual(plugins._splitInstallKey('a@b'), { plugin: 'a', marketplace: 'b' });
  assert.deepEqual(plugins._splitInstallKey('scope@name@market'), { plugin: 'scope@name', marketplace: 'market' });
  assert.equal(plugins._splitInstallKey('nomarketplace'), null);
  assert.equal(plugins._splitInstallKey('@leading'), null);
  assert.equal(plugins._splitInstallKey(''), null);
});

test('an unreadable config is an empty answer, never a throw (#536)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plug-bad-'));
  fs.writeFileSync(path.join(home, 'config.toml'), 'this is [not valid toml');
  assert.deepEqual(plugins.installedPluginSkillDirs(home), []);

  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plug-none-'));
  assert.deepEqual(plugins.installedPluginSkillDirs(missing), []);
  assert.deepEqual(plugins.installedPluginSkillDirs(null), []);
});

// --- how it reaches the listing --------------------------------------------------------------------------

test('each plugin is one listing row, labelled with the plugin it belongs to (#536)', () => {
  const home = makeHome({
    installed: [{ key: 'documents@openai-primary-runtime' }, { key: 'sites@openai-bundled' }],
    cached: [
      { marketplace: 'openai-primary-runtime', plugin: 'documents', version: '1.0.0' },
      { marketplace: 'openai-bundled', plugin: 'sites', version: '0.1.46' },
    ],
  });
  const listed = codexResources.createListResources({ codexHome: () => home })({ projectPath: null });
  const rows = listed.resources.filter(r => String(r.source || '').startsWith('plugin-skills:'));

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.name), ['documents', 'sites'], 'sorted by name');
  for (const row of rows) {
    assert.equal(row.kind, 'skill');
    assert.equal(row.scope, 'global');
    assert.equal(row.source, `plugin-skills:${row.name}`);
    // The path names the marketplace and a version, neither of which a reader would recognise as the
    // plugin — so the row has to say it itself.
    assert.equal(row.originLabel, `Plugin ${row.name}`);
  }
});

test("a plugin's skills directory expands like any other skills tree (#536)", () => {
  const home = makeHome({
    installed: [{ key: 'documents@openai-primary-runtime' }],
    cached: [{ marketplace: 'openai-primary-runtime', plugin: 'documents', version: '1.0.0', skills: ['alpha', 'beta'] }],
  });
  const listed = codexResources.createListResources({ codexHome: () => home })({ projectPath: null });
  const row = listed.resources.find(r => r.source === 'plugin-skills:documents');
  assert.ok(row, 'the row is there to expand');

  const expanded = codexResources.expandResource({ path: row.path, source: row.source, scope: row.scope, projectPath: null });
  assert.equal(expanded.ok, true);
  assert.deepEqual(expanded.entries.map(e => e.name).sort(), ['alpha', 'beta']);
  assert.deepEqual([...new Set(expanded.entries.map(e => e.kind))], ['skill']);
});

test('the expansion resolver still answers the static sources (#536)', () => {
  // The rule became a function so an unknown key can be resolved. A function that forgot the map would
  // leave every ordinary directory unexpandable, and nothing else here would notice.
  const home = makeHome(ONE);
  fs.mkdirSync(path.join(home, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(home, 'rules', 'house.md'), '# house rules\n');

  const listed = codexResources.createListResources({ codexHome: () => home })({ projectPath: null });
  const rules = listed.resources.find(r => r.source === 'rules-directory');
  const expanded = codexResources.expandResource({ path: rules.path, source: rules.source, scope: rules.scope, projectPath: null });
  assert.equal(expanded.ok, true);
  assert.deepEqual(expanded.entries.map(e => e.name), ['house']);
});

// --- what an install key may not do ---------------------------------------------------------------------

test('an install key cannot walk out of the plugin cache (#536)', () => {
  // Both halves of the key become path segments, and `path.join` resolves `..` without complaint. The
  // listing IS the allow-list every other guard consults, so a directory that reaches it is readable,
  // expandable and writable — measured before this check existed: the escaped directory came back with
  // its files.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-esc-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-outside-'));
  const leaf = path.join(outside, '1.0.0', 'skills', 'secret');
  fs.mkdirSync(leaf, { recursive: true });
  fs.writeFileSync(path.join(leaf, 'SKILL.md'), '---\nname: secret\n---\n');

  const rel = path.relative(path.join(home, 'plugins', 'cache', 'mkt'), outside).split(path.sep).join('/');
  fs.writeFileSync(path.join(home, 'config.toml'), `[plugins."${rel}@mkt"]\nenabled = true\n`);

  assert.deepEqual(plugins.installedPluginSkillDirs(home), [], 'the escaped directory is not offered');

  const listed = codexResources.createListResources({ codexHome: () => home })({ projectPath: null });
  for (const row of listed.resources) {
    assert.ok(path.resolve(row.path).startsWith(path.resolve(home)), `${row.source} stayed inside the home`);
  }
});

test('a key half that is not a single path segment is refused (#536)', () => {
  const BACKSLASH = String.fromCharCode(92);
  for (const bad of ['..', '.', 'a/b', `a${BACKSLASH}b`, '', '/abs', `C:${BACKSLASH}abs`]) {
    assert.equal(plugins._isPathSegment(bad), false, `${JSON.stringify(bad)} is not a segment`);
    assert.equal(plugins._splitInstallKey(`${bad}@mkt`), null, `${JSON.stringify(bad)} as a plugin name`);
    assert.equal(plugins._splitInstallKey(`plugin@${bad}`), null, `${JSON.stringify(bad)} as a marketplace`);
  }
  assert.ok(plugins._isPathSegment('normal-name'));
  assert.ok(plugins._isPathSegment('name.with.dots'));
});

test('a junctioned version directory is still seen (#536)', { skip: process.platform !== 'win32' }, () => {
  // `Dirent.isDirectory()` answers false for a Windows junction, which is how a junctioned skills
  // directory once became invisible with no error to see (#440). Linking a working copy into the cache is
  // what a plugin developer does.
  const home = makeHome({ installed: [{ key: 'linked@mkt' }], cached: [] });
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-real-'));
  fs.mkdirSync(path.join(real, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(real, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n');

  const pluginDir = path.join(home, 'plugins', 'cache', 'mkt', 'linked');
  fs.mkdirSync(pluginDir, { recursive: true });
  try {
    fs.symlinkSync(real, path.join(pluginDir, '1.0.0'), 'junction');
  } catch {
    return;                                  // no privilege to make one here; nothing to assert
  }
  const found = plugins.installedPluginSkillDirs(home);
  assert.equal(found.length, 1, 'the linked version directory was seen');
  assert.equal(found[0].version, '1.0.0');
});

test('the expansion resolver answers for a plugin source, which is what makes a row reachable (#536)', () => {
  // `reachable()` in app/backend-resources.js gates read, write, delete and open on `knowsSource`. A
  // resolver that went back to being a static map would leave every plugin row unopenable, and nothing
  // else in this file would notice.
  assert.equal(codexResources.expandResource.knowsSource('plugin-skills:documents'), true);
  assert.equal(codexResources.expandResource.knowsSource('rules-directory'), true);
  assert.equal(codexResources.expandResource.knowsSource('plugin-skills'), false, 'the prefix alone names no plugin');
  assert.equal(codexResources.expandResource.knowsSource('not-a-source'), false);
});
