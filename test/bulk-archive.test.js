// vm.runInContext tests for the bulk archive in shell/sidebar-events.js — the project group and the
// slug group (#250, #251).
//
// WHY THIS EXISTS:
//   "Archive all sessions" used to stop every running session with no way out, and its confirm reported
//   a count nobody could reconcile with the sidebar. Both were fixed in the renderer, where the suite
//   normally sees nothing: the previous pass tested `normalizeControlDialogOptions` and called it
//   covered, while the branch that actually decides WHICH sessions get stopped had no test at all.
//
//   THE COUNTING RULE, which two passes got wrong before it was written down: every number the dialog
//   shows counts SESSIONS — top-level rows, what the sidebar shows. Subagents are never counted and
//   never named: they follow their parent, and the ones under a session that stays running stay with
//   it. The dialog has two numbers, idle and running, because that is what the decision is about.
//
//   So this loads the REAL dialog and the REAL sidebar-events into one jsdom context and drives the
//   thing end to end — render the confirm, tick the checkbox, press the button, assert what was
//   stopped and archived. A test that only exercises the option normalizer cannot tell the two
//   behaviours apart, because the normalizer is identical in both.
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
  // sidebarShortName is NOT stubbed — it is declared in sidebar-events.js itself, so the real one runs
  // and the scope name in the dialog and the toast is the real "last two segments" label.
  // Read by branches these tests never reach, but resolved bare — define them so a stray lookup fails
  // here instead of surfacing as a ReferenceError that hides the real result.
  window.getAllRenderableSessions = () => [];
  window.getSessionRuntimeState = () => ({});
  window.activeSessionId = null;

  for (const rel of [['dialogs', 'control-dialogs.js'], ['shell', 'sidebar-events.js']]) {
    vm.runInContext(fs.readFileSync(path.join(REN, ...rel), 'utf8'), ctx, { filename: rel.join('/') });
  }

  const doc = window.document;
  const dialog = () => doc.querySelector('.control-dialog');
  const confirmBtn = () => doc.querySelector('.control-dialog-confirm');
  const checkbox = () => doc.querySelector('.control-dialog-checkbox input');
  // The details table as a plain object, so a test can assert a row is ABSENT.
  const details = () => Object.fromEntries([...doc.querySelectorAll('.control-dialog-detail-row')]
    .map(r => [r.querySelector('.control-dialog-detail-label').textContent,
      r.querySelector('.control-dialog-detail-value').textContent]));
  const toastText = () => doc.querySelector('.control-toast')?.textContent || '';

  // The dialog renders synchronously inside the promise executor, but two async frames down. One
  // macrotask is enough and does not depend on how many awaits precede it.
  const tick = () => new Promise(r => window.setTimeout(r, 0));

  function session(id, { running = false, parent = null } = {}) {
    const s = { sessionId: id, archived: 0 };
    if (parent) s.parentSessionId = parent;
    if (running) window.activePtyIds.add(id);
    window.sessionMap.set(id, s);
    return s;
  }

  const call = name => vm.runInContext(name, ctx);

  return {
    window, calls, session, tick, call,
    dialog, confirmBtn, checkbox, details, toastText,
    destroy: () => window.close(),
  };
}

function project(sessions) {
  return { projectPath: 'D:/Projekte/switchboard', sessions };
}

// --- #251: what the action covers ---

test('by default the running session is left alone — archiving is for what is done', async () => {
  const t = setup();
  try {
    const sessions = [t.session('a'), t.session('b'), t.session('live', { running: true })];
    const done = t.call('archiveProjectGroup')(project(sessions));
    await t.tick();

    assert.equal(t.confirmBtn().textContent, 'Archive 2 Sessions',
      'the button names what it will archive, not how many sessions exist');
    assert.deepEqual(t.details(), { Project: 'Projekte/switchboard', Sessions: '2', Running: '1' });
    t.confirmBtn().click();
    await done;

    assert.deepEqual(t.calls.archived, ['a', 'b']);
    assert.deepEqual(t.calls.stopped, [], 'nothing running may be stopped without the checkbox');
    assert.equal(sessions[2].archived, 0, 'the live session keeps its state');
  } finally { t.destroy(); }
});

