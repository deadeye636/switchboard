// vm.runInContext tests for the LINEAGE branch of dispatchSidebarActivation (#288).
//
// WHY THIS EXISTS:
//   A folded lineage ancestor (#193, Model A) is rendered as a full `.session-item` NESTED INSIDE the head
//   row's `.session-item`. The row-open guard swallowed every click inside `.session-lineage-thread`, so an
//   ancestor row's action buttons all worked and only the open was dead — a state the suite could not see,
//   because nothing tested this file's lineage branch.
//
//   Three clicks, three outcomes: the ancestor row body opens THAT session; the toggle folds and opens
//   nothing; the thread's own gutter opens nothing (it belongs to the head, not to a row).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

const HEAD = { sessionId: 'child' };
const ANCESTOR = { sessionId: 'parent' };

// One head row with a collapsed thread holding one ancestor row — the DOM shape sidebar-lineage.js builds.
function setup() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="sidebar-content"></div></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  const doc = window.document;

  const calls = { openSession: [], showSubagentTranscript: [] };
  window.sessionMap = new Map([[HEAD.sessionId, HEAD], [ANCESTOR.sessionId, ANCESTOR]]);
  window.openSession = (s) => calls.openSession.push(s);
  window.showSubagentTranscript = (s) => calls.showSubagentTranscript.push(s);
  window.getAllRenderableSessions = () => [];
  window.getSessionRuntimeState = () => ({});
  window.activeSessionId = null;

  vm.runInContext(fs.readFileSync(path.join(REN, 'shell', 'sidebar-events.js'), 'utf8'), ctx,
    { filename: 'shell/sidebar-events.js' });

  const el = (cls, parent) => {
    const n = doc.createElement('div');
    n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  };
  const rowFor = (session, parent) => {
    const item = el('session-item', parent);
    item.dataset.sessionId = session.sessionId;
    const row = el('session-row', item);
    el('session-summary', row);
    return item;
  };

  const head = rowFor(HEAD, doc.getElementById('sidebar-content'));
  const thread = el('session-lineage-thread', head);
  const toggle = el('session-lineage-toggle sidebar-children-caret', thread);
  toggle.setAttribute('aria-expanded', 'false');
  const list = el('session-lineage-ancestors', thread);
  list.style.display = 'none';
  const ancestor = rowFor(ANCESTOR, list);

  const click = (target) =>
    vm.runInContext('dispatchSidebarActivation', ctx)({ target, stopPropagation() {} });

  return {
    calls, click, toggle, list,
    headTitle: head.querySelector('.session-row .session-summary'),
    ancestorTitle: ancestor.querySelector('.session-summary'),
    threadGutter: thread,
    destroy: () => window.close(),
  };
}

test('clicking a folded ancestor row opens THAT session, not the head', () => {
  const s = setup();
  try {
    s.click(s.ancestorTitle);
    assert.deepEqual(s.calls.openSession.map(x => x.sessionId), ['parent'],
      'the ancestor row is a real session row — the thread guard must not swallow its open');
  } finally { s.destroy(); }
});

test('clicking the head row still opens the head', () => {
  const s = setup();
  try {
    s.click(s.headTitle);
    assert.deepEqual(s.calls.openSession.map(x => x.sessionId), ['child']);
  } finally { s.destroy(); }
});

test('the "N earlier" toggle folds/unfolds and opens nothing', () => {
  const s = setup();
  try {
    s.click(s.toggle);
    assert.equal(s.list.style.display, '', 'first click expands');
    assert.equal(s.toggle.getAttribute('aria-expanded'), 'true');
    s.click(s.toggle);
    assert.equal(s.list.style.display, 'none', 'second click collapses');
    assert.equal(s.toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(s.calls.openSession.length, 0, 'the toggle is chrome, not a row');
  } finally { s.destroy(); }
});

test('a click on the thread itself — its indent gutter — opens nothing', () => {
  const s = setup();
  try {
    s.click(s.threadGutter);
    assert.equal(s.calls.openSession.length, 0,
      'the gutter belongs to the head\'s thread chrome; it must not resume the head');
  } finally { s.destroy(); }
});
