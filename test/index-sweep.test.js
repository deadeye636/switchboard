'use strict';

// #590 — a transcript append must not buy a full reconcile through the sidebar's own refetch.
//
// The loop the app closes on itself:
//   append -> postFile -> applyFileReply -> onFileApplied -> notifyRendererProjectsChanged
//          -> the renderer's loadProjects() -> get-projects -> the sweep -> postReconcile
//
// Measured in an ordinary dev instance with two sessions writing: 28 reconcile posts in 93 s, each
// carrying `clone~35f/1177rows`, and every one of them found ZERO tripped folders because
// `refreshFilePrepare` had already stamped the folder before posting the parse.
//
// Which of these fail against the pre-#590 code, honestly: the module did not exist there, so nothing
// in this file LOADS. The statement worth making is about `queueIndexSweep` as it stood in main.js —
// it posted a reconcile for every request that reached it. So "an echo is not swept", "a burst of
// echoes posts once" and "the floor lets one through" describe behaviour it did not have; "a request
// that is not an echo sweeps at once", "duplicates in one tick collapse" and "the first request after
// launch always sweeps" describe behaviour it did, and are contract pins rather than regression
// catches. They are here because they are the three ways this change could have broken something.

const test = require('node:test');
const assert = require('node:assert/strict');

const indexSweep = require('../src/app/index-sweep');

// Drive the module with a controllable push time and a recording postReconcile.
function boot({ pushAt = 0 } = {}) {
  const posts = [];
  const state = { pushAt, quitting: false };
  indexSweep.init({
    isAppQuitting: () => state.quitting,
    lastProjectsPushAt: () => state.pushAt,
    postReconcile: () => posts.push(Date.now()),
  });
  indexSweep._reset();
  return { posts, state };
}

const tick = () => new Promise(r => setImmediate(r));

// One sweep has already run, just now — the ordinary steady state, and the precondition for every
// question about suppression. Without it `lastSweepAt` is 0 and the floor is satisfied by definition.
async function prime(w) {
  w.state.pushAt = 0;
  indexSweep.queue();
  await tick();
  assert.equal(w.posts.length, 1, 'precondition: the priming sweep ran');
  w.posts.length = 0;
}

test('the first request after launch always sweeps, whatever else is going on', async () => {
  // There is nothing to be an echo OF yet, and the first convergence must not wait out the floor.
  const w = boot({ pushAt: Date.now() });
  indexSweep.queue();
  await tick();
  assert.equal(w.posts.length, 1, 'the cold-start sweep is not suppressed');
});

test('a get-projects nobody pushed for sweeps at once', async () => {
  // The user switched to the Sessions tab, or clicked Refresh. Nothing about this is an echo, and the
  // repair it asks for is the whole point of the sweep.
  const w = boot();
  await prime(w);
  w.state.pushAt = Date.now() - (indexSweep.ECHO_WINDOW_MS + 500);
  indexSweep.queue();
  await tick();
  assert.equal(w.posts.length, 1, 'a request from outside the echo window ran immediately');
});

test('duplicate requests inside one tick still collapse to one sweep', async () => {
  const w = boot();
  indexSweep.queue();
  indexSweep.queue();
  indexSweep.queue();
  await tick();
  assert.equal(w.posts.length, 1, 'the old indexSweepQueued guard is intact');
});

test('a get-projects that our own projects-changed push provoked is NOT swept', async () => {
  // The sweep would clone every cached row of every folder to discover that the folder the push was
  // about has already been stamped by refreshFilePrepare.
  const w = boot();
  await prime(w);
  w.state.pushAt = Date.now();
  indexSweep.queue();
  await tick();
  assert.deepEqual(w.posts, [], 'the echo bought nothing, so nothing was posted');
  assert.equal(indexSweep._floorArmed(), true, 'but a sweep is remembered as owed');
});

test('a burst of echoes posts nothing and arms exactly one owed sweep', async () => {
  const w = boot();
  await prime(w);
  for (let i = 0; i < 20; i++) {
    w.state.pushAt = Date.now();
    indexSweep.queue();
    await tick();
  }
  assert.deepEqual(w.posts, [], '20 appends bought 0 reconciles');
  assert.equal(indexSweep._floorArmed(), true, 'one owed sweep, not twenty');
});

test('an echo arriving with no sweep for longer than the floor runs anyway', async () => {
  // Rule 2: a busy session pushes about once a second, so echo suppression alone would switch the
  // drift safety net off for as long as anyone is working.
  const w = boot();
  await prime(w);
  w.state.pushAt = Date.now();
  indexSweep.queue();
  await tick();
  assert.deepEqual(w.posts, [], 'suppressed while a sweep was recent');

  indexSweep._setLastSweepAt(Date.now() - (indexSweep.MIN_INTERVAL_MS + 1000));
  w.state.pushAt = Date.now();
  indexSweep.queue();
  await tick();
  assert.equal(w.posts.length, 1, 'the floor let the safety net through');
});

test('a quit does not let an owed sweep write into a closing database', async () => {
  const w = boot();
  await prime(w);
  w.state.pushAt = Date.now();
  indexSweep.queue();
  await tick();
  assert.equal(indexSweep._floorArmed(), true, 'a sweep is owed');

  w.state.quitting = true;
  // A further request during the quit must not post either — the guard the old setImmediate had.
  w.state.pushAt = 0;
  indexSweep.queue();
  await tick();
  assert.deepEqual(w.posts, [], 'nothing was posted after appQuitting was set');
});

test('the floor is longer than the echo window, or rule 2 could never fire', () => {
  // If the floor were the shorter of the two, every echo would satisfy it and rule 1 would never
  // suppress anything — the two constants only make sense in this order.
  assert.ok(indexSweep.MIN_INTERVAL_MS > indexSweep.ECHO_WINDOW_MS,
    `floor ${indexSweep.MIN_INTERVAL_MS} ms must exceed the echo window ${indexSweep.ECHO_WINDOW_MS} ms`);
});
