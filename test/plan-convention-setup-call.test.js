'use strict';
// What the "Set up…" button on the project settings screen sends as `planDir` (#630).
//
// WHY THIS EXISTS:
//   The plans-directory field is PREFILLED with the effective `planDir` setting, and the click handler
//   used to read that field and pass its value on to `planConventionPreview` / `planConventionApply`
//   unconditionally. So the main process could not tell "the setting" from "a path the user just typed",
//   and it treats the two differently on purpose: a setting the app cannot use — one that leaves the
//   project, one that names the project root — falls back to `.plans` silently, matching what the plan
//   prompt beside it already tells the agent, while a directory the CALLER named is refused with a
//   message. Sending the seeded field made every setup look like a named path, so the fallback never ran
//   in the app at all and the refusal #630 is about survived the main-process half of the fix.
//
//   The handler now sends `planDir` only when the field differs from the value the markup was rendered
//   with (`defaultValue`), and otherwise sends no `planDir` at all so main answers from the setting.
//
// WHAT THIS COVERS:
//   The panel is loaded the way settings.html loads it — every script that page names, in that order,
//   into one jsdom vm context — and the button is really clicked, in the project scope, which is the only
//   scope that renders it. The preview and apply calls are recorded, so this sees what actually left the
//   renderer rather than what the source looks like. The fourth test (edited, then edited BACK to the
//   seeded value) is the one that refuses a "simplification" of the comparison into a truthiness check.
//
// WHAT THIS DOES NOT COVER:
//   What the main process then does with those options — `test/plan-convention-write.test.js` and
//   `test/convention-dirs.test.js` own the fallback and the refusal themselves. Nor the wording of the
//   confirm dialog, nor any styling: the dialog is stubbed to "yes" because the answer is not the
//   subject, only the options the accepted answer sends.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

// Invented paths. POSIX separators on purpose: `shortName` splits the project path on '/', and a
// backslash is an ordinary character to it on a Linux runner.
const PROJECT_PATH = '/projects/example/alpha';
// What the project's stored `planDir` is, so the field is seeded with something that is NOT the default
// and NOT empty — an empty seed would let a truthiness check pass by accident.
const SEEDED_PLAN_DIR = 'docs/plan-documents';
// What a user types over it.
const TYPED_PLAN_DIR = 'docs/agreed-plans';

// The scripts settings.html loads, read FROM settings.html so the list cannot drift away from the page.
// settings-window.js is left out: it is the bootstrap that opens the panel from the URL, and this test
// opens it itself with the scope it wants.
function settingsScripts() {
  const html = fs.readFileSync(path.join(REN, 'settings.html'), 'utf8');
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.ok(srcs.length > 5, 'settings.html script list not found — did the page change shape?');
  return srcs.filter(s => !s.endsWith('settings-window.js'));
}

// The static scaffold settings.html carries.
const DOM_FIXTURE = `<!DOCTYPE html><html><body>
  <div id="settings-viewer" style="display:none;">
    <div id="settings-viewer-header"><span id="settings-viewer-title">Settings</span></div>
    <div id="settings-viewer-body"></div>
  </div>
</body></html>`;

// What the preview would answer for a project that is not set up yet. `unchanged` is false and the
// directory is missing, so the handler goes all the way to the confirm dialog and the apply call.
function previewAnswer() {
  return {
    ok: true,
    unchanged: false,
    dirExists: false,
    planDir: SEEDED_PLAN_DIR,
    dir: PROJECT_PATH + '/' + SEEDED_PLAN_DIR,
    writes: [{ backendLabel: 'Example CLI', file: PROJECT_PATH + '/.example/config.json' }],
    notes: [],
    versioned: false,
  };
}

