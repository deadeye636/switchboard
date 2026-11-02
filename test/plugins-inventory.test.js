'use strict';
// #803 T4 — the plugins and apps the Plugins manager lists (spec 40, E3, E6).
//
// Stub descriptors, because the point is the core's two roads: a backend that answers `listPlugins` is
// shown with its state, one that declines is shown from its listing rows with "not reported". The real
// readers (`listInstalledPlugins` in the Claude and Codex folders) are tested against fixtures below.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const inventory = require('../src/app/plugins-inventory');

const made = [];
function tmpdir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-plugins-' + name + '-'));
  made.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(backends, { rows = null, oneAskerPerCli = null } = {}) {
  inventory.init({
    backends: {
      list: () => rows || backends.map(b => ({ id: b.id, isProfile: false, status: 'ready' })),
      get: (id) => backends.find(b => b.id === id) || null,
      ...(oneAskerPerCli ? { oneAskerPerCli } : {}),
    },
    log: { warn() {}, error() {}, info() {} },
  });
}

const stating = {
  id: 'stating',
  label: 'Stating',
  listPlugins: ({ projectPath }) => ({
    ok: true,
    plugins: [
      { name: 'on', scope: 'global', state: 'enabled', path: '/x/on', brings: ['skills', 7] },
      { name: 'off', scope: 'global', state: 'disabled', path: '/x/off', brings: [] },
      { name: 'odd', scope: 'weird', state: 'maybe', path: '', brings: 'no' },
      ...(projectPath ? [{ name: 'local', scope: 'project', state: 'enabled', path: '/p/local', brings: [] }] : []),
      { name: '' },
    ],
  }),
  listApps: null,
};

function listingBackend(dir) {
  fs.mkdirSync(path.join(dir, 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'beta'), { recursive: true });
  return {
    id: 'listing',
    label: 'Listing',
    listPlugins: null,
    listApps: null,
    listResources: () => ({
      ok: true,
      resources: [
        { kind: 'plugin', scope: 'global', name: 'plugins', path: dir, source: 'plugins-directory' },
        { kind: 'package', scope: 'global', name: 'npm:some-package', path: null, source: 'settings.json:packages' },
        { kind: 'skill', scope: 'global', name: 'skills', path: dir, source: 'skills-directory' },
      ],
    }),
    expandResource: ({ path: d }) => ({
      ok: true,
      entries: fs.readdirSync(d).map(n => ({ kind: 'plugin', name: n, path: path.join(d, n) })),
    }),
  };
}

test('a backend that states on/off is shown with its state, checked field by field', () => {
  setup([stating]);
  const rows = inventory.getPluginInventory({}).plugins;
  assert.deepEqual(rows.map(r => [r.name, r.state, r.scope]), [['odd', 'not reported', 'global'], ['off', 'disabled', 'global'], ['on', 'enabled', 'global']]);
  assert.deepEqual(rows.find(r => r.name === 'on').brings, ['skills'], 'only words cross');
  assert.deepEqual(rows.find(r => r.name === 'odd').brings, []);
  assert.equal(rows.find(r => r.name === 'odd').path, null);
  for (const r of rows) assert.equal(r.backendLabel, 'Stating');
});

test('a project adds its own plugins', () => {
  setup([stating]);
  const rows = inventory.getPluginInventory({ projectPath: tmpdir('proj') }).plugins;
  assert.equal(rows.find(r => r.name === 'local').scope, 'project');
});

test('a backend that declines is shown from its listing rows, one per plugin, state not reported', () => {
  setup([listingBackend(tmpdir('plugins'))]);
  const rows = inventory.getPluginInventory({}).plugins;
  assert.deepEqual(rows.map(r => [r.kind, r.name, r.state]), [
    ['plugin', 'alpha', 'not reported'],
    ['plugin', 'beta', 'not reported'],
    ['package', 'npm:some-package', 'not reported'],
  ]);
});

test('no row carries a backend id', () => {
  setup([stating, listingBackend(tmpdir('plugins'))]);
  for (const r of inventory.getPluginInventory({}).plugins) {
    assert.deepEqual(Object.keys(r).sort(), ['backendLabel', 'brings', 'id', 'kind', 'name', 'path', 'scope', 'state']);
  }
});