test('ticking the checkbox includes the running session — and only then is it stopped', async () => {
  const t = setup();
  try {
    const sessions = [t.session('a'), t.session('live', { running: true })];
    const done = t.call('archiveProjectGroup')(project(sessions));
    await t.tick();

    assert.equal(t.confirmBtn().textContent, 'Archive 1 Session');
    t.checkbox().click();
    assert.equal(t.confirmBtn().textContent, 'Archive 2 Sessions',
      'the button follows the checkbox — a stale count is what made this action untrustworthy');

    t.confirmBtn().click();
    await done;

    assert.deepEqual(t.calls.archived, ['a', 'live']);
    assert.deepEqual(t.calls.stopped, ['live']);
    assert.deepEqual(t.calls.marked, ['live'], 'a deliberate stop must not read as a crash');
  } finally { t.destroy(); }
});

test('no checkbox at all when nothing is running — it would have nothing to include', async () => {
  const t = setup();
  try {
    const done = t.call('archiveProjectGroup')(project([t.session('a')]));
    await t.tick();

    assert.equal(t.checkbox(), null);
    t.confirmBtn().click();
    await done;

    assert.deepEqual(t.calls.archived, ['a'], 'the bare-boolean result shape still confirms');
  } finally { t.destroy(); }
});

test('every session running and the box unchecked: the confirm cannot be pressed', async () => {
  const t = setup();
  try {
    const done = t.call('archiveProjectGroup')(project([
      t.session('x', { running: true }), t.session('y', { running: true }),
    ]));
    await t.tick();

    assert.equal(t.confirmBtn().textContent, 'Archive 0 Sessions');
    assert.equal(t.confirmBtn().disabled, true,
      'a confirm that would do nothing must not accept the click');

    t.checkbox().click();
    assert.equal(t.confirmBtn().disabled, false);
    assert.equal(t.confirmBtn().textContent, 'Archive 2 Sessions');

    t.confirmBtn().click();
    await done;
    assert.deepEqual(t.calls.archived, ['x', 'y']);
  } finally { t.destroy(); }
});

test('cancel archives nothing, and neither does Escape', async () => {
  for (const dismiss of ['cancel', 'escape']) {
    const t = setup();
    try {
      const done = t.call('archiveProjectGroup')(project([t.session('a'), t.session('live', { running: true })]));
      await t.tick();

      if (dismiss === 'cancel') t.window.document.querySelector('.control-dialog-cancel').click();
      else t.window.document.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Escape' }));
      await done;

      assert.deepEqual(t.calls.archived, [], `${dismiss} must not archive`);
      assert.deepEqual(t.calls.stopped, [], `${dismiss} must not stop anything`);
      assert.equal(t.dialog(), null, `${dismiss} closes the dialog`);
    } finally { t.destroy(); }
  }
});

// --- #250: the count the dialog reports ---

test('the counts are sessions, not rows — subagents are never counted or named', async () => {
  const t = setup();
  try {
    const sessions = [
      t.session('p1'), t.session('p2'), t.session('live', { running: true }),
      t.session('s1', { parent: 'p1' }), t.session('s2', { parent: 'p1' }), t.session('s3', { parent: 'p2' }),
    ];
    const done = t.call('archiveProjectGroup')(project(sessions));
    await t.tick();

    // Six rows in the project, but the decision is about two idle sessions and one running one.
    assert.deepEqual(t.details(), { Project: 'Projekte/switchboard', Sessions: '2', Running: '1' });
    assert.equal(t.confirmBtn().textContent, 'Archive 2 Sessions',
      'the button counts the sidebar rows it will archive, not the rows it touches');

    t.confirmBtn().click();
    await done;

    assert.deepEqual(t.calls.archived, ['p1', 'p2', 's1', 's2', 's3'],
      'a session takes its subagents with it, even though the button counted only the parents');
    assert.match(t.toastText(), /Archived 2 sessions/, 'the toast counts the same way the button did');
  } finally { t.destroy(); }
});

