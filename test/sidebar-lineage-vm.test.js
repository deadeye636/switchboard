'use strict';
// vm.runInContext tests for shell/sidebar-lineage.js — the #193 provenance rendering (Model A). Loads the
// REAL source into a jsdom vm context, injects the app.js maps it reads, and asserts the chain walk, the
// idle-ancestor fold, and the caption/thread DOM. The renderer has no behavioural test for most of itself,
// so this pins the pure lineage logic; the live click (drive-app) covers the wiring.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

function setup(sessions = [], { running = [], active = null } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();

  window.sessionMap = new Map(sessions.map(s => [s.sessionId, s]));
  window.activePtyIds = new Set(running);
  window.pendingSessions = new Set();
  window.activeSessionId = active;
  window.cleanDisplayName = (s) => s || '';
  window.ariaButton = (el) => el; // a11y decoration is not the subject here
  // Ancestors render as full session rows (buildSessionItem lives in sidebar-session-row.js, not loaded
  // here); stub it to an id-bearing .session-item so the thread structure is testable.
  const builtWith = [];
  window.buildSessionItem = (s, opts = {}) => {
    builtWith.push({ sessionId: s.sessionId, opts });
    const el = window.document.createElement('div');
    el.className = 'session-item';
    el.dataset.sessionId = s.sessionId;
    return el;
  };

  vm.runInContext(fs.readFileSync(path.join(REN, 'shell/sidebar-lineage.js'), 'utf8'), ctx, { filename: 'shell/sidebar-lineage.js' });
  const call = (name, ...args) => vm.runInContext(name, ctx)(...args);
  return { window, call, builtWith, destroy: () => window.close() };
}

const sess = (id, over = {}) => ({ sessionId: id, summary: id, ...over });

test('lineageAncestorChain walks up the parent links, newest → oldest, and stops at the root', () => {
  const s = setup([sess('root'), sess('mid', { lineageParentId: 'root' }), sess('leaf', { lineageParentId: 'mid' })]);
  try {
    const chain = [...s.call('lineageAncestorChain', { sessionId: 'leaf', lineageParentId: 'mid' })];
    assert.deepEqual(chain.map(x => x.sessionId), ['mid', 'root']);
  } finally { s.destroy(); }
});

test('lineageAncestorChain is cycle-safe', () => {
  const s = setup([sess('a', { lineageParentId: 'b' }), sess('b', { lineageParentId: 'a' })]);
  try {
    const chain = [...s.call('lineageAncestorChain', { sessionId: 'a', lineageParentId: 'b' })];
    assert.ok(chain.length <= 2, 'a cycle does not loop forever');
  } finally { s.destroy(); }
});

test('foldedAncestorIds folds an idle referenced ancestor, but not a running or the active one', () => {
  const sessions = [sess('p'), sess('c', { lineageParentId: 'p' }), sess('pRun'), sess('cRun', { lineageParentId: 'pRun' }), sess('pAct'), sess('cAct', { lineageParentId: 'pAct' })];
  const s = setup(sessions, { running: ['pRun'], active: 'pAct' });
  try {
    const folded = s.call('foldedAncestorIds', sessions);
    assert.equal(folded.has('p'), true, 'an idle ancestor folds under its descendant');
    assert.equal(folded.has('pRun'), false, 'a running ancestor stays its own row');
    assert.equal(folded.has('pAct'), false, 'the active session stays its own row');
  } finally { s.destroy(); }
});

test('foldedAncestorIds ignores a parent that is not itself in the visible set', () => {
  const sessions = [sess('c', { lineageParentId: 'ghost' })];
  const s = setup(sessions);
  try {
    assert.equal(s.call('foldedAncestorIds', sessions).size, 0);
  } finally { s.destroy(); }
});

test('buildLineageThread renders a toggle and one collapsed ancestor row per ancestor', () => {
  const s = setup([sess('root', { summary: 'Root' }), sess('mid', { summary: 'Mid', lineageParentId: 'root' })]);
  try {
    const thread = s.call('buildLineageThread', { sessionId: 'leaf', lineageParentId: 'mid' });
    const toggle = thread.querySelector('.session-lineage-toggle');
    assert.match(toggle.textContent, /2 earlier/);
    assert.ok(toggle.classList.contains('sidebar-children-caret'), 'reuses the subagent caret look');
    assert.ok(toggle.querySelector('.caret-arrow'), 'has the shared caret arrow');
    // Ancestors are full .session-item rows (via buildSessionItem), newest → oldest.
    const rows = thread.querySelectorAll('.session-lineage-ancestors .session-item');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].dataset.sessionId, 'mid');
    assert.equal(rows[1].dataset.sessionId, 'root');
    assert.equal(thread.querySelector('.session-lineage-ancestors').style.display, 'none', 'collapsed by default');
    // The toggle must announce its state, not just look rotated: sidebar-events.js flips this on click
    // and sidebar.js carries it across a re-render (#229).
    assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'starts announced as collapsed');
    assert.equal(s.call('buildLineageThread', { sessionId: 'x' }), null, 'no chain → no thread');
  } finally { s.destroy(); }
});

test('an ancestor row is built as a COPY: no recursion, and no claim on the session DOM id', () => {
  const s = setup([sess('root'), sess('mid', { lineageParentId: 'root' })]);
  try {
    s.call('buildLineageThread', { sessionId: 'leaf', lineageParentId: 'mid' });
    // Lineage is a tree, so the same ancestor can render under several heads. A `si-<id>` on each copy is a
    // duplicate DOM id — which is exactly what morphdom keys node matching on (#288).
    for (const built of s.builtWith) {
      assert.equal(built.opts.noLineageThread, true, `${built.sessionId}: the flat chain must not recurse`);
      assert.equal(built.opts.ancestorCopy, true, `${built.sessionId}: an ancestor copy takes no DOM id`);
    }
    assert.equal(s.builtWith.length, 2);
  } finally { s.destroy(); }
});
