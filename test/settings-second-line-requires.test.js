'use strict';
// "Show branch & change counts" needs "Show second line" (#742).
//
// WHY THIS EXISTS:
//   The badge is drawn in the project second line, so its switch means nothing while the line is off. The
//   settings screen greys the field out, disables the checkbox and shows a hint, and follows the second-line
//   toggle live. All of that happens at render time and inside a `change` handler, which the load-time smoke
//   test cannot see. This loads the panel the way settings.html does (the same harness as
//   settings-project-action-close.test.js), opens the GLOBAL scope and flips the real toggle.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { pageScripts } = require('./helpers/page-scripts');

const REN = path.join(__dirname, '..', 'src', 'renderer');

function settingsScripts() {
  const srcs = pageScripts('settings.html');
  assert.ok(srcs.length > 5, 'settings.html script list not found — did the page change shape?');
  return srcs.filter(s => !s.endsWith('settings-window.js'));
}

const DOM_FIXTURE = `<!DOCTYPE html><html><body>
  <div id="settings-viewer" style="display:none;">
    <div id="settings-viewer-header"><span id="settings-viewer-title">Settings</span></div>
    <div id="settings-viewer-body"></div>
  </div>
</body></html>`;

function makeApi(stored) {
  const anyCall = () => new Proxy(function () {}, {
    get: (t, p) => (p === 'then' ? undefined : anyCall()),
    apply: () => Promise.resolve({ ok: true }),
  });
  const target = {
    platform: 'linux',
    getSetting: async (key) => (key === 'global' ? stored : {}),
    setSetting: async () => ({ ok: true }),
    getShellProfiles: async () => [],
    projectTagsGet: async () => [],
    projectTagsListAll: async () => [],
    // The global scope draws the Tags section, which lists the definitions after the render.
    tagDefsList: async () => ({ ok: true, tags: [] }),
    getAboutInfo: async () => ({}),
    backends: { list: async () => [] },
    profiles: { list: async () => [] },
  };
  return new Proxy(target, {
    get: (t, p) => (p in t ? t[p] : (p === 'then' ? undefined : anyCall())),
  });
}

async function openGlobalSettings(stored) {
  const dom = new JSDOM(DOM_FIXTURE, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.api = makeApi(stored);
  window.bookmarksTags = { pickColor: () => '#61afef', palette: ['#e06c75', '#98c379'] };
  const ctx = dom.getInternalVMContext();
  for (const rel of settingsScripts()) {
    vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  }
  await window.openSettingsViewer('global');
  const $ = (sel) => window.document.querySelector(sel);
  const state = () => ({
    inactive: $('#sv-vcs-badge-field').classList.contains('settings-field-inactive'),
    disabled: $('#sv-vcs-badge').disabled,
    hintHidden: $('#sv-vcs-badge-requires').hidden,
    checked: $('#sv-vcs-badge').checked,
  });
  const toggleSecondLine = (on) => {
    const cb = $('#sv-sidebar-second-line');
    cb.checked = on;
    cb.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  return { state, toggleSecondLine, destroy: () => window.close() };
}

test('#742: with the second line off the badge switch is greyed, disabled and says why — stored value kept', async () => {
  const h = await openGlobalSettings({ sidebarProjectSecondLine: false, vcsShowBadge: true });
  try {
    assert.deepEqual(h.state(), { inactive: true, disabled: true, hintHidden: false, checked: true });
  } finally { h.destroy(); }
});

test('#742: with the second line on the badge switch is a normal control', async () => {
  const h = await openGlobalSettings({ sidebarProjectSecondLine: true, vcsShowBadge: false });
  try {
    assert.deepEqual(h.state(), { inactive: false, disabled: false, hintHidden: true, checked: false });
  } finally { h.destroy(); }
});

test('#742: the badge switch follows the second-line toggle live, both ways', async () => {
  const h = await openGlobalSettings({ sidebarProjectSecondLine: false, vcsShowBadge: true });
  try {
    h.toggleSecondLine(true);
    assert.deepEqual(h.state(), { inactive: false, disabled: false, hintHidden: true, checked: true });
    h.toggleSecondLine(false);
    assert.deepEqual(h.state(), { inactive: true, disabled: true, hintHidden: false, checked: true });
  } finally { h.destroy(); }
});
