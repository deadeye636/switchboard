'use strict';
// #163 — the GLOBAL backend-defaults page must store only what the user actually decided.
//
// It used to write every option on whichever backend page happened to be open. So the first Save pinned
// that backend's ENTIRE option set into the user's settings — including options they never touched — and
// a better default shipped later could never reach them again. Nothing said so, because the frozen value
// still looked right: that day, it WAS the default.
//
// The project scope has had the per-option marker since #149 and its own test. This is the same rule one
// level up, and this file is the save half of it (test/settings-cascade.test.js is the read half).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const CODEX = {
  id: 'codex', label: 'Codex', status: 'ready', axis: 'B', isProfile: false,
  colour: 'codex', monogram: 'X',
  configFields: [
    { id: 'model', label: 'Model', type: 'text', default: '' },
    { id: 'sandbox', label: 'Sandbox', type: 'select', choices: ['read-only', 'workspace-write'], default: 'workspace-write' },
    { id: 'verbose', label: 'Verbose', type: 'toggle', default: true },
  ],
};
const CLAUDE = {
  id: 'claude', label: 'Claude Code', status: 'ready', axis: null, isProfile: false,
  colour: 'claude', monogram: 'C',
  configFields: [{ id: 'model', label: 'Model', type: 'text', default: '' }],
};

/** Mount the panel in the GLOBAL scope with `stored` as the saved backendDefaults blob. */
async function mountGlobal(stored) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>', {
    url: 'http://localhost/', runScripts: 'outside-only',
  });
  const { window } = dom;

  Object.defineProperty(window, 'api', {
    value: {
      backends: { list: async () => ({ backends: [CLAUDE, CODEX], defaultLaunchTarget: 'claude' }) },
      profiles: { list: async () => ({ profiles: [] }) },
      checkEnvRefs: async () => ({}),
    },
    writable: true, configurable: true,
  });
  Object.defineProperty(window, 'renderBackendIcon', {
    value: () => window.document.createElement('span'), writable: true, configurable: true,
  });
  // jsdom does not expose CSS.escape inside the vm context; the panel uses it to build selectors.
  Object.defineProperty(window, 'CSS', {
    value: { escape: (s) => String(s).replace(/([^\w-])/g, '\\$1') },
    writable: true, configurable: true,
  });

  vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, 'backends-panel.js'), 'utf8'),
    dom.getInternalVMContext(), { filename: 'backends-panel.js' });

  const root = window.document.getElementById('root');
  const settings = { backendDefaults: stored };
  await window.backendsPanel.mount(root, {
    isProject: false,
    settings,
    fieldValue: (key, fallback) => (settings[key] !== undefined ? settings[key] : fallback),
  });
  return { window, root };
}

/** Open one backend's gear page (that is where its launch defaults live in the global scope). */
function openPage(window, root, backendId) {
  const gear = root.querySelector(`.backend-gear[data-id="${backendId}"]`);
  assert.ok(gear, `the ${backendId} row has a gear`);
  gear.click();
  const page = root.querySelector(`[data-backend-page="${backendId}"]`);
  assert.ok(page, `the ${backendId} page opened`);
  return page;
}

const cbFor = (page, opt) => page.querySelector(`.backend-inherit-cb[data-opt="${opt}"]`);
const inputFor = (page, opt) => page.querySelector(`.backend-default-input[data-opt="${opt}"]`);

function fire(el, type) {
  el.dispatchEvent(new el.ownerDocument.defaultView.Event(type, { bubbles: true }));
}

// The panel builds its objects inside the jsdom realm, so their prototypes are not this realm's —
// deepStrictEqual would fail on two structurally identical objects. Compare the values, not the realm.
const plain = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** What a Save would write for the backend defaults. */
const savedDefaults = (window, root) => plain(window.backendsPanel.readGlobal(root)).backendDefaults;

test('an untouched backend page saves NOTHING — the shipped defaults are not pinned', async () => {
  const { window, root } = await mountGlobal({});
  openPage(window, root, 'codex');

  const saved = plain(window.backendsPanel.readGlobal(root));
  assert.deepEqual(saved && saved.backendDefaults, {},
    'opening a page and saving must not write the defaults the user never touched — that is what froze them');
});

test('every option starts on "use the backend\'s default", and its control is inert', async () => {
  const { window, root } = await mountGlobal({});
  const page = openPage(window, root, 'codex');

  for (const opt of ['model', 'sandbox', 'verbose']) {
    assert.equal(cbFor(page, opt).checked, true, `${opt} follows the backend default`);
    assert.equal(inputFor(page, opt).disabled, true, `${opt}'s control is disabled while it does`);
  }
});

test('un-ticking an option stores it — and only it', async () => {
  const { window, root } = await mountGlobal({});
  const page = openPage(window, root, 'codex');

  const cb = cbFor(page, 'sandbox');
  cb.checked = false;
  fire(cb, 'change');

  const input = inputFor(page, 'sandbox');
  assert.equal(input.disabled, false, 'the control comes alive');
  input.value = 'read-only';
  fire(input, 'change');

  const saved = savedDefaults(window, root);
  assert.deepEqual(saved, { codex: { sandbox: 'read-only' } },
    'only the option the user actually decided is stored');
});

