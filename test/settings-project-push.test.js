'use strict';
// A project-scope save has to reach the sidebar (#433).
//
// WHY THIS EXISTS:
//   The display name a project renders under lives in its `project:<path>` settings blob, and the sidebar
//   re-derives it from there on every projects-changed push. Nothing pushed on that save: main pushed for
//   the `global` key only, and the renderer half was a `loadProjects()` call in the settings pop-out —
//   a function that lives in app.js, which that window does not load. So a rename sat in the database and
//   the sidebar kept the old name until an unrelated index event happened to fire, which on an idle app is
//   an unbounded wait rather than a slow one.
//
//   The push belongs on the main side, which is what this pins: every window's copy of the list is stale
//   after such a save, not just the sender's, and the sender may have no list at all.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const settings = require('../src/app/settings');

// Wire the module against a fake ctx and return { handlers, pushes, written }. `stored` is the blob
// store merge-setting reads back through — set-setting never looks at it.
function wire(stored = {}) {
  const written = [];
  const pushes = [];
  const handlers = new Map();
  settings.init({
    db: {
      getSetting: (key) => stored[key] || null,
      setSetting: (key, value) => { written.push({ key, value }); stored[key] = value; },
    },
    log: { info() {}, warn() {}, error() {} },
    startBackendWatchers: () => {},
    indexWorker: { postReconcile: () => {} },
    notifyRendererProjectsChanged: () => pushes.push(true),
  });
  settings.registerIpc({ on() {}, handle: (ch, fn) => handlers.set(ch, fn) });
  return { handlers, pushes, written };
}

test('saving a project blob pushes projects-changed so the sidebar re-derives the name', () => {
  const { handlers, pushes, written } = wire();

  handlers.get('set-setting')(null, 'project:/x/y', { displayName: 'Renamed' });

  assert.equal(written.length, 1, 'the blob still reaches the database');
  assert.equal(pushes.length, 1, 'and the renderer is told — without this the sidebar waits on an unrelated event');
});

test('the global save keeps its own push (the backend re-arm path)', () => {
  const { handlers, pushes } = wire();

  handlers.get('set-setting')(null, 'global', { sidebarWidth: 400 });

  assert.equal(pushes.length, 1);
});

// The push is scoped to keys that can change the project list. A window rectangle is written through the
// same door and must not cost a sidebar rebuild.
test('an unrelated key does not push', () => {
  const { handlers, pushes } = wire();

  handlers.get('set-setting')(null, 'window-bounds', { x: 0, y: 0 });

  assert.equal(pushes.length, 0);
});

// The OTHER door (#434). `merge-setting` writes without going through persistSettingsBlob on purpose —
// it fires per drag frame and must not re-arm the backend watchers — and skipped the push with it. It
// gates on the CHANGE rather than the key, so the frequency that justifies the shortcut stays free.
test('merging a new display name into a project blob pushes', () => {
  const { handlers, pushes } = wire({ 'project:/x/y': { displayName: 'Before', tabOrder: ['a'] } });

  handlers.get('merge-setting')(null, 'project:/x/y', { displayName: 'After' });

  assert.equal(pushes.length, 1, 'the list renders that field, so it has to be told');
});

test('a per-project partial that leaves the display name alone does not push', () => {
  const { handlers, pushes, written } = wire({ 'project:/x/y': { displayName: 'Before' } });

  handlers.get('merge-setting')(null, 'project:/x/y', { tabOrder: ['a', 'b'] });

  assert.equal(written.length, 1, 'it is still written');
  assert.equal(pushes.length, 0, 'a sidebar rebuild per drag frame is what this door exists to avoid');
  assert.equal(written[0].value.displayName, 'Before', 'and the merge kept the rest of the blob');
});

test('the global door still never pushes on a merge', () => {
  const { handlers, pushes } = wire({ global: { sidebarWidth: 340 } });

  handlers.get('merge-setting')(null, 'global', { sidebarWidth: 420 });

  assert.equal(pushes.length, 0, 'the sidebar drag is the caller this shortcut was built for');
});

// The renderer half of #433: the dead branch is gone and must not come back. `loadProjects` is app.js's,
// and settings-panel.js also runs in the pop-out, where that name resolves to nothing.
test('the settings panel no longer reaches for app.js\'s loadProjects', () => {
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'panels', 'settings-panel.js'), 'utf8');
  const code = panel.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /\bloadProjects\b/,
    'a call that only resolves in the main window is dead in the settings pop-out — main pushes instead');
});
