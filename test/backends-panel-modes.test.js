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

async function setup(backends, stored = {}, opts = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  window.api = {
    backends: {
      list: async () => ({ backends, defaultLaunchTarget: opts.target || backends[0].id }),
      listResources: async () => ({ ok: true, resources: [] }),
    },
    profiles: { list: async () => ({ profiles: opts.profiles || [] }) },
  };
  Object.defineProperty(window, 'CSS', { value: { escape: (s) => String(s).replace(/([^\w-])/g, '\\$1') }, configurable: true });
  const ctxVm = dom.getInternalVMContext();
  vm.runInContext(fs.readFileSync(path.join(SRC, 'shared', 'backend-modes.js'), 'utf8'), ctxVm, { filename: 'backend-modes.js' });
  vm.runInContext(fs.readFileSync(PANEL, 'utf8'), ctxVm, { filename: PANEL });
  const root = window.document.getElementById('root');
  const settings = { backendDefaults: stored, ...(opts.enabled ? { backendEnabled: opts.enabled } : {}), ...(opts.pickerModes ? { pickerModeByBackend: opts.pickerModes } : {}) };
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

test('the CLI row has one gear, and it opens the one page of the CLI, headed by the owner', async () => {
  const ctx = await setup([A, A_GUI]);
  try {
    assert.equal(ctx.root.querySelector('.backend-gear[data-id="cli-a-gui"]'), null, 'a mode has no gear of its own');
    const page = openGear(ctx, 'cli-a');
    assert.equal(page.dataset.backendPage, 'cli-a');
    assert.equal(page.querySelector('h3').textContent, 'CLI A');
    assert.match(page.querySelector('.backend-caveat').textContent, /Owner caveat/);
    assert.ok(page.querySelector('#sv-capability-matrix'), 'the matrix button stays');
  } finally { ctx.close(); }
});

test('shared controls carry the owner id, own controls their mode id, and nothing is drawn twice', async () => {
  const ctx = await setup([A, A_GUI]);
  try {
    const page = openGear(ctx, 'cli-a');
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
    assert.deepEqual(sections(openGear(off, 'cli-a')), ['cli-a', 'cli-a-gui']);
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
    const page = openGear(ctx, 'cli-c');
    assert.deepEqual(sections(page), ['cli-c', 'cli-c-gui']);
    assert.ok(titles(page).includes('Terminal') && titles(page).includes('GUI'));
    assert.ok(!titles(page).includes('Server'));
    assert.ok(input(page, 'cli-c', 'model') && !input(page, 'cli-c-gui', 'model') && !input(page, 'cli-c-srv', 'model'));
  } finally { ctx.close(); }
  const all = await setup([C, C_GUI, C_SRV]);
  try {
    assert.deepEqual(sections(openGear(all, 'cli-c')), ['cli-c', 'cli-c-gui', 'cli-c-srv']);
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
    const page = openGear(ctx, 'cli-a');
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
    ctx.root.querySelector('.backend-mode-badge[data-group="cli-a"]').click();
    ctx.window.document.querySelector('.backend-badge-pop [data-choice="cli-a"]').click();
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

// --- T7: the PROJECT scope has one pane per CLI ---------------------------------------------------------------

async function setupProject(backends, own = {}, globalOwn = {}) {
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
  Object.defineProperty(window, 'CSS', { value: { escape: (s) => String(s).replace(/([^\w-])/g, '\$1') }, configurable: true });
  const ctxVm = dom.getInternalVMContext();
  vm.runInContext(fs.readFileSync(path.join(SRC, 'shared', 'backend-modes.js'), 'utf8'), ctxVm, { filename: 'backend-modes.js' });
  vm.runInContext(fs.readFileSync(PANEL, 'utf8'), ctxVm, { filename: PANEL });
  const root = window.document.getElementById('root');
  let panes = null;
  await window.backendsPanel.mount(root, {
    isProject: true, projectPath: '/home/someone/projects/demo',
    settings: { backendDefaults: own }, globalDefaults: globalOwn,
    fieldValue: (_k, fb) => fb, useGlobalCheckbox: () => '',
    onBackendPanes: (list) => { panes = plain(list); },
  });
  return { window, root, panes: () => panes, close: () => window.close() };
}

const pane = (root, id) => root.querySelector(`section[data-cat="backend:${id}"]`);
const untick = (ctx, bid, opt, value) => {
  const cb = ctx.root.querySelector(`.backend-inherit-cb[data-backend="${bid}"][data-opt="${opt}"]`);
  cb.checked = false;
  fire(cb, 'change');
  const el = input(ctx.root, bid, opt);
  if (el.dataset.type === 'toggle') el.checked = value; else el.value = value;
  fire(el, 'change');
};

test('project scope: one nav entry and one pane per CLI, none for a mode of its own', async () => {
  const ctx = await setupProject([A, A_GUI, LONE, C, C_GUI, C_SRV]);
  try {
    assert.deepEqual(ctx.panes().map(p => p.id), ['cli-a', 'lone', 'cli-c']);
    assert.ok(pane(ctx.root, 'cli-a') && pane(ctx.root, 'lone'));
    assert.equal(pane(ctx.root, 'cli-a-gui'), null);
    assert.equal(pane(ctx.root, 'cli-c-srv'), null);
    assert.equal(ctx.root.querySelectorAll('section.settings-cat').length, 3);
  } finally { ctx.close(); }
});

test('project scope: a section per enabled mode (all when none is), none for a lone backend', async () => {
  const ctx = await setupProject([A, { ...A_GUI, enabled: false }, LONE]);
  try {
    assert.deepEqual(sections(pane(ctx.root, 'cli-a')), ['cli-a']);
    assert.deepEqual(sections(pane(ctx.root, 'lone')), []);
    assert.deepEqual(titles(pane(ctx.root, 'lone')), []);
  } finally { ctx.close(); }
  const none = await setupProject([{ ...A, enabled: false }, { ...A_GUI, enabled: false }]);
  try {
    assert.deepEqual(sections(pane(none.root, 'cli-a')), ['cli-a', 'cli-a-gui']);
  } finally { none.close(); }
});

test('project scope: the count covers every id of the CLI, a hidden mode included', async () => {
  const own = { 'cli-a': { model: 'x', afk: 5 }, 'cli-a-gui': { suggestOff: true, permissionMode: 'plan' } };
  const ctx = await setupProject([A, { ...A_GUI, enabled: false }, LONE], { ...own, lone: { x: true } });
  try {
    const byId = Object.fromEntries(ctx.panes().map(p => [p.id, p.overrides]));
    assert.equal(byId['cli-a'], 4);
    assert.equal(byId.lone, 1);
  } finally { ctx.close(); }
});

test('project scope: a shared override is stored under the owner, a driver-only one under the driver', async () => {
  const ctx = await setupProject([A, A_GUI]);
  try {
    untick(ctx, 'cli-a', 'model', 'opus');
    untick(ctx, 'cli-a-gui', 'suggestOff', true);
    assert.deepEqual(plain(ctx.window.backendsPanel.readProjectDefaults(ctx.root)),
      { 'cli-a': { model: 'opus' }, 'cli-a-gui': { suggestOff: true } });
  } finally { ctx.close(); }
});

test('project scope: inherited values come from the layered global defaults and the box starts ticked', async () => {
  const ctx = await setupProject([A, A_GUI], {}, { 'cli-a': { model: 'big' }, 'cli-a-gui': { suggestOff: true } });
  try {
    const model = input(ctx.root, 'cli-a', 'model');
    assert.equal(model.value, 'big');
    assert.equal(model.disabled, true);
    assert.equal(inherit(ctx.root, 'cli-a', 'model').checked, true);
    assert.equal(input(ctx.root, 'cli-a-gui', 'suggestOff').checked, true);
    assert.equal(input(ctx.root, 'cli-a-gui', 'model'), null, 'a driver draws no control for a shared field');
    assert.match(pane(ctx.root, 'cli-a').querySelector('.backend-mode-note').textContent, /GUI: Driver wording/);
  } finally { ctx.close(); }
});

test('project scope: Save keeps a hidden mode\'s stored overrides', async () => {
  const own = { 'cli-a-gui': { suggestOff: true } };
  const ctx = await setupProject([A, { ...A_GUI, enabled: false }], own);
  try {
    assert.deepEqual(sections(pane(ctx.root, 'cli-a')), ['cli-a'], 'the driver section is hidden');
    assert.equal(input(ctx.root, 'cli-a-gui', 'suggestOff'), null);
    assert.deepEqual(plain(ctx.window.backendsPanel.readProjectDefaults(ctx.root)), own);
  } finally { ctx.close(); }
});

// --- T8 / T9d: the list has one row per CLI, a toggle, a mode badge and a picker-default badge, over one state map

const rowOf = (root, id) => root.querySelector(`.backend-row[data-backend-row="${id}"]`);
const modeBadge = (root, id) => root.querySelector(`.backend-mode-badge[data-group="${id}"]`);
const pickerBadge = (root, id) => root.querySelector(`.backend-picker-badge[data-group="${id}"]`);
const popOf = (root) => root.ownerDocument.querySelector('.backend-badge-pop');   // on document.body, not in the row
const openMode = (root, id) => { modeBadge(root, id).click(); return popOf(root); };
const openPicker = (root, id) => { pickerBadge(root, id).click(); return popOf(root); };
const choiceLabels = (pop) => [...pop.querySelectorAll('.conversation-idle-choices button')].map(b => b.textContent);
const pressedIn = (pop) => [...pop.querySelectorAll('[aria-pressed="true"]')].map(b => b.textContent);
const toggleOf = (root, id) => root.querySelector(`.backend-cli-toggle[data-group="${id}"]`);
const targetSel = (root) => root.querySelector('#sv-default-launch-target');
const enabledOf = (ctx) => plain(ctx.window.backendsPanel.readGlobal(ctx.root).backendEnabled);
const chooseMode = (root, id, value) => openMode(root, id).querySelector(`[data-choice="${value}"]`).click();
const flip = (root, id, on) => { const t = toggleOf(root, id); t.checked = on; fire(t, 'change'); };
const pickerShown = (root, id) => !pickerBadge(root, id).closest('.backend-picker-anchor').hidden;
const pickerOf = (ctx) => plain(ctx.window.backendsPanel.readGlobal(ctx.root).pickerModeByBackend);
const key = (el, k) => el.dispatchEvent(new el.ownerDocument.defaultView.KeyboardEvent('keydown', { key: k, bubbles: true }));

test('one row per CLI: a lone backend has a toggle and no badge, a pair has a mode badge naming the choice', async () => {
  const ctx = await setup([LONE, A, A_GUI]);
  try {
    assert.deepEqual([...ctx.root.querySelectorAll('.backend-row[data-backend-row]')].map(r => r.dataset.backendRow), ['lone', 'cli-a']);
    assert.equal(rowOf(ctx.root, 'cli-a-gui'), null, 'a mode draws no row of its own');
    assert.equal(modeBadge(ctx.root, 'lone'), null);
    assert.equal(pickerBadge(ctx.root, 'lone'), null);
    assert.ok(toggleOf(ctx.root, 'lone'));
    const badge = modeBadge(ctx.root, 'cli-a');
    assert.equal(badge.tagName, 'BUTTON');
    assert.equal(badge.type, 'button');
    assert.ok(badge.classList.contains('conversation-bg-chip'), 'the badge reuses a styled pill (reflex 8)');
    assert.equal(badge.textContent, 'Both');
    assert.equal(badge.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(badge.getAttribute('aria-expanded'), 'false');
    assert.equal(ctx.root.querySelector('select.backend-mode-select, .backend-mode-switch'), null, 'no dropdown, no inline switch');
    assert.equal(rowOf(ctx.root, 'cli-a').querySelector('.settings-field-info .backend-picker-badge'), null,
      'nothing under the description any more');
    // Control order: mode badge, picker badge, toggle, gear last.
    const control = rowOf(ctx.root, 'cli-a').querySelector('.settings-field-control');
    const kinds = [...control.querySelectorAll('.backend-mode-badge, .backend-picker-badge, .backend-cli-toggle, .backend-gear')]
      .map(el => ['backend-mode-badge', 'backend-picker-badge', 'backend-cli-toggle', 'backend-gear'].find(c => el.classList.contains(c)));
    assert.deepEqual(kinds, ['backend-mode-badge', 'backend-picker-badge', 'backend-cli-toggle', 'backend-gear']);
    assert.equal(badge.closest('.backend-badge-anchor').nextElementSibling, pickerBadge(ctx.root, 'cli-a').closest('.backend-badge-anchor'),
      'the picker badge sits right of the mode badge');
    assert.equal(ctx.root.querySelector('.backend-enable'), null, 'no per-id checkbox is left');
  } finally { ctx.close(); }
});

test('a mode not installed is named under the description', async () => {
  const ctx = await setup([A, { ...A_GUI, available: false, unavailableReason: 'Needs a newer CLI.' }]);
  try {
    const lines = [...rowOf(ctx.root, 'cli-a').querySelectorAll('.backend-unavailable')].map(l => l.textContent);
    assert.deepEqual(lines, ['GUI: Needs a newer CLI.']);
  } finally { ctx.close(); }
});

test('the mode badge opens its choices side by side with the current one marked; a pick applies and closes', async () => {
  const ctx = await setup([A, A_GUI, LONE]);
  try {
    const pop = openMode(ctx.root, 'cli-a');
    assert.ok(pop, 'the popover opens');
    assert.ok(pop.classList.contains('conversation-bg-pop'), 'the idle chooser\'s popover look');
    assert.equal(pop.getAttribute('role'), 'dialog');
    assert.ok(pop.querySelector('.conversation-idle-choices'), 'choices side by side, as the idle chooser');
    assert.deepEqual(choiceLabels(pop), ['Terminal', 'GUI', 'Both']);
    assert.ok([...pop.querySelectorAll('button')].every(b => b.classList.contains('new-session-secondary-btn')));
    assert.deepEqual(pressedIn(pop), ['Both']);
    assert.equal(modeBadge(ctx.root, 'cli-a').getAttribute('aria-expanded'), 'true');
    assert.equal(ctx.window.document.activeElement, pop.querySelector('[aria-pressed="true"]'), 'focus goes into the popover');
    pop.querySelector('[data-choice="cli-a-gui"]').click();
    assert.equal(popOf(ctx.root), null, 'a pick closes it');
    assert.deepEqual(enabledOf(ctx), { 'cli-a': false, 'cli-a-gui': true, lone: true });
    assert.equal(modeBadge(ctx.root, 'cli-a').textContent, 'GUI');
    assert.equal(ctx.window.document.activeElement, modeBadge(ctx.root, 'cli-a'), 'and the badge has the focus again');
  } finally { ctx.close(); }
});

test('every choice writes the same backendEnabled as enabledForChoice', async () => {
  const ctx = await setup([A, A_GUI, LONE]);
  try {
    const modes = ctx.window.backendModes;
    const group = modes.cliGroups([A, A_GUI]).find(g => g.owner.id === 'cli-a');
    for (const c of modes.modeChoices(group)) {
      chooseMode(ctx.root, 'cli-a', c.value);
      assert.deepEqual(enabledOf(ctx), { ...plain(modes.enabledForChoice(group, c.value)), lone: true }, c.label);
      assert.equal(modeBadge(ctx.root, 'cli-a').textContent, c.label);
    }
  } finally { ctx.close(); }
});

test('the popover lives on document.body, placed from the badge, and a scroll or a resize closes it', async () => {
  const ctx = await setup([A, A_GUI]);
  try {
    const badge = modeBadge(ctx.root, 'cli-a');
    // jsdom lays nothing out: give the badge a rect and the popover a size, so the placement has numbers to use.
    badge.getBoundingClientRect = () => ({ left: 300, right: 360, top: 100, bottom: 120, width: 60, height: 20 });
    const doc = ctx.window.document;
    Object.defineProperty(doc.documentElement, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(doc.documentElement, 'clientHeight', { value: 600, configurable: true });
    Object.defineProperty(ctx.window.HTMLElement.prototype, 'offsetWidth', { get() { return 200; }, configurable: true });
    Object.defineProperty(ctx.window.HTMLElement.prototype, 'offsetHeight', { get() { return 80; }, configurable: true });
    let pop = openMode(ctx.root, 'cli-a');
    assert.equal(pop.parentElement, doc.body, 'outside every clipping ancestor');
    assert.ok(!ctx.root.contains(pop));
    assert.equal(pop.style.top, '126px', 'below the badge');
    assert.equal(pop.style.left, '160px', 'right-aligned to the badge');
    fire(ctx.root, 'scroll');
    assert.equal(popOf(ctx.root), null, 'a scroll of the settings content closes it');
    assert.equal(doc.activeElement, badge);
    // Near the bottom it opens above; near the left edge it is clamped into the viewport.
    badge.getBoundingClientRect = () => ({ left: 10, right: 70, top: 560, bottom: 580, width: 60, height: 20 });
    pop = openMode(ctx.root, 'cli-a');
    assert.equal(pop.style.top, '474px', 'flipped above the badge');
    assert.equal(pop.style.left, '8px', 'clamped inside the viewport');
    ctx.window.dispatchEvent(new ctx.window.Event('resize'));
    assert.equal(popOf(ctx.root), null, 'a resize closes it');
  } finally { ctx.close(); }
});

test('focus leaving both the popover and its badge closes the popover and leaves the focus where it went', async () => {
  const ctx = await setup([A, A_GUI]);
  try {
    const doc = ctx.window.document;
    const pop = openMode(ctx.root, 'cli-a');
    pop.querySelector('[data-choice="cli-a"]').focus();
    assert.ok(popOf(ctx.root), 'focus moving inside the popover keeps it');
    modeBadge(ctx.root, 'cli-a').focus();
    assert.ok(popOf(ctx.root), 'focus on its own badge keeps it');
    const gear = rowOf(ctx.root, 'cli-a').querySelector('.backend-gear');
    gear.focus();   // Tab to the gear
    assert.equal(popOf(ctx.root), null, 'no orphan popover is left behind');
    assert.equal(doc.activeElement, gear, 'and the focus is not pulled back to the badge');
    assert.equal(modeBadge(ctx.root, 'cli-a').getAttribute('aria-expanded'), 'false');
    assert.deepEqual(enabledOf(ctx), { 'cli-a': true, 'cli-a-gui': true }, 'nothing written');
  } finally { ctx.close(); }
});

test('Escape or a click outside closes the popover without writing and returns focus to the badge', async () => {
  const ctx = await setup([A, A_GUI]);
  try {
    let pop = openMode(ctx.root, 'cli-a');
    key(ctx.window.document.activeElement, 'Escape');
    assert.equal(popOf(ctx.root), null);
    assert.equal(ctx.window.document.activeElement, modeBadge(ctx.root, 'cli-a'));
    assert.equal(modeBadge(ctx.root, 'cli-a').getAttribute('aria-expanded'), 'false');
    assert.deepEqual(enabledOf(ctx), { 'cli-a': true, 'cli-a-gui': true });
    pop = openMode(ctx.root, 'cli-a');
    assert.ok(pop);
    fire(ctx.window.document.body, 'mousedown');
    assert.equal(popOf(ctx.root), null, 'a click outside closes it');
    assert.equal(ctx.window.document.activeElement, modeBadge(ctx.root, 'cli-a'));
    modeBadge(ctx.root, 'cli-a').click();
    modeBadge(ctx.root, 'cli-a').click();
    assert.equal(popOf(ctx.root), null, 'a second click on the badge closes it');
  } finally { ctx.close(); }
});

test('toggle off writes every id off; on restores the remembered mode, with none remembered the owner only', async () => {
  const ctx = await setup([A, A_GUI]);
  try {
    chooseMode(ctx.root, 'cli-a', 'cli-a-gui');
    flip(ctx.root, 'cli-a', false);
    assert.deepEqual(enabledOf(ctx), { 'cli-a': false, 'cli-a-gui': false });
    assert.equal(modeBadge(ctx.root, 'cli-a').disabled, true, 'the badge is disabled while the CLI is off');
    assert.equal(modeBadge(ctx.root, 'cli-a').textContent, 'GUI', 'and shows the last mode');
    modeBadge(ctx.root, 'cli-a').click();
    assert.equal(popOf(ctx.root), null, 'a disabled badge opens nothing');
    flip(ctx.root, 'cli-a', true);
    assert.deepEqual(enabledOf(ctx), { 'cli-a': false, 'cli-a-gui': true });
    assert.equal(modeBadge(ctx.root, 'cli-a').disabled, false);
  } finally { ctx.close(); }
  const off = await setup([A, A_GUI], {}, { enabled: { 'cli-a': false, 'cli-a-gui': false } });
  try {
    assert.equal(toggleOf(off.root, 'cli-a').checked, false);
    assert.equal(modeBadge(off.root, 'cli-a').disabled, true);
    flip(off.root, 'cli-a', true);
    assert.deepEqual(enabledOf(off), { 'cli-a': true, 'cli-a-gui': false });
  } finally { off.close(); }
});

test('the default target follows the mode: a target on a mode switched off moves to its twin, otherwise it stays', async () => {
  const ctx = await setup([A, A_GUI, LONE], {}, { target: 'cli-a-gui' });
  try {
    assert.equal(targetSel(ctx.root).value, 'cli-a-gui');
    chooseMode(ctx.root, 'cli-a', 'cli-a');
    assert.equal(targetSel(ctx.root).value, 'cli-a');
    assert.equal(ctx.window.backendsPanel.readGlobal(ctx.root).defaultLaunchTarget, 'cli-a');
    chooseMode(ctx.root, 'cli-a', 'cli-a|cli-a-gui');
    assert.equal(targetSel(ctx.root).value, 'cli-a', 'Both keeps the owner target');
    assert.deepEqual([...targetSel(ctx.root).options].map(o => o.value), ['cli-a', 'cli-a-gui', 'lone'],
      'the target select still lists every enabled id');
  } finally { ctx.close(); }
});

test('a three-mode group offers each mode and All, and names an unofferable combination with nothing marked', async () => {
  const ctx = await setup([C, C_GUI, C_SRV], {}, { enabled: { 'cli-c': true, 'cli-c-gui': true, 'cli-c-srv': false } });
  try {
    assert.equal(modeBadge(ctx.root, 'cli-c').textContent, 'Terminal + GUI', 'the badge names the combination');
    const pop = openMode(ctx.root, 'cli-c');
    assert.deepEqual(choiceLabels(pop), ['Terminal', 'GUI', 'Server', 'All']);
    assert.deepEqual(pressedIn(pop), [], 'no choice marked for a combination it cannot offer');
    assert.match(pop.querySelector('.conversation-idle-info').textContent, /Terminal \+ GUI/);
    assert.deepEqual(enabledOf(ctx), { 'cli-c': true, 'cli-c-gui': true, 'cli-c-srv': false }, 'opening rewrites nothing');
    pop.querySelector('[data-choice="cli-c-srv"]').click();
    assert.deepEqual(enabledOf(ctx), { 'cli-c': false, 'cli-c-gui': false, 'cli-c-srv': true });
    assert.equal(modeBadge(ctx.root, 'cli-c').textContent, 'Server');
  } finally { ctx.close(); }
});

test('readGlobal while a gear page is open returns the live map (#163)', async () => {
  const ctx = await setup([A, A_GUI, LONE]);
  try {
    chooseMode(ctx.root, 'cli-a', 'cli-a-gui');
    openGear(ctx, 'cli-a');
    const saved = plain(ctx.window.backendsPanel.readGlobal(ctx.root));
    assert.deepEqual(saved.backendEnabled, { 'cli-a': false, 'cli-a-gui': true, lone: true });
    assert.equal(saved.defaultLaunchTarget, 'cli-a-gui');
    await back(ctx);
    assert.equal(modeBadge(ctx.root, 'cli-a').textContent, 'GUI', 'Back keeps the unsaved mode');
    assert.equal(targetSel(ctx.root).value, 'cli-a-gui');
  } finally { ctx.close(); }
});

test('a template on a driver base follows that base', async () => {
  const profiles = [{ id: 'tpl', name: 'Tpl', backendId: 'cli-a-gui' }];
  const ctx = await setup([A, A_GUI], {}, { profiles });
  try {
    const listed = () => [...targetSel(ctx.root).options].map(o => o.value);
    assert.ok(listed().includes('tpl'));
    chooseMode(ctx.root, 'cli-a', 'cli-a');
    assert.ok(!listed().includes('tpl'), 'the base is off, so the template is no launch target');
    chooseMode(ctx.root, 'cli-a', 'cli-a-gui');
    assert.ok(listed().includes('tpl'));
  } finally { ctx.close(); }
});

// --- T9d (E6 d): "Default in the picker" ----------------------------------------------------------------------

test('the picker badge shows only with 2+ modes on, starts on Terminal, and is saved through readGlobal', async () => {
  const ctx = await setup([A, A_GUI, LONE]);
  try {
    assert.ok(pickerShown(ctx.root, 'cli-a'), 'both modes on: shown');
    const badge = pickerBadge(ctx.root, 'cli-a');
    assert.ok(badge.classList.contains('conversation-bg-chip'));
    assert.equal(badge.textContent, 'Picker: Terminal', 'nothing stored: the terminal mode');
    assert.deepEqual(pickerOf(ctx), {}, 'opening stores nothing');
    const pop = openPicker(ctx.root, 'cli-a');
    assert.deepEqual(choiceLabels(pop), ['Terminal', 'GUI']);
    assert.deepEqual(pressedIn(pop), ['Terminal']);
    pop.querySelector('[data-picker-mode="cli-a-gui"]').click();
    assert.equal(popOf(ctx.root), null);
    assert.equal(ctx.window.document.activeElement, badge, 'focus back on the picker badge');
    assert.deepEqual(pickerOf(ctx), { 'cli-a': 'cli-a-gui' });
    assert.equal(badge.textContent, 'Picker: GUI');
    chooseMode(ctx.root, 'cli-a', 'cli-a');
    assert.ok(!pickerShown(ctx.root, 'cli-a'), 'one mode on: hidden');
    chooseMode(ctx.root, 'cli-a', 'cli-a|cli-a-gui');
    assert.ok(pickerShown(ctx.root, 'cli-a'));
    assert.equal(pickerBadge(ctx.root, 'cli-a').textContent, 'Picker: GUI', 'the choice made in this session is kept');
    openPicker(ctx.root, 'cli-a');
    key(ctx.window.document.activeElement, 'Escape');
    assert.equal(popOf(ctx.root), null);
    assert.equal(ctx.window.document.activeElement, pickerBadge(ctx.root, 'cli-a'));
  } finally { ctx.close(); }
  const one = await setup([A, { ...A_GUI, enabled: false }]);
  try {
    assert.ok(!pickerShown(one.root, 'cli-a'), 'hidden from the start with one mode on');
  } finally { one.close(); }
});

test('a stored picker default is shown; one that is not an enabled mode shows Terminal', async () => {
  let ctx = await setup([A, A_GUI], {}, { pickerModes: { 'cli-a': 'cli-a-gui' } });
  try {
    assert.equal(pickerBadge(ctx.root, 'cli-a').textContent, 'Picker: GUI');
    assert.deepEqual(pickerOf(ctx), { 'cli-a': 'cli-a-gui' }, 'kept on save');
  } finally { ctx.close(); }
  ctx = await setup([A, A_GUI], {}, { pickerModes: { 'cli-a': 'gone' } });
  try {
    assert.equal(pickerBadge(ctx.root, 'cli-a').textContent, 'Picker: Terminal');
  } finally { ctx.close(); }
});

test('settings-panel saves pickerModeByBackend from readGlobal', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'renderer', 'panels', 'settings-panel.js'), 'utf8'));
  assert.match(src, /settings\.pickerModeByBackend\s*=\s*bs\.pickerModeByBackend/);
});
