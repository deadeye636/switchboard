// vm.runInContext tests for the single-row archive when the row heads a lineage thread (#499).
//
// WHY THIS EXISTS:
//   The sidebar folds a head's idle ancestors under the "N earlier" toggle (#193), and it decides what
//   is folded AFTER dropping archived rows. Archiving the head alone therefore did not clear the thread
//   — it promoted the ancestor into the head's place, so a thread of N sessions cost N archive clicks,
//   each of which looked like it had done nothing.
//
//   The scope is now asked once: Single, All, Cancel. That question is renderer-only, which is where the
//   suite normally sees nothing, so this loads the REAL dialog, the REAL lineage chain walk and the REAL
//   sidebar-events into one jsdom context and drives it end to end — open the dialog, press a button,
//   assert which sessions were archived and which were stopped.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');

function setup() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="sidebar-content"></div></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();

  const calls = { stopped: [], archived: [], unarchived: [], marked: [] };
  window.escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window.cleanDisplayName = s => (s ? String(s) : '');
  window.activePtyIds = new Set();
  window.pendingSessions = new Set();
  window.sessionMap = new Map();
  window.api = {
    stopSession: async id => { calls.stopped.push(id); window.activePtyIds.delete(id); },
    archiveSession: async (id, flag) => { (flag ? calls.archived : calls.unarchived).push(id); },
  };
  window._markUserStopped = id => calls.marked.push(id);
  window.pollActiveSessions = () => {};
  window.loadProjects = () => {};
  // Read by branches these tests never reach, but resolved bare — define them so a stray lookup fails
  // here instead of surfacing as a ReferenceError that hides the real result.
  window.getAllRenderableSessions = () => [];
  window.getSessionRuntimeState = () => ({});
  window.activeSessionId = null;
  window.launchPending = () => false;

  // sidebar-lineage.js comes along because `lineageAncestorChain` is what decides the scope — stubbing it
  // would test the dialog against a chain walk nobody runs.
  for (const rel of [['dialogs', 'control-dialogs.js'], ['shell', 'sidebar-lineage.js'], ['shell', 'sidebar-events.js']]) {
    vm.runInContext(fs.readFileSync(path.join(REN, ...rel), 'utf8'), ctx, { filename: rel.join('/') });
  }

  const doc = window.document;
  const dialog = () => doc.querySelector('.control-dialog');
  const confirmBtn = () => doc.querySelector('.control-dialog-confirm');
  const secondaryBtn = () => doc.querySelector('.control-dialog-secondary');
  const cancelBtn = () => doc.querySelector('.control-dialog-cancel');
  const details = () => Object.fromEntries([...doc.querySelectorAll('.control-dialog-detail-row')]
    .map(r => [r.querySelector('.control-dialog-detail-label').textContent,
      r.querySelector('.control-dialog-detail-value').textContent]));
  const toastText = () => doc.querySelector('.control-toast')?.textContent || '';
  const toastAction = () => doc.querySelector('.control-toast button');

  // The dialog renders synchronously inside the promise executor, but two async frames down. One
  // macrotask is enough and does not depend on how many awaits precede it.
  const tick = () => new Promise(r => window.setTimeout(r, 0));

  function session(id, { parent = null, running = false, archived = 0 } = {}) {
    const s = { sessionId: id, archived, projectPath: 'D:/Projekte/switchboard', name: id };
    if (parent) s.lineageParentId = parent;
    if (running) window.activePtyIds.add(id);
    window.sessionMap.set(id, s);
    return s;
  }

  const call = name => vm.runInContext(name, ctx);

  return {
    window, calls, session, tick, call,
    dialog, confirmBtn, secondaryBtn, cancelBtn, details, toastText, toastAction,
    destroy: () => window.close(),
  };
}

// A thread: root ← middle ← head. The head is the row the sidebar shows; the other two are folded.
function thread(t) {
  const root = t.session('root');
  const middle = t.session('middle', { parent: 'root' });
  const head = t.session('head', { parent: 'middle' });
  return { root, middle, head };
}

test('a head with folded ancestors asks for the scope, and "All" takes the whole thread', async () => {
  const t = setup();
  try {
    const { head } = thread(t);
    const done = t.call('archiveSessionFromRow')(head);
    await t.tick();

    assert.equal(t.confirmBtn().textContent, 'All');
    assert.equal(t.secondaryBtn().textContent, 'Single');
    assert.equal(t.cancelBtn().textContent, 'Cancel');
    assert.equal(t.details().Earlier, '2', 'the dialog says how many earlier sessions the thread holds');
    assert.equal(t.details().Running, undefined, 'nothing is running, so there is no Running row');

    t.confirmBtn().click();
    await done;

    assert.deepEqual(t.calls.archived, ['head', 'middle', 'root'],
      'the whole thread goes in one act — otherwise the ancestor just takes the head\'s place');
    assert.match(t.toastText(), /Archived 3 sessions/);
  } finally { t.destroy(); }
});

