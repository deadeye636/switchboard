'use strict';
// Where the project settings screen goes after Hide Project / Remove Project (#565).
//
// WHY THIS EXISTS:
//   `closeAfterProjectAction` hid `#settings-viewer` and then showed `#placeholder`. Both halves were
//   written for the in-app overlay. The overlay went away with #365 and settings-panel.js is now loaded
//   by settings.html alone — a page that has no `#placeholder` at all. So in the only window that runs
//   this code the first line blanked the window and the second threw on a null: press Remove Project and
//   you get an empty window, no confirmation, no error, and no way back. That blank window is also what
//   hid the failure reported in #566.
//
//   `openSettingsViewer` already knows this — it hides `placeholder`, `terminal-area` and the viewers
//   through a null-safe loop with a comment saying the standalone window has none of them. The close path
//   never got the same treatment.
//
// WHAT THIS COVERS:
//   The panel is loaded the way settings.html loads it — every script that page names, in that order,
//   into one jsdom vm context — and the two buttons are really clicked. So this sees the click-time
//   surface, which `settings-modules-smoke.test.js` explicitly does not: it is a load-time guard, and a
//   defect that only fires inside an event handler is invisible to it. What it still does not see is
//   styling; that the flash is green is `.settings-btn-row button.is-saved` in style.css and a human eye.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

// An invented project path. POSIX separators on purpose: `shortName` splits on '/', and a backslash is
// an ordinary character to it on a Linux runner.
const PROJECT_PATH = '/projects/example/alpha';

// The scripts settings.html loads, read FROM settings.html so the list cannot drift away from the page.
// settings-window.js is left out: it is the bootstrap that opens the panel from the URL, and this test
// opens it itself with the scope it wants.
function settingsScripts() {
  const html = fs.readFileSync(path.join(REN, 'settings.html'), 'utf8');
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.ok(srcs.length > 5, 'settings.html script list not found — did the page change shape?');
  return srcs.filter(s => !s.endsWith('settings-window.js'));
}

// The static scaffold settings.html carries. Deliberately WITHOUT `#placeholder`: that absence is the
// condition the bug needed, so adding one here would make the whole file vacuous.
const DOM_FIXTURE = `<!DOCTYPE html><html><body>
  <div id="settings-viewer" style="display:none;">
    <div id="settings-viewer-header"><span id="settings-viewer-title">Settings</span></div>
    <div id="settings-viewer-body"></div>
  </div>
</body></html>`;

// Everything main would answer. Only the calls the open path actually consumes need a real shape; the
// rest fall through to a callable proxy so an unrelated call cannot fail the test for the wrong reason.
function makeApi(record) {
  const anyCall = () => new Proxy(function () {}, {
    get: (t, p) => (p === 'then' ? undefined : anyCall()),
    apply: () => Promise.resolve({ ok: true }),
  });
  const target = {
    platform: 'linux',
    getSetting: async () => ({}),
    setSetting: async () => ({ ok: true }),
    getShellProfiles: async () => [],
    projectTagsGet: async () => [],
    projectTagsListAll: async () => [],
    projectTagsSet: async () => ({ ok: true }),
    getAboutInfo: async () => ({}),
    notifySettingsChanged: async () => ({ ok: true }),
    backends: { list: async () => [] },
    profiles: { list: async () => [], setDefault: async () => ({ ok: true }) },
    hideProject: async (p) => { record.hide.push(p); return record.hideResult; },
    removeProject: async (p) => { record.remove.push(p); return record.removeResult; },
    hideSettingsWindow: () => { record.windowHidden += 1; },
  };
  return new Proxy(target, {
    get: (t, p) => (p in t ? t[p] : (p === 'then' ? undefined : anyCall())),
  });
}

