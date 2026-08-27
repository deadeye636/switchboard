'use strict';
// #486 — the keyboard route from a session to a plan.
//
// The same two things that can quietly go wrong with `handoff.create` (#473) go wrong here, so the same
// two are pinned: WHICH session the row means (`focusedActionSession`, and the row says so), and that it
// reaches the one flow rather than a second one.
//
// A third thing is specific to plans: what gets TYPED. The app never writes a plan, so if the prompt
// does not carry the directory and the convention, nothing else will.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REN = path.join(__dirname, '..', 'src', 'renderer');
const ACTIONS = fs.readFileSync(path.join(REN, 'shell', 'command-actions.js'), 'utf8');
const PLANS = fs.readFileSync(path.join(REN, 'views', 'plans-memory-view.js'), 'utf8');
const health = require('../src/renderer/session/session-health.js');

// The renderer's classic scripts share one global scope, so the test builds it: the registry first (it is
// what the view calls at parse time), then the view, with the free globals it reaches stubbed. Everything
// plans-memory-view.js touches at PARSE time has to be present — the file is a whole viewer, so the DOM
// handles it grabs are stubbed rather than mocked in detail.
function load({ session = null, settings = {}, dirs = null } = {}) {
  const seeded = [];
  const ctx = vm.createContext({});
  ctx.window = ctx;
  ctx.console = console;
  ctx.setTimeout = setTimeout;
  ctx.CSS = { escape: (s) => s };

  const el = () => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, replaceChildren() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    setAttribute() {}, removeAttribute() {}, dataset: {}, children: [], innerHTML: '', textContent: '',
  });
  ctx.document = { createElement: el, getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };

  // What the view reaches for at call time.
  ctx.focusedActionSession = () => session;
  ctx.cleanDisplayName = (s) => (s || '').trim();
  ctx.sessionBackendId = (s) => (s && s.backendId) || '';
  ctx.getBackend = (id) => ({ id, label: id, seedGraceMs: 0 });
  ctx.seedSessionWhenReady = (sessionId, text, opts) => { seeded.push({ sessionId, text, opts }); };
  ctx.showControlToast = () => {};
  ctx.formatDate = () => '';
  ctx.api = {
    getSetting: async () => settings,
    projectConventionDirs: async (p) => (dirs === null ? null : { ...dirs, asked: p }),
    getPlans: async () => ({ plans: [], hasStore: true }),
    getMemories: async () => ({}),
  };
  // The prompt helpers are a UMD module in the real renderer; here they are put into the shared scope the
  // same way the <script> tag does.
  Object.assign(ctx, health);

  vm.runInContext(ACTIONS, ctx);
  vm.runInContext(PLANS, ctx);
  return { ctx, seeded, action: () => ctx.listCommandActions().find(a => a.id === 'plan.create') };
}

test('the action is absent when no session is active', () => {
  assert.equal(load({ session: null }).action(), undefined,
    'offered everywhere and failing on use is the shape this replaces');
});

test('the action names the session it would plan for', () => {
  const { action } = load({ session: { sessionId: 's1', name: 'tariff end date' } });
  assert.equal(action().title, 'Write a plan for “tariff end date”');
  assert.equal(action().group, 'Plan');
});

test('a session with no name falls back to its id rather than to empty quotes', () => {
  const { action } = load({ session: { sessionId: 's1' } });
  assert.equal(action().title, 'Write a plan for “s1”');
});

test('running it types the prompt into THAT session, with the project\'s plan directory in it', async () => {
  const session = { sessionId: 's1', name: 'tariff end date', projectPath: '/dev/shop', backendId: 'codex' };
  const { action, seeded } = load({
    session,
    dirs: { planDir: '.plans', planPath: '/dev/shop/.plans', handoffDir: '.handoffs', handoffPath: '/dev/shop/.handoffs' },
  });

  await action().run();
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].sessionId, 's1');
  assert.ok(seeded[0].text.includes('/dev/shop/.plans'), 'the agent is told where the plan goes');
  assert.ok(seeded[0].text.includes('tariff end date'));
  assert.ok(!seeded[0].text.includes('{planPath}'), 'nothing is left unsubstituted');
  assert.equal(seeded[0].opts.timelineLabel, 'Plan requested');
});

test('a slash-command prompt is sent with the directory appended', async () => {
  const { action, seeded } = load({
    session: { sessionId: 's1', projectPath: '/dev/shop', backendId: 'claude' },
    settings: { planPromptByBackend: { claude: '/plan' } },
    dirs: { planDir: '.plans', planPath: '/dev/shop/.plans' },
  });

  await action().run();
  assert.ok(seeded[0].text.startsWith('/plan'), 'the command stays the first thing typed');
  assert.match(seeded[0].text, /plan directory is \/dev\/shop\/\.plans/);
});

test('a session with no project still gets a prompt — the directory token just resolves to nothing', async () => {
  const { action, seeded } = load({ session: { sessionId: 's1', name: 'x' }, dirs: null });
  await action().run();
  assert.equal(seeded.length, 1);
  assert.ok(!seeded[0].text.includes('{planPath}'));
});
