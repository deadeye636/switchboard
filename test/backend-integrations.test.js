'use strict';
// #212 — the renderer must not name a backend, and `integrations` is what replaced the one place that
// still did (`if (backend.id === 'claude')` gated the block onto Claude's gear page).
//
// The declaration is now the whole contract, and it spans three files that nothing else ties together:
//   backends/<id>/index.js   declares the fields
//   main.js                  passes the declaration over IPC (`backends-list`)
//   backends-panel.js        renders whatever arrived
//   settings-panel.js        reads the control back at save time, BY ITS `domId`
//
// That last hop is a bare string shared across two files with no import between them: rename `domId` on
// one side and the toggle keeps rendering, keeps taking clicks, and silently stops saving. Nothing else
// in the suite would notice — settings-panel.js falls back to the stored value when the control is
// absent (deliberately: the gear page is usually not in the DOM). So the fallback that makes the save
// path safe is exactly what would hide the break. Hence this file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const claude = require('../src/backends/claude');
const codex = require('../src/backends/codex');
const agy = require('../src/backends/agy');
const hermes = require('../src/backends/hermes');
const pi = require('../src/backends/pi');

const BACKENDS = [claude, codex, agy, hermes, pi];

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('an integrations declaration is complete and typed', () => {
  for (const backend of BACKENDS) {
    if (!backend.integrations) continue;   // declaring none is the normal case, not a defect
    const spec = backend.integrations;
    assert.ok(spec.title, `${backend.id}: integrations needs a title — it is the section heading`);
    assert.ok(Array.isArray(spec.fields) && spec.fields.length,
      `${backend.id}: an integrations block with no fields renders an empty section`);
    for (const f of spec.fields) {
      assert.ok(f.id, `${backend.id}: an integration field needs an id — it IS the setting key`);
      assert.ok(f.domId, `${backend.id}.${f.id} needs a domId — settings-panel.js finds the control by it`);
      assert.equal(f.type, 'toggle',
        `${backend.id}.${f.id}: "toggle" is the only type backends-panel.js renders; a new one needs a branch there`);
      assert.ok(f.label, `${backend.id}.${f.id} needs a label — it is rendered`);
      assert.ok(f.description, `${backend.id}.${f.id} needs a description — every other settings control has one`);
    }
  }
});

// Declaring NO integrations is the normal case, so every test above passes vacuously for a backend that
// declares none — including Claude, if the declaration were ever dropped. It must not be: settings-panel.js
// still carries the other half (it writes the hook via `configureAttentionHook` when the value changes),
// so losing the declaration leaves a save path for a setting that has no control anywhere. The toggle
// would simply be gone from the UI, with the suite green.
test('claude still declares the attention hook — the save path has no other control', () => {
  const fields = ((claude.integrations || {}).fields || []).map(f => f.id);
  assert.ok(fields.includes('attentionHooks'),
    'claude must declare attentionHooks: settings-panel.js writes the hook on change, but only this declaration renders the toggle that changes it');
});

// The declaration is useless if it cannot reach the renderer. `backends-list` hand-picks the JSON-safe
// fields off the descriptor, so a capability that is not named there simply never arrives — which looks
// exactly like "the backend declares nothing" and renders nothing, with no error.
test('backends-list carries the integrations declaration over IPC', () => {
  assert.match(read('src/main.js'), /integrations:\s*b\.integrations/,
    'main.js `backends-list` must pass `integrations` through, or the panel never sees it');
});

// Every declared domId must be one settings-panel.js actually reads back. This is the hop with no
// import graph behind it.
test('every declared integration domId is read by the save path', () => {
  const savePath = read('src/renderer/panels/settings-panel.js');
  for (const backend of BACKENDS) {
    for (const f of (backend.integrations || {}).fields || []) {
      assert.ok(savePath.includes(`#${f.domId}`),
        `${backend.id}.${f.id}: settings-panel.js never reads #${f.domId}, so the toggle renders but never saves`);
      assert.ok(savePath.includes(`settings.${f.id}`),
        `${backend.id}.${f.id}: settings-panel.js never writes settings.${f.id}`);
    }
  }
});

