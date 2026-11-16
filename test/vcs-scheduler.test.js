'use strict';

// The VCS poll scheduler (#277 F6) — dedupe, concurrency cap, backoff, non-repo skip. Electron-free:
// createScheduler takes injected deps, so this runs under plain `node --test`.

const { test } = require('node:test');
const assert = require('node:assert');
const { createScheduler } = require('../src/app/vcs');

const flush = () => new Promise((r) => setImmediate(r));
const gitProvider = { id: 'git' };

function makeDeps(overrides = {}) {
  let clock = 10_000;
  const calls = [];
  const statuses = [];
  const deps = {
    now: () => clock,
    setClock: (v) => { clock = v; },
    advance: (ms) => { clock += ms; },
    detect: (cwd) => (cwd.startsWith('repo') ? gitProvider : null),
    runStatus: (provider, cwd) => { calls.push(cwd); return Promise.resolve({ branch: 'main', staged: 1 }); },
    onStatus: (cwd, summary) => statuses.push({ cwd, summary }),
    getConfig: () => ({ pollMs: 20_000, countUntracked: true }),
    jitter: () => 0,
    calls,
    statuses,
  };
  return Object.assign(deps, overrides);
}

test('watch dedupes and drops removed cwds; non-repos are tracked but not polled', async () => {
  const d = makeDeps();
  const s = createScheduler(d);
  s.watch(['repoA', 'repoA', 'plain']);
  assert.ok(s._state.has('repoA'));
  assert.ok(s._state.has('plain'));
  assert.strictEqual(s._state.get('repoA').isRepo, true);
  assert.strictEqual(s._state.get('plain').isRepo, false);

  s.tick();
  await flush();
  assert.deepStrictEqual(d.calls, ['repoA']); // plain (non-repo) never polled
  assert.strictEqual(d.statuses.length, 1);

  s.watch(['plain']); // repoA dropped
  assert.ok(!s._state.has('repoA'));
});

test('concurrency cap limits simultaneous polls', async () => {
  let resolveFns = [];
  const d = makeDeps({
    runStatus: (provider, cwd) => { d.calls.push(cwd); return new Promise((res) => resolveFns.push(res)); },
  });
  const s = createScheduler(d);
  s.watch(['repo1', 'repo2', 'repo3', 'repo4', 'repo5']);
  s.tick();
  await flush();
  // only CONCURRENCY_CAP (3) launched; the rest wait
  assert.strictEqual(d.calls.length, 3);
  s.tick(); // no budget left — nothing new
  await flush();
  assert.strictEqual(d.calls.length, 3);
});

test('failure backs off (nextDue pushed out), success resets and pushes status', async () => {
  let fail = true;
  const d = makeDeps({
    runStatus: (provider, cwd) => { d.calls.push(cwd); return Promise.resolve(fail ? null : { branch: 'main' }); },
  });
  const s = createScheduler(d);
  s.watch(['repoX']);

  s.tick();
  await flush();
  const st = s._state.get('repoX');
  assert.ok(st.nextDue > d.now(), 'backed off into the future');
  const firstBackoff = st.nextDue - d.now();

  // still failing → backoff grows
  d.advance(firstBackoff + 1);
  s.tick();
  await flush();
  const secondBackoff = st.nextDue - d.now();
  assert.ok(secondBackoff > firstBackoff, 'exponential backoff');

  // now succeed → status pushed, nextDue at poll interval
  fail = false;
  d.advance(secondBackoff + 1);
  s.tick();
  await flush();
  assert.strictEqual(d.statuses.length, 1);
  assert.ok(s._state.get('repoX').summary);
});

test('refresh forces an immediate poll', async () => {
  const d = makeDeps();
  const s = createScheduler(d);
  s.watch(['repoR']);
  s.tick();
  await flush();
  assert.strictEqual(d.calls.length, 1);
  // not due again yet
  s.tick();
  await flush();
  assert.strictEqual(d.calls.length, 1);
  // refresh overrides the schedule
  s.refresh('repoR');
  await flush();
  assert.strictEqual(d.calls.length, 2);
});

