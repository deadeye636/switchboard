'use strict';
// #761 (T6) — one launch-defaults page per CLI in the global scope.
//
// The gear of either mode of a CLI opens the CLI's page: the fields both modes share first (stored under the
// OWNER's id), then one section per ENABLED mode with the fields only that mode has (stored under that mode's
// id). A backend with no twin renders as it always did. The panel runs in a real DOM here with fake descriptors
// shaped like the real pairs, so no backend id appears in this file as a behaviour, only as a fixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { stripComments } = require('./helpers/strip-comments');

const SRC = path.join(__dirname, '..', 'src');
const PANEL = path.join(SRC, 'renderer', 'panels', 'backends-panel.js');

const base = (id, label, extra) => ({
  id, label, status: 'ready', available: true, isProfile: false, resourceDiscovery: false, enabled: true, ...extra,
});
const MODEL = { id: 'model', label: 'Model', type: 'text', default: '' };
const WORKTREE = { id: 'worktree', label: 'Worktree', type: 'toggle', default: false, description: 'Owner wording' };

// Claude-shaped: a narrower permission list in the driver (not shared), a field only the driver has, and a
// shared field whose description differs.
const A = base('cli-a', 'CLI A', {
  caveat: 'Owner caveat.',
  configFields: [MODEL, WORKTREE,
    { id: 'permissionMode', label: 'Permission mode', type: 'select', choices: ['default', 'plan', 'skip'], default: 'default' },
    { id: 'afk', label: 'AFK timeout', type: 'number', default: 0 }],
});
const A_GUI = base('cli-a-gui', 'CLI A (GUI)', {
  transcriptsOf: 'cli-a', modeLabel: 'GUI',
  configFields: [MODEL, { ...WORKTREE, description: 'Driver wording' },
    { id: 'permissionMode', label: 'Permission mode', type: 'select', choices: ['default', 'plan'], default: 'default' },
    { id: 'suggestOff', label: 'Suggestions off', type: 'toggle', default: false }],
});
// Pi-shaped: the driver adds a gate and a list that requires it.
const B = base('cli-b', 'CLI B', {
  configFields: [MODEL, { id: 'models', label: 'Models', type: 'text', default: '' }],
});
const B_GUI = base('cli-b-gui', 'CLI B (GUI)', {
  transcriptsOf: 'cli-b', modeLabel: 'GUI',
  configFields: [MODEL,
    { id: 'gate', label: 'Gate', type: 'toggle', default: true },
    { id: 'rules', label: 'Rules', type: 'lines', default: '', requires: 'gate' }],
});
// Three modes: one owner, two drivers.
const C = base('cli-c', 'CLI C', { configFields: [MODEL, { id: 'own-c', label: 'Own C', type: 'text', default: '' }] });
const C_GUI = base('cli-c-gui', 'CLI C (GUI)', { transcriptsOf: 'cli-c', modeLabel: 'GUI', configFields: [MODEL] });
const C_SRV = base('cli-c-srv', 'CLI C (server)', { transcriptsOf: 'cli-c', modeLabel: 'Server', configFields: [MODEL] });
const LONE = base('lone', 'Lone', { configFields: [MODEL, { id: 'x', label: 'X', type: 'toggle', default: false }] });

async function setup(backends, stored = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  window.api = {
    backends: {
      list: async () => ({ backends, defaultLaunchTarget: backends[0].id }),
      listResources: async () => ({ ok: true, resources: [] }),
    },
    profiles: { list: async () => ({ profiles: [] }) },
  };
  Object.defineProperty(window, 'CSS', { value: { escape: (s) => String(s).replace(/([^\w-])/g, '\\$1') }, configurable: true });
  const ctxVm = dom.getInternalVMContext();
  vm.runInContext(fs.readFileSync(path.join(SRC, 'shared', 'backend-modes.js'), 'utf8'), ctxVm, { filename: 'backend-modes.js' });
  vm.runInContext(fs.readFileSync(PANEL, 'utf8'), ctxVm, { filename: PANEL });
  const root = window.document.getElementById('root');
  const settings = { backendDefaults: stored };
  const mountCtx = { isProject: false, settings, fieldValue: (k, fb) => (settings[k] !== undefined ? settings[k] : fb) };
  await window.backendsPanel.mount(root, mountCtx);
  return { window, root, mountCtx, close: () => window.close() };
}

const plain = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const fire = (el, type) => el.dispatchEvent(new el.ownerDocument.defaultView.Event(type, { bubbles: true }));
const pageOf = (root) => root.querySelector('.backend-page');
const sections = (page) => [...page.querySelectorAll('.backend-mode-section')].map(s => s.dataset.modeFor);
const input = (page, bid, opt) => page.querySelector(`.backend-default-input[data-backend="${bid}"][data-opt="${opt}"]`);
const inherit = (page, bid, opt) => page.querySelector(`.backend-inherit-cb[data-backend="${bid}"][data-opt="${opt}"]`);
const titles = (page) => [...page.querySelectorAll('.settings-section-title')].map(t => t.textContent.trim());

