'use strict';
// #803 T10 follow-up — the Plugins group inside the REAL settings panel (verifier findings M1-M4, L1, L7).
//
// The panel is loaded the way settings.html loads it (every script that page names, in order, into one jsdom vm
// context — the harness of settings-project-action-close.test.js) and its buttons are really clicked. What this pins
// is what the occluded demo window could not show: Cancel, Save, Apply, Hide and the settings search stop while a
// skill page holds unsaved text, and say so by showing that page; the search keeps focus in its box and brings every
// view back to its list; a deep-link category is taken once and an unknown one is ignored.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { pageScripts } = require('./helpers/page-scripts');

const REN = path.join(__dirname, '..', 'src', 'renderer');
const PROJECT_PATH = '/projects/example/alpha';
const tick = () => new Promise(r => setTimeout(r, 0));

const DOM_FIXTURE = `<!DOCTYPE html><html><body>
  <div id="settings-viewer" style="display:none;">
    <div id="settings-viewer-header"><span id="settings-viewer-title">Settings</span></div>
    <div id="settings-viewer-body"></div>
  </div>
</body></html>`;

const SKILL = { id: 'sk1', name: 'house-style', scope: 'global', sourceLabel: 'Switchboard', filePath: '/d/house-style/SKILL.md', alsoNamed: [], editable: true };

function makeApi(record) {
  const anyCall = () => new Proxy(function () {}, {
    get: (t, p) => (p === 'then' ? undefined : anyCall()),
    apply: () => Promise.resolve({ ok: true }),
  });
  const target = {
    platform: 'linux',
    getSetting: async () => ({}),
    setSetting: async () => ({ ok: true }),
    getShellProfiles: async () => [],
    projectTagsGet: async () => [],
    projectTagsListAll: async () => [],
    projectTagsSet: async () => ({ ok: true }),
    getAboutInfo: async () => ({}),
    notifySettingsChanged: async () => ({ ok: true }),
    backends: { list: async () => [] },
    profiles: { list: async () => [], setDefault: async () => ({ ok: true }) },
    hideProject: async (p) => { record.hide.push(p); return { ok: true }; },
    hideSettingsWindow: () => { record.windowHidden += 1; },
    getSkillInventory: async () => ({ skills: [SKILL] }),
    getSkillDetail: async () => ({ ok: true, targets: [] }),
    readSkill: async () => ({ ok: true, content: 'x\n' }),
    getPluginInventory: async () => ({ plugins: [] }),
    getAppInventory: async () => ({ apps: [] }),
    getProjectsAdmin: async () => ({ ok: true, projects: [] }),
    checkExternalMcp: async () => ({ ok: true, results: [] }),
    tagDefsList: async () => ({ ok: true, tags: [] }),
  };
  return new Proxy(target, { get: (t, p) => (p in t ? t[p] : (p === 'then' ? undefined : anyCall())) });
}

