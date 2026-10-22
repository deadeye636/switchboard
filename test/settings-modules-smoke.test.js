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

// #789: the project's MCP servers editor. Loaded the way settings.html loads it (utils.js for escapeHtml, the
// shared validator, then the module), so a free identifier in it throws here and not in front of a user.
test('settings-external-mcp: the text area renders the stored list, round-trips it and names a rejected entry', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="body"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only' });
  try {
    const ctx = dom.getInternalVMContext();
    for (const rel of ['lib/utils.js', '../shared/external-mcp-validate.js', 'panels/settings-external-mcp.js']) {
      vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
    }
    const { window } = dom;
    const mod = window.settingsExternalMcp;
    const body = window.document.getElementById('body');
    const stored = [{ name: 'docs', transport: 'http', url: 'https://example.invalid/mcp' }];
    body.innerHTML = mod.sectionHtml(stored);

    const ta = body.querySelector('textarea.settings-input#sv-external-mcp');
    assert.ok(ta, 'the editor is a styled settings textarea');
    assert.deepStrictEqual(JSON.parse(ta.value), stored);
    mod.bind(body, new window.AbortController().signal);

    // A good list round-trips.
    let res = mod.read(body);
    assert.strictEqual(res.problem, '');
    assert.strictEqual(res.list[0].name, 'docs');

    // Blank means an empty list.
    ta.value = '  ';
    res = mod.read(body);
    assert.strictEqual(res.problem, '');
    assert.deepStrictEqual(Array.from(res.list), []);

    // A bad entry is refused with a sentence naming the entry and the field.
    ta.value = JSON.stringify([{ name: 'bad name', transport: 'stdio', command: 'x' }, stored[0]]);
    res = mod.read(body);
    assert.match(res.problem, /Entry 1 \("bad name"\): name "bad name" may only use/);

    // Invalid JSON is reported, not dropped.
    ta.value = '[{';
    res = mod.read(body);
    assert.match(res.problem, /not valid JSON/);
    assert.match(body.querySelector('#sv-external-mcp-status').textContent, /not valid JSON/);

    // A literal secret warns and does not block.
    ta.value = JSON.stringify([{ name: 'a', transport: 'stdio', command: 'x', env: { API_KEY: 'sk-abcdef123456' } }]);
    res = mod.read(body);
    assert.strictEqual(res.problem, '');
    assert.match(body.querySelector('#sv-external-mcp-status').textContent, /literal secret/);
  } finally { dom.window.close(); }
});