test('a cwd that becomes a repo (git init) is picked up on the next watch', async () => {
  let isRepo = false;
  const d = makeDeps({ detect: () => (isRepo ? gitProvider : null) });
  const s = createScheduler(d);
  s.watch(['proj']);
  s.tick();
  await flush();
  assert.strictEqual(d.calls.length, 0);            // non-repo → never polled
  assert.strictEqual(s._state.get('proj').isRepo, false);

  isRepo = true;                                    // user runs `git init`
  s.watch(['proj']);                                // next sidebar render re-detects
  assert.strictEqual(s._state.get('proj').isRepo, true);
  s.tick();
  await flush();
  assert.strictEqual(d.calls.length, 1);            // now it polls
});

test('getCached returns the last summary or null', async () => {
  const d = makeDeps();
  const s = createScheduler(d);
  assert.strictEqual(s.getCached('repoC'), null);
  s.watch(['repoC']);
  s.tick();
  await flush();
  assert.ok(s.getCached('repoC'));
});

// The follow union (#858, #870): a window's Repository group (`vcs-follow`) and main's own subscribers (`followFolder`,
// one key per followed session's Changes group) each hold a list of their own; the poller follows the union, and ending
// one does not end the other.
test('follow union: two subscribers on one folder share one follow, and the heartbeat runs until the last ends', () => {
  const vcsApp = require('../src/app/vcs');
  vcsApp.init({ getSetting: () => ({ vcsChipEnabled: false }), log: { debug() {} } });
  try {
    const handlers = new Map();
    vcsApp.registerIpc({ on: (ch, fn) => handlers.set(ch, fn), handle() {} });
    const follow = handlers.get('vcs-follow');
    const ev = { sender: { id: 7 } };
    assert.equal(vcsApp._pollWanted(), false);

    follow(ev, ['repoA']);                        // the Repository group
    vcsApp.followFolder('changes:S1', 'repoA');   // two sessions' Changes groups
    vcsApp.followFolder('changes:S2', 'repoB');
    assert.deepEqual(vcsApp._followedCwds().sort(), ['repoA', 'repoB']);
    assert.equal(vcsApp._pollWanted(), true);
    assert.ok(vcsApp._scheduler()._state.has('repoA') && vcsApp._scheduler()._state.has('repoB'));

    vcsApp.followFolder('changes:S2', null);      // one Changes group ends: the others' folders stay
    assert.deepEqual(vcsApp._followedCwds(), ['repoA']);
    assert.equal(vcsApp._pollWanted(), true);
    assert.ok(!vcsApp._scheduler()._state.has('repoB'));

    follow(ev, []);                               // the Repository group ends: S1 still holds repoA
    assert.deepEqual(vcsApp._followedCwds(), ['repoA']);
    vcsApp.followFolder('changes:S1', null);      // the last one ends: nothing followed, the heartbeat has no reason
    assert.deepEqual(vcsApp._followedCwds(), []);
    assert.equal(vcsApp._pollWanted(), false);
    assert.equal(vcsApp._scheduler()._state.size, 0);
  } finally { vcsApp.stop(); }
});

test('follow union: a window that goes takes its own list, not main\'s subscribers; another window keeps its own', () => {
  const vcsApp = require('../src/app/vcs');
  vcsApp.init({ getSetting: () => ({ vcsChipEnabled: false }), log: { debug() {} } });
  try {
    const handlers = new Map();
    vcsApp.registerIpc({ on: (ch, fn) => handlers.set(ch, fn), handle() {} });
    const follow = handlers.get('vcs-follow');
    const gone = {};
    const w1 = { sender: { id: 1, once: (ev, fn) => { gone.fn = fn; } } };
    follow(w1, ['repoA']);
    vcsApp.followFolder('changes:S1', 'repoC');
    follow({ sender: { id: 2 } }, ['repoB']);
    gone.fn();   // window 1 destroyed
    assert.deepEqual(vcsApp._followedCwds().sort(), ['repoB', 'repoC']);
    assert.equal(vcsApp._pollWanted(), true);
  } finally { vcsApp.stop(); }
});

test('onStatus: an in-process listener hears each pushed status and can stop listening', () => {
  const vcsApp = require('../src/app/vcs');
  vcsApp.init({ log: { debug() {} } });
  try {
    const heard = [];
    const off = vcsApp.onStatus((cwd, summary) => heard.push([cwd, summary.branch]));
    vcsApp._push('repoA', { branch: 'main' });
    off();
    vcsApp._push('repoA', { branch: 'dev' });
    assert.deepEqual(heard, [['repoA', 'main']]);
  } finally { vcsApp.stop(); }
});
