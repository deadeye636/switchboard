// vm.runInContext smoke tests for the settings-panel ctx modules (#218, #228).
//
// WHY THIS EXISTS — the failure it is built to catch:
//   #218 split openSettingsViewer into five modules. Two earlier cuts in that issue shipped a
//   ReferenceError past all 1488 tests: settings-tags.js left `settingsViewerBody` behind, and
//   settings-shortcuts.js left `stopShortcutCapture` behind — the second killed Save for every setting.
//   Nothing loaded those files, nothing opened that panel, so the suite had no opinion. Both were found
//   only by clicking.
//
//   A vm context IS a way to load them. Each settings-* module is a classic script that hangs a factory on
//   `window`; running create(ctx) and its returned init() against a stub DOM turns "a name it reads does
//   not resolve" into a thrown ReferenceError here, in node --test, instead of a blank panel in front of a
//   user. And settingsGlobalHtml(v) is pure string building — rendered with a full v, a free identifier
//   throws and a value missing from v renders the literal text "undefined", both of which this asserts.
//
// WHAT IT COVERS AND WHAT IT DOES NOT — measured, not assumed:
//   It loads the REAL dependency scripts (utils.js, shortcuts.js, terminal-themes.js, control-dialogs.js)
//   into the context, so the free-identifier check is real — a global the modules reach for that no loaded
//   script declares throws, exactly as in the browser. A ctx member read at create/init time and left out
//   catches too: dropping `body` throws on the first querySelector (the settingsViewerBody class of bug,
//   verified). What it does NOT catch is a ctx member read only inside a later event handler — dropping
//   `reopen` (used only in the import click) leaves init green. So this guards the load-time surface; the
//   click still guards the click-time surface, and drive-app.js is still how that is exercised. A green run
//   here means "these modules load and wire without a dangling reference", not "the panel works".

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

// The markup openSettingsViewer builds before it wires these modules — enough ids that every init()
// finds what it queries. A module whose ids are absent early-returns (that is real behaviour too), but
// giving it the ids exercises the listener binding, which is where a stale reference would surface.
const DOM_FIXTURE = `<!DOCTYPE html><html><body>
  <div id="settings-viewer-body">
    <button id="sv-export-settings"></button>
    <button id="sv-import-settings"></button>
    <button id="sv-rebuild-cache"></button>
    <button class="settings-shortcut-btn" data-sc-id="sessionNavArrows"></button>
    <input id="sv-project-tags-input">
    <div id="sv-project-tags-chips"></div>
    <div id="sv-project-tags-suggest" hidden></div>
    <div id="sv-tagdefs-project">
      <div class="settings-tagdef-list"></div>
      <input class="settings-tagdef-new">
      <button class="settings-tagdef-add-btn"></button>
    </div>
    <div id="sv-tagdefs-session">
      <div class="settings-tagdef-list"></div>
      <input class="settings-tagdef-new">
      <button class="settings-tagdef-add-btn"></button>
    </div>
  </div>
</body></html>`;

