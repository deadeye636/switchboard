'use strict';
// #803 T10 — the Plugins group of the settings screen (spec 40 E1, E7, E8, E9): nav and sections agree, a deep link
// carries only a known category, the views read when first shown and count their rows, and a page holding unsaved
// work stops what would drop it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');
const tick = () => new Promise(r => setTimeout(r, 0));
const { settingsQuery, shownQueryKey, SETTINGS_SEED_CATS } = require('../src/app/windows');

function load(api = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="body"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  for (const rel of ['lib/utils.js', '../shared/external-mcp-validate.js', '../shared/external-mcp-form.js', '../shared/mcp-addon-catalog.js',
    'panels/plugins-kit.js', 'panels/plugins-views.js', 'panels/plugins-resources.js', 'panels/settings-external-mcp.js', 'panels/settings-plugins.js']) {
    vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  }
  dom.window.api = api;
  return dom;
}

const navCats = (html) => [...html.matchAll(/data-cat="([^"]+)"/g)].map(m => m[1]);

test('every nav item of the group has its section, in both windows', () => {
  const dom = load();
  try {
    const sp = dom.window.settingsPlugins;
    const globalHtml = sp.sectionsHtml('global') + '<section class="settings-cat" data-cat="mcp-addons"></section>';
    const projectHtml = sp.sectionsHtml('project') + '<section class="settings-cat" data-cat="mcp"></section>';
    for (const [scope, sections] of [['global', globalHtml], ['project', projectHtml]]) {
      const have = navCats(sections);
      const nav = navCats(sp.navHtml(scope));
      assert.equal(nav.length, 8, scope + ': five items (E7) and Agents, Commands, Rules (#823)');
      for (const cat of nav) assert.ok(have.includes(cat), `${scope}: ${cat} has a section`);
    }
    assert.ok(navCats(sp.navHtml('project')).includes('mcp'), 'the project MCPs item is the existing project MCP category');
    assert.ok(navCats(sp.navHtml('global')).includes('plugins-mcps'));
    assert.match(sp.navHtml('global'), />Marketplace </);
  } finally { dom.window.close(); }
});

test('a deep link carries only a category from the fixed list, the same list main and the renderer hold', () => {
  const dom = load();
  try {
    assert.equal(settingsQuery('global', null, { cat: 'plugins-skills' }).cat, 'plugins-skills');
    assert.equal(settingsQuery('global', null, { cat: 'tags' }).cat, undefined, 'not on the list');
    assert.equal(settingsQuery('global', null, { cat: 'backends' }).cat, 'backends', 'the welcome tour\'s gear (#873)');
    assert.equal(settingsQuery('global', null, { cat: '<x>' }).cat, undefined);
    const rendererCats = JSON.parse(JSON.stringify(dom.window.settingsPlugins.SEED_CATS));
    assert.deepEqual([...rendererCats].sort(), [...SETTINGS_SEED_CATS].sort(), 'main and the renderer hold the same list, both ways');
    for (const cat of rendererCats) {
      assert.equal(settingsQuery('global', null, { cat }).cat, cat, `main takes ${cat}`);
    }
    assert.equal(shownQueryKey({ scope: 'global', cat: 'plugins-apps' }), shownQueryKey({ scope: 'global' }),
      'a category to land on does not make the window a different thing');
  } finally { dom.window.close(); }
});

function mountBody(dom, scope) {
  const { window } = dom;
  const body = window.document.getElementById('body');
  const sp = window.settingsPlugins;
  body.innerHTML = `<nav>${sp.navHtml(scope)}</nav>${sp.sectionsHtml(scope)}`
    + (scope === 'global' ? '<section class="settings-cat" data-cat="mcp-addons"><div id="sv-mcp-addons"></div></section>' : '');
  return body;
}