// A running session that keeps its own subagents is the whole point of leaving it running. Archiving
// the tree underneath it would gut the live session while it works.
test('the subagents of a running session are protected with it', async () => {
  const t = setup();
  try {
    const sessions = [
      t.session('idle'), t.session('idlesub', { parent: 'idle' }),
      t.session('live', { running: true }),
      t.session('livesub', { parent: 'live' }), t.session('livedeep', { parent: 'livesub' }),
    ];
    const done = t.call('archiveProjectGroup')(project(sessions));
    await t.tick();

    assert.equal(t.confirmBtn().textContent, 'Archive 1 Session');
    t.confirmBtn().click();
    await done;

    assert.deepEqual(t.calls.archived, ['idle', 'idlesub']);
    assert.equal(sessions[3].archived, 0, "the running session's subagent must survive");
    assert.equal(sessions[4].archived, 0, '...and so must the one below it');
  } finally { t.destroy(); }
});

test('with the box ticked the running session and its subagents go too', async () => {
  const t = setup();
  try {
    const sessions = [
      t.session('idle'), t.session('live', { running: true }), t.session('livesub', { parent: 'live' }),
    ];
    const done = t.call('archiveProjectGroup')(project(sessions));
    await t.tick();

    t.checkbox().click();
    assert.equal(t.confirmBtn().textContent, 'Archive 2 Sessions',
      'the checkbox adds the running SESSION to the count, not its subagent rows');
    t.confirmBtn().click();
    await done;

    assert.deepEqual(t.calls.archived, ['idle', 'live', 'livesub']);
    assert.deepEqual(t.calls.stopped, ['live']);
  } finally { t.destroy(); }
});

test('the table stays at two numbers — nothing about subagents leaks into it', async () => {
  const t = setup();
  try {
    const done = t.call('archiveProjectGroup')(project([
      t.session('a'), t.session('sub', { parent: 'a' }),
    ]));
    await t.tick();

    assert.deepEqual(Object.keys(t.details()), ['Project', 'Sessions', 'Running'],
      'a subagent row must not add a row to the dialog');
    t.window.document.querySelector('.control-dialog-cancel').click();
    await done;
  } finally { t.destroy(); }
});

// --- Undo ---

test('undo restores exactly the set that was archived — not the ones left running', async () => {
  const t = setup();
  try {
    const sessions = [t.session('a'), t.session('b'), t.session('live', { running: true })];
    const done = t.call('archiveProjectGroup')(project(sessions));
    await t.tick();
    t.confirmBtn().click();
    await done;

    assert.match(t.toastText(), /Archived 2 sessions from Projekte\/switchboard\./);
    t.window.document.querySelector('.control-toast button').click();
    await t.tick();

    assert.deepEqual(t.calls.unarchived, ['a', 'b']);
    assert.deepEqual(sessions.map(s => s.archived), [0, 0, 0]);
  } finally { t.destroy(); }
});

// --- The slug group takes the same route ---
//
// It carried an identical copy of the old "stop everything" loop. Both entry points now share one
// confirm, and this is what stops a future copy from drifting back.

test('the slug group archive also leaves running sessions alone by default', async () => {
  const t = setup();
  try {
    t.session('g1'); t.session('g2'); t.session('glive', { running: true });
    const doc = t.window.document;
    const group = doc.createElement('div');
    group.innerHTML = '<div class="slug-group-header"><span class="slug-group-name">feature-x</span></div>'
      + ['g1', 'g2', 'glive'].map(id => `<div class="session-item" data-session-id="${id}"></div>`).join('');
    doc.getElementById('sidebar-content').appendChild(group);

    const done = t.call('archiveSlugGroup')(group.querySelector('.slug-group-header'));
    await t.tick();

    assert.equal(t.details().Group, 'feature-x');
    assert.equal(t.confirmBtn().textContent, 'Archive 2 Sessions');
    t.confirmBtn().click();
    await done;

    assert.deepEqual(t.calls.archived, ['g1', 'g2']);
    assert.deepEqual(t.calls.stopped, []);
  } finally { t.destroy(); }
});