function setup() {
  const dom = new JSDOM(DOM_FIXTURE, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  // window.api / window.bookmarksTags are reached through `typeof`/`&&` guards in the modules; a proxy
  // that answers every call keeps them from throwing on a path the smoke test happens to reach.
  // Answers every call with a shape wide enough for the async paths a smoke run reaches: `tagDefsList`
  // reads `res.tags`, so an ok result must carry an (empty) array or the async render throws after the
  // test ends. This is a stub detail, not the thing under test.
  window.api = new Proxy({ platform: 'linux' }, {
    get(t, p) { return p in t ? t[p] : () => Promise.resolve({ ok: true, tags: [], keys: 0 }); },
  });
  window.bookmarksTags = { pickColor: () => '#61afef', palette: ['#e06c75', '#98c379'] };

  const ctx = dom.getInternalVMContext();
  // The REAL dependencies — this is what makes the free-identifier check honest. A name the modules read
  // that none of these declares is a ReferenceError, exactly as it would be in the browser.
  for (const rel of ['lib/utils.js', 'shell/shortcuts.js', 'terminal/terminal-themes.js', 'dialogs/control-dialogs.js']) {
    vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  }
  // The modules under test.
  for (const rel of ['panels/settings-tags.js', 'panels/settings-maintenance.js', 'panels/settings-shortcuts.js',
                     'panels/settings-project-tags.js', 'panels/settings-global-html.js']) {
    vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  }
  const inCtx = (code) => vm.runInContext(code, ctx);
  return { window, inCtx, body: window.document.getElementById('settings-viewer-body'), destroy: () => window.close() };
}

// The v object the global template reads. Its keys are extracted from the module's OWN destructure so the
// list cannot drift out of sync with the source — which means this asserts "no free identifier throws" and
// "no key renders undefined", not "the key list is what I typed once".
function buildTemplateV() {
  const src = fs.readFileSync(path.join(REN, 'panels/settings-global-html.js'), 'utf8');
  const m = src.match(/const\s*\{([\s\S]*?)\}\s*=\s*v;/);
  assert.ok(m, 'settings-global-html.js destructure block not found — did the shape change?');
  const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
  const v = {};
  for (const n of names) v[n] = '';
  // The two members the template calls .map() on need real arrays of the right shape.
  v.shellProfiles = [{ id: 'bash', name: 'Bash' }];
  v.TERMINAL_FONT_PRESETS = [{ value: 'mono', label: 'Mono' }];
  return { v, names };
}

test('settings-global-html: renders a full v with no free-identifier throw and no "undefined"', () => {
  const { inCtx, destroy } = setup();
  try {
    const { v } = buildTemplateV();
    inCtx(`globalThis.__v = ${JSON.stringify(v).replace(/</g, '\\u003c')};`);
    // shape-carrying members do not survive JSON round-trip cleanly enough; set them in-context
    inCtx(`__v.shellProfiles = [{id:'bash',name:'Bash'}]; __v.TERMINAL_FONT_PRESETS = [{value:'mono',label:'Mono'}];`);
    const html = inCtx('window.settingsGlobalHtml(__v)');
    assert.equal(typeof html, 'string');
    assert.ok(html.length > 1000, 'expected a substantial form, got ' + html.length + ' chars');
    assert.ok(!html.includes('undefined'),
      'template rendered the literal "undefined" — a key is read but missing from the destructure/call site');
    // The twelve nav categories are the structural fingerprint; a broken map would drop them.
    const cats = (html.match(/data-cat="/g) || []).length;
    assert.ok(cats >= 24, 'expected >=24 data-cat occurrences (12 nav + 12 panes), got ' + cats);
  } finally { destroy(); }
});

test('settings-global-html: a value missing from v renders "undefined" (the guard has teeth)', () => {
  const { inCtx, destroy } = setup();
  try {
    const { v } = buildTemplateV();
    // A DIRECTLY interpolated seed (`${visCountValue}`), not one only used in a `=== 'x'` comparison —
    // dropping the latter would render nothing, and the negative test would pass for the wrong reason.
    delete v.visCountValue;
    inCtx(`globalThis.__v = ${JSON.stringify(v).replace(/</g, '\\u003c')};`);
    inCtx(`__v.shellProfiles = [{id:'bash',name:'Bash'}]; __v.TERMINAL_FONT_PRESETS = [{value:'mono',label:'Mono'}];`);
    const html = inCtx('window.settingsGlobalHtml(__v)');
    assert.ok(html.includes('undefined'), 'dropping visCountValue should surface "undefined" — the positive assert would be vacuous otherwise');
  } finally { destroy(); }
});

test('settings-maintenance: create + init binds against the DOM without throwing', () => {
  const { inCtx, destroy } = setup();
  try {
    inCtx(`
      const m = window.settingsMaintenance.create({ body: document.getElementById('settings-viewer-body'), reopen: () => {} });
      m.initMaintenanceSection();
    `);
  } finally { destroy(); }
});

test('settings-shortcuts: create + init binds, and getShortcuts/setShortcuts are the accessor pair', () => {
  const { inCtx, destroy } = setup();
  try {
    inCtx(`
      let store = { sessionNavArrows: { primary: true, shift: true } };
      const s = window.settingsShortcuts.create({
        body: document.getElementById('settings-viewer-body'),
        isMac: false,
        getShortcuts: () => store,
        setShortcuts: (n) => { store = n; },
      });
      s.initShortcutSection();
      if (typeof s.stopShortcutCapture !== 'function') throw new Error('stopShortcutCapture not returned — the save path calls it');
    `);
  } finally { destroy(); }
});

test('settings-project-tags: create + init binds against the project-tags DOM without throwing', () => {
  const { inCtx, destroy } = setup();
  try {
    inCtx(`
      const p = window.settingsProjectTags.create({
        body: document.getElementById('settings-viewer-body'),
        allProjectTags: [{ tag: 'x', color: '#fff' }],
        tagColor: () => '#61afef',
        buildColorPopover: () => document.createElement('div'),
        signal: new AbortController().signal,
      });
      p.initProjectTagsEditor();
      if (typeof p.renderTagChip !== 'function') throw new Error('renderTagChip not returned — settings-panel.js seeds its chips with it');
      if (!/title="Click to change color"/.test(p.renderTagChip('x'))) throw new Error('a recolourable chip lost its title');
    `);
  } finally { destroy(); }
});

// #675: the Add Project dialog (index.html) builds the editor WITHOUT buildColorPopover — settings-tags.js
// is a settings.html module. The chip then promises no recolouring, and clicking one must not reach for a
// picker that is not there.
test('settings-project-tags: without buildColorPopover the chips render and a chip click throws nothing', () => {
  const { inCtx, destroy } = setup();
  try {
    inCtx(`
      const p = window.settingsProjectTags.create({
        body: document.getElementById('settings-viewer-body'),
        allProjectTags: [],
        tagColor: () => '#61afef',
        signal: new AbortController().signal,
      });
      p.initProjectTagsEditor();
      const html = p.renderTagChip('alpha');
      if (/title=/.test(html)) throw new Error('a chip nobody can recolour says it can be');
      const box = document.getElementById('sv-project-tags-chips');
      box.innerHTML = html;
      // A throw inside a listener is REPORTED, not thrown out of click() — collect it.
      const errs = [];
      window.addEventListener('error', (e) => errs.push(e.message));
      box.querySelector('.settings-tag-label').click();
      if (errs.length) throw new Error('chip click threw: ' + errs[0]);
      box.querySelector('.settings-tag-remove').click();
      if (box.querySelector('.settings-tag-chip')) throw new Error('× did not remove the chip');
    `);
  } finally { destroy(); }
});

// #675: saving a project's tags also sets each tag DEFINITION's colour (setProjectTagsTx), so a typed name
// of an existing tag must carry that tag's colour, not a default — even when it was typed before the
// suggestion list arrived (the Add Project dialog loads it asynchronously). A chip whose colour somebody
// chose keeps its own, and a genuinely new tag gets the default.
test('settings-project-tags: a typed existing tag keeps its colour, resolved again at write time', () => {
  const { inCtx, destroy } = setup();
  try {
    const out = inCtx(`
      (() => {
        const known = [];   // empty at first: the suggestions have not arrived yet
        const p = window.settingsProjectTags.create({
          body: document.getElementById('settings-viewer-body'),
          allProjectTags: known,
          tagColor: () => '#000001',
          signal: new AbortController().signal,
        });
        p.initProjectTagsEditor();
        const input = document.getElementById('sv-project-tags-input');
        const type = (text) => {
          input.value = text;
          input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        };
        type('early');                           // typed before the list is known
        known.push({ tag: 'late', color: '#abcdef' });
        type('late');                            // typed after: the chip itself wears the colour
        type('fresh');                           // a new tag
        const box = document.getElementById('sv-project-tags-chips');
        box.insertAdjacentHTML('beforeend', p.renderTagChip('seeded', '#123456'));
        const lateChip = box.querySelector('[data-tag="late"]');
        const defs = [
          { tag: 'early', color: '#fedcba' },
          { tag: 'late', color: '#abcdef' },
          { tag: 'seeded', color: '#999999' },
          { tag: 'Fresh', color: '#777777' },   // a different name: the store compares exactly
        ];
        return JSON.stringify({ lateChipColor: lateChip.dataset.color, written: p.readChipTags(defs) });
      })()
    `);
    const { lateChipColor, written } = JSON.parse(out);
    assert.equal(lateChipColor, '#abcdef', 'a typed existing tag wears its colour when the list is known');
    assert.deepStrictEqual(written, [
      { tag: 'early', color: '#fedcba' },     // resolved at write time, not from the default the chip got
      { tag: 'late', color: '#abcdef' },
      { tag: 'fresh', color: '#000001' },     // new: the default colour
      { tag: 'seeded', color: '#123456' },    // chosen (the project's stored colour): its own
    ]);
  } finally { destroy(); }
});

test('settings-tags: create returns its three functions and initTagDefsSection binds without throwing', () => {
  const { inCtx, destroy } = setup();
  try {
    inCtx(`
      const t = window.settingsTags.create({
        body: document.getElementById('settings-viewer-body'),
        tagColor: () => '#61afef',
        tagPalette: ['#e06c75', '#98c379'],
        signal: new AbortController().signal,
      });
      for (const fn of ['initTagDefsSection', 'notifyTagsChanged', 'buildColorPopover']) {
        if (typeof t[fn] !== 'function') throw new Error(fn + ' not returned');
      }
      t.initTagDefsSection('project');
      t.initTagDefsSection('session');
    `);
  } finally { destroy(); }
});
