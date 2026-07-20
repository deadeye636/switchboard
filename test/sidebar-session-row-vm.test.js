// vm.runInContext tests for shell/sidebar-session-row.js — buildSessionItem (#218 opt3).
//
// WHY THIS EXISTS:
//   buildSessionItem is the sidebar row builder, and its provider-badge and Fork-button visibility are
//   the exact surface #225 regressed: a `|| 'claude'` fallback made every row assert a default backend the
//   user might not run, so a badge appeared where it should not and Fork was offered on a backend that
//   cannot do it. That logic lives INSIDE this function, in the renderer, which has no behavioural test for
//   most of itself — a green suite only ever said "the main process still loads". This loads the REAL
//   source into a jsdom vm context and calls buildSessionItem, so:
//     - a name it reads that nothing in the context defines is a ReferenceError HERE, in node --test,
//       instead of a blank row in front of a user (the settingsViewerBody class of bug);
//     - and the badge / Fork visibility rules are asserted against the produced DOM, #225 included.
//
//   The cross-module helpers it calls (getSessionStatus, getSessionHealth, formatDate, …) are stubbed:
//   they are not what this test is about, and their own dangling references belong to their own files.
//   What is NOT stubbed is the backend-registry surface (sessionBackendId, _defaultBackendId,
//   _showAllBadges, getBackend) — that is the thing under test, driven per scenario.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

