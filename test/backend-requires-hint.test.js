'use strict';
// #731 (O9) — an option that means nothing while another one is off (`requires`) is greyed out in the settings
// screen, with a line saying why, and stays editable. Mounted in a real DOM, like the withheld-hint test beside
// it: what is asserted is what somebody sees.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PANEL = path.join(__dirname, '..', 'src', 'renderer', 'panels', 'backends-panel.js');
const PROJECT_PATH = '/home/someone/projects/demo';

// Shaped like the declaration that needs it: a gate that defaults on, and a list that means nothing without it.
const BACKEND = {
  id: 'runtime', label: 'Runtime', status: 'ready', available: true, resourceDiscovery: false,
  configFields: [
    { id: 'gate', label: 'The gate', type: 'toggle', default: true },
    { id: 'rules', label: 'Rules', type: 'lines', default: '', requires: 'gate' },
    { id: 'orphan', label: 'Orphan', type: 'text', default: '', requires: 'nothing-by-that-name' },
  ],
};

function setup(backend = BACKEND) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  window.api = {
    backends: {
      list: async () => ({ backends: [backend], defaultLaunchTarget: backend.id }),
      listResources: async () => ({ ok: true, resources: [] }),
    },
    profiles: { list: async () => ({ profiles: [] }) },
  };
  window.navigator.clipboard = { writeText: async () => {} };
  vm.runInContext(fs.readFileSync(PANEL, 'utf8'), dom.getInternalVMContext(), { filename: PANEL });
  return { window, dom, root: window.document.getElementById('root') };
}

async function mountProject(ctx, own, globalOwn = {}) {
  await ctx.window.backendsPanel.mount(ctx.root, {
    isProject: true,
    projectPath: PROJECT_PATH,
    settings: { backendDefaults: { [BACKEND.id]: own } },
    globalDefaults: { [BACKEND.id]: globalOwn },
    fieldValue: (_id, fallback) => fallback,
    useGlobalCheckbox: () => '',
  });
}

const row = (ctx) => ctx.root.querySelector('.settings-field[data-requires="gate"]');
const noteShown = (ctx) => !row(ctx).querySelector('.backend-requires-note').hidden;

test('with the gate at its default (on) the rules row is active', async () => {
  const ctx = setup();
  try {
    await mountProject(ctx, {});
    assert.ok(row(ctx), 'the row carries what it needs');
    assert.equal(row(ctx).classList.contains('settings-field-inactive'), false);
    assert.equal(noteShown(ctx), false);
  } finally { ctx.dom.window.close(); }
});

test('with the gate off the rules row is greyed, says why, and stays editable', async () => {
  const ctx = setup();
  try {
    await mountProject(ctx, { gate: false });
    assert.equal(row(ctx).classList.contains('settings-field-inactive'), true);
    assert.equal(noteShown(ctx), true);
    assert.match(row(ctx).querySelector('.backend-requires-note').textContent, /The gate/);
    assert.ok(row(ctx).querySelector('.backend-requires-note').classList.contains('settings-hint'), 'an existing hint style');
  } finally { ctx.dom.window.close(); }
});

test('a project that inherits follows the global value, and a switch on the page is followed at once', async () => {
  const ctx = setup();
  try {
    await mountProject(ctx, {}, { gate: false });
    assert.equal(row(ctx).classList.contains('settings-field-inactive'), true, 'inherits the global gate off');
    const inherit = ctx.root.querySelector('.backend-inherit-cb[data-opt="gate"]');
    inherit.checked = false;
    inherit.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
    const toggle = ctx.root.querySelector('.backend-default-input[data-opt="gate"]');
    toggle.checked = true;
    toggle.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
    assert.equal(row(ctx).classList.contains('settings-field-inactive'), false, 'the project turns the gate on');
    assert.equal(noteShown(ctx), false);
  } finally { ctx.dom.window.close(); }
});

test('a requires naming no field of the backend draws nothing, and a page without such rows does not throw', async () => {
  const ctx = setup({ ...BACKEND, configFields: [BACKEND.configFields[0], BACKEND.configFields[2]] });
  try {
    await mountProject(ctx, { gate: false });
    assert.equal(ctx.root.querySelectorAll('.settings-field[data-requires-backend]').length, 0);
    assert.equal(ctx.root.querySelectorAll('.backend-requires-note').length, 0);
  } finally { ctx.dom.window.close(); }
});
