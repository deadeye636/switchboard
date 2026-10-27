'use strict';
// The review runner (#507 slice 2b, spec 39, T5): a session started for a review, followed without a view, one turn,
// the last assistant text, stopped once. Everything it touches is a fake handed through `ctx`; no process starts.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createReviewRunner, forgetRunning, PREAMBLE, SENTENCES, MAX_MS, MAX_TEXT, APP_CAP } = require('../src/app/review-runner');
const { stopSession } = require('../src/app/terminal/stop-session');
const { stripComments } = require('./helpers/strip-comments');

beforeEach(() => forgetRunning());

const PROJECT = '/projects/example/alpha';
const TARGETS = [
  { id: 'pi-native', label: 'Pi (native)', options: { approvalGate: true } },
  { id: 'claude-native', label: 'Claude (native)', options: { permissionMode: 'plan' } },
];

// A fake world. `open` decides what openTerminal answers; everything the runner did is recorded.
function world({ open, quitting = false, callerIsReview = false, targets = TARGETS } = {}) {
  const activeSessions = new Map([['caller-id', { _terminalTag: 'caller-tag', exited: false }]]);
  const calls = { open: [], sent: [], aborted: [], timeline: [], links: [] };
  const observers = new Map();
  const timers = [];
  const state = { now: 1000, quitting };
  const ctx = {
    activeSessions,
    listTargets: () => targets,
    now: () => state.now,
    getAppQuitting: () => state.quitting,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false, fired: false, unref() {} }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    defer: (fn) => fn(),
    timeline: { recordLifecycle: (...args) => calls.timeline.push(args) },
    stopSession,
    linkSession: (...args) => calls.links.push(args),
    log: { info() {}, warn() {}, debug() {} },
    openTerminal: async (id, projectPath, isNew, opts) => {
      calls.open.push({ id, projectPath, isNew, opts });
      if (open) { const answer = open(id); if (answer) return answer; }
      const s = { _terminalTag: `tag-${id}`, exited: false, kills: 0 };
      s.pty = { kill: () => { s.kills += 1; } };
      activeSessions.set(id, s);
      return { ok: true };
    },
    agentRpc: {
      observe: (id, obs) => { if (!activeSessions.has(id)) return false; observers.set(id, obs); return true; },
      sendTurn: async (id, payload) => { calls.sent.push({ id, payload }); return { ok: true }; },
      abortTurn: async (id) => { calls.aborted.push(id); return { ok: true }; },
    },
  };
  const runner = createReviewRunner({ projectPath: PROJECT, callerTag: 'caller-tag', callerIsReview, ctx });
  const reviewId = () => calls.open[calls.open.length - 1].id;
  return {
    runner, ctx, calls, state, timers, activeSessions,
    obs: () => observers.get(reviewId()),
    session: () => activeSessions.get(reviewId()),
    armed: () => timers.filter((t) => !t.cleared && !t.fired),
    fire: () => { for (const t of timers.filter((x) => !x.cleared && !x.fired)) { t.fired = true; t.fn(); } },
  };
}

const startOk = async (w, backend = 'pi-native', prompt = 'Review src/app.js please.') => {
  const res = await w.runner.start({ backend, prompt });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.accepted.id;
};

test('the happy path: one session with the profile, one turn, the last text, stopped once', async () => {
  const w = world();
  const id = await startOk(w);
  const [open] = w.calls.open;
  assert.equal(open.projectPath, PROJECT);
  assert.equal(open.isNew, true);
  assert.deepEqual(open.opts, { backendId: 'pi-native', approvalGate: true, model: '', reviewTools: false, spawnedBy: 'caller-id' });
  assert.equal(w.calls.sent.length, 1);
  assert.equal(w.calls.sent[0].payload.text, PREAMBLE + 'Review src/app.js please.');
  assert.deepEqual(w.calls.links, [[open.id, 'caller-id', 'review']]);
  assert.equal(w.runner.result(id).result.state, 'running');

  const o = w.obs();
  o.onBusy(true);
  o.onEntry({}, null);
  o.onEntry({}, 'first thought');
  o.onEntry({}, '   ');
  o.onEntry({}, 'The final answer.');
  o.onBusy(false);
  const r = w.runner.result(id).result;
  assert.equal(r.state, 'done');
  assert.equal(r.text, 'The final answer.');
  assert.equal(r.truncated, false);
  assert.equal(r.refusedActions, 0);
  assert.equal(r.sessionId, open.id);
  assert.equal(w.session().kills, 1);
  assert.deepEqual(w.calls.timeline, [[open.id, 'stopped', 'Session stopped', SENTENCES.stopReason]], 'the runner\'s reason is recorded');
  assert.deepEqual(w.armed(), []);
  o.onBusy(false);
  o.onExit();
  assert.equal(w.session().kills, 1, 'stopped once');
});