// #789 slice B: the cards are a projection of the text area. Same load order as above.
test('settings-external-mcp: cards follow the text, a card operation edits the raw entry, a bad text shows no cards', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="body"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only' });
  try {
    const ctx = dom.getInternalVMContext();
    for (const rel of ['lib/utils.js', '../shared/external-mcp-validate.js', '../shared/external-mcp-form.js', 'panels/settings-external-mcp.js']) {
      vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
    }
    const { window } = dom;
    const mod = window.settingsExternalMcp;
    const body = window.document.getElementById('body');
    const stored = [
      { name: 'docs', transport: 'http', url: 'https://example.invalid/mcp', custom: { keep: 1 } },
      { name: 'tool', transport: 'stdio', command: 'x', enabled: true },
    ];
    body.innerHTML = mod.sectionHtml(stored);
    mod.bind(body, new window.AbortController().signal);
    const ta = body.querySelector('#sv-external-mcp');
    const cards = () => Array.from(body.querySelectorAll('#sv-external-mcp-cards .sv-mcp-card'));
    const json = body.querySelector('details.settings-adv#sv-external-mcp-json');

    assert.strictEqual(cards().length, 2, 'one card per stored entry');
    assert.ok(json && !json.open, 'the JSON disclosure is closed by default');
    assert.ok(json.contains(ta), 'the text area lives in the disclosure');
    assert.strictEqual(body.querySelector('#sv-external-mcp-add').disabled, false, 'Add is reachable on a valid list');

    // Every control is a styled one; nothing carries an inline colour.
    const region = body.querySelector('#sv-external-mcp-cards');
    for (const b of region.querySelectorAll('button')) assert.ok(b.className.includes('settings-action-btn'), 'a styled button');
    assert.strictEqual(region.querySelectorAll('[style]').length, 0, 'no inline style in the cards');
    assert.ok(region.querySelector('label.settings-toggle'), 'the switch reuses .settings-toggle');

    // The switch changes only `enabled` and leaves an unknown key in place.
    const sw = cards()[0].querySelector('.settings-toggle input');
    assert.strictEqual(sw.checked, true);
    sw.checked = false;
    sw.dispatchEvent(new window.Event('change'));
    let now = JSON.parse(ta.value);
    assert.deepStrictEqual(now[0], { ...stored[0], enabled: false });
    assert.deepStrictEqual(now[1], stored[1]);
    assert.strictEqual(cards()[0].querySelector('.settings-toggle input').checked, false, 'redrawn from the text');

    // Remove drops exactly that entry.
    cards()[0].querySelector('button.danger').click();
    now = JSON.parse(ta.value);
    assert.deepStrictEqual(now.map(e => e.name), ['tool']);
    assert.strictEqual(cards().length, 1);
    cards()[0].querySelector('button.danger').click();
    assert.strictEqual(ta.value, '', 'an emptied list is blank text');
    assert.strictEqual(cards().length, 0);

    // A text edit redraws on blur; a rejected entry keeps a card with its reason and no switch.
    ta.value = JSON.stringify([{ name: 'bad name', transport: 'stdio', command: 'x' }, stored[1]]);
    ta.dispatchEvent(new window.Event('blur'));
    assert.strictEqual(cards().length, 2);
    assert.strictEqual(cards()[0].querySelector('.settings-toggle'), null, 'no switch on a rejected entry');
    assert.match(cards()[0].textContent, /may only use/);
    assert.ok(cards()[0].querySelector('button.danger'), 'a rejected entry can still be removed');
    assert.ok(cards()[1].querySelector('.settings-toggle'));

    // Invalid JSON: no cards, a sentence, the disclosure opens, read() still refuses.
    json.open = false;
    ta.value = '[{';
    ta.dispatchEvent(new window.Event('blur'));
    assert.strictEqual(cards().length, 0);
    assert.match(region.textContent, /not valid JSON/);
    assert.strictEqual(json.open, true);
    assert.strictEqual(body.querySelector('#sv-external-mcp-add').disabled, true);
    assert.match(mod.read(body).problem, /not valid JSON/);

    // A stored value that is not a list is shown as it is, with the same state (no blank area).
    body.innerHTML = mod.sectionHtml({ name: 'x' });
    mod.bind(body, new window.AbortController().signal);
    assert.deepStrictEqual(JSON.parse(body.querySelector('#sv-external-mcp').value), { name: 'x' });
    assert.strictEqual(body.querySelectorAll('.sv-mcp-card').length, 0);
    assert.match(body.querySelector('#sv-external-mcp-cards').textContent, /not a list/);
  } finally { dom.window.close(); }
});