test('the views read on their first show, once, and the badge is their row count', async () => {
  const calls = [];
  const dom = load({
    getSkillInventory: async () => { calls.push('skills'); return { skills: [{ id: 'a', name: 'a', scope: 'global', sourceLabel: 'X', filePath: '/a', alsoNamed: [], editable: false }] }; },
    getPluginInventory: async () => { calls.push('plugins'); return { plugins: [] }; },
    getAppInventory: async () => ({ apps: [] }),
    getProjectsAdmin: async () => ({ ok: true, projects: [] }),
    checkExternalMcp: async () => ({ ok: true, results: [] }),
  });
  try {
    const { window } = dom;
    const body = mountBody(dom, 'global');
    window.settingsExternalMcp.bindAddons(body, new window.AbortController().signal);
    window.settingsPlugins.bind(body, new window.AbortController().signal, { scope: 'global', projectPath: null });
    await tick();
    assert.deepEqual(calls, [], 'nothing read at bind');
    const show = (cat) => body.querySelector(`section[data-cat="${cat}"]`).dispatchEvent(new window.CustomEvent('settings-cat-shown'));
    show('plugins-skills'); show('plugins-skills');
    await tick(); await tick();
    assert.deepEqual(calls, ['skills']);
    const badge = (cat) => body.querySelector(`.settings-nav-item[data-cat="${cat}"] .settings-nav-count`);
    assert.equal(badge('plugins-skills').textContent, '1');
    assert.equal(badge('plugins-plugins').hidden, true, 'an unread view counts nothing');
    assert.equal(badge('mcp-addons').textContent, String(window.MCP_ADDON_CATALOG.length), 'catalog rows, not registry hits');
  } finally { dom.window.close(); }
});

test('Agents, Commands and Rules read on their first show, once, in both windows, and count their rows (#823)', async () => {
  for (const scope of ['global', 'project']) {
    const asked = [];
    const dom = load({
      getResourceInventory: async (view, pp) => { asked.push([view, pp]); return { ok: true, rows: view === 'rules' ? [] : [{ id: view, name: view, scope: 'global', sourceLabel: 'X', clis: [], editable: false }], declines: [] }; },
      getResourcePlaces: async () => ({ ok: true, places: [] }),
    });
    try {
      const { window } = dom;
      const body = mountBody(dom, scope);
      window.settingsPlugins.bind(body, new window.AbortController().signal, { scope, projectPath: scope === 'project' ? '/work/p' : null });
      await tick();
      assert.deepEqual(asked, [], scope + ': nothing read at bind');
      const show = (cat) => body.querySelector(`section[data-cat="${cat}"]`).dispatchEvent(new window.CustomEvent('settings-cat-shown'));
      show('plugins-agents'); show('plugins-agents'); show('plugins-commands');
      await tick(); await tick();
      const pp = scope === 'project' ? '/work/p' : null;
      assert.deepEqual(asked, [['agents', pp], ['commands', pp]]);
      const badge = (cat) => body.querySelector(`.settings-nav-item[data-cat="${cat}"] .settings-nav-count`);
      assert.equal(badge('plugins-agents').textContent, '1');
      assert.equal(badge('plugins-rules').hidden, true, 'an unread view counts nothing');
      assert.ok(body.querySelector('.settings-nav-item[data-cat="plugins-rules"]').hasAttribute('data-count-own'));
    } finally { dom.window.close(); }
  }
});

test('the global MCPs view opens a chosen project on its MCP servers after the warning (E8)', async () => {
  const opened = [];
  const dom = load({
    getProjectsAdmin: async () => ({ ok: true, projects: [{ projectPath: '/work/zeta', displayName: 'Zeta', registered: true }] }),
    openSettingsWindow: (scope, p, seed) => opened.push([scope, p, seed]),
    checkExternalMcp: async () => ({ ok: true, results: [] }),
  });
  try {
    const { window } = dom;
    window.showControlDialog = async () => true;
    const body = mountBody(dom, 'global');
    window.settingsPlugins.bind(body, new window.AbortController().signal, { scope: 'global', projectPath: null });
    body.querySelector('section[data-cat="plugins-mcps"]').dispatchEvent(new window.CustomEvent('settings-cat-shown'));
    await tick(); await tick();
    const picker = body.querySelector('#sv-plugins-mcps-pick select');
    picker.value = '/work/zeta';
    [...body.querySelectorAll('#sv-plugins-mcps-pick button')][0].click();
    await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(opened)), [['project', '/work/zeta', { cat: 'mcp' }]]);
  } finally { dom.window.close(); }
});