test('an idle edge before the turn began is the start settling, not the end', async () => {
  const w = world();
  const id = await startOk(w);
  w.obs().onBusy(false);
  assert.equal(w.runner.result(id).result.state, 'running');
  w.obs().onBusy(true);
  w.obs().onBusy(false);
  assert.equal(w.runner.result(id).result.state, 'failed', 'a turn with no text is no answer');
  assert.equal(w.runner.result(id).result.reason, SENTENCES.noReply);
});

test('every ask is refused and counted; a plan is the answer only when no text follows it', async () => {
  const w = world();
  const id = await startOk(w, 'claude-native');
  const o = w.obs();
  o.onBusy(true);
  assert.deepEqual(o.onAsk({ id: 'q1', kind: 'approval', tool: 'Bash' }), { cancelled: true });
  assert.deepEqual(o.onAsk({ id: 'q2', kind: 'plan', plan: 'Step one, step two.' }), { cancelled: true });
  o.onBusy(false);
  const r = w.runner.result(id).result;
  assert.equal(r.state, 'done');
  assert.equal(r.text, 'Step one, step two.');
  assert.equal(r.refusedActions, 2);

  const w2 = world();
  const id2 = await startOk(w2, 'claude-native');
  w2.obs().onBusy(true);
  w2.obs().onAsk({ id: 'q', kind: 'plan', plan: 'The plan.' });
  w2.obs().onEntry({}, 'The real answer.');
  w2.obs().onBusy(false);
  assert.equal(w2.runner.result(id2).result.text, 'The real answer.');
});

test('the cap aborts the turn, keeps what was written as a timeout, and stops the session once', async () => {
  const w = world();
  const id = await startOk(w);
  assert.equal(w.timers[0].ms, MAX_MS);
  w.obs().onBusy(true);
  w.obs().onEntry({}, 'half of it');
  w.fire();
  const r = w.runner.result(id).result;
  assert.equal(r.state, 'timeout');
  assert.equal(r.text, 'half of it', 'the partial text is kept, never labelled done');
  assert.equal(r.reason, SENTENCES.timeout);
  assert.deepEqual(w.calls.aborted, [w.calls.open[0].id]);
  assert.equal(w.session().kills, 1);
  w.obs().onBusy(false);
  assert.equal(w.runner.result(id).result.state, 'timeout', 'the late idle changes nothing');
});

test('the session ending before an answer is stopped, and nothing is stopped twice', async () => {
  const w = world();
  const id = await startOk(w);
  w.obs().onBusy(true);
  w.session().exited = true;
  w.obs().onExit({ exitCode: 1 });
  const r = w.runner.result(id).result;
  assert.equal(r.state, 'stopped');
  assert.equal(r.reason, SENTENCES.sessionStopped);
  assert.equal(w.session().kills, 0, 'an exited session is not killed again');
  assert.deepEqual(w.armed(), []);
});

test('one running review per caller, named; and an app-wide cap', async () => {
  const w = world();
  const id = await startOk(w);
  const second = await w.runner.start({ backend: 'pi-native', prompt: 'again' });
  assert.equal(second.ok, false);
  assert.match(second.error, new RegExp(id));

  const others = [world(), world()];
  for (const o of others) await startOk(o);
  const over = await world().runner.start({ backend: 'pi-native', prompt: 'one too many' });
  assert.deepEqual(over, { ok: false, error: SENTENCES.appCap });
  assert.equal(APP_CAP, 3);
});

test('refusals before anything starts: a review caller, quitting, an unknown backend, an empty or long prompt', async () => {
  const cases = [
    [world({ callerIsReview: true }), { backend: 'pi-native', prompt: 'x' }, SENTENCES.callerIsReview],
    [world({ quitting: true }), { backend: 'pi-native', prompt: 'x' }, SENTENCES.quitting],
    [world(), { backend: 'codex', prompt: 'x' }, SENTENCES.noTarget],
    [world({ targets: [] }), { backend: 'pi-native', prompt: 'x' }, SENTENCES.noTarget],
    [world(), { backend: 'pi-native', prompt: '   ' }, SENTENCES.emptyPrompt],
    [world(), { backend: 'pi-native', prompt: 'x'.repeat(16001) }, SENTENCES.longPrompt],
  ];
  for (const [w, args, sentence] of cases) {
    assert.deepEqual(await w.runner.start(args), { ok: false, error: sentence });
    assert.equal(w.calls.open.length, 0);
    assert.deepEqual(w.armed(), []);
  }
});

test('a start the spawn path refuses answers a fixed sentence, leaks nothing and leaves nothing running', async () => {
  const cases = [
    [() => ({ ok: false, error: 'no window' }), SENTENCES.noWindow],
    [() => ({ ok: false, untrusted: { backendId: 'pi-native' } }), SENTENCES.untrusted],
    [() => ({ ok: false, error: 'project directory no longer exists: /home/someone/secret' }), SENTENCES.notStarted],
  ];
  for (const [open, sentence] of cases) {
    const w = world({ open });
    assert.deepEqual(await w.runner.start({ backend: 'pi-native', prompt: 'x' }), { ok: false, error: sentence });
    assert.deepEqual(w.armed(), []);
  }
  // None of them counted against the app-wide cap.
  for (let i = 0; i < APP_CAP; i += 1) await startOk(world());
});

