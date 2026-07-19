// One setting, one default (#237).
//
// WHY THIS EXISTS:
//   `visibleSessionCount` had two. `SETTING_DEFAULTS` in the main process said 5; the renderer carried its
//   own `let visibleSessionCount = 10`. Only the second one ever applied — the sidebar reads the RAW
//   `global` blob, so an unsaved key never reached the `!= null` check and the renderer kept its literal,
//   while the 5 left the main process only through get-effective-settings, whose callers do not read it.
//   A default that looks authoritative, is listed in the cascade, and reaches nothing.
//
//   The renderer now takes the value from the cascade at boot, so its literal is only the first-paint
//   value. That is a fine thing to have — but it silently becomes a second default again the moment the
//   two numbers drift, and nothing else in the suite would notice. So: pin them equal.
//
//   Read as TEXT on purpose. app.js is a classic script that cannot be required, and the point here is
//   not what the code does at runtime (the boot path is what does that) — it is that two literals in two
//   processes still say the same thing.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const settings = require('../src/app/settings');
const APP_JS = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');

test('the renderer\'s first-paint value matches SETTING_DEFAULTS', () => {
  const defaults = settings.SETTING_DEFAULTS;
  assert.equal(typeof defaults, 'object', 'SETTING_DEFAULTS must be exported for this to be checkable');

  const m = /let visibleSessionCount = (\d+);/.exec(APP_JS);
  assert.ok(m, 'app.js must still declare a first-paint visibleSessionCount (rename? update this test)');
  assert.equal(Number(m[1]), defaults.visibleSessionCount,
    'the renderer\'s starting value and the cascade default must agree — two numbers is how #237 happened');
});

test('the renderer reads the effective setting at boot instead of trusting its literal', () => {
  assert.match(APP_JS, /getEffectiveSettings\(null\)/,
    'the boot must ask the cascade for visibleSessionCount; without it an unsaved key keeps the literal');
});

// #239: sessionMaxAgeDays and autoHideDays are global-only ON PURPOSE — but that is a statement about
// SCOPE, not a licence to scatter their defaults. They were four literals over three files, which is the
// same shape #237 had to be dug out of: independent numbers that agree until someone edits one.
//
// GLOBAL_ONLY_DEFAULTS is the single source; projects.js requires it directly, and the renderer — which
// cannot require a main-process module — is pinned against it here.
const PANEL_JS = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'panels', 'settings-panel.js'), 'utf8');

test('the renderer\'s sessionMaxAgeDays literals match GLOBAL_ONLY_DEFAULTS', () => {
  const want = settings.GLOBAL_ONLY_DEFAULTS.sessionMaxAgeDays;

  const boot = /let sessionMaxAgeDays = (\d+);/.exec(APP_JS);
  assert.ok(boot, 'app.js must still declare a starting sessionMaxAgeDays (renamed? update this test)');
  assert.equal(Number(boot[1]), want, 'app.js and the single source must agree');

  const read = /fieldValue\('sessionMaxAgeDays', (\d+)\)/.exec(PANEL_JS);
  assert.ok(read, 'the panel must still read sessionMaxAgeDays with a fallback');
  assert.equal(Number(read[1]), want, 'what the panel SHOWS when unset must be the same number');

  const write = /parseLimit\('#sv-max-age', (\d+)\)/.exec(PANEL_JS);
  assert.ok(write, 'the panel must still parse #sv-max-age with a fallback');
  assert.equal(Number(write[1]), want, 'and what it WRITES back on an empty field must match too');
});

test('the renderer\'s autoHideDays literals match GLOBAL_ONLY_DEFAULTS', () => {
  const want = settings.GLOBAL_ONLY_DEFAULTS.autoHideDays;

  const read = /fieldValue\('autoHideDays', (\d+)\)/.exec(PANEL_JS);
  assert.ok(read, 'the panel must still read autoHideDays with a fallback');
  assert.equal(Number(read[1]), want);

  // The write path is `parseInt(...) || 0` — the `|| 0` IS the default, so it has to be the same number.
  const write = /querySelector\('#sv-auto-hide-days'\)\.value\) \|\| (\d+)/.exec(PANEL_JS);
  assert.ok(write, 'the panel must still parse #sv-auto-hide-days with a fallback');
  assert.equal(Number(write[1]), want);
});
