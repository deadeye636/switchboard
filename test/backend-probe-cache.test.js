'use strict';
// #722: a backend's probe walks PATH, and a caller that came less often than the cache lifetime paid the whole
// walk synchronously — the live-owners poll held the main thread for over a second. A stale answer is now
// returned at once and renewed in a task of its own; only the very first answer is taken synchronously.

const test = require('node:test');
const assert = require('node:assert/strict');
const backends = require('../src/backends');
const fs = require('node:fs');
const path = require('node:path');
const { stripComments } = require('./helpers/strip-comments');

// Renewals run in setImmediate tasks, one per turn of the loop (#750). A timer is no measure of that: under load
// it can fire in the timers phase before the check phase that holds the renewal. Count turns instead.
const turns = async (n) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

test('a probe answers once synchronously, then renews a stale answer off the caller\'s path', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  let installed = true;
  backends._resetForTests();
  try {
    backends.register({ id: 'probe-cache-test', status: 'ready', probe: () => { calls++; return installed ? { ok: true } : { ok: false, reason: 'gone' }; } });
    const row = () => backends.list().find(b => b.id === 'probe-cache-test');

    assert.equal(row().available, true);
    assert.equal(calls, 1, 'the first answer is taken synchronously');
    row();
    assert.equal(calls, 1, 'a fresh answer is reused');

    now += 60_000;
    installed = false;
    assert.equal(row().available, true, 'a stale answer is returned as it is…');
    row();
    assert.equal(calls, 1, '…and nobody waits on the walk, however often it is asked');

    await turns(2);
    assert.equal(calls, 2, 'renewed in a task of its own, once');
    assert.deepEqual([row().available, row().unavailableReason], [false, 'gone'], 'the renewed answer is served next');
  } finally {
    backends._seedDefaults();
  }
});

// #750: one timer per backend still ran the whole roster in a single timers phase — every renewal expires at
// once — so a hook request on 127.0.0.1 waited out all of them and Claude Code dropped it after 1 s. The loop
// must get a turn between any two renewals: whatever one probe schedules runs before the next probe does.
test('stale probes are renewed one per turn of the loop, not back to back', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const order = [];
  backends._resetForTests();
  try {
    for (const id of ['probe-turn-a', 'probe-turn-b', 'probe-turn-c']) {
      backends.register({ id, status: 'ready', probe: () => {
        order.push(id);
        setImmediate(() => order.push(`turn-after-${id}`));
        return { ok: true };
      } });
    }
    backends.list();
    await turns(2);   // the first, synchronous answers' own markers
    order.length = 0;

    now += 60_000;
    backends.list();
    assert.deepEqual(order, [], 'nobody waits on a stale probe');

    await turns(10);
    assert.deepEqual(order, [
      'probe-turn-a', 'turn-after-probe-turn-a',
      'probe-turn-b', 'turn-after-probe-turn-b',
      'probe-turn-c', 'turn-after-probe-turn-c',
    ]);
  } finally {
    backends._seedDefaults();
  }
});

// #750: the PATH listing a probe reads is shared for a few seconds, so a launch drops it before it asks
// `probe({ launch: true })` — or a CLI installed just before the click is refused for the listing's lifetime.
// A SOURCE check, for the reason `test/spawn-first-resize.test.js` gives: `node-pty` is required at module
// load, so no test reaches a fresh spawn. What it pins is the reordering that would bring the refusal back.
test('the spawn path drops the PATH listing before it asks the launch probe', () => {
  const code = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js'), 'utf8'));
  const drop = code.indexOf('ctx.backends.forgetPathListing()');
  const ask = code.indexOf('backend.probe({ launch: true })');
  assert.ok(drop > 0, 'spawn.js drops the listing');
  assert.ok(ask > 0, 'spawn.js asks the launch probe');
  assert.ok(drop < ask, 'the listing is dropped BEFORE the launch probe reads it');
  assert.equal(typeof backends.forgetPathListing, 'function', 'the registry offers what spawn.js calls');
});
