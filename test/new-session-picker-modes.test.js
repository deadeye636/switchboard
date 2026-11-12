'use strict';
// #761 E5 / T9c: the New Session picker lists ONE row per CLI. Both modes enabled: the row starts the terminal
// mode (the owner) and a GUI button beside the gear starts the GUI mode (the driver). Only the GUI mode: the row
// starts it under the GUI's own label. Only the terminal mode: the row as before, no GUI button. The Configure
// dialog gets a Terminal | GUI switch only when both modes are enabled, and starts the mode it shows.
//
// Driven in jsdom over fake descriptors — no real backend id appears here, and none may appear in the new code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const REN = path.join(ROOT, 'src', 'renderer');

const READY = { status: 'ready', enabled: true };
const MODEL = { id: 'model', label: 'Model', type: 'text', default: '' };
const GATE = { id: 'gate', label: 'Approval gate', type: 'toggle', default: false };

function registry(patch = {}) {
  const byId = {
    ow: { id: 'ow', label: 'Owner', ...READY, configFields: [MODEL] },
    'ow-gui': { id: 'ow-gui', label: 'Owner (GUI)', ...READY, transcriptsOf: 'ow', modeLabel: 'GUI', configFields: [MODEL, GATE] },
    solo: { id: 'solo', label: 'Solo', ...READY, configFields: [] },
  };
  for (const [id, p] of Object.entries(patch)) byId[id] = { ...byId[id], ...p };
  return byId;
}

function setup({ backends = registry(), defaultId = 'ow', globalSettings = null } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><button id="anchor"></button></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  const launched = [];
  window._backendsById = backends;
  window._defaultBackendId = defaultId;
  // What app.js holds as the global blob; the picker reads `pickerModeByBackend` from it (#761 E6 d).
  if (globalSettings) window.appGlobalSettings = globalSettings;
  window.getBackend = (id) => backends[id] || null;
  window.launchableBackends = () => Object.values(backends).filter(b => b.status === 'ready' && b.enabled);
  window.escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window.launchNewSession = (project, options) => { launched.push(options); };
  window.api = {
    getSetting: async () => ({}),
    getEffectiveSettings: async () => ({ backendDefaults: {} }),
    listHandoffs: async () => [],
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'shared', 'backend-modes.js'), 'utf8'), ctx, { filename: 'backend-modes.js' });
  vm.runInContext(fs.readFileSync(path.join(REN, 'dialogs', 'dialogs.js'), 'utf8'), ctx, { filename: 'dialogs.js' });
  const call = (name) => vm.runInContext(name, ctx);
  const project = { projectPath: '/work/proj' };
  return {
    window, launched, project,
    openPicker: async () => {
      await call('showNewSessionPopover')(project, window.document.getElementById('anchor'));
      return window.document.querySelector('.new-session-popover');
    },
    openConfigure: async (id) => {
      await call('showNewSessionDialog')(project, id);
      return window.document.querySelector('.new-session-dialog');
    },
  };
}

const settle = () => new Promise(r => setTimeout(r, 0));
const rows = (popover) => [...popover.querySelectorAll('.popover-option-backend')];
const rowText = (row) => row.querySelector('.popover-option-body').textContent;

test('both modes: one row for the CLI, the row starts the owner and the GUI button the driver', async () => {
  const t = setup();
  let popover = await t.openPicker();
  const list = rows(popover);
  assert.equal(list.length, 2, 'one row per CLI (Owner, Solo), not one per mode');
  const owner = list[0];
  assert.match(rowText(owner), /^\s*Owner/);
  assert.ok(owner.querySelector('.popover-option-tag'), 'the default badge stays on the row');
  const gui = owner.querySelector('button.popover-option-mode');
  assert.ok(gui, 'the GUI button is there');
  assert.equal(gui.textContent, 'GUI', 'labelled with the mode label');
  assert.ok(gui.classList.contains('fp-toolbar-btn'), 'reuses an existing button style');
  assert.equal(gui.getAttribute('aria-label'), 'Start Owner in GUI mode');
  assert.equal(gui.nextElementSibling, owner.querySelector('.popover-option-gear'), 'the GUI button sits before the gear');
  assert.ok(!gui.classList.contains('active'), 'not marked default while the default is the terminal mode');

  owner.querySelector('.popover-option-body').click();
  await settle();
  assert.equal(t.launched.at(-1).backendId, 'ow');

  popover = await t.openPicker();
  rows(popover)[0].querySelector('.popover-option-mode').click();
  await settle();
  assert.equal(t.launched.at(-1).backendId, 'ow-gui');
});

test('the GUI id as the default keeps the badge on the row and marks the GUI button', async () => {
  const t = setup({ defaultId: 'ow-gui' });
  const popover = await t.openPicker();
  const owner = rows(popover)[0];
  assert.match(rowText(owner), /Owner/);
  assert.ok(owner.querySelector('.popover-option-tag'));
  const gui = owner.querySelector('.popover-option-mode');
  assert.ok(gui.classList.contains('active'));
  assert.match(gui.getAttribute('aria-label'), /\(default\)/);
});

test('only the GUI mode: the row starts the driver under its own label, no GUI button', async () => {
  const t = setup({ backends: registry({ ow: { enabled: false } }), defaultId: 'solo' });
  const popover = await t.openPicker();
  const list = rows(popover);
  assert.equal(list.length, 2);
  const gui = list.find(r => /Owner \(GUI\)/.test(rowText(r)));
  assert.ok(gui, 'the row carries the GUI label');
  assert.equal(gui.querySelector('.popover-option-mode'), null);
  gui.querySelector('.popover-option-body').click();
  await settle();
  assert.equal(t.launched.at(-1).backendId, 'ow-gui');
});