test('"Single" archives the row that was clicked and nothing else', async () => {
  const t = setup();
  try {
    const { head, middle, root } = thread(t);
    const done = t.call('archiveSessionFromRow')(head);
    await t.tick();
    t.secondaryBtn().click();
    await done;

    assert.deepEqual(t.calls.archived, ['head']);
    assert.equal(middle.archived, 0);
    assert.equal(root.archived, 0);
    assert.match(t.toastText(), /Session archived/);
  } finally { t.destroy(); }
});

test('cancel archives nothing, and neither does Escape', async () => {
  for (const dismiss of ['cancel', 'escape']) {
    const t = setup();
    try {
      const { head } = thread(t);
      const done = t.call('archiveSessionFromRow')(head);
      await t.tick();

      if (dismiss === 'cancel') t.cancelBtn().click();
      else t.window.document.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Escape' }));
      await done;

      assert.deepEqual(t.calls.archived, [], `${dismiss} must not archive`);
      assert.equal(head.archived, 0);
      assert.equal(t.dialog(), null, `${dismiss} closes the dialog`);
    } finally { t.destroy(); }
  }
});

test('a session with no ancestors keeps the old behaviour: no scope dialog at all', async () => {
  const t = setup();
  try {
    const lone = t.session('lone');
    await t.call('archiveSessionFromRow')(lone);

    assert.equal(t.dialog(), null, 'nothing to choose between, so nothing to ask');
    assert.deepEqual(t.calls.archived, ['lone']);
    assert.match(t.toastText(), /Session archived/);
  } finally { t.destroy(); }
});

test('a running session in the scope is named and stopped, not archived behind a live pty', async () => {
  const t = setup();
  try {
    t.session('root');
    const head = t.session('head', { parent: 'root', running: true });
    const done = t.call('archiveSessionFromRow')(head);
    await t.tick();

    assert.equal(t.details().Running, '1', 'the dialog says what it will have to stop');
    t.confirmBtn().click();
    await done;

    assert.deepEqual(t.calls.stopped, ['head']);
    assert.deepEqual(t.calls.marked, ['head'], 'a deliberate stop must not read as a crash');
    assert.deepEqual(t.calls.archived, ['head', 'root']);
  } finally { t.destroy(); }
});

test('a running session with no ancestors still gets its own stop-and-archive confirm', async () => {
  const t = setup();
  try {
    const lone = t.session('lone', { running: true });
    const done = t.call('archiveSessionFromRow')(lone);
    await t.tick();

    assert.equal(t.confirmBtn().textContent, 'Stop And Archive');
    t.confirmBtn().click();
    await done;

    assert.deepEqual(t.calls.stopped, ['lone']);
    assert.deepEqual(t.calls.archived, ['lone']);
  } finally { t.destroy(); }
});

test('the chain ends at an already-archived ancestor — the scope is what the toggle shows', async () => {
  const t = setup();
  try {
    t.session('root');
    t.session('middle', { parent: 'root', archived: 1 });
    const head = t.session('head', { parent: 'middle' });
    await t.call('archiveSessionFromRow')(head);

    assert.equal(t.dialog(), null,
      'an archived ancestor is out of the sidebar, so the head has no thread left to ask about');
    assert.deepEqual(t.calls.archived, ['head'], 'and the root above it is not swept in unnamed');
  } finally { t.destroy(); }
});

test('undo restores exactly the set that was archived', async () => {
  const t = setup();
  try {
    const { head, middle, root } = thread(t);
    const done = t.call('archiveSessionFromRow')(head);
    await t.tick();
    t.confirmBtn().click();
    await done;

    t.toastAction().click();
    await t.tick();

    assert.deepEqual(t.calls.unarchived, ['head', 'middle', 'root']);
    assert.deepEqual([head.archived, middle.archived, root.archived], [0, 0, 0]);
  } finally { t.destroy(); }
});

test('un-archiving stays a single-session act', async () => {
  const t = setup();
  try {
    t.session('root', { archived: 1 });
    const head = t.session('head', { parent: 'root', archived: 1 });
    await t.call('archiveSessionFromRow')(head);

    assert.equal(t.dialog(), null);
    assert.deepEqual(t.calls.unarchived, ['head'], 'bringing one row back says nothing about the rest');
    assert.equal(head.archived, 0);
  } finally { t.destroy(); }
});

