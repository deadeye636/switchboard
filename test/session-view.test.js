// #670 step S2: where a session of an owner/driver pair opens, shown and offered outside the Resume dialog.
//
// Three surfaces read ONE derivation (`sessionViewOf` in dialogs/dialogs.js): the sidebar row's symbol (beside the
// badge, which names the pair's owner, E21a), the row's "Open in GUI" / "Open in terminal" button (built on
// every pair row that is not detached), two command-palette actions and, since step S3, an entry in the pane menu.
// A dormant session opens in the other view; a running one is stopped and opened there (`switchSessionView`).
// And one write that is not a spawn: clearing a stored choice, in `src/app/session-view.js`.
//
// The renderer half loads the REAL files into a jsdom vm context, the way sidebar-session-row-vm.test.js does,
// so a name the row reaches for that nothing defines is a ReferenceError here. Backend ids below are invented
// ('own', 'drv', …): the renderer names none, and the pair is found through `transcriptsOf` alone.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const REN = path.join(__dirname, '..', 'src', 'renderer');
const sessionView = require('../src/app/session-view');

// --- the renderer half ---

const READY = { status: 'ready', enabled: true };
function registry(overrides = {}) {
  const byId = {
    own: { id: 'own', label: 'Own', ...READY },
    drv: { id: 'drv', label: 'Own (native)', transcriptsOf: 'own', ...READY },
    solo: { id: 'solo', label: 'Solo', ...READY },
    // A template runs on a built-in but is its own owner, and declares no transcriptsOf (#670, V8).
    tpl: { id: 'tpl', label: 'Template', isProfile: true, ...READY },
  };
  for (const [id, patch] of Object.entries(overrides)) byId[id] = patch === null ? undefined : { ...byId[id], ...patch };
  for (const id of Object.keys(byId)) if (!byId[id]) delete byId[id];
  return byId;
}

