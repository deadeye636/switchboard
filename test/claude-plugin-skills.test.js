'use strict';
// #463 — a plugin's skills, offered under the name the CLI expects.
//
// Two things the directory layout cannot answer, and both are the whole feature: what the plugin is
// CALLED (the invocation is `/<plugin>:<skill>`, and the cache folder is named after the marketplace),
// and whether it is installed AND enabled at all (a marketplace checkout holds plugins nobody installed,
// and the install record holds ones that are switched off). A wrong answer to either produces a slash
// command the CLI refuses — the failure the measured capability table exists to prevent.
//
// Everything here builds a fake Claude home on disk, because that is what the code reads. Nothing
// resolves a real home: an isolated instance must never see the user's plugins.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plugins = require('../src/backends/claude/plugins');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-plugins-'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeSkill(dir, name) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), '# ' + name + '\n');
}

/**
 * A temp directory, as its REAL path. macOS hands out `/var/...` for a directory that lives under
 * `/private/var/...`, so a test that skipped this would be measuring the normalisation rather than the
 * question it means to ask.
 */
function realTmp(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// A junction on Windows, a directory symlink elsewhere: the same mechanism under two names, and the one
// of #545's three spellings a test can make without taking a drive letter off the machine it runs on.
function linkDir(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

// A machine or a policy that refuses to make one says so out loud rather than passing quietly.
const LINK_REFUSED = (() => {
  const probe = realTmp('sb-plugin-linkprobe-');
  try {
    fs.mkdirSync(path.join(probe, 'target'));
    linkDir(path.join(probe, 'target'), path.join(probe, 'link'));
    return false;
  } catch (err) {
    return `this machine would not create a directory link (${err && err.code})`;
  }
})();

// Whether two names differing only in case are two directories here — asked of the filesystem, because a
// macOS volume can be either and the answer decides which of the two assertions below is the true one.
const CASE_SENSITIVE_FS = (() => {
  const probe = realTmp('sb-plugin-caseprobe-');
  fs.mkdirSync(path.join(probe, 'CaseProbe'));
  return !fs.existsSync(path.join(probe, 'caseprobe'));
})();

/**
 * A Claude home with one cached plugin checkout.
 * `manifestName` is what the plugin calls itself; leave it out to test the fallback.
 */
function makeHome({ installKey = 'tools@market', manifestName = 'tools', enabled = true,
  scope = 'user', projectPath = null, withSkills = true, cacheDir = 'market/tools/1.0.0' } = {}) {
  const home = tmpHome();
  const installPath = path.join(home, 'plugins', 'cache', ...cacheDir.split('/'));
  fs.mkdirSync(installPath, { recursive: true });
  if (manifestName) writeJson(path.join(installPath, '.claude-plugin', 'plugin.json'), { name: manifestName });
  if (withSkills) {
    writeSkill(path.join(installPath, 'skills'), 'do-a-thing');
    writeSkill(path.join(installPath, 'skills'), 'do-another');
  }
  const install = { scope, installPath };
  if (projectPath) install.projectPath = projectPath;
  writeJson(path.join(home, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: { [installKey]: [install] },
  });
  if (enabled !== null) writeJson(path.join(home, 'settings.json'), { enabledPlugins: { [installKey]: enabled } });
  return { home, installPath };
}

test('an installed, enabled plugin with skills is reported once, under its manifest name', () => {
  const { home, installPath } = makeHome({ installKey: 'tools@market', manifestName: 'toolkit' });
  const found = plugins.installedPluginSkillDirs(home, null);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'toolkit', 'the manifest names the plugin, not the cache folder');
  assert.equal(found[0].skillsDir, path.join(installPath, 'skills'));
  assert.equal(found[0].scope, 'global');
});

test('without a manifest the install key names it — never the directory it was cached in', () => {
  // The cache folder is the marketplace's name for the plugin; on the machine this was written on the
  // two happened to match, which is exactly how a wrong invocation ships.
  const { home } = makeHome({ installKey: 'toolkit@some-marketplace', manifestName: null, cacheDir: 'some-marketplace/whatever/2.0.0' });
  const found = plugins.installedPluginSkillDirs(home, null);
  assert.deepEqual(found.map(p => p.name), ['toolkit']);
});

test('a plugin that is installed but not enabled is not offered', () => {
  const { home } = makeHome({ enabled: false });
  assert.deepEqual(plugins.installedPluginSkillDirs(home, null), []);
});

test('a plugin with no enabled entry at all is not offered either', () => {
  // "Installed but never switched on" is what a marketplace leaves behind; an absent flag is not a yes.
  const { home } = makeHome({ enabled: null });
  assert.deepEqual(plugins.installedPluginSkillDirs(home, null), []);
});

test('a plugin without a skills directory is not a skill source', () => {
  const { home } = makeHome({ withSkills: false });
  assert.deepEqual(plugins.installedPluginSkillDirs(home, null), []);
});

test('a locally installed plugin follows its own project and no other', () => {
  const projectPath = path.join(os.tmpdir(), 'sb-plugin-project');
  const { home } = makeHome({ scope: 'local', projectPath });
  assert.deepEqual(plugins.installedPluginSkillDirs(home, projectPath).map(p => p.scope), ['project']);
  assert.deepEqual(plugins.installedPluginSkillDirs(home, path.join(os.tmpdir(), 'sb-other-project')), []);
  assert.deepEqual(plugins.installedPluginSkillDirs(home, null), [], 'and it is not a global plugin');
});

test('a local plugin path spelled with the other separator is still the same project', () => {
  const base = realTmp('sb-plugin-proj-');
  const { home } = makeHome({ scope: 'local', projectPath: base });
  assert.equal(plugins.installedPluginSkillDirs(home, base.replace(/\\/g, '/')).length, 1);
});

test('...and spelled in another case, where the filesystem itself ignores case',
  { skip: CASE_SENSITIVE_FS && 'this filesystem tells the two spellings apart' }, () => {
    const base = realTmp('sb-plugin-case-ok-');
    const { home } = makeHome({ scope: 'local', projectPath: base });
    assert.equal(plugins.installedPluginSkillDirs(home, base.toUpperCase()).length, 1);
  });

// #545 — the two things a resolved-string compare answered wrongly. Both decide a listing entry's SCOPE,
// so both failed as a plugin's skills quietly missing rather than as anything anyone could read.

test('two projects that differ only in case are two projects, where the filesystem says so (#545)',
  { skip: !CASE_SENSITIVE_FS && 'this filesystem calls both spellings one directory' }, () => {
    const base = realTmp('sb-plugin-twin-');
    const mine = path.join(base, 'proj');
    const theirs = path.join(base, 'PROJ');
    fs.mkdirSync(mine);
    fs.mkdirSync(theirs);
    const { home } = makeHome({ scope: 'local', projectPath: mine });
    assert.equal(plugins.installedPluginSkillDirs(home, mine).length, 1, 'its own project still gets it');
    assert.deepEqual(plugins.installedPluginSkillDirs(home, theirs), [],
      'lowercasing hands one project the plugin that was installed for the other');
  });

test('a project reached through a link is the project its plugin was installed for (#545)',
  { skip: LINK_REFUSED }, () => {
    const base = realTmp('sb-plugin-link-');
    const project = path.join(base, 'proj');
    const other = path.join(base, 'other');
    fs.mkdirSync(project);
    fs.mkdirSync(other);
    const viaLink = path.join(base, 'link');
    const toOther = path.join(base, 'other-link');
    linkDir(project, viaLink);
    linkDir(other, toOther);
    const { home } = makeHome({ scope: 'local', projectPath: project });

    // The install record holds the real directory; the app opened the project through the link. One
    // project, two spellings — and deciding it by the string drops the plugin's skills from the listing.
    assert.deepEqual(plugins.installedPluginSkillDirs(home, viaLink).map(p => p.scope), ['project'],
      'a project reached through a link keeps its plugins');
    // …and a link to somewhere else is still refused, which is the half a "resolve both" fix must keep.
    assert.deepEqual(plugins.installedPluginSkillDirs(home, toOther), []);
  });

test('a project may enable a plugin the user settings say nothing about', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-plugin-enable-'));
  const { home } = makeHome({ installKey: 'tools@market', enabled: null });
  writeJson(path.join(projectPath, '.claude', 'settings.json'), { enabledPlugins: { 'tools@market': true } });
  assert.equal(plugins.installedPluginSkillDirs(home, projectPath).length, 1);
});