// The whole reason the marker has to exist: an option whose default is ON can only be switched off by
// STORING the false. A dropped false is indistinguishable from "not set", and the default comes back.
test('a `false` is a value: an ON-by-default option can be switched off and stays off', async () => {
  const { window, root } = await mountGlobal({});
  const page = openPage(window, root, 'codex');

  const cb = cbFor(page, 'verbose');
  cb.checked = false;
  fire(cb, 'change');

  const toggle = inputFor(page, 'verbose');
  assert.equal(toggle.checked, true, 'it starts at the ON default');
  toggle.checked = false;
  fire(toggle, 'change');

  const saved = savedDefaults(window, root);
  assert.deepEqual(saved, { codex: { verbose: false } }, 'the false is STORED, not dropped');
});

test('an empty string is a value too — "explicitly no model" is storable', async () => {
  const { window, root } = await mountGlobal({ codex: { model: 'gpt-5.5' } });
  const page = openPage(window, root, 'codex');

  const input = inputFor(page, 'model');
  assert.equal(cbFor(page, 'model').checked, false, 'a stored option shows as set');
  input.value = '';
  fire(input, 'input');

  const saved = savedDefaults(window, root);
  assert.deepEqual(saved, { codex: { model: '' } });
});

test('re-ticking the box hands the option back — it is REMOVED, not blanked', async () => {
  const { window, root } = await mountGlobal({ codex: { model: 'gpt-5.5', sandbox: 'read-only' } });
  const page = openPage(window, root, 'codex');

  const cb = cbFor(page, 'sandbox');
  assert.equal(cb.checked, false, 'a stored option starts as "set"');
  cb.checked = true;
  fire(cb, 'change');

  const saved = savedDefaults(window, root);
  assert.deepEqual(saved, { codex: { model: 'gpt-5.5' } },
    'sandbox is gone from the blob entirely — so it follows the backend default again, now and later');
});

// The DOM only ever holds ONE backend's page. Reading it alone would drop every other backend the user
// did not happen to open — the quiet data loss a settings screen must never commit.
test('editing one backend does not wipe another backend it never opened', async () => {
  const { window, root } = await mountGlobal({ claude: { model: 'opus' }, codex: { model: 'gpt-5.5' } });
  const page = openPage(window, root, 'codex');

  const input = inputFor(page, 'model');
  input.value = 'gpt-5.5-mini';
  fire(input, 'input');

  const saved = savedDefaults(window, root);
  assert.equal(saved.claude.model, 'opus', "Claude's stored default survives being off-screen");
  assert.equal(saved.codex.model, 'gpt-5.5-mini');
});

test('values already on disk are left in force — nobody loses a setting to this change', async () => {
  const { window, root } = await mountGlobal({ codex: { model: 'gpt-5.5', sandbox: 'read-only', verbose: false } });
  openPage(window, root, 'codex');

  const saved = savedDefaults(window, root);
  assert.deepEqual(saved, { codex: { model: 'gpt-5.5', sandbox: 'read-only', verbose: false } },
    'an existing blob is indistinguishable from deliberate choices — dropping it would be worse');
});

// Opening a backend's gear page REPLACES the list — select, enable toggles and all. The save used to
// look for that select in the DOM to decide whether the section had been mounted, found nothing, and
// returned null. settings-panel.js then skipped EVERY backend key. So: open the gear, change an option,
// press Save, and your change was gone — unless you happened to click "Backends" first.
test('saving while a backend page is open keeps the edit (it used to be discarded)', async () => {
  const { window, root } = await mountGlobal({});
  const page = openPage(window, root, 'codex');

  const cb = cbFor(page, 'model');
  cb.checked = false;
  fire(cb, 'change');
  const input = inputFor(page, 'model');
  input.value = 'gpt-5.5-mini';
  fire(input, 'input');

  // No "Back" click — straight to Save, exactly as a user would.
  const saved = plain(window.backendsPanel.readGlobal(root));
  assert.ok(saved, 'the save must not decide the section was never mounted just because a page is open');
  assert.deepEqual(saved.backendDefaults, { codex: { model: 'gpt-5.5-mini' } });
  // ...and the list-level values it can no longer see in the DOM survive too.
  assert.equal(saved.defaultLaunchTarget, 'claude');
  assert.deepEqual(saved.backendEnabled, { claude: true, codex: false },
    'the enable flags the list last showed are not lost while a page is open');
});

test('readGlobal still returns null when the Backends section was never opened', async () => {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>', { url: 'http://localhost/' });
  // A fresh panel that was never mounted must not hand the save an empty object to write.
  const { window } = await mountGlobal({});
  await window.backendsPanel.mount(window.document.getElementById('root'), {
    isProject: true, settings: {}, fieldValue: (_k, f) => f, globalDefaults: {},
  });
  assert.equal(window.backendsPanel.readGlobal(dom.window.document.getElementById('root')), null);
});
