'use strict';
// #444/#445 — the resource rows in Settings → Backends, driven rather than grepped.
//
// Both issues are about what the user is shown, and both had a shape the suite could not see: a pill
// whose class said "coming soon" about a file that exists, and a failure written into the button that
// had just told the user what it does. So the panel is mounted in a real DOM, in project scope, and the
// rows are read back and clicked.
//
// The panel is an IIFE that exposes only `mount` — which is the seam, so the stubs below are everything
// it asks for on the way in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PANEL = path.join(__dirname, '..', 'src', 'renderer', 'panels', 'backends-panel.js');

const PROJECT_PATH = '/home/someone/projects/switchboard';

const RESOURCES = [
  { kind: 'memory', scope: 'project', name: 'CLAUDE.md', path: `${PROJECT_PATH}/CLAUDE.md`, source: 'project-instructions' },
  { kind: 'settings', scope: 'global', name: 'settings.json', path: '/home/someone/.claude/settings.json', source: 'settings-file' },
];

function setup({ openResult = { ok: true } } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;

  const openCalls = [];
  const listCalls = [];
  window.api = {
    backends: {
      list: async () => ({
        backends: [{ id: 'claude', label: 'Claude Code', status: 'ready', available: true, resourceDiscovery: true, configFields: [] }],
        defaultLaunchTarget: 'claude',
      }),
      listResources: async (backendId, projectPath) => {
        listCalls.push([backendId, projectPath]);
        return { ok: true, resources: RESOURCES };
      },
      openResource: async (backendId, resourcePath) => { openCalls.push([backendId, resourcePath]); return openResult; },
    },
    profiles: { list: async () => ({ profiles: [] }) },
  };
  window.navigator.clipboard = { writeText: async () => {} };

  vm.runInContext(fs.readFileSync(PANEL, 'utf8'), dom.getInternalVMContext(), { filename: PANEL });

  return { window, dom, openCalls, listCalls, root: window.document.getElementById('root') };
}

async function mountPanel(ctx, over = {}) {
  await ctx.window.backendsPanel.mount(ctx.root, {
    isProject: true,
    projectPath: PROJECT_PATH,
    settings: {},
    globalDefaults: {},
    fieldValue: (_id, fallback) => fallback,
    useGlobalCheckbox: () => '',
    ...over,
  });
}

/** Open every resources disclosure — since #472 that is what fetches them. */
function openResources(ctx) {
  for (const d of ctx.root.querySelectorAll('details.backend-resources')) {
    d.open = true;
    // jsdom does not always fire `toggle` from the property, and the panel's own `dataset.loaded` guard
    // makes a doubled event harmless — so this is safe whichever way jsdom behaves.
    d.dispatchEvent(new ctx.window.Event('toggle'));
  }
}

