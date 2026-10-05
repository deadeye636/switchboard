'use strict';
// The Version control settings with no subagent-capable backend (#745).
//
// WHY THIS EXISTS:
//   The Version control subsection was drawn inside the Subagents conditional, so a setup whose launchable
//   backends support no subagents had no VCS fields at all. Save read the missing checkboxes as unchecked
//   and wrote vcsChipEnabled, vcsShowBadge and vcsCountUntracked as false: saving any unrelated setting
//   switched the VCS display off. This loads the panel the way settings.html does (the same harness as
//   settings-project-action-close.test.js), with a backend set that has no subagent support, and presses
//   the real Save button.

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

const STORED = { vcsChipEnabled: true, vcsShowBadge: true, vcsCountUntracked: true, vcsPollSeconds: 45 };

function makeApi(record) {
  const anyCall = () => new Proxy(function () {}, {
    get: (t, p) => (p === 'then' ? undefined : anyCall()),
    apply: () => Promise.resolve({ ok: true }),
  });
  const target = {
    platform: 'linux',
    getSetting: async (key) => (key === 'global' ? { ...STORED } : {}),
    setSetting: async (key, value) => { record.saved.push({ key, value }); return { ok: true }; },
    getShellProfiles: async () => [],
    projectTagsGet: async () => [],
    projectTagsListAll: async () => [],
    tagDefsList: async () => ({ ok: true, tags: [] }),
    getAboutInfo: async () => ({}),
    backends: { list: async () => [] },
    profiles: { list: async () => ({ profiles: [] }), setDefault: async () => ({ ok: true }) },
    hideSettingsWindow: () => {},
  };
  return new Proxy(target, {
    get: (t, p) => (p in t ? t[p] : (p === 'then' ? undefined : anyCall())),
  });
}

async function openGlobalSettings() {
  const record = { saved: [] };
  const dom = new JSDOM(DOM_FIXTURE, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.api = makeApi(record);
  window.bookmarksTags = { pickColor: () => '#61afef', palette: ['#e06c75', '#98c379'] };
  // A Codex- or Hermes-only setup: backends are known, and none of them supports subagents.
  window.launchableBackends = () => [{ id: 'other', supportsSubagents: false }];
  const ctx = dom.getInternalVMContext();
  for (const rel of settingsScripts()) {
    vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  }
  await window.openSettingsViewer('global');
  const $ = (sel) => window.document.querySelector(sel);
  const save = async () => {
    $('#sv-save-btn').click();
    for (let i = 0; i < 50 && record.saved.length === 0; i++) await new Promise(r => setTimeout(r, 10));
    const global = record.saved.find(s => s.key === 'global');
    assert.ok(global, 'Save wrote the global blob');
    return global.value;
  };
  return { window, $, save, destroy: () => window.close() };
}

test('#745: the Version control fields are drawn without a subagent-capable backend', async () => {
  const h = await openGlobalSettings();
  try {
    assert.equal(h.$('#sv-show-subagents'), null, 'the Subagents section is still gated');
    for (const id of ['#sv-vcs-enabled', '#sv-vcs-badge', '#sv-vcs-poll', '#sv-vcs-count-untracked']) {
      assert.ok(h.$(id), `${id} is on screen`);
    }
  } finally { h.destroy(); }
});

test('#745: saving an unrelated change keeps the stored version-control values', async () => {
  const h = await openGlobalSettings();
  try {
    const saved = await h.save();
    assert.equal(saved.vcsChipEnabled, true);
    assert.equal(saved.vcsShowBadge, true);
    assert.equal(saved.vcsCountUntracked, true);
    assert.equal(saved.vcsPollSeconds, 45);
  } finally { h.destroy(); }
});

test('#745: a version-control field that is not on screen keeps its stored value on Save', async () => {
  const h = await openGlobalSettings();
  try {
    for (const id of ['#sv-vcs-enabled', '#sv-vcs-badge', '#sv-vcs-poll', '#sv-vcs-count-untracked']) h.$(id).remove();
    const saved = await h.save();
    assert.equal(saved.vcsChipEnabled, true, 'not written off');
    assert.equal(saved.vcsShowBadge, true, 'not written off');
    assert.equal(saved.vcsCountUntracked, true, 'not written off');
    assert.equal(saved.vcsPollSeconds, 45, 'not reset to the default');
  } finally { h.destroy(); }
});