async function openProjectSettings() {
  const record = { hide: [], remove: [], windowHidden: 0, messages: [], hideResult: { ok: true }, removeResult: { ok: true } };
  const dom = new JSDOM(DOM_FIXTURE, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.api = makeApi(record);
  window.bookmarksTags = { pickColor: () => '#61afef', palette: ['#e06c75', '#98c379'] };

  const ctx = dom.getInternalVMContext();
  for (const rel of settingsScripts()) {
    vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  }
  // The confirm is a real modal with real buttons; the answer is not what this file is about, so it is
  // stubbed to "yes". `showControlMessage` is captured rather than rendered, for the same reason.
  window.showControlDialog = async () => true;
  window.showControlMessage = (o) => { record.messages.push(o); return Promise.resolve(true); };

  await window.openSettingsViewer('project', PROJECT_PATH);
  return { window, record, destroy: () => window.close() };
}

// The click handlers are async and end on a 600 ms timer. jsdom runs real timers, so the test waits.
const CLOSE_DELAY_MS = 900;
const settle = () => new Promise(r => setTimeout(r, CLOSE_DELAY_MS));

test('Remove Project closes the settings screen instead of blanking it', async () => {
  const { window, record, destroy } = await openProjectSettings();
  try {
    const btn = window.document.getElementById('sv-remove-project-btn');
    assert.ok(btn, 'the project scope must offer Remove Project');
    const viewer = window.document.getElementById('settings-viewer');

    btn.click();
    await settle();

    assert.deepEqual(record.remove, [PROJECT_PATH], 'the action itself still runs');
    assert.equal(record.windowHidden, 1, 'the screen closes — the user is taken somewhere, not left on an empty pane');
    assert.notEqual(viewer.style.display, 'none',
      'the viewer must not be hidden in place: that is the blank window, and this page has nothing behind it');
  } finally { destroy(); }
});

test('Remove Project says what happened before the screen goes', async () => {
  const { window, record, destroy } = await openProjectSettings();
  try {
    const btn = window.document.getElementById('sv-remove-project-btn');
    btn.click();
    // Read the label before the close timer fires: the confirmation is what the user sees on the way out.
    await new Promise(r => setTimeout(r, 50));

    assert.equal(btn.textContent, '✓ Removed', 'the pressed button reports the removal');
    assert.ok(btn.classList.contains('is-saved'), 'and wears the existing flash class rather than a new control');
    assert.equal(record.windowHidden, 0, 'the confirmation is readable before the window goes');
    await settle();
  } finally { destroy(); }
});

test('Hide Project takes the same path and gets the same ending', async () => {
  const { window, record, destroy } = await openProjectSettings();
  try {
    const btn = window.document.getElementById('sv-remove-btn');
    assert.ok(btn, 'the project scope must offer Hide Project');
    const viewer = window.document.getElementById('settings-viewer');

    btn.click();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(btn.textContent, '✓ Hidden', 'Hide says it hid, not that it removed');
    await settle();

    assert.deepEqual(record.hide, [PROJECT_PATH]);
    assert.equal(record.windowHidden, 1, 'Hide shared the blank-pane defect and shares the fix');
    assert.notEqual(viewer.style.display, 'none');
  } finally { destroy(); }
});

test('a refused Remove is reported instead of swallowed', async () => {
  const { window, record, destroy } = await openProjectSettings();
  try {
    record.removeResult = { error: 'project is locked' };
    window.document.getElementById('sv-remove-project-btn').click();
    await settle();

    assert.equal(record.windowHidden, 0, 'a failed removal leaves the screen open');
    assert.equal(record.messages.length, 1,
      'and says so — `toast` belongs to app.js, which this window never loads, so the old guard was quietly false');
    assert.match(record.messages[0].message, /locked/);
  } finally { destroy(); }
});

// The condition the defect needed, pinned so it cannot be reintroduced sideways: this window has no
// `#placeholder`, so nothing loaded into it may reach for one unguarded.
test('settings-panel.js does not reach for #placeholder outside the null-safe hide loop', () => {
  const src = fs.readFileSync(path.join(REN, 'panels', 'settings-panel.js'), 'utf8');
  assert.ok(!/getElementById\(\s*['"]placeholder['"]\s*\)/.test(src),
    "settings-panel.js must not resolve #placeholder directly — settings.html has none, and the null it returns is what blanked the window");
});
