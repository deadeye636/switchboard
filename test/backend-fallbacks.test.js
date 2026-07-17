'use strict';
// #212 — "With Claude disabled, the launch popover, the default-target select and the profile editor all
// resolve to a launchable backend."
//
// The panel used to answer `|| 'claude'` whenever nobody had named a backend. That is a guess, and since
// #162 it is a wrong one: Claude can be switched off, and a default that names a disabled backend is a
// spawn that gets refused. Every such site now resolves to the first LAUNCHABLE backend, or to '' when
// there is none — every backend can be disabled (§5.8), and '' is the honest answer.
//
// Why this file exists at all: while making that change I moved the resolver into `mount()`, where
// `readGlobal` — which runs at SAVE time, from module scope — could not see it. The whole suite stayed
// green, because `||` short-circuits: every existing test mounts with a backend enabled, so the select
// has a value and the resolver is never reached. The ReferenceError sat in the one path #212 is about.
// So the fallback needs a test that actually takes the fallback.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC_DIR = path.join(__dirname, '..', 'src');

const backend = (id, label, enabled) => ({
  id, label, status: 'ready', isProfile: false, enabled,
  colour: id, monogram: id.slice(0, 1).toUpperCase(), configFields: [],
});

/** Mount the global panel over a given backend list. `defaultLaunchTarget` is what the registry reports. */
async function mountWith(backends, defaultLaunchTarget) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>', {
    url: 'http://localhost/', runScripts: 'outside-only',
  });
  const { window } = dom;

  Object.defineProperty(window, 'api', {
    value: {
      backends: { list: async () => ({ backends, defaultLaunchTarget }) },
      profiles: { list: async () => ({ profiles: [] }) },
      checkEnvRefs: async () => ({}),
    },
    writable: true, configurable: true,
  });
  Object.defineProperty(window, 'renderBackendIcon', {
    value: () => window.document.createElement('span'), writable: true, configurable: true,
  });
  Object.defineProperty(window, 'CSS', {
    value: { escape: (s) => String(s).replace(/([^\w-])/g, '\\$1') },
    writable: true, configurable: true,
  });

  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, 'renderer', 'panels', 'backends-panel.js'), 'utf8'),
    dom.getInternalVMContext(), { filename: 'backends-panel.js' });

  const root = window.document.getElementById('root');
  const settings = {};
  await window.backendsPanel.mount(root, {
    isProject: false,
    settings,
    fieldValue: (key, fallback) => (settings[key] !== undefined ? settings[key] : fallback),
  });
  return { window, root };
}

const CLAUDE = (on) => backend('claude', 'Claude Code', on);
const CODEX = (on) => backend('codex', 'Codex', on);

test('with Claude disabled, the default target resolves to a LAUNCHABLE backend', async () => {
  // The registry still reports claude as the stored default — it is what the user picked before they
  // switched it off. The panel must not carry that into the select, nor into the next save.
  const { window, root } = await mountWith([CLAUDE(false), CODEX(true)], 'claude');

  const select = root.querySelector('#sv-default-launch-target');
  assert.deepEqual([...select.options].map(o => o.value), ['codex'],
    'a disabled backend is not offered as a launch target');
  assert.equal(select.value, 'codex', 'the select lands on the launchable backend, not the disabled default');

  assert.equal(window.backendsPanel.readGlobal(root).defaultLaunchTarget, 'codex',
    'a save must not write a default that names a backend the user has switched off');
});

test('with every backend disabled, the default target is empty — not a backend that cannot start', async () => {
  const { window, root } = await mountWith([CLAUDE(false), CODEX(false)], 'claude');

  const warn = root.querySelector('#sv-no-backend-warning');
  assert.equal(warn.hidden, false, 'the panel says nothing can be launched');

  // The path that mattered: with no select value and no live target, the resolver is finally REACHED.
  // It used to be `|| 'claude'`, which wrote a backend that cannot spawn; then briefly a ReferenceError,
  // which the whole suite missed because every other test has a backend enabled and never gets here.
  const saved = window.backendsPanel.readGlobal(root);
  assert.equal(saved.defaultLaunchTarget, '',
    'with nothing launchable the honest answer is "none" — naming a disabled backend is what #212 removed');
});

test('the resolver follows the checkbox, not the stored state — an unsaved toggle counts', async () => {
  const { window, root } = await mountWith([CLAUDE(true), CODEX(true)], 'claude');
  assert.equal(window.backendsPanel.readGlobal(root).defaultLaunchTarget, 'claude');

  // Switch Claude off in the list without saving, exactly as a user would before pressing Save once.
  const cb = root.querySelector('.backend-enable[data-id="claude"]');
  cb.checked = false;
  cb.dispatchEvent(new window.Event('change', { bubbles: true }));

  const select = root.querySelector('#sv-default-launch-target');
  assert.equal(select.value, 'codex', 'the select rebuilt onto the backend that can still launch');
  assert.equal(window.backendsPanel.readGlobal(root).defaultLaunchTarget, 'codex',
    'the save that follows must carry what the list SHOWS, not what was stored before the toggle');
});