// #789 slice B: the inline Add / Edit form, over the real files.
test('settings-external-mcp: the inline form adds and edits through the one validator and Cancel stores nothing', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="body"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only' });
  try {
    const ctx = dom.getInternalVMContext();
    for (const rel of ['lib/utils.js', '../shared/external-mcp-validate.js', '../shared/external-mcp-form.js', 'panels/settings-external-mcp.js']) {
      vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
    }
    const { window } = dom;
    const doc = window.document;
    const mod = window.settingsExternalMcp;
    const body = doc.getElementById('body');
    const stored = [{ name: 'docs', transport: 'http', url: 'https://example.invalid/mcp', custom: { keep: 1 } }];
    body.innerHTML = mod.sectionHtml(stored);
    mod.bind(body, new window.AbortController().signal);
    const ta = body.querySelector('#sv-external-mcp');
    const host = body.querySelector('#sv-external-mcp-form');
    const addBtn = body.querySelector('#sv-external-mcp-add');
    const btn = (label) => Array.from(host.querySelectorAll('button')).find(b => b.textContent === label);
    const fieldOf = (label) => Array.from(host.querySelectorAll('.sv-mcp-form-field'))
      .find(f => f.querySelector('.settings-label').textContent === label);
    const addRow = (label) => Array.from(fieldOf(label).querySelectorAll('button')).find(b => b.textContent === 'Add row').click();
    const set = (el, v) => { el.value = v; };
    const fire = (el, ev) => el.dispatchEvent(new window.Event(ev));
    const before = ta.value;

    // Cancel stores nothing.
    addBtn.click();
    assert.ok(host.querySelector('.sv-mcp-form'), 'Add opens the form');
    set(fieldOf('Name').querySelector('input'), 'x');
    btn('Cancel').click();
    assert.strictEqual(host.children.length, 0);
    assert.strictEqual(ta.value, before);

    // The type switch hides the other side's fields.
    addBtn.click();
    const type = fieldOf('Type').querySelector('select');
    const groups = host.querySelectorAll('.sv-mcp-form-group');
    assert.strictEqual(groups[0].hidden, false);
    assert.strictEqual(groups[1].hidden, true);
    set(type, 'http'); fire(type, 'change');
    assert.strictEqual(groups[0].hidden, true);
    assert.strictEqual(groups[1].hidden, false);
    set(type, 'stdio'); fire(type, 'change');

    // Add a stdio server with every stdio field: appended, built by formToEntry.
    set(fieldOf('Name').querySelector('input'), 'tool');
    set(fieldOf('Command').querySelector('input'), 'npx');
    set(fieldOf('Arguments').querySelector('textarea'), '-y\n\npkg with space\n');
    addRow('Environment variables');
    const envInputs = fieldOf('Environment variables').querySelectorAll('.sv-mcp-row input');
    set(envInputs[0], 'MODE'); set(envInputs[1], 'fast');
    addRow('Environment variable passthrough');
    set(fieldOf('Environment variable passthrough').querySelector('.sv-mcp-row input'), 'API_KEY');
    set(fieldOf('Working directory').querySelector('input'), '~/work');
    btn('Add').click();
    let now = JSON.parse(ta.value);
    assert.strictEqual(host.children.length, 0, 'the form closes on success');
    assert.deepStrictEqual(now[0], stored[0], 'the other entry is untouched');
    assert.deepStrictEqual(now[1], {
      name: 'tool', transport: 'stdio', command: 'npx', args: ['-y', 'pkg with space'],
      env: { MODE: 'fast', API_KEY: '${API_KEY}' }, cwd: '~/work',
    });
    assert.strictEqual(body.querySelectorAll('.sv-mcp-card').length, 2);

    // Add an http server: url and headers only.
    addBtn.click();
    set(fieldOf('Type').querySelector('select'), 'http'); fire(fieldOf('Type').querySelector('select'), 'change');
    set(fieldOf('Name').querySelector('input'), 'web');
    set(fieldOf('URL').querySelector('input'), 'https://example.invalid/x');
    addRow('Headers');
    const hi = fieldOf('Headers').querySelectorAll('.sv-mcp-row input');
    set(hi[0], 'Authorization'); set(hi[1], 'Bearer ${TOKEN}');
    btn('Add').click();
    now = JSON.parse(ta.value);
    assert.deepStrictEqual(now[2], { name: 'web', transport: 'http', url: 'https://example.invalid/x', headers: { Authorization: 'Bearer ${TOKEN}' } });

    // A duplicate name and the reserved name are refused with the validator's wording; the form stays, nothing stored.
    const snapshot = ta.value;
    addBtn.click();
    set(fieldOf('Name').querySelector('input'), 'docs');
    set(fieldOf('Command').querySelector('input'), 'x');
    btn('Add').click();
    assert.ok(host.querySelector('.sv-mcp-form'), 'the form stays open');
    assert.match(host.querySelector('.sv-mcp-form-msg').textContent, /duplicate|already/i);
    assert.strictEqual(ta.value, snapshot);
    set(fieldOf('Name').querySelector('input'), 'switchboard');
    btn('Add').click();
    assert.ok(host.querySelector('.sv-mcp-form-msg').textContent.length > 0);
    assert.strictEqual(ta.value, snapshot);
    btn('Cancel').click();

    // Edit one field in place; the other entries and the unknown key stay.
    body.querySelectorAll('.sv-mcp-card')[0].querySelector('button').click();
    assert.strictEqual(fieldOf('URL').querySelector('input').value, 'https://example.invalid/mcp');
    set(fieldOf('URL').querySelector('input'), 'https://example.invalid/new');
    btn('Save changes').click();
    now = JSON.parse(ta.value);
    assert.deepStrictEqual(now[0], { ...stored[0], url: 'https://example.invalid/new' });
    assert.deepStrictEqual(now.map(e => e.name), ['docs', 'tool', 'web']);

    // The form is not reachable while the text is not a list.
    ta.value = '[{';
    fire(ta, 'blur');
    assert.strictEqual(addBtn.disabled, true);
    addBtn.click();
    assert.strictEqual(host.children.length, 0);
  } finally { dom.window.close(); }
});

