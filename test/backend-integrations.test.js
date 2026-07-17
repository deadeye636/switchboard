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

// The point of the whole exercise: the panel renders the declaration, it does not know who declared it.
test('the settings surface names no backend', () => {
  for (const rel of [
    'src/renderer/panels/backends-panel.js',
    'src/renderer/panels/settings-panel.js',
  ]) {
    const src = read(rel);
    // Strip comments first — prose may name a backend to explain WHY; code may not.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const backend of BACKENDS) {
      assert.ok(!code.includes(`id === '${backend.id}'`),
        `${rel} branches on the backend id "${backend.id}" — the descriptor must carry that, not the panel`);
    }
  }
});
