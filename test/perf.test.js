const { test } = require('node:test');
const assert = require('node:assert');
const { startTimer, timed, timedAsync } = require('../src/perf');

test('startTimer returns a non-decreasing, non-negative elapsed probe', () => {
  const done = startTimer();
  const a = done();
  const b = done();
  assert.ok(a >= 0, 'first reading is non-negative');
  assert.ok(b >= a, 'later reading is not smaller');
  assert.equal(typeof a, 'number');
});

test('timed returns the wrapped value', () => {
  const out = timed('x', () => 42, { log: null });
  assert.equal(out, 42);
});

test('timed logs one [perf] line when the span is at/over the threshold', () => {
  const lines = [];
  const log = { debug: (m) => lines.push(m) };
  // slowMs: -1 so any non-negative elapsed counts as slow → deterministic.
  timed('hot.block', () => {}, { log, slowMs: -1 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[perf\] hot\.block \d+(\.\d+)?ms$/);
});

test('timed stays silent when under the threshold', () => {
  const lines = [];
  const log = { debug: (m) => lines.push(m) };
  timed('cheap', () => {}, { log, slowMs: Infinity });
  assert.equal(lines.length, 0);
});

test('timed measures and rethrows even when fn throws', () => {
  const lines = [];
  const log = { debug: (m) => lines.push(m) };
  assert.throws(() => timed('boom', () => { throw new Error('nope'); }, { log, slowMs: -1 }), /nope/);
  assert.equal(lines.length, 1, 'the finally block still logged the span');
});

test('timed without a logger measures silently and does not throw', () => {
  assert.doesNotThrow(() => timed('no-log', () => {}, { slowMs: -1 }));
});

test('timedAsync awaits the value and logs when slow', async () => {
  const lines = [];
  const log = { debug: (m) => lines.push(m) };
  const out = await timedAsync('async.block', async () => 'ok', { log, slowMs: -1 });
  assert.equal(out, 'ok');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[perf\] async\.block /);
});

const { performance } = require('perf_hooks');
const { noteWork, createLoopLagCheck } = require('../src/perf');

test('loop-lag check stays silent while the timer runs on time', () => {
  const lines = [];
  const t0 = performance.now();
  const check = createLoopLagCheck({ log: { info: (m) => lines.push(m) }, intervalMs: 250, thresholdMs: 1000, now: () => t0 });
  assert.equal(check.tick(t0 + 250), null);
  assert.equal(check.tick(t0 + 500 + 900), null, 'late, but under the threshold');
  assert.equal(lines.length, 0);
});

test('loop-lag check names the work that started since the previous tick', () => {
  const lines = [];
  const t0 = performance.now();
  const check = createLoopLagCheck({ log: { info: (m) => lines.push(m) }, intervalMs: 250, thresholdMs: 1000, now: () => t0 });
  noteWork('ipc:get-projects');
  noteWork('index-apply:file');
  noteWork('ipc:get-projects');
  const line = check.tick(performance.now() + 250 + 3000);
  assert.equal(lines.length, 1);
  assert.equal(line, lines[0]);
  assert.match(line, /^\[loop-lag\] main event loop blocked ~\d+ms; work started in that window: ipc:get-projects, index-apply:file$/);
});

test('loop-lag check does not name work from before the previous tick', () => {
  noteWork('ipc:old-call');
  const t1 = performance.now() + 1;
  const check = createLoopLagCheck({ log: null, intervalMs: 250, thresholdMs: 1000, now: () => t1 });
  const line = check.tick(t1 + 250 + 2000);
  assert.match(line, /work started in that window: nothing noted$/);
});

test('noteIpcCalls leaves a breadcrumb for handle and on, and passes the call through', () => {
  const { noteIpcCalls } = require('../src/perf');
  const listeners = new Map();
  const ipc = {
    handle(channel, fn) { listeners.set(`handle:${channel}`, fn); },
    on(channel, fn) { listeners.set(`on:${channel}`, fn); },
  };
  noteIpcCalls(ipc);
  assert.strictEqual(noteIpcCalls(ipc), ipc, 'a second wrap is refused');
  ipc.handle('ask', (_e, n) => n * 2);
  ipc.on('tell', () => 'told');
  const t0 = performance.now();
  const check = createLoopLagCheck({ log: null, intervalMs: 250, thresholdMs: 1000, now: () => t0 });
  assert.equal(listeners.get('handle:ask')({}, 21), 42);
  assert.equal(listeners.get('on:tell')({}), 'told');
  assert.match(check.tick(performance.now() + 250 + 2000), /work started in that window: ipc:ask, ipc:tell$/);
});

test('a breadcrumb names the work that HELD the loop, and only that work', async () => {
  const { noteIpcCalls, setSlowWorkLog } = require('../src/perf');
  const lines = [];
  setSlowWorkLog({ info: (m) => lines.push(m) }, 30);
  try {
    const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* hold the thread */ } };
    const listeners = new Map();
    const ipc = { handle(channel, fn) { listeners.set(channel, fn); }, on() {} };
    noteIpcCalls(ipc);
    ipc.handle('slow', () => { busy(40); return 'ok'; });
    ipc.handle('quick', () => 'ok');
    ipc.handle('awaits', async () => { await new Promise(r => setTimeout(r, 60)); return 'ok'; });
    ipc.handle('throws', () => { busy(40); throw new Error('boom'); });
    assert.equal(listeners.get('slow')(), 'ok');
    assert.equal(listeners.get('quick')(), 'ok');
    assert.equal(await listeners.get('awaits')(), 'ok');
    assert.throws(() => listeners.get('throws')(), /boom/);
    const done = noteWork('index-apply:file');
    busy(40);
    assert.ok(done() >= 40, 'done() answers the span');
    assert.equal(lines.length, 3, lines.join(' | '));
    assert.match(lines[0], /^\[slow-work\] ipc:slow held the main thread \d+ms$/);
    assert.match(lines[1], /^\[slow-work\] ipc:throws held the main thread/, 'a handler that throws is measured too');
    assert.match(lines[2], /^\[slow-work\] index-apply:file held the main thread/);
    // Only the synchronous part counts: the 60 ms await did not hold the loop.
    assert.ok(!lines.some(l => l.includes('ipc:awaits')));
  } finally {
    setSlowWorkLog(null);
  }
});

test('no slow-work logger, no line', () => {
  const { setSlowWorkLog } = require('../src/perf');
  setSlowWorkLog(null);
  const done = noteWork('quiet');
  const end = performance.now() + 5; while (performance.now() < end) { /* hold */ }
  assert.ok(done() >= 5);
});