// Everything main would answer. Only the calls this path consumes need a real shape; the rest fall
// through to a callable proxy so an unrelated call cannot fail the test for the wrong reason.
function makeApi(record) {
  const anyCall = () => new Proxy(function () {}, {
    get: (t, p) => (p === 'then' ? undefined : anyCall()),
    apply: () => Promise.resolve({ ok: true }),
  });
  const target = {
    platform: 'linux',
    // The project's own blob carries `planDir`, so the field renders enabled and seeded with it.
    getSetting: async (key) => (key === 'project:' + PROJECT_PATH ? { planDir: SEEDED_PLAN_DIR } : {}),
    setSetting: async () => ({ ok: true }),
    getShellProfiles: async () => [],
    projectTagsGet: async () => [],
    projectTagsListAll: async () => [],
    projectTagsSet: async () => ({ ok: true }),
    getAboutInfo: async () => ({}),
    notifySettingsChanged: async () => ({ ok: true }),
    backends: { list: async () => [] },
    profiles: { list: async () => [], setDefault: async () => ({ ok: true }) },
    planConventionPreview: async (projectPath, options) => {
      record.preview.push({ projectPath, options });
      return previewAnswer();
    },
    planConventionApply: async (projectPath, options) => {
      record.apply.push({ projectPath, options });
      return { ok: true, planDir: SEEDED_PLAN_DIR };
    },
    hideSettingsWindow: () => {},
  };
  return new Proxy(target, {
    get: (t, p) => (p in t ? t[p] : (p === 'then' ? undefined : anyCall())),
  });
}