test('only the terminal mode: the row as before, no GUI button', async () => {
  const t = setup({ backends: registry({ 'ow-gui': { enabled: false } }) });
  const popover = await t.openPicker();
  const list = rows(popover);
  assert.equal(list.length, 2);
  assert.equal(popover.querySelector('.popover-option-mode'), null);
});

test('the Configure switch is there only with both modes, and starts the mode it shows', async () => {
  let t = setup();
  let dialog = await t.openConfigure('ow');
  const sw = dialog.querySelectorAll('.new-session-mode-switch [data-mode]');
  assert.equal(sw.length, 2);
  assert.deepEqual([...sw].map(b => b.textContent), ['Terminal', 'GUI']);
  assert.equal(sw[0].getAttribute('aria-pressed'), 'true');
  assert.equal(dialog.querySelectorAll('.gcd-inherit').length, 1, 'the owner\'s fields');
  assert.match(dialog.querySelector('h3').textContent, /^New Owner Terminal Session/);
  sw[1].click();
  assert.match(dialog.querySelector('h3').textContent, /^New Owner GUI Session/);
  assert.equal(dialog.querySelectorAll('.gcd-inherit').length, 2, 'redrawn with the driver\'s fields');
  assert.equal(dialog.querySelector('.new-session-mode-switch [data-mode="ow-gui"]').getAttribute('aria-pressed'), 'true');
  dialog.querySelector('.new-session-start-btn').click();
  await settle();
  assert.equal(t.launched.at(-1).backendId, 'ow-gui');

  t = setup();
  dialog = await t.openConfigure('ow-gui');
  dialog.querySelector('.new-session-mode-switch [data-mode="ow"]').click();
  dialog.querySelector('.new-session-start-btn').click();
  await settle();
  assert.equal(t.launched.at(-1).backendId, 'ow');

  t = setup({ backends: registry({ 'ow-gui': { enabled: false } }) });
  dialog = await t.openConfigure('ow');
  assert.equal(dialog.querySelector('.new-session-mode-switch'), null, 'no switch with one mode');
  t = setup();
  dialog = await t.openConfigure('solo');
  assert.equal(dialog.querySelector('.new-session-mode-switch'), null, 'no switch for a CLI without a GUI');
});

// --- T9d (E6 d): "Default in the picker" decides which mode the row starts -------------------------------------

const PREFER_GUI = { pickerModeByBackend: { ow: 'ow-gui' } };

test('picker default GUI: the row starts the GUI under the CLI label, the button starts Terminal', async () => {
  const t = setup({ globalSettings: PREFER_GUI });
  let popover = await t.openPicker();
  const owner = rows(popover)[0];
  assert.match(rowText(owner), /^\s*Owner(?!\s*\()/, 'the row keeps the CLI label');
  const btn = owner.querySelector('button.popover-option-mode');
  assert.equal(btn.textContent, 'Terminal', 'the button names the OTHER mode');
  assert.equal(btn.getAttribute('aria-label'), 'Start Owner in Terminal mode (default)', 'the default target is the terminal mode');
  assert.ok(btn.classList.contains('active'));
  assert.ok(owner.querySelector('.popover-option-tag'), 'the DEFAULT badge logic is unchanged');
  owner.querySelector('.popover-option-body').click();
  await settle();
  assert.equal(t.launched.at(-1).backendId, 'ow-gui');

  popover = await t.openPicker();
  rows(popover)[0].querySelector('.popover-option-mode').click();
  await settle();
  assert.equal(t.launched.at(-1).backendId, 'ow');
});

test('picker default GUI: the gear opens Configure on the GUI mode', async () => {
  const t = setup({ globalSettings: PREFER_GUI });
  const popover = await t.openPicker();
  rows(popover)[0].querySelector('.popover-option-gear').click();
  await settle();
  const dialog = t.window.document.querySelector('.new-session-dialog');
  assert.equal(dialog.querySelector('.new-session-mode-switch [data-mode="ow-gui"]').getAttribute('aria-pressed'), 'true');
  assert.match(dialog.querySelector('h3').textContent, /^New Owner GUI Session/);
});

test('picker default falls back to Terminal when the preferred mode is off or unknown', async () => {
  let t = setup({ globalSettings: { pickerModeByBackend: { ow: 'gone' } } });
  let popover = await t.openPicker();
  let owner = rows(popover)[0];
  assert.equal(owner.querySelector('.popover-option-mode').textContent, 'GUI');
  owner.querySelector('.popover-option-body').click();
  await settle();
  assert.equal(t.launched.at(-1).backendId, 'ow');

  t = setup({ backends: registry({ 'ow-gui': { enabled: false } }), globalSettings: PREFER_GUI });
  popover = await t.openPicker();
  owner = rows(popover)[0];
  assert.equal(owner.querySelector('.popover-option-mode'), null, 'one mode on: no side button');
  owner.querySelector('.popover-option-body').click();
  await settle();
  assert.equal(t.launched.at(-1).backendId, 'ow');
});

test('the new code names no backend id', () => {
  const src = fs.readFileSync(path.join(REN, 'dialogs', 'dialogs.js'), 'utf8');
  const start = src.indexOf('function cliLaunchModesOf');
  const helper = src.slice(start, src.indexOf('\n}\n', start));
  const picker = src.slice(src.indexOf('const shownClis'), src.indexOf("const termBtn = document.createElement('button')"));
  for (const block of [helper, picker]) {
    assert.ok(block.length > 100);
    assert.doesNotMatch(block, /['"`](claude|codex|pi|hermes|agy)(-native)?['"`]/);
  }
});