// Back re-mounts the list, which asks the registry again: let that settle.
async function back(ctx) {
  ctx.root.querySelector('[data-act="back"]').click();
  await new Promise(r => setTimeout(r, 20));
}

function openGear(ctx, id) {
  const gear = ctx.root.querySelector(`.backend-gear[data-id="${id}"]`);
  assert.ok(gear, `${id} has a gear`);
  gear.click();
  return pageOf(ctx.root);
}

test('the gear of either row opens the one page of the CLI, headed by the owner', async () => {
  const ctx = await setup([A, A_GUI]);
  try {
    for (const id of ['cli-a', 'cli-a-gui']) {
      const page = openGear(ctx, id);
      assert.equal(page.dataset.backendPage, 'cli-a');
      assert.equal(page.querySelector('h3').textContent, 'CLI A');
      assert.match(page.querySelector('.backend-caveat').textContent, /Owner caveat/);
      assert.ok(page.querySelector('#sv-capability-matrix'), 'the matrix button stays');
      await back(ctx);
    }
  } finally { ctx.close(); }
});

test('shared controls carry the owner id, own controls their mode id, and nothing is drawn twice', async () => {
  const ctx = await setup([A, A_GUI]);
  try {
    const page = openGear(ctx, 'cli-a-gui');
    for (const opt of ['model', 'worktree']) {
      assert.ok(input(page, 'cli-a', opt), `${opt} stored under the owner`);
      assert.equal(input(page, 'cli-a-gui', opt), null, `${opt} has no driver control`);
    }
    // permissionMode differs in its choices, so it is per mode: once in each section.
    assert.ok(input(page, 'cli-a', 'permissionMode') && input(page, 'cli-a-gui', 'permissionMode'));
    assert.ok(input(page, 'cli-a', 'afk'));
    assert.ok(input(page, 'cli-a-gui', 'suggestOff'));
    assert.equal(input(page, 'cli-a', 'suggestOff'), null);
    // The shared block comes first and carries the driver's differing description as a note.
    assert.equal(titles(page)[0], 'Launch defaults');
    const note = page.querySelector('.backend-mode-note');
    assert.ok(note, 'the note is drawn');
    assert.match(note.textContent, /GUI: Driver wording/);
    assert.ok(note.classList.contains('settings-hint'), 'with a visible hint class, not the collapsed settings-more');
    assert.ok(!note.classList.contains('settings-more'));
    assert.deepEqual(sections(page), ['cli-a', 'cli-a-gui']);
    assert.deepEqual(titles(page).filter(t => t === 'Terminal' || t === 'GUI'), ['Terminal', 'GUI']);
  } finally { ctx.close(); }
});

test('a Pi-shaped pair: the driver-only gate and rules sit in the GUI section and keep their requires link', async () => {
  const ctx = await setup([B, B_GUI]);
  try {
    const page = openGear(ctx, 'cli-b');
    assert.ok(input(page, 'cli-b-gui', 'gate') && input(page, 'cli-b-gui', 'rules'));
    assert.ok(input(page, 'cli-b', 'models'));
    const rules = page.querySelector('.settings-field[data-requires="gate"]');
    assert.ok(rules, 'the requires row is drawn');
    assert.equal(rules.dataset.requiresBackend, 'cli-b-gui', 'the link stays inside one data-backend');
  } finally { ctx.close(); }
});

test('a section per ENABLED mode and none for a disabled one; with none enabled every section shows', async () => {
  const ctx = await setup([A, { ...A_GUI, enabled: false }]);
  try {
    assert.deepEqual(sections(openGear(ctx, 'cli-a')), ['cli-a']);
  } finally { ctx.close(); }
  const off = await setup([{ ...A, enabled: false }, { ...A_GUI, enabled: false }]);
  try {
    assert.deepEqual(sections(openGear(off, 'cli-a-gui')), ['cli-a', 'cli-a-gui']);
  } finally { off.close(); }
  const gui = await setup([{ ...A, enabled: false }, A_GUI]);
  try {
    const page = openGear(gui, 'cli-a');
    assert.deepEqual(sections(page), ['cli-a-gui']);
    assert.ok(input(page, 'cli-a', 'model'), 'the shared block is drawn with the owner switched off');
  } finally { gui.close(); }
});