test('a backend without listResources is skipped, and one that throws does not drop the others', () => {
  const bare = { id: 'bare', label: 'Bare', listPlugins: null, listApps: null };
  const throwing = { id: 'throwing', label: 'Throwing', listPlugins: () => { throw new Error('boom'); }, listApps: () => { throw new Error('boom'); } };
  setup([bare, throwing, stating]);
  assert.deepEqual([...new Set(inventory.getPluginInventory({}).plugins.map(r => r.backendLabel))], ['Stating']);
  assert.deepEqual(inventory.getAppInventory({}).apps, []);
});

test('one asker per CLI: the registry decides which of a pair is asked', () => {
  const twin = { ...stating, id: 'twin', label: 'Twin' };
  setup([stating, twin], { oneAskerPerCli: (list) => list.filter(b => b.id !== 'twin') });
  assert.deepEqual([...new Set(inventory.getPluginInventory({}).plugins.map(r => r.backendLabel))], ['Stating']);
});

test('profiles and backends that are not ready are not asked', () => {
  const other = { ...stating, id: 'other', label: 'Other' };
  setup([stating, other], { rows: [{ id: 'stating', isProfile: true, status: 'ready' }, { id: 'other', isProfile: false, status: 'missing' }] });
  assert.deepEqual(inventory.getPluginInventory({}).plugins, []);
});

test('apps: none while no backend answers, and a backend that answers shows through', () => {
  setup([stating]);
  assert.deepEqual(inventory.getAppInventory({}).apps, []);
  const withApps = { id: 'apps', label: 'Apps', listPlugins: null, listApps: () => ({ ok: true, apps: [{ name: 'Mail', state: 'enabled' }, { name: '' }] }) };
  setup([stating, withApps]);
  const apps = inventory.getAppInventory({}).apps;
  assert.deepEqual(apps.map(a => [a.name, a.backendLabel, a.state]), [['Mail', 'Apps', 'enabled']]);
  assert.match(apps[0].id, /^[0-9a-f]{16}$/);
});

test('extension rows, a directory without a reading rule, and throwing listing hooks', () => {
  const extDir = tmpdir('ext');
  fs.mkdirSync(path.join(extDir, 'one-ext'));
  const pkgDir = tmpdir('npm');
  const mixed = {
    id: 'mixed',
    label: 'Mixed',
    listPlugins: null,
    listApps: null,
    listResources: () => ({
      ok: true,
      resources: [
        { kind: 'extension', scope: 'global', name: 'extensions', path: extDir, source: 'extensions-directory' },
        { kind: 'package', scope: 'global', name: 'npm', path: pkgDir, source: 'installed-directory' },
      ],
    }),
    expandResource: ({ path: d, source }) => (source === 'installed-directory'
      ? { ok: false, reason: 'no rule' }
      : { ok: true, entries: fs.readdirSync(d).map(n => ({ kind: 'extension', name: n, path: path.join(d, n) })) }),
  };
  const listingThrows = { id: 'lt', label: 'LT', listPlugins: null, listApps: null, listResources: () => { throw new Error('x'); } };
  const expandThrows = {
    id: 'et',
    label: 'ET',
    listPlugins: null,
    listApps: null,
    listResources: () => ({ ok: true, resources: [{ kind: 'plugin', scope: 'global', name: 'plugins', path: extDir, source: 'plugins-directory' }] }),
    expandResource: () => { throw new Error('x'); },
  };
  setup([mixed, listingThrows, expandThrows]);
  const rows = inventory.getPluginInventory({}).plugins;
  assert.deepEqual(rows.map(r => [r.backendLabel, r.kind, r.name]), [
    ['Mixed', 'package', 'npm'],
    ['Mixed', 'extension', 'one-ext'],
    ['ET', 'plugin', 'plugins'],
  ], 'an unreadable directory is one entry, not dropped; a throwing listing drops only its own backend');
});

test('ids are stable and distinct', () => {
  setup([stating]);
  const a = inventory.getPluginInventory({}).plugins.map(r => r.id);
  const b = inventory.getPluginInventory({}).plugins.map(r => r.id);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
});

// ── The two readers that state on/off, against fixtures in an isolated home ───────────────────────────
const claudePlugins = require('../src/backends/claude/plugins');
const codexPlugins = require('../src/backends/codex/plugins');