async function mountProject(ctx) {
  await mountPanel(ctx);
  openResources(ctx);
  // loadResources is fired without being awaited — the rows arrive a microtask later.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const rowFor = (ctx, name) => [...ctx.root.querySelectorAll('.backend-resource-row')]
  .find(r => r.querySelector('.settings-label')?.textContent === name);

// --- #445: the project scope is not "coming soon" ----------------------------

test('a project-scoped resource does not wear the coming-soon pill', async () => {
  const ctx = setup();
  try {
    await mountProject(ctx);
    const row = rowFor(ctx, 'CLAUDE.md');
    assert.ok(row, 'the project row was rendered');
    const scopePill = [...row.querySelectorAll('.backend-pill')].find(p => p.textContent === 'project');
    assert.ok(scopePill, 'the scope is shown');
    assert.equal(scopePill.classList.contains('soon'), false,
      'a file that exists on disk right now must not be styled as something still to come');
    assert.equal(scopePill.classList.contains('scope-project'), true, 'it has a style of its own');
  } finally { ctx.dom.window.close(); }
});

test('the project pill is visually distinct from the global one', async () => {
  const ctx = setup();
  try {
    await mountProject(ctx);
    const project = [...rowFor(ctx, 'CLAUDE.md').querySelectorAll('.backend-pill')].find(p => p.textContent === 'project');
    const global = [...rowFor(ctx, 'settings.json').querySelectorAll('.backend-pill')].find(p => p.textContent === 'global');
    assert.notDeepEqual([...project.classList], [...global.classList], 'the two scopes do not share a look');
  } finally { ctx.dom.window.close(); }
});

test('the resource section names the project it is showing', async () => {
  const ctx = setup();
  try {
    await mountProject(ctx);
    const heading = [...ctx.root.querySelectorAll('details.backend-resources > summary')]
      .map(el => el.textContent.replace(/\s+/g, ' ').trim())
      .find(t => t.includes('resources'));
    assert.ok(heading.includes('switchboard'),
      `the project has to be readable from the section itself, got: ${heading}`);
    // And the folder name alone is ambiguous, so the full path is there too.
    const hint = ctx.root.querySelector('.backend-resources-project');
    assert.ok(hint && hint.textContent.includes(PROJECT_PATH));
  } finally { ctx.dom.window.close(); }
});

// --- #472: closed, and free until it is opened --------------------------------

test('nothing is read from disk until a resources section is opened', async () => {
  const ctx = setup();
  try {
    await mountPanel(ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Rendering used to walk the filesystem once per backend for a list nobody had asked to see.
    assert.deepEqual(ctx.listCalls, [], 'a closed section costs nothing');
    assert.equal(ctx.root.querySelector('details.backend-resources').open, false, 'and it starts closed');

    openResources(ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(ctx.listCalls.length, 1, 'opening it is what fetches');
    assert.ok(rowFor(ctx, 'CLAUDE.md'), 'and the rows are there afterwards');

    // Closing and opening again must not fetch a second time.
    openResources(ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(ctx.listCalls.length, 1);
  } finally { ctx.dom.window.close(); }
});

test('a collapsed backend says whether this project overrides anything', async () => {
  const ctx = setup();
  try {
    ctx.window.api.backends.list = async () => ({
      backends: [{
        id: 'claude', label: 'Claude Code', status: 'ready', available: true, resourceDiscovery: true,
        configFields: [
          { id: 'model', label: 'Model', type: 'text', default: '' },
          { id: 'sandbox', label: 'Sandbox', type: 'text', default: '' },
        ],
      }],
      defaultLaunchTarget: 'claude',
    });
    await mountPanel(ctx, { settings: { backendDefaults: { claude: { model: 'opus' } } } });

    const summary = ctx.root.querySelector('details.backend-collapse > summary');
    assert.ok(summary, 'the launch defaults are a disclosure now');
    assert.equal(ctx.root.querySelector('details.backend-collapse').open, false, 'closed');
    // Without this, "what does this project change" means opening every section in turn.
    assert.match(summary.textContent, /1 override\b/);
  } finally { ctx.dom.window.close(); }
});

// --- #444: a failure goes into the row, not into the button -------------------

test('a failed Open shows its reason and gives the button back', async () => {
  const ctx = setup({ openResult: { ok: false, reason: 'That path is not a discovered resource for this backend.' } });
  try {
    await mountProject(ctx);
    const row = rowFor(ctx, 'CLAUDE.md');
    const button = row.querySelector('.backend-resource-open');

    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const line = row.querySelector('.backend-resource-error');
    assert.equal(line.hidden, false, 'the reason is visible');
    assert.match(line.textContent, /not a discovered resource/, 'and it is the reason the main process worded');
    assert.equal(button.textContent, 'Open', 'the control still says what it does');
  } finally { ctx.dom.window.close(); }
});

test('a successful Open leaves no failure behind, and the next attempt starts clean', async () => {
  const ctx = setup({ openResult: { ok: false, reason: 'Your system would not open that path.' } });
  try {
    await mountProject(ctx);
    const row = rowFor(ctx, 'CLAUDE.md');
    const button = row.querySelector('.backend-resource-open');
    const line = row.querySelector('.backend-resource-error');

    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(line.hidden, false);

    // The same button, this time answered. A stale message would read as a failure that just happened.
    ctx.window.api.backends.openResource = async () => ({ ok: true });
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(line.hidden, true, 'the previous failure is gone');
    assert.equal(line.textContent, '');
    assert.equal(button.textContent, 'Opened', 'and the success is what flashes on the button');
  } finally { ctx.dom.window.close(); }
});

test('a failure right after a success does not leave the button contradicting the row', async () => {
  // The flash runs for over a second. Without calling it off, a button reading "Opened" sits above a
  // line saying the open failed — and the button is the thing the eye goes to.
  const ctx = setup({ openResult: { ok: true } });
  try {
    await mountProject(ctx);
    const row = rowFor(ctx, 'CLAUDE.md');
    const button = row.querySelector('.backend-resource-open');

    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(button.textContent, 'Opened');

    ctx.window.api.backends.openResource = async () => ({ ok: false, reason: 'It is no longer there.' });
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(button.textContent, 'Open', 'the flash was called off, not left to run out');
    assert.equal(row.querySelector('.backend-resource-error').hidden, false);
  } finally { ctx.dom.window.close(); }
});

test('a run of successes never records a flashed label as the real one', async () => {
  const ctx = setup({ openResult: { ok: true } });
  try {
    await mountProject(ctx);
    const button = rowFor(ctx, 'CLAUDE.md').querySelector('.backend-resource-open');

    for (let i = 0; i < 3; i++) {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(button.textContent, 'Opened');
    }

    // Let the last flash run out on its own rather than being replaced.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal(button.textContent, 'Open', 'the button came back to its own label, not to "Opened"');
  } finally { ctx.dom.window.close(); }
});

test('a row with no path carries no error line to fill', async () => {
  const ctx = setup();
  try {
    // A configured resource the backend knows by name only — it gets no buttons, so nothing can ever
    // write into an error line, and shipping one would be markup that cannot be reached.
    ctx.window.api.backends.listResources = async () => ({
      ok: true, resources: [{ kind: 'skill', scope: 'global', name: 'named-only', path: null, source: 'settings.json:skills' }],
    });
    await mountProject(ctx);
    const row = rowFor(ctx, 'named-only');
    assert.ok(row);
    assert.equal(row.querySelector('.backend-resource-open'), null);
    assert.equal(row.querySelector('.backend-resource-error'), null);
  } finally { ctx.dom.window.close(); }
});

test('the reason a failure carries is never a raw filesystem error', async () => {
  // The pairing that makes #444 whole: the main process refuses to word an error with a path in it
  // (backend-resources.test.js), and the renderer shows whatever it was given. So what is asserted here
  // is that the renderer does not invent one of its own when the call itself blows up.
  const ctx = setup();
  try {
    await mountProject(ctx);
    const row = rowFor(ctx, 'CLAUDE.md');
    ctx.window.api.backends.openResource = async () => { throw new Error(`EACCES: permission denied, open '${PROJECT_PATH}/CLAUDE.md'`); };

    row.querySelector('.backend-resource-open').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const line = row.querySelector('.backend-resource-error');
    assert.equal(line.hidden, false);
    assert.ok(!line.textContent.includes('EACCES'), 'a thrown IPC error is not a message for the user');
    assert.ok(!line.textContent.includes(PROJECT_PATH));
  } finally { ctx.dom.window.close(); }
});