test('Marketplace in a project window: "Add to this project" switches to MCPs and opens the Add form prefilled (E9)', async () => {
  const dom = load({ checkExternalMcp: async () => ({ ok: true, results: [] }), backends: { list: async () => ({ backends: [] }) } });
  try {
    const { window } = dom;
    const body = window.document.getElementById('body');
    const sp = window.settingsPlugins;
    body.innerHTML = `<nav>${sp.navHtml('project')}</nav>${window.settingsExternalMcp.sectionHtml([])}${sp.sectionsHtml('project')}`;
    const signal = new window.AbortController().signal;
    window.settingsExternalMcp.bind(body, signal, '/proj');
    const restored = [];
    sp.bind(body, signal, { scope: 'project', projectPath: '/proj', restoreCat: (c) => restored.push(c) });
    const id = window.MCP_ADDON_CATALOG[0].id;
    body.querySelector(`.sv-addon-catalog .plugins-row[data-key="${id}"] .plugins-row-open`).click();
    [...body.querySelectorAll('.sv-addon-catalog .plugins-detail button')].find(b => b.textContent === 'Add to this project').click();
    assert.deepEqual(restored, ['mcp']);
    assert.ok(body.querySelector('#sv-external-mcp-form .sv-mcp-form'), 'the Add form is open');
    assert.equal(body.querySelector('#sv-external-mcp-form input').value, window.MCP_ADDON_CATALOG[0].stdio.name || id);
    assert.equal(body.querySelector('#sv-external-mcp').value, '', 'nothing is stored before Add and Save');
  } finally { dom.window.close(); }
});

test('leave(): a skill page with unsaved text refuses and stays open', async () => {
  let typed = null;
  const dom = load({
    getSkillInventory: async () => ({ skills: [{ id: 'a', name: 'a', scope: 'global', sourceLabel: 'X', filePath: '/a', alsoNamed: [], editable: true }] }),
    getSkillDetail: async () => ({ ok: true, targets: [] }),
    readSkill: async () => ({ ok: true, content: 'x\n' }),
    getProjectsAdmin: async () => ({ ok: true, projects: [] }),
    checkExternalMcp: async () => ({ ok: true, results: [] }),
  });
  try {
    const { window } = dom;
    window.createEditableViewer = (parent, text) => {
      let value = text;
      typed = (t) => { value = t; };
      return { state: { doc: { toString: () => value, get length() { return value.length; } } }, dispatch() {}, dom: parent, destroy() {} };
    };
    const body = mountBody(dom, 'global');
    const ctl = window.settingsPlugins.bind(body, new window.AbortController().signal, { scope: 'global', projectPath: null });
    body.querySelector('section[data-cat="plugins-skills"]').dispatchEvent(new window.CustomEvent('settings-cat-shown'));
    await tick(); await tick();
    body.querySelector('section[data-cat="plugins-skills"] .plugins-row-open').click();
    await tick(); await tick(); await tick();
    assert.equal(ctl.leave(), true, 'nothing typed: it may leave');
    body.querySelector('section[data-cat="plugins-skills"] .plugins-row-open').click();
    await tick(); await tick(); await tick();
    typed('y\n');
    assert.equal(ctl.leave(), false, 'unsaved text refuses');
    assert.equal(body.querySelector('section[data-cat="plugins-skills"] .plugins-detail-page').hidden, false);
  } finally { dom.window.close(); }
});
