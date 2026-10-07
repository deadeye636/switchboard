// #752 — the Stats view counts a session of an owner/driver pair under the OWNER, whichever view it opens in.
//
// A GUI driver (`transcriptsOf`) runs its owner's binary on its owner's store, and the DB files its sessions
// under the owner. The per-backend breakdown used to bucket by the opener a row carries, so one CLI's work was
// split across two cards depending on the view each session was last opened in; the filter bar offered the
// driver a pill of its own that scoped every chart to nothing. Same harness as stats-cost.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC_DIR = path.join(__dirname, '..', 'src');
const INDEX_HTML = `<!DOCTYPE html><html><body><div id="stats-viewer-body"></div></body></html>`;

// Neutral ids on purpose: the rule is the descriptor's `transcriptsOf`, not any backend's name.
const OWNER = { id: 'owner', label: 'Owner CLI', monogram: 'O', status: 'ready', enabled: true };
const DRIVER = { id: 'owner-gui', label: 'Owner CLI (GUI)', monogram: 'Og', status: 'ready', enabled: true, transcriptsOf: 'owner' };
const OTHER = { id: 'other', label: 'Other CLI', monogram: 'X', status: 'ready', enabled: true };
const TEMPLATE = { id: 'tpl-1', label: 'My template', status: 'ready', enabled: true, isProfile: true, baseId: 'owner' };

function evalInWindow(dom, file) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), dom.getInternalVMContext(), { filename: file });
}

function setup({ backends, launchable, sessions, defaultId = '' }) {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  const byId = Object.fromEntries(backends.map(b => [b.id, b]));
  const stubs = {
    statsViewerBody: window.document.getElementById('stats-viewer-body'),
    cachedAllProjects: [{ projectPath: '/p', sessions }],
    sessionBackendId: (s) => s.backendId,
    getBackend: (id) => byId[id] || null,
    launchableBackends: () => launchable,
    renderBackendIcon: () => window.document.createElement('span'),
    _defaultBackendId: defaultId,
  };
  for (const [k, v] of Object.entries(stubs)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }
  evalInWindow(dom, path.join(SRC_DIR, 'renderer', 'lib', 'utils.js'));
  evalInWindow(dom, path.join(SRC_DIR, 'renderer', 'views', 'stats-view.js'));
  return window;
}

const SESSIONS = [
  { sessionId: 'a', backendId: 'owner', messageCount: 3 },
  { sessionId: 'b', backendId: 'owner-gui', messageCount: 5 },
  { sessionId: 'c', backendId: 'other', messageCount: 2 },
  { sessionId: 'd', backendId: 'tpl-1', messageCount: 1 },
];

test('a GUI session is counted under its owner, beside the owner\'s terminal sessions', () => {
  const w = setup({ backends: [OWNER, DRIVER, OTHER, TEMPLATE], launchable: [OWNER, DRIVER, OTHER, TEMPLATE], sessions: SESSIONS });
  const usage = w.collectBackendUsage();
  assert.deepEqual([...usage.keys()].sort(), ['other', 'owner', 'tpl-1']);
  assert.equal(usage.get('owner').sessions, 2);
  assert.equal(usage.get('owner').messages, 8);
  assert.equal(usage.has('owner-gui'), false);
});

test('the owner bucket holds when only the GUI half is enabled', () => {
  // The case sessionViewOf answers null for (#670 E8): the terminal half cannot launch.
  const w = setup({ backends: [OWNER, DRIVER, OTHER], launchable: [DRIVER, OTHER], sessions: SESSIONS.slice(0, 3) });
  const usage = w.collectBackendUsage();
  assert.equal(usage.get('owner').sessions, 2);
  assert.equal(usage.has('owner-gui'), false);
});

test('a template keeps its own bucket, as before', () => {
  const w = setup({ backends: [OWNER, DRIVER, TEMPLATE], launchable: [OWNER, DRIVER, TEMPLATE], sessions: SESSIONS });
  assert.equal(w.collectBackendUsage().get('tpl-1').sessions, 1);
});

function pillIds(w) {
  w.buildBackendFilterBar();
  return [...w.document.querySelectorAll('.backend-filter-pill')].map(b => b.dataset.backend);
}

test('the filter bar offers one pill per CLI, named by the owner', () => {
  const w = setup({ backends: [OWNER, DRIVER, OTHER], launchable: [OWNER, DRIVER, OTHER], sessions: SESSIONS });
  assert.deepEqual(pillIds(w), ['all', 'other', 'owner']);
});

test('with only the GUI half enabled, the pill is still the owner\'s, and a GUI default leads', () => {
  const w = setup({ backends: [OWNER, DRIVER, OTHER], launchable: [DRIVER, OTHER], sessions: SESSIONS, defaultId: 'owner-gui' });
  assert.deepEqual(pillIds(w), ['all', 'owner', 'other']);
  const ownerPill = w.document.querySelector('.backend-filter-pill[data-backend="owner"]');
  assert.match(ownerPill.textContent, /Owner CLI$/);
});