// The other half of #212: dialogs.js used to emit Anthropic's logo as a raw SVG string, but only when the
// backend id read `claude`. The logo now lives in backend-icons.js's ART map and Claude reaches it by
// declaring `icon: 'anthropic'` — so the popover calls one code path for every backend.
//
// That declaration is a bare slug matched against a map in another file, with nothing importing either
// end: rename one side and Claude quietly falls back to a "C" monogram. Nobody would call that a crash,
// which is precisely why it needs a test rather than an eye.
test('a declared icon slug resolves to real artwork', () => {
  const src = read('src/renderer/backends/backend-icons.js');
  // The ART keys, read off the source — the renderer has no module system, so it cannot be required.
  const artBlock = src.slice(src.indexOf('var ART = {'), src.indexOf('function colourFor'));
  assert.ok(artBlock.includes("anthropic: {"), 'the ART map must still hold the anthropic artwork');
  assert.equal(claude.icon, 'anthropic',
    'claude declares the slug the ART map is keyed by; rename either side and the popover silently shows a monogram');
});

// The point of the whole exercise: the renderer renders what the descriptor declares, and does not know
// who declared it. #212's acceptance: these files "contain no backend id literal except where a comment
// states it is reading a legacy record".
//
// An earlier version of this test searched for the literal string `id === '<id>'` and was GREEN while
// `backends-panel.js` held `const isClaudeBase = () => baseId === 'claude'` — the capital I in `baseId`
// was enough to slip past it. A test that only finds the spelling you happened to remove is a test that
// certifies whatever you did not think of, so match the SHAPE instead: any comparison against a backend
// id, in either order, either quote style, `==` or `===`.
const ID_COMPARE = (id) => new RegExp(
  `(===?\\s*['"]${id}['"])|(['"]${id}['"]\\s*===?)`,
);

// Strip comments so prose may explain WHY a backend is named while code may not. Deliberately conservative:
// it does not try to understand string literals containing `//` or `/*`, so it can over-strip. That direction
// is safe here — over-stripping can only hide a violation from a test that is a backstop, and every file it
// runs on is checked by the allow-list below as well.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The names a file may bind a backend id to, each because it is NOT a guess: a record written before the
// multi-LLM era, or a coupling in another module that this file only reports. Anything else must resolve to
// the first launchable backend. Adding a name here is meant to be a deliberate act — say why.
const ALLOWED_BINDINGS = {
  'src/renderer/panels/backends-panel.js': [
    'LEGACY_TEMPLATE_BASE',      // a template record from before #161 carries no backendId
  ],
  'src/renderer/dialogs/dialogs.js': [
    'LEGACY_TEMPLATE_BASE',      // ditto, for a template's baseId
    'SCHEDULER_BACKEND',         // servers/schedule-runner.js writes Claude's transcript format, only
  ],
  'src/renderer/panels/settings-panel.js': [],
};

test('the renderer never branches on a backend id', () => {
  for (const rel of Object.keys(ALLOWED_BINDINGS)) {
    const code = stripComments(read(rel));
    for (const backend of BACKENDS) {
      const m = code.match(ID_COMPARE(backend.id));
      assert.equal(m, null,
        `${rel} compares against the backend id "${backend.id}" (${m && m[0]}) — the descriptor must carry that, not the renderer`);
    }
  }
});

test('the renderer names a backend only where it is binding a documented non-guess', () => {
  for (const [rel, allowed] of Object.entries(ALLOWED_BINDINGS)) {
    const code = stripComments(read(rel));
    for (const backend of BACKENDS) {
      // Every surviving occurrence of the id must be the right-hand side of one of the allowed bindings.
      const occurrences = (code.match(new RegExp(`['"]${backend.id}['"]`, 'g')) || []).length;
      const bound = allowed.reduce((n, name) =>
        n + (code.match(new RegExp(`${name}\\s*=\\s*['"]${backend.id}['"]`, 'g')) || []).length, 0);
      assert.equal(occurrences, bound,
        `${rel} spells "${backend.id}" ${occurrences}x but binds it ${bound}x — an id literal outside a documented binding is a guess (#212). Resolve it to the first launchable backend, or add a named constant here with the reason.`);
    }
  }
});