// #789 slice A2: the prune switch, its Save value and the per-backend capability lines.
test('settings-external-mcp: the prune switch reflects the stored flag, is read at Save and lists the served capability answers', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="body"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only' });
  try {
    const ctx = dom.getInternalVMContext();
    for (const rel of ['lib/utils.js', '../shared/external-mcp-validate.js', '../shared/external-mcp-form.js', 'panels/settings-external-mcp.js']) {
      vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
    }
    const { window } = dom;
    window.api = { backends: { list: async () => ({ backends: [
      { id: 'a', label: 'Alpha CLI', enabled: true, capabilities: { mcpPrune: { state: 'yes', note: null } } },
      { id: 'b', label: 'Beta CLI', enabled: true, capabilities: { mcpPrune: { state: 'no', note: 'declines for now' } } },
      { id: 'c', label: 'Gamma CLI', enabled: true },
      { id: 'p', label: 'A profile', enabled: true, isProfile: true, capabilities: { mcpPrune: { state: 'yes', note: null } } },
    ] }) } };
    const mod = window.settingsExternalMcp;
    assert.strictEqual(mod.PRUNE_KEY, 'externalMcpPrune');
    const body = window.document.getElementById('body');
    const sw = () => body.querySelector('input#sv-external-mcp-prune');

    body.innerHTML = mod.sectionHtml([], true);
    assert.strictEqual(sw().checked, true);
    assert.ok(sw().closest('label.settings-toggle'), 'the switch reuses the settings toggle style');
    body.innerHTML = mod.sectionHtml([], false);
    assert.strictEqual(sw().checked, false);
    body.innerHTML = mod.sectionHtml([]);
    assert.strictEqual(sw().checked, false, 'unset is off');
    assert.strictEqual(mod.read(body).prune, false);
    sw().checked = true;
    assert.strictEqual(mod.read(body).prune, true);

    mod.bind(body, new window.AbortController().signal);
    await new Promise(r => setTimeout(r, 0));
    const list = body.querySelector('#sv-external-mcp-prune-list').textContent;
    assert.match(list, /Alpha CLI: applied/);
    assert.match(list, /Beta CLI: not applied \(declines for now\)/);
    assert.doesNotMatch(list, /Gamma|profile/);
  } finally { dom.window.close(); }
});