test('the local settings file wins over the project one, like Claude reads them', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-plugin-local-'));
  const { home } = makeHome({ installKey: 'tools@market', enabled: true });
  writeJson(path.join(projectPath, '.claude', 'settings.json'), { enabledPlugins: { 'tools@market': true } });
  writeJson(path.join(projectPath, '.claude', 'settings.local.json'), { enabledPlugins: { 'tools@market': false } });
  assert.deepEqual(plugins.installedPluginSkillDirs(home, projectPath), []);
});

test('a missing, empty or malformed install record is an answer, not a throw', () => {
  const empty = tmpHome();
  assert.deepEqual(plugins.installedPluginSkillDirs(empty, null), []);
  fs.mkdirSync(path.join(empty, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(empty, 'plugins', 'installed_plugins.json'), '{ not json');
  assert.deepEqual(plugins.installedPluginSkillDirs(empty, null), []);
  assert.deepEqual(plugins.installedPluginSkillDirs(null, null), []);
});

test('the source carries the plugin name, and only a plugin source answers to it', () => {
  assert.equal(plugins.pluginSkillsSource('toolkit'), 'plugin-skills:toolkit');
  assert.equal(plugins.pluginFromSource('plugin-skills:toolkit'), 'toolkit');
  assert.equal(plugins.pluginFromSource('skills-directory'), '');
  assert.equal(plugins.pluginFromSource(null), '');
});

// --- Through the descriptor: the listing, the expansion and the invocation ---

const claudeResources = require('../src/backends/claude/resources');

test('a plugin\'s skills are listed as skills, expandable, and named for the invocation', () => {
  const { home, installPath } = makeHome({ installKey: 'tools@market', manifestName: 'toolkit' });
  const listResources = claudeResources.createListResources({ claudeHome: () => home });
  const listed = listResources({ projectPath: null });
  const row = listed.resources.find(r => (r.source || '').startsWith('plugin-skills:'));
  assert.ok(row, 'the plugin\'s skills directory is listed as a skill source');
  assert.equal(row.kind, 'skill');
  assert.equal(row.source, 'plugin-skills:toolkit');
  assert.equal(row.originLabel, 'Plugin toolkit', 'the row says which plugin it came from');
  assert.equal(row.path, path.join(installPath, 'skills'));

  // The source key is not in any static rule map — the backend resolves it, or nothing could read it.
  assert.equal(claudeResources.expandResource.knowsSource(row.source), true);
  const expanded = claudeResources.expandResource({ path: row.path, source: row.source, scope: row.scope });
  assert.equal(expanded.ok, true);
  assert.deepEqual(expanded.entries.map(e => e.name), ['do-a-thing', 'do-another']);
});

test('a source that only looks like a plugin one is still refused', () => {
  assert.equal(claudeResources.expandResource.knowsSource('plugin-skills'), false);
  assert.equal(claudeResources.expandResource({ path: os.tmpdir(), source: 'plugin-skills' }).ok, false);
});

const claude = require('../src/backends/claude');

// MEASURED in a running session, not read out of a help text (the rule a per-backend answer is held to):
// typing `/caveman:` at the prompt offers `/caveman:caveman` and `/caveman:cavecrew`, each with the
// skill's own description and a `(caveman)` marker. So the plugin half comes first and the skill second.
test('a plugin skill is invoked as /<plugin>:<skill>, a plain one keeps /<skill>', () => {
  assert.equal(claude.skillInvocation({ name: 'do-a-thing', source: 'plugin-skills:toolkit' }), '/toolkit:do-a-thing');
  assert.equal(claude.skillInvocation({ name: 'git-commit', source: 'skills-directory' }), '/git-commit');
  assert.equal(claude.skillInvocation({ name: 'git-commit' }), '/git-commit');
  assert.equal(claude.skillInvocation({ name: '' }), null);
});

test('a marketplace checkout whose plugin was never installed is not offered', () => {
  // The case the issue names: a marketplace directory holds skills for plugins nobody installed, and
  // offering one produces a slash command the CLI answers with an error. Both checkouts sit in the same
  // cache, with the same shape — only the install record tells them apart.
  const { home } = makeHome({ installKey: 'tools@market', manifestName: 'toolkit' });
  const strangerPath = path.join(home, 'plugins', 'cache', 'market', 'stranger', '9.9.9');
  writeJson(path.join(strangerPath, '.claude-plugin', 'plugin.json'), { name: 'stranger' });
  writeSkill(path.join(strangerPath, 'skills'), 'not-mine');
  // …and it is even enabled, so the flag alone cannot be what excludes it.
  writeJson(path.join(home, 'settings.json'), {
    enabledPlugins: { 'tools@market': true, 'stranger@market': true },
  });

  const found = plugins.installedPluginSkillDirs(home, null);
  assert.deepEqual(found.map(p => p.name), ['toolkit']);
  assert.ok(!found.some(p => p.skillsDir.includes('stranger')), 'nothing walks the cache directory itself');
});
