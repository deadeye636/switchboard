// vm.runInContext tests for shell/sidebar.js's live-owner cache (#172, #607).
//
// WHY THIS EXISTS:
//   The sidebar holds the last list main broadcast and rebuilds only when it MOVED — a 45 s timer that
//   rebuilt the tree every tick would be the most expensive thing in the window. So the comparison is
//   load-bearing: whatever it fails to look at is a change the user never sees.
//
//   It was written against `kind` and `pid`, which were the whole entry at the time. `canStop` broke that
//   silently: it flips when the process behind an entry exits, while the session, the kind and the pid all
//   stay the same — so the row went on offering to stop a process that was gone. The suite could not see
//   it, and neither could a click: it needs a process to die between two polls.
//
//   Loaded the way the two sibling vm tests load it, with the same reasoning — the real source, not a
//   description of it.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

// `setLiveOwners` rebuilds the sidebar when the answer moved, so the count of those calls IS the subject
// here. Everything else is stubbed to the minimum sidebar.js touches on this path.
function setup() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();

  const renders = [];
  Object.assign(window, {
    refreshSidebar: () => renders.push(1),
    activePtyIds: new Set(),
    openSessions: new Map(),
    sortedOrder: [],
    lastActivityTime: new Map(),
  });

  vm.runInContext(fs.readFileSync(path.join(REN, 'lib/a11y-utils.js'), 'utf8'), ctx, { filename: 'lib/a11y-utils.js' });
  vm.runInContext(fs.readFileSync(path.join(REN, 'lib/project-name.js'), 'utf8'), ctx, { filename: 'lib/project-name.js' });
  vm.runInContext(fs.readFileSync(path.join(REN, 'shell/sidebar.js'), 'utf8'), ctx, { filename: 'shell/sidebar.js' });

  const call = (name, ...args) => vm.runInContext(name, ctx)(...args);
  return { call, renders, destroy: () => window.close() };
}

const owner = (over = {}) => ({ sessionId: 's-1', kind: 'background', pid: 4242, canStop: true, ...over });

test('#172: an unchanged list does not rebuild the sidebar', () => {
  const { call, renders, destroy } = setup();
  try {
    call('setLiveOwners', [owner()]);
    assert.equal(renders.length, 1, 'the first answer is a change from nothing');
    call('setLiveOwners', [owner()]);
    assert.equal(renders.length, 1, 'a 45 s timer must not rebuild the tree for the same answer');
  } finally { destroy(); }
});

test('#607: canStop flipping IS a change, even when the session, kind and pid are identical', () => {
  const { call, renders, destroy } = setup();
  try {
    call('setLiveOwners', [owner({ canStop: true })]);
    assert.equal(renders.length, 1);
    // The process exited; the CLI still lists the session, under the same pid it always had. Only the
    // offer has become untrue — which is exactly what the row's tooltip says.
    call('setLiveOwners', [owner({ canStop: false })]);
    assert.equal(renders.length, 2, 'otherwise the row keeps offering to stop a process that is gone');
  } finally { destroy(); }
});

test('#172: a session leaving or joining the list is a change', () => {
  const { call, renders, destroy } = setup();
  try {
    call('setLiveOwners', [owner()]);
    call('setLiveOwners', []);
    assert.equal(renders.length, 2, 'the mark has to disappear when the session is free again');
    call('setLiveOwners', [owner({ sessionId: 's-2' })]);
    assert.equal(renders.length, 3, 'same size, different session');
  } finally { destroy(); }
});

test('#172: an entry with no session id is not an entry', () => {
  const { call, renders, destroy } = setup();
  try {
    call('setLiveOwners', [null, {}, owner()]);
    assert.equal(renders.length, 1);
    assert.equal(call('liveOwnerFor', 's-1').pid, 4242);
    assert.equal(call('liveOwnerFor', 'nobody'), null);
  } finally { destroy(); }
});
