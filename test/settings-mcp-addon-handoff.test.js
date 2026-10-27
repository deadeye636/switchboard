'use strict';
// "Add to project" from the global MCP servers catalog (#790 T6, spec 38 D6, D11): the project window opens on its
// MCP servers category with the Add form prefilled from the catalog, from a one-shot seed.
//
// The panel is loaded the way settings.html loads it (every script that page names, in order, into one jsdom vm
// context), as in test/settings-project-action-close.test.js. settings-window.js is left out: it is the bootstrap that
// turns the URL into `window.__SETTINGS_SEED__`, and this test sets that value itself.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { pageScripts } = require('./helpers/page-scripts');

const REN = path.join(__dirname, '..', 'src', 'renderer');
const PROJECT_PATH = '/projects/example/alpha';

function settingsScripts() {
  const srcs = pageScripts('settings.html');
  assert.ok(srcs.includes('../shared/mcp-addon-catalog.js'), 'settings.html loads the catalog');
  return srcs.filter(s => !s.endsWith('settings-window.js'));
}

const DOM_FIXTURE = `<!DOCTYPE html><html><body>
  <div id="settings-viewer" style="display:none;">
    <div id="settings-viewer-header"><span id="settings-viewer-title">Settings</span></div>
    <div id="settings-viewer-body"></div>
  </div>
</body></html>`;

function makeApi(stored) {
  const anyCall = () => new Proxy(function () {}, {
    get: (t, p) => (p === 'then' ? undefined : anyCall()),
    apply: () => Promise.resolve({ ok: true }),
  });
  const target = {
    platform: 'linux',
    getSetting: async (key) => (key === 'project:' + PROJECT_PATH ? { externalMcpServers: stored } : {}),
    setSetting: async () => ({ ok: true }),
    getShellProfiles: async () => [],
    projectTagsGet: async () => [],
    projectTagsListAll: async () => [],
    getAboutInfo: async () => ({}),
    backends: { list: async () => ({ backends: [] }) },
    profiles: { list: async () => [] },
    checkExternalMcp: async () => ({ ok: true, results: [] }),
  };
  return new Proxy(target, { get: (t, p) => (p in t ? t[p] : (p === 'then' ? undefined : anyCall())) });
}

async function openProject({ seed, stored = [] } = {}) {
  const dom = new JSDOM(DOM_FIXTURE, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.api = makeApi(stored);
  window.bookmarksTags = { pickColor: () => '#61afef', palette: ['#e06c75', '#98c379'] };
  const ctx = dom.getInternalVMContext();
  for (const rel of settingsScripts()) vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  window.showControlDialog = async () => true;
  window.__SETTINGS_SEED__ = seed === undefined ? null : seed;
  await window.openSettingsViewer('project', PROJECT_PATH);
  return window;
}

// The panel's own async loads (backends, the check) finish after it opens; let them land before the window closes.
const done = async (window) => { await new Promise(r => setTimeout(r, 100)); window.close(); };

const body = (window) => window.document.getElementById('settings-viewer-body');
const formOf = (window) => body(window).querySelector('#sv-external-mcp-form .sv-mcp-form');
const inputOf = (form, label) => {
  const f = [...form.querySelectorAll('.sv-mcp-form-field')].find(x => x.querySelector('.settings-label').textContent === label);
  return f.querySelector('input, textarea, select');
};
const textArea = (window) => body(window).querySelector('#sv-external-mcp');

test('a catalog seed opens MCP servers with the Add form prefilled, and leaves the list alone', async () => {
  const window = await openProject({ seed: { addon: 'jcodemunch' } });
  try {
    const form = formOf(window);
    assert.ok(form, 'the Add form is open');
    assert.equal(inputOf(form, 'Name').value, 'jcodemunch');
    assert.equal(inputOf(form, 'Command').value, 'jcodemunch-mcp');
    assert.equal(inputOf(form, 'Arguments').value, '');
    assert.equal(textArea(window).value, '', 'nothing is written before Add');
    assert.equal(body(window).querySelector('.settings-nav-item.active').dataset.cat, 'mcp');
    assert.equal(window.__SETTINGS_SEED__, null, 'the seed is taken once');
  } finally { await done(window); }
});

test('pressing Add puts the catalog entry in the list through the validator', async () => {
  const window = await openProject({ seed: { addon: 'jdocmunch' } });
  try {
    const add = [...formOf(window).querySelectorAll('button')].find(b => b.textContent === 'Add');
    add.click();
    const list = JSON.parse(textArea(window).value);
    assert.deepEqual(list, [{ name: 'jdocmunch', transport: 'stdio', command: 'jdocmunch-mcp' }]);
    assert.equal(formOf(window), null, 'the form closes');
  } finally { await done(window); }
});

test('a duplicate name is refused inline, as for any entry', async () => {
  const stored = [{ name: 'jdatamunch', transport: 'stdio', command: 'something-else' }];
  const window = await openProject({ seed: { addon: 'jdatamunch' }, stored });
  try {
    const form = formOf(window);
    [...form.querySelectorAll('button')].find(b => b.textContent === 'Add').click();
    assert.match(form.querySelector('.sv-mcp-form-msg').textContent, /duplicate name/);
    assert.deepEqual(JSON.parse(textArea(window).value), stored, 'the stored list is unchanged');
  } finally { await done(window); }
});

test('Apply\'s rebuild does not open the form again, and an unknown id opens nothing', async () => {
  const window = await openProject({ seed: { addon: 'jcodemunch' } });
  try {
    assert.ok(formOf(window));
    await window.openSettingsViewer('project', PROJECT_PATH);
    assert.equal(formOf(window), null, 'a second build of the panel has no seed');
  } finally { await done(window); }

  const unknown = await openProject({ seed: { addon: 'not-in-catalog' } });
  try {
    assert.equal(formOf(unknown), null);
    assert.equal(unknown.__SETTINGS_SEED__, null);
  } finally { await done(unknown); }
});
