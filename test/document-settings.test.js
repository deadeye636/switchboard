'use strict';
// #755: the two document-preview settings. `documentPreview` ('card' | 'inline', default card) and
// `documentPreviewMaxKB` (64-65536, default 2048). The renderer helpers are loaded from the real
// jsonl-viewer.js; the settings screen's wiring is pinned by reading its source, because the panel needs a
// whole settings window to run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { stripComments } = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function setup(globalSettings) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const w = dom.window;
  w.api = new Proxy({}, { get: () => () => {} });
  const ctx = vm.createContext(w);
  vm.runInContext(read('src/shared/partial-args.js'), ctx);
  vm.runInContext(read('src/renderer/session/subagent-live.js'), ctx);
  vm.runInContext('function escapeHtml(s) { return String(s); }', ctx);
  if (globalSettings !== undefined) {
    ctx.__settings = globalSettings;
    vm.runInContext('var appGlobalSettings = __settings;', ctx);
  }
  vm.runInContext(read('src/renderer/jsonl/jsonl-viewer.js'), ctx);
  return {
    mode: () => vm.runInContext('documentPreviewMode()', ctx),
    maxBytes: () => vm.runInContext('documentPreviewMaxBytes()', ctx),
  };
}

test('defaults: card, 2048 KB, with no settings object at all', () => {
  const h = setup();
  assert.equal(h.mode(), 'card');
  assert.equal(h.maxBytes(), 2048 * 1024);
  const e = setup({});
  assert.equal(e.mode(), 'card');
  assert.equal(e.maxBytes(), 2048 * 1024);
});

test('documentPreview: inline is honoured, anything else is card', () => {
  assert.equal(setup({ documentPreview: 'inline' }).mode(), 'inline');
  assert.equal(setup({ documentPreview: 'card' }).mode(), 'card');
  assert.equal(setup({ documentPreview: 'bogus' }).mode(), 'card');
  assert.equal(setup({ documentPreview: 1 }).mode(), 'card');
});

test('documentPreviewMaxKB: a value in range is used', () => {
  assert.equal(setup({ documentPreviewMaxKB: 64 }).maxBytes(), 64 * 1024);
  assert.equal(setup({ documentPreviewMaxKB: 512 }).maxBytes(), 512 * 1024);
  assert.equal(setup({ documentPreviewMaxKB: 65536 }).maxBytes(), 65536 * 1024);
});

test('documentPreviewMaxKB: junk and out-of-range fall back to the default', () => {
  for (const bad of [0, 63, 65537, -5, NaN, Infinity, '512', null, {}, undefined]) {
    assert.equal(setup({ documentPreviewMaxKB: bad }).maxBytes(), 2048 * 1024, String(bad));
  }
});

test('the settings screen reads, renders and saves both keys', () => {
  const panel = stripComments(read('src/renderer/panels/settings-panel.js'));
  const html = stripComments(read('src/renderer/panels/settings-global-html.js'));
  assert.match(panel, /fieldValue\('documentPreview', 'card'\)/);
  assert.match(panel, /fieldValue\('documentPreviewMaxKB', 2048\)/);
  assert.match(panel, /settings\.documentPreview = [^;]*'inline' \? 'inline' : 'card'/);
  assert.match(panel, /settings\.documentPreviewMaxKB = Number\.isFinite\(kb\) \? Math\.max\(64, Math\.min\(65536, kb\)\) : 2048/);
  assert.match(html, /id="sv-document-preview" class="settings-select"/);
  assert.match(html, /class="settings-input settings-input-compact" id="sv-document-preview-max-kb" min="64" max="65536"/);
  // Both names travel from the panel to the markup builder.
  assert.equal((panel.match(/documentPreviewValue, documentPreviewMaxKBValue/g) || []).length, 1);
  assert.equal((html.match(/documentPreviewValue, documentPreviewMaxKBValue/g) || []).length, 1);
});

test('docs/settings-reference.md lists both keys with the real defaults', () => {
  const doc = read('docs/settings-reference.md');
  assert.match(doc, /\| `documentPreview` \|[^\n]*\| `card` \| global \|/);
  assert.match(doc, /\| `documentPreviewMaxKB` \|[^\n]*\| `2048` \| global \|/);
});