// --- #501: the keyboard must not pick the widest answer ---------------------

test('the scope dialog opens focused on Single, and Enter there archives the row alone', async () => {
  const t = setup();
  try {
    const { head, middle, root } = thread(t);
    const done = t.call('archiveSessionFromRow')(head);
    await t.tick();

    assert.equal(t.window.document.activeElement, t.secondaryBtn(),
      'the confirm here is "All" — opening on it makes Enter the widest answer');

    // Enter with the button focused: the browser activates that button, and the dialog's own key
    // handler must keep its hands off, or the confirm answers first and "Single" is decoration.
    t.secondaryBtn().dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    t.secondaryBtn().click(); // what a real Enter on a focused <button> does
    await done;

    assert.deepEqual(t.calls.archived, ['head']);
    assert.equal(middle.archived, 0);
    assert.equal(root.archived, 0);
  } finally { t.destroy(); }
});

test('Enter outside the buttons still answers with the confirm', async () => {
  const t = setup();
  try {
    const { head } = thread(t);
    const done = t.call('archiveSessionFromRow')(head);
    await t.tick();

    t.dialog().dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await done;

    assert.deepEqual(t.calls.archived, ['head', 'middle', 'root'], 'the confirm is still what Enter means');
  } finally { t.destroy(); }
});

test('the running stop-and-archive dialog still opens on its confirm', async () => {
  const t = setup();
  try {
    const lone = t.session('lone', { running: true });
    const done = t.call('archiveSessionFromRow')(lone);
    await t.tick();

    assert.equal(t.window.document.activeElement, t.confirmBtn(),
      'a dialog that did not ask for anything else is unchanged');
    t.confirmBtn().click();
    await done;
    assert.deepEqual(t.calls.archived, ['lone']);
  } finally { t.destroy(); }
});

// --- #502: the scope is what the toggle folds, nothing above it -------------
//
// `foldedAncestorIds` folds an ancestor only while it is idle, not launch-pending and not the session
// on screen. A chain walked to the top could therefore hand "All" a session standing beside the clicked
// row as its own row — and stop it, for a number the dialog showed as `Earlier`.

test('the chain ends at a RUNNING ancestor, which the sidebar shows as its own row', async () => {
  const t = setup();
  try {
    t.session('root');
    t.session('middle', { parent: 'root', running: true });
    const head = t.session('head', { parent: 'middle' });
    await t.call('archiveSessionFromRow')(head);

    assert.equal(t.dialog(), null, 'nothing is folded under this head, so there is no scope to ask about');
    assert.deepEqual(t.calls.archived, ['head']);
    assert.deepEqual(t.calls.stopped, [], 'a running row beside the clicked one must not be stopped');
  } finally { t.destroy(); }
});

test('the chain ends at the ACTIVE session, and keeps the ancestors below it', async () => {
  const t = setup();
  try {
    t.session('root');
    t.session('middle', { parent: 'root' });
    const head = t.session('head', { parent: 'middle' });
    t.window.activeSessionId = 'middle';
    const done = t.call('archiveSessionFromRow')(head);
    await t.tick();

    assert.equal(t.dialog(), null, 'the only ancestor above the head is on screen, so nothing folds');
    await done;
    assert.deepEqual(t.calls.archived, ['head']);
  } finally { t.destroy(); }
});

test('a launch-pending ancestor ends the chain too', async () => {
  const t = setup();
  try {
    t.session('root');
    t.session('middle', { parent: 'root' });
    const head = t.session('head', { parent: 'middle' });
    t.window.launchPending = id => id === 'middle';
    await t.call('archiveSessionFromRow')(head);

    assert.equal(t.dialog(), null);
    assert.deepEqual(t.calls.archived, ['head']);
  } finally { t.destroy(); }
});

test('an idle ancestor above a running one is out of the scope, not pulled past it', async () => {
  const t = setup();
  try {
    t.session('root');                                   // idle, but above a running ancestor
    t.session('middle', { parent: 'root', running: true });
    const head = t.session('head', { parent: 'middle', running: false });
    t.session('below', { parent: 'head' });              // not an ancestor of the head; ignored
    await t.call('archiveSessionFromRow')(head);

    assert.deepEqual(t.calls.archived, ['head'], 'the thread stops where the sidebar stops folding');
  } finally { t.destroy(); }
});
