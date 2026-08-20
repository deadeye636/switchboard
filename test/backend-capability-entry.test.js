'use strict';
// #446 — the ways INTO the capability matrix, driven rather than grepped.
//
// The matrix itself (#439) has had a test since it shipped; what it did not have was a test that anyone
// can reach it. It hung off the header of the GLOBAL Backends page alone — not on a single backend's own
// page, which is where someone is already asking what that backend can do.
//
// The project scope is a deliberate NO, and it is asserted here as one: what a backend can do does not
// vary per project, so the answer stays in global settings beside the other global backend controls.
// Without that assertion the branch would be untested either way, which is how it drifts back.
//
// The panel is mounted in a real DOM in each branch, the button is clicked, and what the overlay is
// handed is read back. `openBackendCapabilityMatrix` is stubbed: the overlay's own drawing belongs to
// backend-capabilities.test.js — what is under test here is the way in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PANEL = path.join(__dirname, '..', 'src', 'renderer', 'panels', 'backends-panel.js');

const PROJECT_PATH = '/home/someone/projects/switchboard';

const BACKENDS = [
  { id: 'claude', label: 'Claude Code', status: 'ready', available: true, enabled: true, configFields: [], capabilities: { fork: { state: 'yes' } } },
  { id: 'hermes', label: 'Hermes', status: 'ready', available: true, enabled: true, configFields: [], capabilities: { fork: { state: 'no' } } },
];

const CATALOG = {
  groups: [{ id: 'sessions', label: 'Sessions' }],
  rows: [{ id: 'fork', group: 'sessions', label: 'Fork a session' }],
};

function setup() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;

  window.api = {
    backends: {
      list: async () => ({ backends: BACKENDS, defaultLaunchTarget: 'claude', capabilityCatalog: CATALOG }),
      listResources: async () => ({ ok: true, resources: [] }),
    },
    profiles: { list: async () => ({ profiles: [] }) },
  };
  window.BACKEND_PRESETS = [];

  // The seam under test: what the button hands over.
  const opened = [];
  window.openBackendCapabilityMatrix = (payload) => { opened.push(payload); };

  vm.runInContext(fs.readFileSync(PANEL, 'utf8'), dom.getInternalVMContext(), { filename: PANEL });

  const root = window.document.getElementById('root');
  const mount = (extra) => window.backendsPanel.mount(root, {
    settings: {},
    globalDefaults: {},
    fieldValue: (_id, fallback) => fallback,
    useGlobalCheckbox: () => '',
    ...extra,
  });

  return { window, dom, root, opened, mount };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const matrixButton = (ctx) => ctx.root.querySelector('#sv-capability-matrix');

test('the global Backends page offers the matrix', async () => {
  const ctx = setup();
  try {
    await ctx.mount();
    const btn = matrixButton(ctx);
    assert.ok(btn, 'the button is on the global page');
    assert.equal(btn.classList.contains('backend-btn'), true, 'and it wears the panel\'s button style');
  } finally { ctx.dom.window.close(); }
});

test('the PROJECT scope deliberately does NOT offer it', async () => {
  // Owner's call. What a backend can do is the same in every project, so the table does not belong
  // beside per-project launch options — a project scope reaches it through global settings, the same
  // way it reaches enabling a backend and the default launch target, which are global too.
  const ctx = setup();
  try {
    await ctx.mount({ isProject: true, projectPath: PROJECT_PATH });
    assert.equal(matrixButton(ctx), null, 'the project scope stays about this project');
  } finally { ctx.dom.window.close(); }
});

test("a single backend's page offers it, where someone is already asking about one backend", async () => {
  const ctx = setup();
  try {
    await ctx.mount();
    ctx.root.querySelector('.backend-gear[data-id="hermes"]').click();
    await settle();
    assert.ok(ctx.root.querySelector('.backend-page'), 'the gear opened the backend page');
    assert.ok(matrixButton(ctx), 'and the matrix is reachable from it');
  } finally { ctx.dom.window.close(); }
});

test('the click hands over the backends AND the catalog', async () => {
  const ctx = setup();
  try {
    await ctx.mount();
    matrixButton(ctx).click();
    assert.equal(ctx.opened.length, 1, 'one open per click');
    const payload = ctx.opened[0];
    assert.deepEqual(payload.catalog, CATALOG, 'the rows and their labels come from main, not from here');
    assert.deepEqual(payload.backends.map(b => b.id), ['claude', 'hermes'], 'every backend is a column');
  } finally { ctx.dom.window.close(); }
});

test('the per-backend page opens the FULL matrix, not just that backend', async () => {
  // Deliberate: the question on a single backend's page is "can this one do X", and the neighbouring
  // column is the answer. Filtering would answer the narrower question with less information.
  const ctx = setup();
  try {
    await ctx.mount();
    ctx.root.querySelector('.backend-gear[data-id="hermes"]').click();
    await settle();
    matrixButton(ctx).click();
    assert.deepEqual(ctx.opened[0].backends.map(b => b.id), ['claude', 'hermes']);
  } finally { ctx.dom.window.close(); }
});

test('a missing overlay is a no-op, not a thrown row', async () => {
  // index.html and settings.html both load backend-capabilities.js before this panel, so the function is
  // there — but the panel must not be the thing that breaks if a page ever loads without it.
  const ctx = setup();
  try {
    delete ctx.window.openBackendCapabilityMatrix;
    await ctx.mount();
    assert.doesNotThrow(() => matrixButton(ctx).click());
  } finally { ctx.dom.window.close(); }
});