test('release stops a running review and forgets every result', async () => {
  const w = world();
  const id = await startOk(w);
  w.runner.release();
  assert.equal(w.session().kills, 1);
  assert.deepEqual(w.runner.result(id), { ok: false, error: SENTENCES.unknownId });
  assert.deepEqual(await w.runner.start({ backend: 'pi-native', prompt: 'x' }), { ok: false, error: SENTENCES.callerEnded });
  assert.deepEqual(w.armed(), []);
});

test('another caller\'s review id answers the same sentence as one that never existed', async () => {
  const a = world();
  const id = await startOk(a);
  const b = world();
  assert.deepEqual(b.runner.result(id), { ok: false, error: SENTENCES.unknownId });
  assert.deepEqual(b.runner.result('nope'), b.runner.result(id));
  assert.deepEqual(b.runner.result(42), b.runner.result(id));
});

test('a long answer is cut on a character boundary and says so', async () => {
  const w = world();
  const id = await startOk(w);
  w.obs().onBusy(true);
  w.obs().onEntry({}, '\u{1F600}'.repeat(MAX_TEXT + 500));
  w.obs().onBusy(false);
  const r = w.runner.result(id).result;
  assert.equal(r.truncated, true);
  assert.match(r.text, /\[\.\.\. 500 characters omitted \.\.\.\]/);
  assert.doesNotMatch(r.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'no lone surrogate');
});

test('once the app is quitting nothing is called into it: no stop, no abort', async () => {
  const w = world();
  const id = await startOk(w);
  w.obs().onBusy(true);
  w.state.quitting = true;
  w.obs().onBusy(false);
  assert.equal(w.runner.result(id).result.state, 'stopped');
  assert.equal(w.runner.result(id).result.reason, SENTENCES.appQuitting);
  assert.equal(w.session().kills, 0);

  const w2 = world();
  const id2 = await startOk(w2);
  w2.state.quitting = true;
  w2.fire();
  assert.deepEqual(w2.calls.aborted, []);
  assert.equal(w2.runner.result(id2).result.state, 'stopped');
});

test('the read-only profile wins over a stored default through the real options merge', () => {
  const spawn = require('../src/app/terminal/spawn');
  const stored = { 'pi-native': { approvalGate: false, model: 'big-model' }, 'claude-native': { permissionMode: 'bypassPermissions', model: 'opus' } };
  spawn.init({ getSetting: (key) => (key === 'global' ? { backendDefaults: stored } : {}) });
  for (const target of TARGETS) {
    // The options the runner hands openTerminal, as the happy-path test pins them.
    const opts = { backendId: target.id, ...target.options, model: '', reviewTools: false, spawnedBy: 'caller-id' };
    const merged = spawn.spawnOptionsFor({ id: target.id }, PROJECT, opts);
    for (const [k, v] of Object.entries(target.options)) assert.equal(merged[k], v, `${target.id}.${k}`);
    assert.equal(merged.model, '', 'a stored model is kept out');
  }
});

test('the runner names no backend and needs no electron', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'review-runner.js'), 'utf8'));
  assert.doesNotMatch(src, /require\(['"]electron['"]\)/);
  assert.doesNotMatch(src, /['"](claude|claude-native|codex|agy|pi|pi-native|hermes)['"]/);
  assert.doesNotMatch(src, /require\(['"]\.\.\/backends\//, 'src/app does not import a backend folder');
});

// T5 verifier F1, F2, F4.
test('narration before the plan does not beat it; a failed model call is no answer; a gone caller starts nothing', async () => {
  const w = world();
  const id = await startOk(w, 'claude-native');
  w.obs().onBusy(true);
  w.obs().onEntry({}, 'I will start by reading the files.');
  w.obs().onAsk({ id: 'p', kind: 'plan', plan: 'The full review.' });
  w.obs().onBusy(false);
  assert.equal(w.runner.result(id).result.text, 'The full review.');

  const f = world();
  const fid = await startOk(f);
  f.obs().onBusy(true);
  f.obs().onEntry({}, 'Let me look at X.');
  f.obs().onEntry({ _failed: true }, null);
  f.obs().onBusy(false);
  assert.equal(f.runner.result(fid).result.state, 'failed');

  const g = world();
  g.activeSessions.delete('caller-id');
  assert.deepEqual(await g.runner.start({ backend: 'pi-native', prompt: 'x' }), { ok: false, error: SENTENCES.callerEnded });
  assert.equal(g.calls.open.length, 0);
});