// Build a context with everything buildSessionItem reaches for. `backend` shapes the registry surface
// under test; everything else is a minimal stub so the row renders without the helpers being the subject.
function setup(backend = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();

  // The app.js maps buildSessionItem reads (bare, at call time). Real Maps so the classes reflect them.
  const state = {
    activePtyIds: new Set(),
    attentionSessions: new Set(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map(),
    subagentActiveSessions: new Set(),
    lastActivityTime: new Map(),
  };
  Object.assign(window, state);

  // Cross-module helper stubs — not the subject; each returns the shape the row reads.
  window.formatDate = () => 'just now';
  window.cleanDisplayName = (s) => s || '';
  window.getSessionStatus = () => ({ className: 'status-active', label: 'Active' });
  window.getSessionRuntimeState = () => ({});
  window.getSessionHealth = () => ({ className: 'health-ok', label: 'OK', state: 'healthy' });
  window.getQuietDetailParts = () => [];
  window.getWorktreeLabel = () => '';
  window.ICONS = { archive: () => '<svg/>', launchConfig: () => '<svg/>' };
  window.getSessionRuntimeState = () => ({});

  // The registry surface under test. `sessionBackendId` and `getBackend` are read as window.* in the badge
  // block and bare in the Fork block; in a jsdom vm context the global IS window, so setting them on window
  // satisfies both — exactly as the UMD Object.assign(window, …) does in the browser.
  window.sessionBackendId = backend.sessionBackendId || ((s) => s.backendId || 'claude');
  window._defaultBackendId = backend.defaultBackendId ?? 'claude';
  window._showAllBadges = backend.showAllBadges ?? false;
  window.getBackend = backend.getBackend || (() => null);
  window.backendMonogram = (id) => id.slice(0, 2).toUpperCase();

  // Real a11y-utils so ariaButton (and its siblings) resolve exactly as in the browser.
  for (const rel of ['lib/a11y-utils.js', 'shell/sidebar-session-row.js']) {
    vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  }

  const build = (session) => vm.runInContext('buildSessionItem', ctx)(session);
  return { window, state, build, destroy: () => window.close() };
}

const SESSION = { sessionId: 's1', name: 'Demo', modified: '2026-07-17T00:00:00Z', type: 'session' };

test('buildSessionItem renders a session row without a dangling reference', () => {
  const { build, destroy } = setup();
  try {
    const item = build(SESSION);
    assert.equal(item.className.includes('session-item'), true);
    assert.equal(item.dataset.sessionId, 's1');
    assert.equal(item.querySelector('.session-summary').textContent, 'Demo');
    // Default backend, single-backend user → no provider badge.
    assert.equal(item.querySelector('.session-backend-badge'), null);
  } finally { destroy(); }
});

test('the map state paints the row classes it drives', () => {
  const { build, state, destroy } = setup();
  try {
    state.activePtyIds.add('s1');
    state.attentionSessions.add('s1');
    state.responseReadySessions.add('s1');
    state.sessionBusyState.set('s1', true);
    state.subagentActiveSessions.add('s1');
    const item = build(SESSION);
    for (const c of ['has-running-pty', 'needs-attention', 'response-ready', 'cli-busy', 'subagent-active']) {
      assert.equal(item.classList.contains(c), true, `expected class ${c}`);
    }
    // The dot is driven by status.className now (#254), not a bare `running` toggle. getSessionStatus is
    // stubbed here, so the dot wears the stub's className — the point is the WIRING: dot follows status,
    // no longer the raw activePtyIds flag. (The status resolution itself is covered in session-status.test.js.)
    assert.equal(item.querySelector('.session-status-dot').classList.contains('status-active'), true);
    assert.equal(item.querySelector('.session-status-dot').classList.contains('running'), false);
  } finally { destroy(); }
});

// --- Provider badge visibility: the #225 surface ---

test('badge appears in mixed mode (_showAllBadges)', () => {
  const { build, destroy } = setup({ showAllBadges: true });
  try {
    const badge = build(SESSION).querySelector('.session-backend-badge');
    assert.notEqual(badge, null, 'mixed mode should badge every row');
  } finally { destroy(); }
});

test('badge appears on a non-default row', () => {
  const { build, destroy } = setup({
    defaultBackendId: 'claude',
    sessionBackendId: () => 'codex',
  });
  try {
    const badge = build({ ...SESSION, backendId: 'codex' }).querySelector('.session-backend-badge');
    assert.notEqual(badge, null, 'a row that is not the default should badge');
    assert.equal(badge.classList.contains('backend-codex'), true);
  } finally { destroy(); }
});

test('NO badge when the default is unknown, even for a non-default backend (#225)', () => {
  // The #225 regression: _defaultBackendId is '' when nothing is launchable. With `|| "claude"` the row
  // would have compared codex against claude and wrongly badged. The fix makes the empty default mean
  // "no assumption to correct", so isNonDefault stays false and only _showAllBadges could badge.
  const { build, destroy } = setup({
    defaultBackendId: '',
    showAllBadges: false,
    sessionBackendId: () => 'codex',
  });
  try {
    const badge = build({ ...SESSION, backendId: 'codex' }).querySelector('.session-backend-badge');
    assert.equal(badge, null, 'an unknown default must not manufacture a badge');
  } finally { destroy(); }
});

test('a terminal row carries no provider badge at all', () => {
  const { build, destroy } = setup({ showAllBadges: true });
  try {
    const item = build({ ...SESSION, type: 'terminal' });
    assert.equal(item.querySelector('.session-backend-badge'), null);
    assert.equal(item.classList.contains('is-terminal'), true);
  } finally { destroy(); }
});

// --- Fork button visibility: the other #225 surface ---

test('Fork is offered only when the backend supports it', () => {
  const withFork = setup({ getBackend: () => ({ supportsFork: true, label: 'Claude' }) });
  try {
    assert.notEqual(withFork.build(SESSION).querySelector('.session-fork-btn'), null);
  } finally { withFork.destroy(); }

  const noFork = setup({ getBackend: () => ({ supportsFork: false, label: 'Codex' }) });
  try {
    assert.equal(noFork.build(SESSION).querySelector('.session-fork-btn'), null);
  } finally { noFork.destroy(); }
});

test('a profile backend forks like Claude; an unknown backend does not', () => {
  const profile = setup({ getBackend: () => ({ isProfile: true }) });
  try {
    assert.notEqual(profile.build(SESSION).querySelector('.session-fork-btn'), null);
  } finally { profile.destroy(); }

  const unknown = setup({ getBackend: () => null });
  try {
    assert.equal(unknown.build(SESSION).querySelector('.session-fork-btn'), null);
  } finally { unknown.destroy(); }
});
