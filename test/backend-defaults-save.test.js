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

// `enabled` is what backends.list() reports — the panel reads it, and since #162 nothing forces
// Claude's toggle on any more, so the stub has to be honest about it.
const CODEX = {
  id: 'codex', label: 'Codex', status: 'ready', axis: 'B', isProfile: false, enabled: false,
  colour: 'codex', monogram: 'X',
  configFields: [
    { id: 'model', label: 'Model', type: 'text', default: '' },
    { id: 'sandbox', label: 'Sandbox', type: 'select', choices: ['read-only', 'workspace-write'], default: 'workspace-write' },
    { id: 'verbose', label: 'Verbose', type: 'toggle', default: true },
  ],
};
const CLAUDE = {
  id: 'claude', label: 'Claude Code', status: 'ready', axis: null, isProfile: false, enabled: true,
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

// --- templates are STAGED, like everything else on this screen -------------------------------------
//
// The editor used to write straight to the profiles store, and Delete removed a template there and then.
// So one settings screen had two save buttons that meant different things: "Save template" was final,
// while "Save Settings" ten pixels below it was what saved everything else — and Cancel undid one and not
// the other. Now both paths stage, and only Save Settings commits.

async function mountWithProfiles(storedProfiles) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>', {
    url: 'http://localhost/', runScripts: 'outside-only',
  });
  const { window } = dom;
  const calls = { saved: [], deleted: [] };

  Object.defineProperty(window, 'api', {
    value: {
      backends: { list: async () => ({ backends: [CLAUDE, CODEX], defaultLaunchTarget: 'claude' }) },
      profiles: {
        list: async () => ({ profiles: storedProfiles }),
        save: async (p, allowSecrets) => { calls.saved.push({ p, allowSecrets }); return { ok: true }; },
        delete: async (id) => { calls.deleted.push(id); return { ok: true }; },
        validate: async (p) => ({ ok: true, profile: p }),
        setDefault: async () => ({ ok: true }),
      },
      checkEnvRefs: async () => ({}),
    },
    writable: true, configurable: true,
  });
  Object.defineProperty(window, 'renderBackendIcon', {
    value: () => window.document.createElement('span'), writable: true, configurable: true,
  });
  Object.defineProperty(window, 'CSS', {
    value: { escape: (s) => String(s).replace(/([^\w-])/g, '\$1') }, writable: true, configurable: true,
  });
  // The panel's confirmDialog() delegates to showControlDialog() and otherwise falls back to
  // window.confirm, which jsdom does not implement. Stub the real seam.
  Object.defineProperty(window, 'showControlDialog', {
    value: async () => true, writable: true, configurable: true,   // the user always says yes here
  });

  vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, 'backends-panel.js'), 'utf8'),
    dom.getInternalVMContext(), { filename: 'backends-panel.js' });

  const root = window.document.getElementById('root');
  const settings = {};
  await window.backendsPanel.mount(root, {
    isProject: false, settings, fieldValue: (k, f) => (settings[k] !== undefined ? settings[k] : f),
  });
  return { window, root, calls };
}

const DS = { id: 'ds', name: 'DeepSeek', backendId: 'claude', icon: 'deepseek', options: {}, env: {} };

// The click handler confirms, then re-mounts — and mount() awaits two IPC calls. Give the whole chain a
// few turns of the loop rather than guessing at one.
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); };

test('deleting a template writes NOTHING until the settings are saved', async () => {
  const { window, root, calls } = await mountWithProfiles([DS]);

  root.querySelector('.backend-row [data-act="delete"][data-id="ds"]').click();
  await settle();

  assert.deepEqual(calls.deleted, [], 'nothing has left the disk yet');
  assert.equal(root.querySelector('[data-profile-row="ds"]'), null, 'but it is gone from the list');

  await window.backendsPanel.commitTemplates();
  assert.deepEqual(calls.deleted, ['ds'], 'the delete happens when Save Settings says so');
});

test('closing the settings without saving discards a staged delete', async () => {
  const { window, root, calls } = await mountWithProfiles([DS]);

  root.querySelector('.backend-row [data-act="delete"][data-id="ds"]').click();
  await settle();

  // A fresh mount without keepPending is what happens when Settings is closed and re-opened.
  const settings = {};
  await window.backendsPanel.mount(root, {
    isProject: false, settings, fieldValue: (k, f) => (settings[k] !== undefined ? settings[k] : f),
  });

  assert.ok(root.querySelector('[data-profile-row="ds"]'), 'the template is back — Cancel really cancelled');
  assert.deepEqual(calls.deleted, [], 'and it was never deleted');
});

test('commitTemplates deletes BEFORE it saves', async () => {
  // A rename frees an id and a new template may claim it. If the save ran first, the delete would then
  // remove the row that had just been written.
  const { window, calls } = await mountWithProfiles([DS]);
  const order = [];
  window.api.profiles.delete = async (id) => { order.push('delete:' + id); return { ok: true }; };
  window.api.profiles.save = async (p) => { order.push('save:' + p.id); return { ok: true }; };

  // Stage both by hand — the UI paths are covered above; this is about the ORDER.
  await window.backendsPanel.mount(window.document.getElementById('root'), {
    isProject: false, settings: {}, fieldValue: (_k, f) => f,
  });
  const root = window.document.getElementById('root');
  root.querySelector('.backend-row [data-act="delete"][data-id="ds"]').click();
  await settle();
  await window.backendsPanel.commitTemplates();

  assert.deepEqual(order, ['delete:ds']);
});

test('a template that could not be saved is REPORTED, not swallowed', async () => {
  const { window, calls } = await mountWithProfiles([DS]);
  window.api.profiles.delete = async () => ({ ok: false, error: 'file is read-only' });

  const root = window.document.getElementById('root');
  root.querySelector('.backend-row [data-act="delete"][data-id="ds"]').click();
  await settle();

  const res = await window.backendsPanel.commitTemplates();
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /read-only/,
    'a template the user believes they saved and that never reached the disk is the worst outcome');
});

// Create a template and delete it again, both before saving: the two stagings cancel out. Asking the
// store to remove a record it never got would report "not found" about a thing the user never created —
// a true statement about the store, and nonsense to the person reading it.
test('creating and then deleting a template before saving is a no-op, not an error', async () => {
  const { window, root, calls } = await mountWithProfiles([]);

  // Create one through the real dialog — no test-only seam.
  root.querySelector('.backend-chip-blank').click();
  await settle();
  const dialog = window.document.querySelector('.backend-editor');
  assert.ok(dialog, 'the editor opened');
  dialog.querySelector('#be-name').value = 'Fresh';
  dialog.querySelector('#be-save').click();
  await settle();

  const row = root.querySelector('.backend-row [data-act="delete"]');
  assert.ok(row, 'the staged template is shown, marked as unsaved');
  const id = row.dataset.id;

  row.click();
  await settle();
  assert.equal(root.querySelector(`[data-profile-row="${id}"]`), null, 'and it is gone again');

  const res = await window.backendsPanel.commitTemplates();
  assert.equal(res.ok, true, 'nothing to report — nothing happened');
  assert.deepEqual(calls.deleted, [], 'the store was never asked to remove a record it never had');
  assert.deepEqual(calls.saved, [], 'and never asked to write one either');
});

test('deleting a STORED template still reaches the store', async () => {
  const { window, root, calls } = await mountWithProfiles([DS]);
  root.querySelector('.backend-row [data-act="delete"][data-id="ds"]').click();
  await settle();
  await window.backendsPanel.commitTemplates();
  assert.deepEqual(calls.deleted, ['ds'], 'the cancel-out must not swallow a real delete');
});
