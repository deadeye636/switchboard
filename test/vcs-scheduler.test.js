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

test('getCached returns the last summary or null', async () => {
  const d = makeDeps();
  const s = createScheduler(d);
  assert.strictEqual(s.getCached('repoC'), null);
  s.watch(['repoC']);
  s.tick();
  await flush();
  assert.ok(s.getCached('repoC'));
});