function setup({ backends = registry(), showAllBadges = true } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();

  const state = {
    activePtyIds: new Set(),
    attentionSessions: new Set(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map(),
    subagentActiveSessions: new Set(),
    lastActivityTime: new Map(),
    openSessions: new Map(),
    sessionMap: new Map(),
  };
  Object.assign(window, state);

  window.formatDate = () => 'just now';
  window.cleanDisplayName = (s) => s || '';
  window.getSessionStatus = () => ({ className: 'status-active', label: 'Active' });
  window.getSessionRuntimeState = () => ({});
  window.getSessionHealth = () => ({ className: 'health-ok', label: 'OK', state: 'healthy' });
  window.getQuietDetailParts = () => [];
  window.getWorktreeLabel = () => '';

  window._backendsById = backends;
  window.sessionBackendId = (s) => s.backendId;
  window._defaultBackendId = 'own';
  window._showAllBadges = showAllBadges;
  window.getBackend = (id) => backends[id] || null;
  window.backendMonogram = (id) => id.slice(0, 2).toUpperCase();

  const opened = [];
  window.openSession = (session, customOptions, opts) => { opened.push({ session, customOptions, opts }); };
  let focused = null;
  window.focusedActionSession = () => focused;
  const resets = [];
  const stops = [];
  const toasts = [];
  const dialogs = [];
  const answers = { confirm: true, stop: { ok: true } };
  window.api = {
    resetSessionView: async (id) => { resets.push(id); return { ok: true, cleared: true }; },
    stopSession: async (id) => { stops.push(id); return answers.stop; },
  };
  window.showControlToast = (o) => { toasts.push(o.message); };
  const destroyed = [];
  window.destroySession = (id, opts) => { destroyed.push({ id, opts }); state.openSessions.delete(id); };
  window.showControlDialog = async (o) => { dialogs.push(o); return answers.confirm; };

  for (const rel of ['lib/a11y-utils.js', 'lib/icons.js', 'shell/command-actions.js', 'dialogs/dialogs.js', 'shell/sidebar-session-row.js']) {
    vm.runInContext(fs.readFileSync(path.join(REN, rel), 'utf8'), ctx, { filename: rel });
  }
  const call = (name) => vm.runInContext(name, ctx);
  return {
    window, state, opened, resets, stops, toasts, dialogs, answers, destroyed,
    call,
    focus: (s) => { focused = s; },
    build: (session) => call('buildSessionItem')(session),
    viewOf: (session) => call('sessionViewOf')(session),
    actions: () => call('listCommandActions')(),
    runAction: (id) => call('listCommandActions')().find(a => a.id === id).run(),
    destroy: () => window.close(),
  };
}

// A row of the pair. `backendId` is the effective opener the core stamped (openerFor), `ownerBackendId` the owner.
const inTerminal = { sessionId: 's1', name: 'Fix the drag', modified: '2026-09-01T00:00:00Z', type: 'session', backendId: 'own', ownerBackendId: 'own', openerStored: false };
const inGui = { ...inTerminal, sessionId: 's2', name: 'Refactor', backendId: 'drv', openerStored: true };

test('a pair row keeps the badge of the OWNER and shows where it opens beside it (E3, E21a)', () => {
  const t = setup();
  try {
    const term = t.build(inTerminal);
    const termSym = term.querySelector('.session-view-symbol');
    assert.ok(termSym, 'a terminal row of the pair carries the symbol');
    assert.equal(termSym.title, 'Opens in the terminal');
    assert.ok(termSym.classList.contains('view-terminal'));
    assert.ok(termSym.querySelector('svg'), 'the symbol is an icon');
    const termBadge = term.querySelector('.session-backend-badge');
    assert.ok(termBadge, 'the badge stays, so a row still says which CLI it belongs to');
    assert.ok(termBadge.classList.contains('backend-' + inTerminal.ownerBackendId), 'it names the owner');
    assert.equal(termBadge.nextElementSibling, termSym, 'the view glyph sits right after it');

    const gui = t.build(inGui);
    const guiSym = gui.querySelector('.session-view-symbol');
    assert.equal(guiSym.title, 'Opens in the GUI');
    assert.ok(guiSym.classList.contains('view-gui'));
    assert.ok(gui.querySelector('.session-backend-badge').classList.contains('backend-' + inGui.ownerBackendId),
      'a row open in the GUI still names the owner, not the driver');
  } finally { t.destroy(); }
});

test('a backend with no driver keeps its badge and gets no symbol', () => {
  const t = setup();
  try {
    const row = t.build({ ...inTerminal, backendId: 'solo', ownerBackendId: 'solo' });
    assert.equal(row.querySelector('.session-view-symbol'), null);
    assert.ok(row.querySelector('.session-backend-badge'), 'mixed mode still badges it');
    assert.equal(row.querySelector('.session-view-switch-btn'), null);
  } finally { t.destroy(); }
});

test('a template row is never part of a pair (V8)', () => {
  const t = setup();
  try {
    const row = t.build({ ...inTerminal, backendId: 'tpl', ownerBackendId: 'tpl' });
    assert.equal(row.querySelector('.session-view-symbol'), null);
    assert.ok(row.querySelector('.session-backend-badge'));
    assert.equal(t.viewOf({ ...inTerminal, backendId: 'tpl', ownerBackendId: 'tpl' }), null);
  } finally { t.destroy(); }
});

// E8: a driver or an owner that cannot launch — disabled, not ready, known missing — offers NOTHING.
for (const [what, overrides] of [
  ['the driver is disabled', { drv: { enabled: false } }],
  ['the driver is not ready', { drv: { status: 'missing' } }],
  ['the driver is known missing', { drv: { available: false } }],
  ['the driver is not registered', { drv: null }],
  ['the owner is disabled', { own: { enabled: false } }],
]) {
  test(`E8: ${what} — no symbol, no button, no palette entry; the badge stays`, () => {
    const t = setup({ backends: registry(overrides) });
    try {
      const row = t.build(inGui);
      assert.equal(row.querySelector('.session-view-symbol'), null);
      assert.equal(row.querySelector('.session-view-switch-btn'), null);
      assert.ok(row.querySelector('.session-backend-badge'), 'the row is badged exactly as before #670');
      t.focus(inGui);
      const ids = t.actions().map(a => a.id);
      assert.ok(!ids.includes('session.view.open-other'));
      assert.ok(!ids.includes('session.view.reset'), 'a stored choice stays stored, and is not offered for clearing');
    } finally { t.destroy(); }
  });
}

test('a plain terminal row and a subagent row get nothing about views', () => {
  const t = setup();
  try {
    assert.equal(t.viewOf({ ...inTerminal, type: 'terminal' }), null);
    assert.equal(t.viewOf({ ...inTerminal, parentSessionId: 'p1' }), null);
    assert.equal(t.build({ ...inTerminal, type: 'terminal' }).querySelector('.session-view-symbol'), null);
  } finally { t.destroy(); }
});

test('the switch button is on every pair row, with the icon of the view it switches to', () => {
  const t = setup();
  try {
    const btn = t.build(inTerminal).querySelector('.session-view-switch-btn');
    assert.ok(btn, 'a dormant terminal row offers the GUI');
    assert.equal(btn.title, 'Open in GUI');
    assert.equal(t.build(inGui).querySelector('.session-view-switch-btn').title, 'Open in terminal');

    // A running row carries it too and shows it (step S3): the click stops the session and opens it there.
    t.state.activePtyIds.add('s1');
    const running = t.build(inTerminal);
    assert.ok(running.classList.contains('has-running-pty'));
    assert.ok(running.querySelector('.session-view-switch-btn'), 'offered while it runs');
    const css = fs.readFileSync(path.join(REN, 'style.css'), 'utf8');
    assert.ok(!/has-running-pty[^{]*session-view-switch-btn/.test(css), 'no rule hides it while the row runs');
    t.state.activePtyIds.delete('s1');

    t.state.openSessions.set('s1', { closed: true });
    assert.ok(t.build(inTerminal).querySelector('.session-view-switch-btn'), 'an exited tab is dormant again');

    t.window.isSessionDetached = (id) => id === 's1';
    assert.equal(t.build(inTerminal).querySelector('.session-view-switch-btn'), null, 'not for one in another window');
  } finally { t.destroy(); }
});

test('the palette offers the other view for a dormant focused session, and opens it with the choice', () => {
  const t = setup();
  try {
    t.focus(inTerminal);
    let open = t.actions().find(a => a.id === 'session.view.open-other');
    assert.ok(open, 'offered');
    assert.equal(open.title, 'Open “Fix the drag” in GUI');
    open.run();
    assert.equal(t.opened.length, 1);
    assert.equal(t.opened[0].opts.openerChoice, 'drv', 'the choice travels with the open, and main stores it (E5)');

    t.focus(inGui);
    open = t.actions().find(a => a.id === 'session.view.open-other');
    assert.equal(open.title, 'Open “Refactor” in terminal');

    // A process with no surface in this window (another window renders it, or nothing has mounted it): not
    // offered, and a run that raced the start does nothing.
    t.focus(inTerminal);
    const stale = t.actions().find(a => a.id === 'session.view.open-other');
    t.state.activePtyIds.add('s1');
    assert.ok(!t.actions().some(a => a.id === 'session.view.open-other'));
    stale.run();
    assert.equal(t.opened.length, 1, 'the run asks again and switches nothing it does not hold');
    assert.equal(t.stops.length, 0);

    t.focus(null);
    assert.ok(!t.actions().some(a => a.id.startsWith('session.view.')), 'no focused session, no action');
  } finally { t.destroy(); }
});

test('"Use the default view" is offered only while a choice is stored, and clears it through main', async () => {
  const t = setup();
  try {
    t.focus(inTerminal); // openerStored: false
    assert.ok(!t.actions().some(a => a.id === 'session.view.reset'));

    const stored = { ...inGui };
    t.state.sessionMap.set(stored.sessionId, stored);
    t.focus(stored);
    const reset = t.actions().find(a => a.id === 'session.view.reset');
    assert.ok(reset);
    assert.equal(reset.title, 'Use the default view for “Refactor”');
    await reset.run();
    assert.deepEqual(t.resets, ['s2']);
    assert.equal(stored.openerStored, false, 'the row forgets it at once; main pushes projects-changed for the view');

    // Offered for a RUNNING session too: clearing changes the next open, not the running one.
    const running = { ...inGui, sessionId: 's3' };
    t.state.activePtyIds.add('s3');
    t.focus(running);
    assert.ok(t.actions().some(a => a.id === 'session.view.reset'));
  } finally { t.destroy(); }
});

// --- step S3: a RUNNING session, stopped and opened in the other view (`switchSessionView`) ---

// A session running in this window: a live process and a surface that holds it.
function runHere(t, session) {
  t.state.activePtyIds.add(session.sessionId);
  t.state.openSessions.set(session.sessionId, { closed: false, session });
  t.state.sessionMap.set(session.sessionId, session);
}
const until = async (cond) => { for (let i = 0; i < 50 && !cond(); i++) await new Promise(r => setTimeout(r, 0)); };

test('a running idle session is asked about, stopped, and opened in the other view once its exit is handled', async () => {
  const t = setup();
  try {
    runHere(t, inTerminal);
    t.focus(inTerminal);
    const action = t.actions().find(a => a.id === 'session.view.open-other');
    assert.ok(action, 'offered while it runs here');
    assert.equal(action.title, 'Open “Fix the drag” in GUI');
    const done = action.run();
    await until(() => t.stops.length === 1);
    assert.equal(t.dialogs.length, 1, 'asked first');
    assert.equal(t.dialogs[0].confirmLabel, 'Switch to GUI');
    assert.deepEqual(t.stops, ['s1']);
    assert.equal(t.opened.length, 0, 'nothing is opened before the exit has been handled');
    assert.equal(t.call('takeViewSwitchExit')('s1'), true, 'the exit handler hands this exit to the switch');
    assert.equal(t.call('takeViewSwitchExit')('s1'), false, 'and only once');
    assert.equal(await done, true);
    assert.deepEqual(JSON.parse(JSON.stringify(t.destroyed)), [{ id: 's1', opts: { keepTab: true } }],
      'the old surface is unmounted with its pane tab kept, so the reopen lands in the same tab');
    assert.equal(t.opened.length, 1);
    assert.equal(t.opened[0].opts.openerChoice, 'drv', 'opened with the other view as an explicit choice, which main stores');
    assert.equal(t.opened[0].opts.ignoreLiveOwner, true, 'the process it just stopped is not taken for a foreign owner');
  } finally { t.destroy(); }
});

test('a second switch of the same session while one is under way does nothing', async () => {
  const t = setup();
  try {
    runHere(t, inTerminal);
    const first = t.call('switchSessionView')(inTerminal);
    await until(() => t.stops.length === 1);
    assert.equal(await t.call('switchSessionView')(inTerminal), false);
    assert.equal(t.stops.length, 1, 'not stopped twice');
    t.call('takeViewSwitchExit')('s1');
    assert.equal(await first, true);
    assert.equal(t.opened.length, 1);
  } finally { t.destroy(); }
});

test('a session that ended on its own between the confirmation and the stop is still opened in the other view', async () => {
  const t = setup();
  try {
    runHere(t, inTerminal);
    // The exit arrives before main answers the stop, which then says "not running".
    t.window.api.stopSession = async (id) => { t.stops.push(id); t.call('takeViewSwitchExit')(id); return { ok: false, error: 'not running' }; };
    assert.equal(await t.call('switchSessionView')(inTerminal), true);
    assert.equal(t.toasts.length, 0, 'not reported as a failed stop');
    assert.equal(t.opened.length, 1);
    assert.equal(t.opened[0].opts.openerChoice, 'drv');
  } finally { t.destroy(); }
});

test('a running session that is working, waiting for an answer or has no conversation yet is not switched', async () => {
  for (const [what, mark, why] of [
    ['working on a turn', (t) => t.state.sessionBusyState.set('s1', true), /once it is idle/],
    ['waiting for an answer', (t) => t.state.attentionSessions.add('s1'), /once it is idle/],
    ['still pending, with no transcript', (t) => { t.window.pendingSessions = new Map([['s1', {}]]); }, /after its first turn/],
  ]) {
    const t = setup();
    try {
      runHere(t, inTerminal);
      mark(t);
      assert.equal(await t.call('switchSessionView')(inTerminal), false, what);
      assert.equal(t.stops.length, 0, `${what}: nothing stopped`);
      assert.equal(t.dialogs.length, 0, `${what}: nothing asked`);
      assert.match(t.toasts[0], why, `${what}: the user is told why`);
    } finally { t.destroy(); }
  }
});

test('a cancelled confirmation or a refused stop leaves the session running and opens nothing', async () => {
  const t = setup();
  try {
    runHere(t, inTerminal);
    t.answers.confirm = false;
    assert.equal(await t.call('switchSessionView')(inTerminal), false);
    assert.equal(t.stops.length, 0, 'cancelled: not stopped');

    t.answers.confirm = true;
    t.answers.stop = { ok: false, error: 'not running' };
    assert.equal(await t.call('switchSessionView')(inTerminal), false);
    assert.equal(t.opened.length, 0, 'a refused stop opens nothing');
    assert.match(t.toasts[0], /could not be stopped/);
    assert.equal(t.call('takeViewSwitchExit')('s1'), false, 'and leaves no switch waiting for an exit');
  } finally { t.destroy(); }
});

test('the pane menu offers the other view for its session, disabled while it is busy', () => {
  const t = setup();
  try {
    const items = [];
    const item = (label, handler, opts = {}) => { items.push({ label, handler, disabled: !!opts.disabled }); };
    t.state.sessionMap.set('s1', inTerminal);
    t.window.appendViewSwitchItem('s1', item);
    assert.deepEqual(items.map(i => [i.label, i.disabled]), [['Open in GUI', false]], 'a dormant session');

    items.length = 0;
    runHere(t, inTerminal);
    t.state.sessionBusyState.set('s1', true);
    t.window.appendViewSwitchItem('s1', item);
    assert.deepEqual(items.map(i => [i.label, i.disabled]), [['Open in GUI', true]], 'running and busy: shown, not usable');

    items.length = 0;
    t.state.sessionMap.set('x', { ...inTerminal, sessionId: 'x', backendId: 'solo', ownerBackendId: 'solo' });
    t.window.appendViewSwitchItem('x', item);
    assert.equal(items.length, 0, 'no pair, no entry');
  } finally { t.destroy(); }
});

test('the exit handler gives a switching session its exit before any banner or tab close', () => {
  const src = fs.readFileSync(path.join(REN, 'shell', 'session-ipc.js'), 'utf8');
  const handler = src.slice(src.indexOf('window.api.onProcessExited'));
  const take = handler.indexOf('takeViewSwitchExit(sessionId)');
  assert.ok(take > 0, 'the handler asks for the switch');
  for (const later of ['markExited', 'session exited (code', 'closeTabNow', 'scheduleTabAutoClose', 'destroySession(sessionId)']) {
    assert.ok(handler.indexOf(later) > take, `${later} comes after it`);
  }
});

// --- the main-process half: src/app/session-view.js ---

function fakeCtx(stored = {}) {
  const calls = { set: [], notified: 0 };
  return {
    calls,
    ctx: {
      getOpener: (id) => stored[id] || null,
      setOpener: (id, value) => { calls.set.push([id, value]); if (value == null) delete stored[id]; else stored[id] = value; },
      notifyRendererProjectsChanged: () => { calls.notified++; },
      log: { info() {}, warn() {} },
    },
  };
}

test('resetView refuses anything that is not a session id', () => {
  const { ctx, calls } = fakeCtx({ s1: 'drv' });
  sessionView.init(ctx);
  for (const bad of [undefined, null, '', '   ', 42, {}, ['s1'], 'x'.repeat(513)]) {
    const r = sessionView.resetView(bad);
    assert.equal(r.ok, false, `refused: ${JSON.stringify(bad)}`);
    assert.equal(typeof r.error, 'string');
  }
  assert.deepEqual(calls.set, [], 'nothing was written');
  assert.equal(calls.notified, 0);
});

test('resetView clears a stored choice through ctx and tells the sidebar', () => {
  const stored = { s1: 'drv' };
  const { ctx, calls } = fakeCtx(stored);
  sessionView.init(ctx);
  assert.deepEqual(sessionView.resetView('s1'), { ok: true, cleared: true });
  assert.deepEqual(calls.set, [['s1', null]]);
  assert.equal(stored.s1, undefined);
  assert.equal(calls.notified, 1, 'projects-changed, because only main can re-derive the row’s view');
});

test('resetView with nothing stored is a success that writes nothing', () => {
  const { ctx, calls } = fakeCtx({});
  sessionView.init(ctx);
  assert.deepEqual(sessionView.resetView('s1'), { ok: true, cleared: false });
  assert.deepEqual(calls.set, []);
  assert.equal(calls.notified, 0);
});

test('resetView turns a failing store into a sentence, not a throw', () => {
  const { ctx } = fakeCtx({ s1: 'drv' });
  ctx.setOpener = () => { throw new Error('SQLITE_BUSY'); };
  sessionView.init(ctx);
  const r = sessionView.resetView('s1');
  assert.equal(r.ok, false);
  assert.match(r.error, /could not be cleared/);
});

test('the module registers its one channel and takes the store through ctx, never a db require', () => {
  const handled = [];
  sessionView.registerIpc({ handle: (name, fn) => handled.push([name, fn]) });
  assert.deepEqual(handled.map(h => h[0]), ['session-view:reset']);
  const { ctx } = fakeCtx({ s9: 'drv' });
  sessionView.init(ctx);
  assert.deepEqual(handled[0][1]({}, 's9'), { ok: true, cleared: true });

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'session-view.js'), 'utf8');
  assert.doesNotMatch(src, /require\(\s*['"][^'"]*\/db\//, 'no require of the db layer');
  assert.doesNotMatch(src, /require\(\s*['"]electron['"]\s*\)/, 'electron arrives through ctx');
});

test('main.js wires the module and preload exposes the binding', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /require\('\.\/app\/session-view'\)/);
  assert.match(main, /sessionView\.registerIpc\(ipcMain\)/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert.match(preload, /resetSessionView:\s*\(sessionId\)\s*=>\s*ipcRenderer\.invoke\('session-view:reset', sessionId\)/);
});