async function openProjectSettings() {
  const record = { preview: [], apply: [], messages: [], toasts: [], dialogs: [] };
  const dom = new JSDOM(DOM_FIXTURE, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.api = makeApi(record);
  window.bookmarksTags = { pickColor: () => '#61afef', palette: ['#e06c75', '#98c379'] };

  const ctx = dom.getInternalVMContext();
  for (const rel of settingsScripts()) {
    vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  }
  // The confirm is a real modal with real buttons; the answer is not what this file is about, so it is
  // stubbed to "yes" and the apply call is reached. The message and toast surfaces are captured rather
  // than rendered — a captured message is also how a failing test says which branch it took.
  window.showControlDialog = async (o) => { record.dialogs.push(o); return true; };
  window.showControlMessage = (o) => { record.messages.push(o); return Promise.resolve(true); };
  window.showControlToast = (o) => { record.toasts.push(o); return null; };

  await window.openSettingsViewer('project', PROJECT_PATH);
  return { window, record, destroy: () => window.close() };
}

// The field, asserted to be seeded — every test below reasons about the difference between the seed and
// what is in the field, so a field that was never seeded would make all of them vacuous.
function planDirField(window) {
  const input = window.document.getElementById('sv-plan-dir');
  assert.ok(input, 'the project scope must render the plans-directory field');
  assert.equal(input.defaultValue, SEEDED_PLAN_DIR,
    'the field is rendered from the setting — that prefill is the whole reason the handler has to tell seed from typed');
  assert.equal(input.value, SEEDED_PLAN_DIR, 'and nothing has touched it yet');
  return input;
}

// As close to typing as jsdom gets: the value plus the event a real keystroke would fire. `defaultValue`
// stays on the rendered attribute, which is what the handler compares against.
function typeInto(window, input, text) {
  input.value = text;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

// The options object was built inside the jsdom vm context, so its prototype is that realm's
// `Object.prototype` and a strict deep compare against a literal written here fails on identity alone.
// Copied flat into this realm, which is also what the IPC boundary would do to it.
const plain = (o) => ({ ...(o || {}) });

// The handler is async across two awaited promises. Poll rather than guess a delay.
async function waitFor(fn, what) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail('timed out waiting for ' + what);
}

// One run of the button, with an optional edit to the field first.
async function clickSetUp(edit) {
  const opened = await openProjectSettings();
  const { window, record } = opened;
  const input = planDirField(window);
  if (typeof edit === 'function') edit(window, input);

  const btn = window.document.getElementById('sv-plan-convention');
  assert.ok(btn, 'the project scope must offer the Set up… button');
  btn.click();
  await waitFor(() => record.preview.length > 0,
    'the preview call — the handler threw before it, or the button is no longer wired');
  return opened;
}

test('an untouched plans directory is not sent as a path the caller named', async () => {
  const { record, destroy } = await clickSetUp(null);
  try {
    assert.equal(record.preview.length, 1);
    assert.equal(record.preview[0].projectPath, PROJECT_PATH);
    const opts = record.preview[0].options || {};
    assert.equal('planDir' in opts, false,
      'the seeded field is the SETTING, and a setting the app cannot use falls back silently in main — '
      + 'sending it as `planDir` makes main refuse it instead, which is the defect #630 is about. '
      + 'The property has to be absent, not empty: main tells "not given" from "given as nothing".');
    assert.equal(opts.shared, false, 'the rest of the options is unchanged');
  } finally { destroy(); }
});

test('a plans directory the user typed is sent exactly as typed', async () => {
  const { record, destroy } = await clickSetUp((window, input) => typeInto(window, input, TYPED_PLAN_DIR));
  try {
    assert.equal(record.preview.length, 1);
    assert.deepEqual(plain(record.preview[0].options), { planDir: TYPED_PLAN_DIR, shared: false },
      'a directory somebody just named is the case main is entitled to refuse with a message, so it must arrive');
  } finally { destroy(); }
});

test('the apply call carries exactly the options the preview was shown — untouched field', async () => {
  const { record, destroy } = await clickSetUp(null);
  try {
    await waitFor(() => record.apply.length > 0, 'the apply call after the confirm was accepted');
    assert.equal(record.apply.length, 1);
    assert.equal(record.apply[0].projectPath, PROJECT_PATH);
    assert.deepEqual(plain(record.apply[0].options), plain(record.preview[0].options),
      'the dialog described what the preview computed; writing under different options is the one failure a preview exists to prevent');
    assert.equal('planDir' in (record.apply[0].options || {}), false);
  } finally { destroy(); }
});

test('the apply call carries exactly the options the preview was shown — typed field', async () => {
  const { record, destroy } = await clickSetUp((window, input) => typeInto(window, input, TYPED_PLAN_DIR));
  try {
    await waitFor(() => record.apply.length > 0, 'the apply call after the confirm was accepted');
    assert.deepEqual(plain(record.apply[0].options), plain(record.preview[0].options));
    assert.deepEqual(plain(record.apply[0].options), { planDir: TYPED_PLAN_DIR, shared: false });
  } finally { destroy(); }
});

// The assertion that refuses a "simplification" of the comparison into `if (value)`: the field holds a
// non-empty string here, and it still must not be sent, because it is the value the markup was rendered
// with. Only a comparison against the seed can tell these two runs apart.
test('a field edited and then put back to the seeded value counts as untouched', async () => {
  const { record, destroy } = await clickSetUp((window, input) => {
    typeInto(window, input, TYPED_PLAN_DIR);
    typeInto(window, input, SEEDED_PLAN_DIR);
  });
  try {
    assert.equal(record.preview.length, 1);
    assert.equal('planDir' in (record.preview[0].options || {}), false,
      'the field holds the setting again, so main answers from the setting — the edit that was undone leaves no trace');
    await waitFor(() => record.apply.length > 0, 'the apply call after the confirm was accepted');
    assert.deepEqual(plain(record.apply[0].options), plain(record.preview[0].options));
  } finally { destroy(); }
});

// Clearing the field is a change like any other, and it means "the default" — which is what Save would
// store. Treating it as untouched would set up whatever the setting still says, the value the user has just
// cleared in front of them, so the default is sent explicitly rather than left to the main process.
test('a field the user emptied means the default, not the setting still on disk', async () => {
  const { record, destroy } = await clickSetUp((window, input) => {
    typeInto(window, input, '   ');
  });
  try {
    assert.equal(record.preview.length, 1);
    assert.deepEqual(plain(record.preview[0].options), { planDir: '.plans', shared: false });
    await waitFor(() => record.apply.length > 0, 'the apply call after the confirm was accepted');
    assert.deepEqual(plain(record.apply[0].options), plain(record.preview[0].options));
  } finally { destroy(); }
});
