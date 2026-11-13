'use strict';
// #823 T7 — a deep link names a category AND an item (an opaque inventory id), and a link to an already open
// settings window navigates that window (spec 40's recorded gap, spec 44). Main validates the seed; the open window
// is sent `settings-goto`; the renderer opens the item's page once its view has read, and an unknown id leaves the list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { settingsQuery, shownQueryKey, sendSettingsGoto } = require('../src/app/windows');

const REN = path.join(__dirname, '..', 'src', 'renderer');
const tick = () => new Promise(r => setTimeout(r, 0));
const ID = '0123456789abcdef';

test('main takes an item only beside a known category, and only as a 16-character lowercase hex id', () => {
  assert.equal(settingsQuery('global', null, { cat: 'instructions', item: ID }).item, ID);
  assert.equal(settingsQuery('project', '/p', { cat: 'plugins-agents', item: ID }).item, ID);
  for (const bad of ['~/project/CLAUDE.md', '/etc/passwd', '../x', ID.toUpperCase(), ID + '0', 'abc', '', 42, null, {}, [ID]]) {
    assert.equal(settingsQuery('global', null, { cat: 'instructions', item: bad }).item, undefined, `refused ${JSON.stringify(bad)}`);
  }
  assert.equal(settingsQuery('global', null, { item: ID }).item, undefined, 'no category: no item');
  // `backends` is a deep-link category since #873 (the welcome tour's gear); `tags` is not one.
  assert.equal(settingsQuery('global', null, { cat: 'tags', item: ID }).item, undefined, 'unknown category: no item');
  assert.equal(settingsQuery('global', null, { cat: 'tags', item: ID }).cat, undefined);
});

test('the item does not make the window a different thing', () => {
  assert.equal(shownQueryKey({ scope: 'global', cat: 'instructions', item: ID }), shownQueryKey({ scope: 'global' }));
});

test('a goto reaches a loaded window at once and a loading one when it has loaded', () => {
  const sent = [];
  const handlers = [];
  const mk = (loading) => ({ isDestroyed: () => false, webContents: {
    isLoading: () => loading, once: (e, f) => handlers.push([e, f]), send: (ch, msg) => sent.push([ch, msg]) } });
  sendSettingsGoto(mk(false), { cat: 'instructions', item: ID });
  assert.deepEqual(sent, [['settings-goto', { cat: 'instructions', item: ID }]]);
  sendSettingsGoto(mk(true), { cat: 'plugins-rules', item: null });
  assert.equal(sent.length, 1, 'not yet');
  assert.equal(handlers[0][0], 'did-finish-load');
  handlers[0][1]();
  assert.deepEqual(sent[1], ['settings-goto', { cat: 'plugins-rules', item: null }]);
});

function setup(rows) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="body"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  for (const rel of ['lib/utils.js', 'panels/plugins-kit.js', 'panels/plugins-views.js', 'panels/plugins-resources.js', 'panels/settings-plugins.js']) {
    vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  }
  const w = dom.window;
  w.api = { getResourceInventory: async () => ({ ok: true, rows, declines: [] }), getResourcePlaces: async () => ({ ok: true, places: [] }) };
  const body = w.document.getElementById('body');
  body.innerHTML = w.settingsPlugins.sectionsHtml('global');
  const ac = new w.AbortController();
  const ctl = w.settingsPlugins.bind(body, ac.signal, { scope: 'global', projectPath: null, restoreCat: () => {} });
  const show = (cat) => body.querySelector(`.settings-cat[data-cat="${cat}"]`).dispatchEvent(new w.Event('settings-cat-shown'));
  return { dom, body, ctl, show };
}
const row = (id, name) => ({ id, name, kind: 'agent', scope: 'global', sourceLabel: 'S', originLabel: 'S', cli: { key: 'c', label: 'C' }, clis: [{ key: 'c', label: 'C' }], editable: false, deletable: false });

test('an item asked for before the view has read opens its page when the view mounts', async () => {
  const { dom, body, ctl, show } = setup([row(ID, 'one'), row('fedcba9876543210', 'two')]);
  try {
    ctl.openItem('plugins-agents', ID);
    show('plugins-agents');
    await tick(); await tick();
    assert.equal(body.querySelector('.plugins-detail-page').hidden === false, true);
    assert.match(body.querySelector('.plugins-detail-page .plugins-title').textContent, /one/);
  } finally { dom.window.close(); }
});

test('an item asked for on a mounted view opens its page; an unknown id leaves the list', async () => {
  const { dom, body, ctl, show } = setup([row(ID, 'one')]);
  try {
    show('plugins-agents');
    await tick(); await tick();
    ctl.openItem('plugins-agents', 'ffffffffffffffff');
    assert.equal(body.querySelector('.plugins-list-page').hidden, false, 'unknown id: still the list');
    ctl.openItem('plugins-agents', ID);
    assert.equal(body.querySelector('.plugins-list-page').hidden, true);
    assert.match(body.querySelector('.plugins-detail-page .plugins-title').textContent, /one/);
  } finally { dom.window.close(); }
});

// openSettingsWindow's same-window branch, against a fake electron (loaded in a child process so the real module
// graph of the other tests is untouched).
test('a link to the open window of the same scope sends a goto; a plain re-open only raises it', () => {
  const { execFileSync } = require('node:child_process');
  const script = `
    const Module = require('module');
    const log = [];
    class FakeWindow {
      constructor() { this.visible = false; this.webContents = { isLoading: () => false, once() {}, send: (ch, m) => log.push(['send', ch, m]) }; }
      isDestroyed() { return false; } isVisible() { return this.visible; } show() { this.visible = true; } hide() { this.visible = false; }
      focus() { log.push(['focus']); } setMenu() {} loadFile(f, o) { log.push(['load', o.query]); this.visible = true; } once() {} on() {}
    }
    const fake = { BrowserWindow: FakeWindow, dialog: {}, ipcMain: { on() {}, handle() {} }, Menu: {}, screen: {}, shell: {} };
    const orig = Module._load;
    Module._load = function (req, ...rest) { return req === 'electron' ? fake : orig.call(this, req, ...rest); };
    const w = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'app', 'windows.js'))});
    w.init({ getMainWindow: () => null, getAppQuitting: () => false, getSetting: () => ({}), setSetting() {} });
    w.openSettingsWindow('global', null, { cat: 'instructions', item: ${JSON.stringify(ID)} });
    const afterOpen = log.length;
    w.openSettingsWindow('global', null);
    const plain = log.slice(afterOpen);
    w.openSettingsWindow('global', null, { cat: 'plugins-rules', item: 'not-an-id' });
    console.log(JSON.stringify({ first: log.slice(0, afterOpen), plain, linked: log.slice(afterOpen + plain.length) }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim().split('\n').pop());
  assert.deepEqual(out.first[0], ['load', { scope: 'global', cat: 'instructions', item: ID }]);
  assert.deepEqual(out.plain, [['focus']], 'a plain re-open only raises');
  assert.deepEqual(out.linked, [['focus'], ['send', 'settings-goto', { cat: 'plugins-rules', item: null }]], 'raised and told to go; the bad id is dropped');
});