// #789 slice B: the backends chips, over the real files and a fake `window.api.backends.list`.
test('settings-external-mcp: backends chips come from the served list, keep an unknown id and survive a failed call', async () => {
  const load = (listImpl) => {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="body"></div></body></html>',
      { url: 'http://localhost/', runScripts: 'outside-only' });
    const ctx = dom.getInternalVMContext();
    for (const rel of ['lib/utils.js', '../shared/external-mcp-validate.js', '../shared/external-mcp-form.js', 'panels/settings-external-mcp.js']) {
      vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
    }
    if (listImpl) dom.window.api = { backends: { list: listImpl } };
    return dom;
  };
  const tick = () => new Promise(r => setTimeout(r, 0));
  const served = async () => ({ backends: [
    { id: 'alpha', label: 'Alpha CLI', enabled: true },
    { id: 'beta', label: 'Beta CLI', enabled: true },
    { id: 'gamma', label: 'Gamma CLI', enabled: true },
    { id: 'off', label: 'Switched off', enabled: false },
    { id: 'prof', label: 'A profile', enabled: true, isProfile: true },
  ] });

  // Served list: the card drawn before the answer shows the raw ids, then the served labels.
  let dom = load(served);
  try {
    const { window } = dom;
    const mod = window.settingsExternalMcp;
    const body = window.document.getElementById('body');
    const stored = [
      { name: 'one', transport: 'stdio', command: 'x', backends: ['beta', 'zeta'] },
      { name: 'two', transport: 'stdio', command: 'x' },
    ];
    body.innerHTML = mod.sectionHtml(stored);
    mod.bind(body, new window.AbortController().signal);
    const cards = () => Array.from(body.querySelectorAll('.sv-mcp-card'));
    const chipText = (card) => Array.from(card.querySelectorAll('.sv-mcp-chip')).map(c => c.textContent);
    assert.deepStrictEqual(chipText(cards()[0]), ['beta', 'zeta'], 'raw ids before the list resolves');
    await tick();
    assert.deepStrictEqual(chipText(cards()[0]), ['Beta CLI', 'zeta (unknown)']);
    assert.ok(cards()[0].querySelector('.sv-mcp-chip-unknown'));
    assert.deepStrictEqual(chipText(cards()[1]), [], 'no backends key: no chip');
    assert.match(cards()[1].textContent, /All backends/);

    // The form offers every enabled served backend plus the stored unknown id.
    const ta = body.querySelector('#sv-external-mcp');
    const host = body.querySelector('#sv-external-mcp-form');
    const formChips = () => Array.from(host.querySelectorAll('.sv-mcp-chips button'));
    const pressed = () => formChips().filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent);
    cards()[0].querySelector('button').click();
    assert.deepStrictEqual(formChips().map(b => b.textContent), ['Alpha CLI', 'Beta CLI', 'Gamma CLI', 'zeta (unknown)']);
    assert.deepStrictEqual(pressed(), ['Beta CLI', 'zeta (unknown)']);
    const save = () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Save changes').click();
    save();
    assert.deepStrictEqual(JSON.parse(ta.value)[0].backends, ['beta', 'zeta'], 'an unknown id round-trips');

    // Selecting more stores them in served order, unknown ids after.
    cards()[0].querySelector('button').click();
    formChips()[2].click(); // Gamma
    formChips()[0].click(); // Alpha
    save();
    assert.deepStrictEqual(JSON.parse(ta.value)[0].backends, ['alpha', 'beta', 'gamma', 'zeta']);

    // Deselecting everything stores no key.
    cards()[0].querySelector('button').click();
    formChips().filter(b => b.getAttribute('aria-pressed') === 'true').forEach(b => b.click());
    save();
    assert.ok(!('backends' in JSON.parse(ta.value)[0]));
  } finally { dom.window.close(); }

  // A rejected list call: no throw, stored ids stay visible as raw chips, the form still works.
  dom = load(async () => { throw new Error('boom'); });
  try {
    const { window } = dom;
    const mod = window.settingsExternalMcp;
    const body = window.document.getElementById('body');
    body.innerHTML = mod.sectionHtml([{ name: 'one', transport: 'stdio', command: 'x', backends: ['zeta'] }]);
    mod.bind(body, new window.AbortController().signal);
    await tick();
    assert.deepStrictEqual(Array.from(body.querySelectorAll('.sv-mcp-card .sv-mcp-chip')).map(c => c.textContent), ['zeta']);
    body.querySelector('.sv-mcp-card button').click();
    const host = body.querySelector('#sv-external-mcp-form');
    assert.deepStrictEqual(Array.from(host.querySelectorAll('.sv-mcp-chips button')).map(b => b.textContent), ['zeta']);
    Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Save changes').click();
    assert.deepStrictEqual(JSON.parse(body.querySelector('#sv-external-mcp').value)[0].backends, ['zeta']);
  } finally { dom.window.close(); }
});