async function openSettings(scope, seed) {
  const record = { hide: [], windowHidden: 0 };
  const dom = new JSDOM(DOM_FIXTURE, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.api = makeApi(record);
  window.bookmarksTags = { pickColor: () => '#61afef', palette: ['#e06c75', '#98c379'] };
  const ctx = dom.getInternalVMContext();
  for (const rel of pageScripts('settings.html').filter(s => !s.endsWith('settings-window.js'))) {
    vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  }
  window.showControlDialog = async () => true;
  window.showControlMessage = async () => true;
  // The editor: CodeMirror cannot load in jsdom, so a stand-in with the same surface the adapter reads.
  window.createEditableViewer = (parent, text) => {
    const view = { value: text, state: null, dom: parent, dispatch(tr) { view.value = tr.changes.insert; }, destroy() {} };
    Object.defineProperty(view, 'state', { get: () => ({ doc: { toString: () => view.value, length: view.value.length } }) });
    window.__editor = view;
    return view;
  };
  if (seed) window.__SETTINGS_SEED__ = seed;
  await window.openSettingsViewer(scope, scope === 'project' ? PROJECT_PATH : null);
  return { window, record, doc: window.document, destroy: () => window.close() };
}

const nav = (doc, cat) => doc.querySelector(`.settings-nav-item[data-cat="${cat}"]`);
const activeCat = (doc) => doc.querySelector('.settings-nav-item.active').dataset.cat;

/** Open the skill's page and leave unsaved text in its editor. */
async function dirtySkill(window, doc) {
  nav(doc, 'plugins-skills').click();
  await tick(); await tick();
  doc.querySelector('section[data-cat="plugins-skills"] .plugins-row-open').click();
  await tick(); await tick(); await tick();
  window.__editor.value = 'changed\n';
}

test('Cancel with unsaved skill text keeps the window and shows the skill page; after Discard it closes', async () => {
  const { window, record, doc, destroy } = await openSettings('global');
  try {
    await dirtySkill(window, doc);
    nav(doc, 'terminal').click();
    assert.equal(activeCat(doc), 'terminal');
    doc.getElementById('sv-cancel-btn').click();
    await tick();
    assert.equal(record.windowHidden, 0, 'the window stays');
    assert.equal(activeCat(doc), 'plugins-skills', 'the refusal is shown, not silent');
    assert.match(doc.querySelector('section[data-cat="plugins-skills"]').textContent, /unsaved changes/);
    [...doc.querySelectorAll('section[data-cat="plugins-skills"] .plugins-skill-edit button')].find(b => b.textContent === 'Discard').click();
    doc.getElementById('sv-cancel-btn').click();
    assert.equal(record.windowHidden, 1);
  } finally { destroy(); }
});

test('Save and Apply stop the same way while a skill page holds unsaved text', async () => {
  const { window, record, doc, destroy } = await openSettings('global');
  try {
    await dirtySkill(window, doc);
    doc.getElementById('sv-save-btn').click();
    doc.getElementById('sv-apply-btn').click();
    await new Promise(r => setTimeout(r, 900));
    assert.equal(record.windowHidden, 0);
    assert.equal(doc.getElementById('sv-save-btn').textContent, 'Save Settings', 'nothing was saved');
  } finally { destroy(); }
});

test('Hide Project asks the skill page first (L1)', async () => {
  const { window, record, doc, destroy } = await openSettings('project');
  try {
    await dirtySkill(window, doc);
    doc.getElementById('sv-remove-btn').click();
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(record.hide, []);
  } finally { destroy(); }
});

test('the settings search brings every view back to its list without taking focus from the search box (M1, M3)', async () => {
  const { window, doc, destroy } = await openSettings('global');
  try {
    nav(doc, 'mcp-addons').click();
    const firstId = window.MCP_ADDON_CATALOG[0].id;
    doc.querySelector(`.sv-addon-catalog .plugins-row[data-key="${firstId}"] .plugins-row-open`).click();
    assert.equal(doc.querySelector('.sv-addon-catalog .plugins-list-page').hidden, true, 'a catalog page is open');
    const search = doc.getElementById('sv-search');
    search.focus();
    search.value = window.MCP_ADDON_CATALOG[0].name;
    search.dispatchEvent(new window.Event('input'));
    assert.equal(doc.activeElement, search, 'focus stays in the search box');
    assert.equal(doc.querySelector('.sv-addon-catalog .plugins-list-page').hidden, false, 'the catalog is back on its list');
    const row = doc.querySelector(`.sv-addon-catalog .plugins-row[data-key="${firstId}"]`);
    assert.notEqual(row.style.display, 'none', 'the matching row is shown');
    assert.equal(doc.getElementById('sv-no-results').style.display, 'none');
    for (const f of doc.querySelectorAll('.plugins-filter-row')) assert.equal(f.style.display, 'none', 'a view\'s own filter is out of the way');

    search.value = 'nothing matches this at all';
    search.dispatchEvent(new window.Event('input'));
    for (const s of doc.querySelectorAll('.plugins-section')) assert.equal(s.style.display, 'none', 'an emptied kit section is hidden');
    assert.equal(doc.getElementById('sv-no-results').style.display, 'block');

    search.value = '';
    search.dispatchEvent(new window.Event('input'));
    for (const s of doc.querySelectorAll('.sv-addon-catalog .plugins-section')) assert.equal(s.style.display, '', 'restored');
    for (const f of doc.querySelectorAll('.plugins-filter-row')) assert.equal(f.style.display, '');
  } finally { destroy(); }
});

test('a search typed while a skill page holds unsaved text is refused and the page is shown', async () => {
  const { window, doc, destroy } = await openSettings('global');
  try {
    await dirtySkill(window, doc);
    nav(doc, 'terminal').click();
    const search = doc.getElementById('sv-search');
    search.value = 'a';
    search.dispatchEvent(new window.Event('input'));
    assert.equal(search.value, '');
    assert.equal(activeCat(doc), 'plugins-skills');
  } finally { destroy(); }
});

test('a deep-link category is taken once; one this window does not have is ignored (L7)', async () => {
  let env = await openSettings('global', { cat: 'plugins-skills' });
  try {
    assert.equal(activeCat(env.doc), 'plugins-skills');
    assert.equal(env.window.__SETTINGS_SEED__, null, 'taken and cleared');
  } finally { env.destroy(); }
  env = await openSettings('global', { cat: 'mcp' });
  try {
    const first = activeCat(env.doc);
    assert.notEqual(first, 'mcp');
    env.doc.getElementById('sv-apply-btn');   // nothing pending to land on later
    nav(env.doc, 'terminal').click();
    assert.equal(activeCat(env.doc), 'terminal');
  } finally { env.destroy(); }
});
