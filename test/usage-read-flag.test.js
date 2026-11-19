'use strict';
// #885: the settings pane's usage rows and the tray's backend choice follow `usage.read`, which main stamps in the
// `backends-list` projection from the registry's `usageReaders()` — not the backend's own `enabled`. Source checks:
// main.js and the settings panel have no seam a test can reach (Electron, a whole settings window).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripComments } = require('./helpers/strip-comments');

const read = (rel) => stripComments(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));

test('backends-list stamps usage.read from usageReaders(), computed once per projection', () => {
  const src = read('src/main.js');
  const handler = src.slice(src.indexOf("ipcMain.handle('backends-list'"));
  assert.match(handler.slice(0, 400), /usageReaders\(\)/, 'the set is built before the map');
  assert.match(handler, /usage: b\.usage \? \{ live: !!b\.usage\.live, read: usageRead\.has\(b\.id\) \}/);
  assert.equal((handler.slice(0, 20000).match(/usageReaders\(\)/g) || []).length, 1, 'once, not per backend');
});

test('the settings pane filters its usage rows on usage.read, not on enabled', () => {
  const src = read('src/renderer/panels/settings-panel.js');
  const m = src.match(/usageCapable = [\s\S]{0,400}?\.sort/);
  assert.ok(m, 'the filter is still where this test looks');
  assert.match(m[0], /b\.usage\.read === true/);
  assert.doesNotMatch(m[0], /\.enabled/);
});

test('no other renderer file decides "usage shown" from enabled', () => {
  for (const f of ['src/renderer/shell/statusbar-usage.js', 'src/renderer/shell/usage-status.js', 'src/renderer/views/stats-view.js', 'src/renderer/dialogs/welcome-tour.js']) {
    if (!fs.existsSync(path.join(__dirname, '..', f))) continue;
    assert.doesNotMatch(read(f), /\.usage\b[^;\n]*\.enabled|\.enabled[^;\n]*\.usage\b/, f);
  }
});
