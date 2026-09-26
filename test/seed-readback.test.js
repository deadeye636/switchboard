'use strict';
// A seed's readback (#648). `seedSessionWhenReady` used to write the seed and forget it, so a submit the CLI
// refused was lost by construction and the user found the text sitting unsent in the CLI's own composer.
// `watchSeedSubmit` asks the one thing every backend reports — did the session start working — and when it
// did not, presses Enter again (never the text) while the line is ours, then tells the user.
//
// The functions are run as they are written in app.js, cut out of it and evaluated in a `vm` against stubs of
// the globals they read, with a timer queue the test advances by hand.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');

function readbackSource() {
  const start = APP.indexOf('const SEED_CONFIRM_MS');
  const end = APP.indexOf('// Legacy alias', start);
  assert.ok(start !== -1 && end > start, 'the readback lives in app.js between SEED_CONFIRM_MS and the legacy alias');
  return APP.slice(start, end);
}

function setup({ live = true } = {}) {
  const timers = [];
  const writes = [];
  const toasts = [];
  const entry = { session: { sessionId: 'launch' }, closed: false };
  const ctx = vm.createContext({
    sessionBusyState: new Map(),
    turnStartedAt: new Map(),
    finishedAt: new Map(),
    activePtyIds: new Set(live ? ['launch'] : []),
    stagedPromptDirtyLines: new Set(),
    attentionSessions: new Set(),
    sessionMap: new Map([['launch', { sessionId: 'launch', name: 'Fresh one' }]]),
    sendSessionInput: (id, data) => writes.push([id, data]),
    showControlToast: (opts) => toasts.push(opts),
    stagedPromptSessionLabel: (session) => (session && (session.name || session.summary)) || '',
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    Date,
  });
  vm.runInContext(readbackSource(), ctx);
  const seededAt = Date.now();
  vm.runInContext('watchSeedSubmit', ctx)({ currentEntry: () => entry, launchId: 'launch', seedText: 'the packet', seededAt });
  // Run the next queued timer, as the event loop would after its delay.
  const tick = () => { const t = timers.shift(); assert.ok(t, 'a check was scheduled'); t.fn(); return t.ms; };
  return { ctx, entry, writes, toasts, timers, tick, seededAt };
}

test('a turn that started after the seed ends the watch: nothing is pressed and nobody is told', () => {
  const h = setup();
  h.ctx.turnStartedAt.set('launch', h.seededAt + 5);
  assert.equal(h.tick(), vm.runInContext('SEED_CONFIRM_MS', h.ctx));
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.toasts, []);
  assert.equal(h.timers.length, 0);
});

test('a turn that already finished, or a session busy now, counts as landed too', () => {
  const a = setup();
  a.ctx.finishedAt.set('launch', a.seededAt + 1);
  a.tick();
  assert.deepEqual([a.writes, a.toasts], [[], []]);
  const b = setup();
  b.ctx.sessionBusyState.set('launch', true);
  b.tick();
  assert.deepEqual([b.writes, b.toasts], [[], []]);
});

test('a turn from before the seed does not count', () => {
  const h = setup();
  h.ctx.turnStartedAt.set('launch', h.seededAt - 1000);
  h.tick();
  assert.deepEqual(h.writes, [['launch', '\r']], 'an old edge says nothing about this submit');
});

test('no turn: the submit alone is pressed again, then the user is told with the text to copy', () => {
  const h = setup();
  const retries = vm.runInContext('SEED_RETRIES', h.ctx);
  for (let i = 0; i < retries; i++) h.tick();
  assert.deepEqual(h.writes, Array.from({ length: retries }, () => ['launch', '\r']), 'Enter only, never the text again');
  assert.deepEqual(h.toasts, []);
  h.tick();
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].message, /The first message for “Fresh one” was not submitted/);
  assert.equal(h.toasts[0].actionLabel, 'Copy message');
  assert.equal(h.timers.length, 0, 'and the watch ends');
});

test('a retry that lands ends the watch', () => {
  const h = setup();
  h.tick();                                              // first check: nothing, Enter pressed
  h.ctx.turnStartedAt.set('launch', Date.now());         // the Enter took
  h.tick();
  assert.deepEqual(h.writes, [['launch', '\r']]);
  assert.deepEqual(h.toasts, []);
});

test('once the user has typed into the line, Enter is theirs: the user is told instead', () => {
  const h = setup();
  h.ctx.stagedPromptDirtyLines.add('launch');
  h.tick();
  assert.deepEqual(h.writes, [], 'an Enter now would send the user\'s half-written line');
  assert.equal(h.toasts.length, 1);
});

test('a session asking for attention may be showing a dialog: no Enter is pressed into it', () => {
  const h = setup();
  h.ctx.attentionSessions.add('launch');
  h.tick();
  assert.deepEqual(h.writes, []);
  assert.equal(h.toasts.length, 1);
});

test('a session that ended or was closed is left alone', () => {
  const ended = setup({ live: false });
  ended.tick();
  assert.deepEqual([ended.writes, ended.toasts], [[], []]);
  const closed = setup();
  closed.entry.closed = true;
  closed.tick();
  assert.deepEqual([closed.writes, closed.toasts], [[], []]);
});

test('the session re-keyed while the watch waited: the edge under its new id counts, and Enter goes there', () => {
  const h = setup();
  h.entry.session.sessionId = 'named-by-cli';
  h.ctx.activePtyIds.clear();
  h.ctx.activePtyIds.add('named-by-cli');
  h.tick();
  assert.deepEqual(h.writes, [['named-by-cli', '\r']]);
  h.ctx.turnStartedAt.set('named-by-cli', Date.now());
  h.tick();
  assert.deepEqual(h.toasts, []);
});

// The wiring: the seed hands a terminal session to the readback, and the busy edge is what it reads.
test('the seed path starts the readback for a terminal session, and the busy edge stamps the time it reads', () => {
  const seed = APP.slice(APP.indexOf('function seedSessionWhenReady('), APP.indexOf('// Did a seed\'s submit land?'));
  assert.match(seed, /if \(!pipe\) watchSeedSubmit\(/, 'a pipe session is answered by main instead');
  const engine = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'shell', 'attention-engine.js'), 'utf8');
  assert.match(engine, /turnStartedAt\.set\(sessionId, Date\.now\(\)\)/);
});