// #789 slice B: the nav count beside "MCP servers" is the number of servers, kept in step with add and remove.
test('settings-external-mcp: the nav count is the number of servers', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><button class="settings-nav-item" data-cat="mcp" data-count-own="1">MCP servers <span class="settings-nav-count"></span></button><div id="body"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only' });
  try {
    const ctx = dom.getInternalVMContext();
    for (const rel of ['lib/utils.js', '../shared/external-mcp-validate.js', '../shared/external-mcp-form.js', 'panels/settings-external-mcp.js']) {
      vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
    }
    const { window } = dom;
    const mod = window.settingsExternalMcp;
    const body = window.document.body;
    const host = window.document.getElementById('body');
    const badge = body.querySelector('.settings-nav-count');
    host.innerHTML = mod.sectionHtml([
      { name: 'one', transport: 'stdio', command: 'x' },
      { name: 'two', transport: 'stdio', command: 'x' },
    ]);
    mod.bind(body, new window.AbortController().signal);
    assert.strictEqual(badge.textContent, '2');
    assert.strictEqual(badge.hidden, false);
    host.querySelectorAll('.sv-mcp-card')[0].querySelectorAll('button')[1].click(); // Remove
    assert.strictEqual(badge.textContent, '1');
    host.querySelector('.sv-mcp-card').querySelectorAll('button')[1].click();
    assert.strictEqual(badge.textContent, '');
    assert.strictEqual(badge.hidden, true);
  } finally { dom.window.close(); }
});

// #789 slice B: editing an already-rejected entry into a duplicate name is refused inline (rejections are compared
// by entry identity, not by index).
test('settings-external-mcp: editing an already-rejected entry into a duplicate name is refused inline', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="body"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only' });
  try {
    const ctx = dom.getInternalVMContext();
    for (const rel of ['lib/utils.js', '../shared/external-mcp-validate.js', '../shared/external-mcp-form.js', 'panels/settings-external-mcp.js']) {
      vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
    }
    const { window } = dom;
    const mod = window.settingsExternalMcp;
    const body = window.document.getElementById('body');
    body.innerHTML = mod.sectionHtml([
      { name: 'broken', transport: 'stdio' },
      { name: 'docs', transport: 'stdio', command: 'x' },
    ]);
    mod.bind(body, new window.AbortController().signal);
    const ta = body.querySelector('#sv-external-mcp');
    const host = body.querySelector('#sv-external-mcp-form');
    const snapshot = ta.value;
    body.querySelectorAll('.sv-mcp-card')[0].querySelector('button').click();
    const input = (label) => Array.from(host.querySelectorAll('.sv-mcp-form-field'))
      .find(f => f.querySelector('.settings-label').textContent === label).querySelector('input');
    input('Name').value = 'docs';
    input('Command').value = 'y';
    Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Save changes').click();
    assert.ok(host.querySelector('.sv-mcp-form'), 'the form stays open');
    assert.match(host.querySelector('.sv-mcp-form-msg').textContent, /duplicate|already/i);
    assert.strictEqual(ta.value, snapshot, 'the JSON is unchanged');
  } finally { dom.window.close(); }
});