test('a fake three-mode group draws a section for each enabled mode, titled by its mode label', async () => {
  const ctx = await setup([C, C_GUI, { ...C_SRV, enabled: false }]);
  try {
    const page = openGear(ctx, 'cli-c-gui');
    assert.deepEqual(sections(page), ['cli-c', 'cli-c-gui']);
    assert.ok(titles(page).includes('Terminal') && titles(page).includes('GUI'));
    assert.ok(!titles(page).includes('Server'));
    assert.ok(input(page, 'cli-c', 'model') && !input(page, 'cli-c-gui', 'model') && !input(page, 'cli-c-srv', 'model'));
  } finally { ctx.close(); }
  const all = await setup([C, C_GUI, C_SRV]);
  try {
    assert.deepEqual(sections(openGear(all, 'cli-c-srv')), ['cli-c', 'cli-c-gui', 'cli-c-srv']);
  } finally { all.close(); }
});

test('a lone backend renders exactly the single page: no mode sections, no mode titles', async () => {
  const ctx = await setup([LONE, A, A_GUI]);
  try {
    const page = openGear(ctx, 'lone');
    assert.equal(page.dataset.backendPage, 'lone');
    assert.deepEqual(sections(page), []);
    assert.deepEqual(titles(page).filter(t => t === 'Terminal' || t === 'GUI'), []);
    assert.ok(input(page, 'lone', 'model') && input(page, 'lone', 'x'));
  } finally { ctx.close(); }
});

test('the page shows the OWNER\'s stored value for a shared field and an unticked box for it', async () => {
  const ctx = await setup([A, A_GUI], { 'cli-a': { model: 'big' }, 'cli-a-gui': { suggestOff: true } });
  try {
    const page = openGear(ctx, 'cli-a-gui');
    assert.equal(input(page, 'cli-a', 'model').value, 'big');
    assert.equal(inherit(page, 'cli-a', 'model').checked, false);
    assert.equal(inherit(page, 'cli-a', 'worktree').checked, true, 'an unset field still follows the default');
    assert.equal(input(page, 'cli-a-gui', 'suggestOff').checked, true);
  } finally { ctx.close(); }
});

test('an edit is stored under the id of the control: shared under the owner, own under its mode', async () => {
  const ctx = await setup([A, A_GUI]);
  try {
    const page = openGear(ctx, 'cli-a');
    for (const [bid, opt, value] of [['cli-a', 'model', 'opus'], ['cli-a-gui', 'suggestOff', true]]) {
      const cb = inherit(page, bid, opt);
      cb.checked = false;
      fire(cb, 'change');
      const el = input(page, bid, opt);
      if (el.dataset.type === 'toggle') el.checked = value; else el.value = value;
      fire(el, 'change');
    }
    assert.deepEqual(plain(ctx.window.backendsPanel.readGlobal(ctx.root).backendDefaults),
      { 'cli-a': { model: 'opus' }, 'cli-a-gui': { suggestOff: true } });
  } finally { ctx.close(); }
});

test('R2: a value edited in a section survives that section being hidden, and Save still finds it', async () => {
  const ctx = await setup([A, A_GUI]);
  try {
    const page = openGear(ctx, 'cli-a');
    const cb = inherit(page, 'cli-a-gui', 'suggestOff');
    cb.checked = false;
    fire(cb, 'change');
    const el = input(page, 'cli-a-gui', 'suggestOff');
    el.checked = true;
    fire(el, 'change');
    await back(ctx);
    // The mode is switched off in the list, then the page is opened again: its section is not drawn.
    const enable = ctx.root.querySelector('.backend-enable[data-id="cli-a-gui"]');
    enable.checked = false;
    fire(enable, 'change');
    const again = openGear(ctx, 'cli-a');
    assert.deepEqual(sections(again), ['cli-a']);
    assert.equal(input(again, 'cli-a-gui', 'suggestOff'), null);
    assert.deepEqual(plain(ctx.window.backendsPanel.readGlobal(ctx.root).backendDefaults), { 'cli-a-gui': { suggestOff: true } });
  } finally { ctx.close(); }
});

test('the panel names no backend id and builds the page from fieldSplit and launchLayer', () => {
  const src = stripComments(fs.readFileSync(PANEL, 'utf8'));
  assert.match(src, /backendModes\.fieldSplit\(/);
  assert.match(src, /backendModes\.launchLayer\(/);
  assert.match(src, /backendModes\.cliGroups\(/);
  const ids = src.match(/['"](claude|codex|pi|hermes|agy|claude-native|pi-native)['"]/g) || [];
  assert.deepEqual(ids, ["'claude'"], 'only the grandfathered LEGACY_TEMPLATE_BASE names an id');
});

test('settings.html loads the shared module before the panel', () => {
  const { pageScripts } = require('./helpers/page-scripts');
  const srcs = pageScripts('settings.html');
  const mod = srcs.findIndex(s => s.endsWith('shared/backend-modes.js'));
  const panel = srcs.findIndex(s => s.endsWith('panels/backends-panel.js'));
  assert.ok(mod >= 0 && panel > mod);
});
