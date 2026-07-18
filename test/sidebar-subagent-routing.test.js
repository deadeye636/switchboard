// vm.runInContext tests for shell/sidebar-events.js — the subagent branch of dispatchSidebarActivation
// (#234).
//
// WHY THIS EXISTS:
//   Clicking a session row either resumes it in a terminal (openSession) or, for a subagent, opens its
//   read-only transcript (showSubagentTranscript). The branch keys on `session.parentSessionId` — a FIELD —
//   and not on the row's markup. That is not a style choice: during a search the sidebar renders subagents
//   as ordinary top-level rows (`nestSubagents === false`), stripped of the `.sidebar-subagent` nesting. A
//   markup check would pass every normal review, work in the tree view, and try to PTY-resume every
//   subagent in the search view — a class of bug the suite could not see, because nothing tests this file.
//
//   So: three shapes, one rule. Nested row and flat row both route to the transcript; a row that merely
//   LOOKS like a subagent (the class, no field) still opens a session.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

// Build a jsdom context holding just what the session-row branch of the dispatcher reaches for at click
// time. Everything else in the file is parse-time-inert (its own header says so), so it loads without a
// DOM of its own.
function setup() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="sidebar-content"></div></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();

  const calls = { openSession: [], showSubagentTranscript: [] };
  window.sessionMap = new Map();
  window.openSession = (s) => calls.openSession.push(s);
  window.showSubagentTranscript = (s) => calls.showSubagentTranscript.push(s);
  // Read by the branches this test never reaches, but resolved bare — define them so a stray lookup is a
  // failed assertion here rather than a ReferenceError that hides the real result.
  window.getAllRenderableSessions = () => [];
  window.getSessionRuntimeState = () => ({});
  window.activeSessionId = null;

  vm.runInContext(fs.readFileSync(path.join(REN, 'shell', 'sidebar-events.js'), 'utf8'), ctx,
    { filename: 'shell/sidebar-events.js' });

  // Click the row's title, the way a user does — the dispatcher walks up from e.target.
  function clickRow({ session, nested }) {
    window.sessionMap.set(session.sessionId, session);
    const wrap = window.document.getElementById('sidebar-content');
    wrap.innerHTML = '';
    const row = window.document.createElement('div');
    row.className = 'session-item' + (nested ? ' sidebar-subagent' : '');
    row.dataset.sessionId = session.sessionId;
    const title = window.document.createElement('span');
    title.className = 'session-summary';
    row.appendChild(title);
    wrap.appendChild(row);
    vm.runInContext('dispatchSidebarActivation', ctx)({ target: title, stopPropagation() {} });
  }

  return { calls, clickRow, destroy: () => window.close() };
}

const SUBAGENT = { sessionId: 'sub:p1:a1', parentSessionId: 'p1', agentId: 'a1', subagentType: 'explorer' };
const PLAIN = { sessionId: 'p1' };

test('a nested subagent row opens its transcript, not a terminal', () => {
  const { calls, clickRow, destroy } = setup();
  try {
    clickRow({ session: SUBAGENT, nested: true });
    assert.deepEqual(calls.showSubagentTranscript.map(s => s.sessionId), ['sub:p1:a1']);
    assert.equal(calls.openSession.length, 0);
  } finally { destroy(); }
});

test('a FLAT subagent row — the search view, no nesting markup — routes the same way', () => {
  const { calls, clickRow, destroy } = setup();
  try {
    clickRow({ session: SUBAGENT, nested: false });
    assert.deepEqual(calls.showSubagentTranscript.map(s => s.sessionId), ['sub:p1:a1'],
      'the branch must key on parentSessionId, not on the row carrying .sidebar-subagent');
    assert.equal(calls.openSession.length, 0);
  } finally { destroy(); }
});

test('a normal session wearing the subagent class still opens a session', () => {
  const { calls, clickRow, destroy } = setup();
  try {
    clickRow({ session: PLAIN, nested: true });
    assert.deepEqual(calls.openSession.map(s => s.sessionId), ['p1']);
    assert.equal(calls.showSubagentTranscript.length, 0);
  } finally { destroy(); }
});