test('Claude: installed plugins with their settings state and what they carry; another project\'s local install is left out', () => {
  const home = tmpdir('claude-home');
  const project = tmpdir('claude-proj');
  const elsewhere = tmpdir('claude-other');
  const install = (name) => {
    const dir = path.join(home, 'plugins', 'cache', 'mkt', name, '1.0.0');
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    return dir;
  };
  const on = install('on');
  fs.mkdirSync(path.join(on, 'commands'));
  fs.writeFileSync(path.join(on, '.mcp.json'), '{}');
  const off = install('off');
  const local = install('local');
  const foreign = install('foreign');
  fs.writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {
    'on@mkt': [{ scope: 'user', installPath: on }],
    'off@mkt': [{ scope: 'user', installPath: off }],
    'local@mkt': [{ scope: 'local', projectPath: project, installPath: local }],
    'foreign@mkt': [{ scope: 'local', projectPath: elsewhere, installPath: foreign }],
    'gone@mkt': [{ scope: 'user', installPath: path.join(home, 'nowhere') }],
  } }));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'on@mkt': true, 'off@mkt': false, 'local@mkt': true } }));
  const rows = claudePlugins.listInstalledPlugins(home, project);
  assert.deepEqual(rows.map(r => [r.name, r.scope, r.state]), [['local', 'project', 'enabled'], ['off', 'global', 'disabled'], ['on', 'global', 'enabled']]);
  assert.deepEqual(rows.find(r => r.name === 'on').brings, ['skills', 'commands', 'mcp-servers']);
});

test('Codex: every plugin config.toml names, with its state; a key with nothing cached or an escaping key is left out', () => {
  const home = tmpdir('codex-home');
  const cache = (plugin) => {
    const dir = path.join(home, 'plugins', 'cache', 'mkt', plugin, '0.1.0');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  fs.mkdirSync(path.join(cache('on'), 'skills'));
  cache('off');
  fs.writeFileSync(path.join(home, 'config.toml'), [
    '[plugins."on@mkt"]', 'enabled = true', '',
    '[plugins."off@mkt"]', 'enabled = false', '',
    '[plugins."missing@mkt"]', 'enabled = true', '',
    '[plugins."../../..@mkt"]', 'enabled = true', '',
  ].join('\n'));
  const rows = codexPlugins.listInstalledPlugins(home);
  assert.deepEqual(rows.map(r => [r.name, r.state, r.brings.join(',')]), [['off', 'disabled', ''], ['on', 'enabled', 'skills']]);
});

test('Claude: an install path that names an .asar archive is never touched', () => {
  const home = tmpdir('claude-asar');
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {
    'x@mkt': [{ scope: 'user', installPath: path.join(home, 'app.asar', 'x') }],
  } }));
  assert.deepEqual(claudePlugins.listInstalledPlugins(home, null), []);
});

// The descriptors' own hooks resolve from the isolated home they are pointed at, never the real one.
test('the real Claude and Codex descriptors answer listPlugins from the home they are pointed at', (t) => {
  const registry = require('../src/backends');
  const claude = registry.get('claude');
  const codex = registry.get('codex');
  const claudeHome = tmpdir('claude-iso');
  fs.mkdirSync(path.join(claudeHome, 'projects'), { recursive: true });
  const installPath = path.join(claudeHome, 'plugins', 'cache', 'mkt', 'iso', '1.0.0');
  fs.mkdirSync(installPath, { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'iso@mkt': [{ scope: 'user', installPath }] } }));
  const codexHome = tmpdir('codex-iso');
  fs.mkdirSync(path.join(codexHome, 'plugins', 'cache', 'mkt', 'iso-codex', '0.1.0'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[plugins."iso-codex@mkt"]\nenabled = true\n');

  const before = claude.getRoots ? claude.getRoots() : null;
  claude.setRoots([path.join(claudeHome, 'projects')]);
  codex.setHome(codexHome);
  t.after(() => {
    claude.setRoots(before || [process.env.SWITCHBOARD_STORE_CLAUDE || path.join(os.homedir(), '.claude', 'projects')]);
    codex.setHome(null);
  });
  assert.deepEqual(claude.listPlugins({}).plugins.map(p => [p.name, p.state]), [['iso', 'disabled']]);
  assert.deepEqual(codex.listPlugins({}).plugins.map(p => [p.name, p.state]), [['iso-codex', 'enabled']]);
});
