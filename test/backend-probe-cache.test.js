'use strict';
// #722: a backend's probe walks PATH, and a caller that came less often than the cache lifetime paid the whole
// walk synchronously — the live-owners poll held the main thread for over a second. A stale answer is now
// returned at once and renewed in a task of its own; only the very first answer is taken synchronously.

const test = require('node:test');
const assert = require('node:assert/strict');
const backends = require('../src/backends');

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

    await new Promise(r => setTimeout(r, 5));
    assert.equal(calls, 2, 'renewed in a task of its own, once');
    assert.deepEqual([row().available, row().unavailableReason], [false, 'gone'], 'the renewed answer is served next');
  } finally {
    backends._seedDefaults();
  }
});
