'use strict';
// The task runner (#804, spec 41, T5 + T6 as one step): a writing task in a worktree of its own, trust inherited from the
// caller's project, its asks drawn for the user and refused past a bound. Everything it touches is a fake handed through
// `ctx`; no process starts and no git runs (the worktree service has its own tests against real git).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createTaskRunner, forgetRunning, SENTENCES, MAX_MS, ASK_BOUND_MS, APP_CAP } = require('../src/app/task-runner');
const review = require('../src/app/review-runner');
const { stopSession } = require('../src/app/terminal/stop-session');

beforeEach(() => { forgetRunning(); review.forgetRunning(); });

const PROJECT = '/projects/example/alpha';
const WT = '/data/wt/the-task';
const TARGETS = [{ id: 'claude-native', label: 'Claude (GUI)', options: { permissionMode: 'default', permissionModeSent: true } }];

let w_maxMs;
function world({ open, trusted = true, trustRequired = true, grant = { ok: true }, made, targets = TARGETS, worktreeTrusted = null } = {}) {
  const activeSessions = new Map([['caller-id', { _terminalTag: 'caller-tag', exited: false }]]);
  const calls = { open: [], sent: [], aborted: [], links: [], created: [], removed: [], trustSet: [], answered: [] };
  const observers = new Map();
  const timers = [];
  const state = { now: 1000, quitting: false, answerOk: true };
  const trust = {
    get: (p) => (p === PROJECT ? trusted : (p === WT ? worktreeTrusted : null)),
    set: (p, v) => { calls.trustSet.push([p, v]); return grant; },
  };
  const ctx = {
    activeSessions,
    listTargets: () => targets,
    now: () => state.now,
    getAppQuitting: () => state.quitting,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false, fired: false, unref() {} }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    defer: (fn) => fn(),
    timeline: { recordLifecycle() {} },
    stopSession,
    linkSession: (...args) => calls.links.push(args),
    log: { info() {}, warn() {}, debug() {} },
    projectTrust: () => trust,
    trustRequired: () => trustRequired,
    checkouts: {
      create: async (args) => {
        calls.created.push(args);
        return made || { ok: true, worktreePath: WT, repoPath: PROJECT, branch: 'switchboard/task-x', baseCommit: 'abc123' };
      },
      remove: async (args) => { calls.removed.push(args); return { ok: true, removed: true }; },
    },
    openTerminal: async (id, cwd, isNew, opts) => {
      calls.open.push({ id, cwd, isNew, opts });
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
      answerAsk: (id, requestId, answer) => {
        calls.answered.push({ id, requestId, answer });
        if (state.answerOk === 'write-failed') return { ok: false, error: 'The session is not running.' };
        if (!state.answerOk) return { ok: false, notOpen: true, error: 'That question is no longer open.' };
        const obs = observers.get(id);
        if (obs && obs.onAskSettled) obs.onAskSettled(requestId);
        return { ok: true };
      },
    },
  };
  const runner = createTaskRunner({ projectPath: PROJECT, callerTag: 'caller-tag', ctx, maxMs: w_maxMs });
  const childId = () => calls.open[calls.open.length - 1].id;
  return {
    runner, ctx, calls, state, timers,
    obs: () => observers.get(childId()),
    session: () => activeSessions.get(childId()),
    armed: () => timers.filter((t) => !t.cleared && !t.fired),
    fireBound: () => { for (const t of timers.filter((x) => !x.cleared && !x.fired && x.ms === ASK_BOUND_MS)) { t.fired = true; t.fn(); } },
  };
}

const startOk = async (w, prompt = 'Rename the helper and update its callers.') => {
  const res = await w.runner.start({ backend: 'claude-native', prompt });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.accepted;
};

test('the happy path: a worktree, the trust it inherits, the task kind, the branch in every answer', async () => {
  const w = world();
  const accepted = await startOk(w);
  assert.deepEqual(w.calls.created, [{ projectPath: PROJECT, taskId: accepted.id.slice(0, 8) }], 'the worktree is named by the task, short (E25)');
  assert.deepEqual(w.calls.trustSet, [[WT, true]], 'the worktree gets the trust the caller\'s project has');
  const [open] = w.calls.open;
  assert.equal(open.cwd, WT, 'the task starts in its worktree, not in the project');
  assert.deepEqual(open.opts, {
    backendId: 'claude-native', permissionMode: 'default', permissionModeSent: true, model: '',
    spawnKind: 'task', reviewTools: false, spawnedBy: 'caller-id',
  });
  assert.deepEqual(w.calls.links, [[open.id, 'caller-id', 'task']]);
  assert.match(w.calls.sent[0].payload.text, /on the branch switchboard\/task-x/);
  assert.match(w.calls.sent[0].payload.text, /Rename the helper and update its callers\.$/);
  assert.equal(accepted.branch, 'switchboard/task-x');
  assert.equal(accepted.maxMinutes, MAX_MS / 60000);
  assert.equal(MAX_MS, 30 * 60 * 1000, 'E22');

  const o = w.obs();
  o.onBusy(true);
  o.onEntry({}, 'Renamed it in three files and committed.');
  o.onBusy(false);
  const r = w.runner.result(accepted.id).result;
  assert.equal(r.state, 'done');
  assert.equal(r.text, 'Renamed it in three files and committed.');
  assert.equal(r.branch, 'switchboard/task-x');
  assert.equal(r.worktreePath, WT);
  assert.equal(r.baseCommit, 'abc123');
  assert.equal(w.session().kills, 1);
  assert.deepEqual(w.calls.removed, [], 'a finished task keeps its worktree (E8)');
});

test('an untrusted caller project refuses before anything is created or granted', async () => {
  const w = world({ trusted: null });
  const res = await w.runner.start({ backend: 'claude-native', prompt: 'Do it.' });
  assert.deepEqual(res, { ok: false, error: SENTENCES.untrusted });
  assert.deepEqual(w.calls.created, []);
  assert.deepEqual(w.calls.trustSet, []);
  assert.deepEqual(w.calls.open, []);
});

test('a target without the trust gate starts without asking or granting trust', async () => {
  const w = world({ trustRequired: false, trusted: null });
  await startOk(w);
  assert.deepEqual(w.calls.trustSet, []);
  assert.equal(w.calls.open.length, 1);
});

test('a folder that is not a repository refuses with the worktree service\'s sentence', async () => {
  const w = world({ made: { ok: false, reason: 'not-a-repository', message: 'This folder is not a repository.' } });
  const res = await w.runner.start({ backend: 'claude-native', prompt: 'Do it.' });
  assert.deepEqual(res, { ok: false, error: 'This folder is not a repository.' });
  assert.deepEqual(w.calls.open, []);
  assert.deepEqual(w.calls.removed, [], 'nothing was made, so nothing is removed');
});

test('a refused grant or a failed spawn removes the worktree the start made', async () => {
  const w1 = world({ grant: { ok: false } });
  assert.deepEqual(await w1.runner.start({ backend: 'claude-native', prompt: 'Do it.' }), { ok: false, error: SENTENCES.trustNotGranted });
  assert.deepEqual(w1.calls.removed, [{ worktreePath: WT }]);
  assert.deepEqual(w1.calls.open, []);

  const w2 = world({ open: () => ({ ok: false, error: 'boom' }) });
  assert.deepEqual(await w2.runner.start({ backend: 'claude-native', prompt: 'Do it.' }), { ok: false, error: SENTENCES.notStarted });
  assert.deepEqual(w2.calls.removed, [{ worktreePath: WT }]);
});

test('an ask goes to the user: no answer from the runner, no memory, needs-input while it is open', async () => {
  const w = world();
  const { id } = await startOk(w);
  const o = w.obs();
  assert.equal(o.answersFromMemory, false, 'E20: the approval memory never answers a task');
  o.onBusy(true);
  assert.equal(o.onAsk({ id: 'q1', kind: 'approval', tool: 'Edit' }), null, 'left to the card and the attention it raises');
  let r = w.runner.result(id).result;
  assert.equal(r.state, 'needs-input');
  assert.equal(r.note, SENTENCES.needsInput);
  assert.equal(r.openQuestions, 1);
  assert.equal(r.branch, 'switchboard/task-x');
  o.onAskSettled('q1');
  r = w.runner.result(id).result;
  assert.equal(r.state, 'running', 'answered: the task goes on');
  assert.equal(w.armed().filter((t) => t.ms === ASK_BOUND_MS).length, 0, 'the bound is cleared');
});

test('past the bound the ask is refused and the task ends failed, with its text and its branch', async () => {
  const w = world();
  const { id } = await startOk(w);
  const o = w.obs();
  o.onBusy(true);
  o.onEntry({}, 'Changed two files, then asked to run the tests.');
  o.onAsk({ id: 'q1', kind: 'question' });
  assert.equal(ASK_BOUND_MS, 10 * 60 * 1000, 'E19');
  w.fireBound();
  assert.deepEqual(w.calls.answered.map((a) => [a.requestId, a.answer]), [['q1', { cancelled: true }]]);
  const r = w.runner.result(id).result;
  assert.equal(r.state, 'failed');
  assert.equal(r.reason, SENTENCES.askUnanswered);
  assert.equal(r.text, 'Changed two files, then asked to run the tests.', 'a task that may have changed files reports what it said');
  assert.equal(r.branch, 'switchboard/task-x');
  assert.equal(w.session().kills, 1, 'a refused ask does not end the turn, so the runner stops the session');
  assert.deepEqual(w.armed(), []);
});

test('the bound loses to an answer that came first, and to a quit', async () => {
  const w = world();
  const { id } = await startOk(w);
  w.obs().onBusy(true);
  w.obs().onAsk({ id: 'q1', kind: 'approval' });
  w.state.answerOk = false;   // the user got there first: the question is no longer open
  w.fireBound();
  assert.equal(w.runner.result(id).result.state, 'running');

  const q = world();
  const second = await startOk(q);
  q.obs().onBusy(true);
  q.obs().onAsk({ id: 'q1', kind: 'plan', plan: 'Step one.' });
  q.state.quitting = true;
  q.fireBound();
  assert.deepEqual(q.calls.answered, [], 'nothing is written into a closing app');
  assert.equal(q.runner.result(second.id).result.state, 'stopped');
});

test('a task that ends while an ask is open leaves no bound behind; the caller ending stops a waiting task', async () => {
  const w = world();
  const { id } = await startOk(w);
  const o = w.obs();
  o.onBusy(true);
  o.onEntry({}, 'Done.');
  o.onAsk({ id: 'lasting', kind: 'question', lasting: true });
  o.onBusy(false);
  assert.equal(w.runner.result(id).result.state, 'done');
  assert.deepEqual(w.armed(), []);

  const c = world();
  const t2 = await startOk(c);
  c.obs().onBusy(true);
  c.obs().onAsk({ id: 'q1', kind: 'approval' });
  c.runner.release();
  assert.equal(c.session().kills, 1);
  assert.deepEqual(c.armed(), []);
  assert.deepEqual(c.runner.result(t2.id), { ok: false, error: SENTENCES.unknownId });
});

test('the task caps: one per caller, three in the app', async () => {
  const w = world();
  const first = await startOk(w);
  const again = await w.runner.start({ backend: 'claude-native', prompt: 'And another.' });
  assert.equal(again.ok, false);
  assert.match(again.error, new RegExp(`A task is already running for this session: ${first.id}`));
  assert.equal(APP_CAP, 3);
  const others = [world(), world()];
  for (const o of others) await startOk(o);
  const fourth = await world().runner.start({ backend: 'claude-native', prompt: 'One too many.' });
  assert.deepEqual(fourth, { ok: false, error: SENTENCES.appCap });
});

test('a caller that is itself a started session cannot start a task (depth 1)', async () => {
  const w = world();
  const child = createTaskRunner({ projectPath: PROJECT, callerTag: 'caller-tag', callerIsChild: true, ctx: w.ctx });
  assert.deepEqual(await child.start({ backend: 'claude-native', prompt: 'Do it.' }), { ok: false, error: SENTENCES.callerIsChild });
});

test('a checkout the CLI already trusts (its repository root, a folder above) is not written to', async () => {
  const w = world({ worktreeTrusted: true });
  await startOk(w);
  assert.deepEqual(w.calls.trustSet, [], "nothing of the caller's trust is changed");
  assert.equal(w.calls.open.length, 1);
});

test('a refusal that could not be written still ends the task: the question has left the open set', async () => {
  const w = world();
  const { id } = await startOk(w);
  w.obs().onBusy(true);
  w.obs().onAsk({ id: 'q1', kind: 'approval' });
  w.state.answerOk = 'write-failed';
  w.fireBound();
  const r = w.runner.result(id).result;
  assert.equal(r.state, 'failed');
  assert.equal(r.reason, SENTENCES.askUnanswered);
});

test('the overall cap ends a task as timeout, with its text and its branch; the seam shortens it', async () => {
  w_maxMs = 5000;
  try {
    const w = world();
    const accepted = await startOk(w);
    assert.equal(accepted.maxMinutes, 5000 / 60000, 'the seam shortened the cap');
    w.obs().onBusy(true);
    w.obs().onPartial('Half way through the rename.');
    const cap = w.timers.find((t) => t.ms === 5000 && !t.cleared);
    cap.fired = true;
    cap.fn();
    const r = w.runner.result(accepted.id).result;
    assert.equal(r.state, 'timeout');
    assert.equal(r.reason, 'The task took longer than 5 seconds and was stopped.');
    assert.equal(r.text, 'Half way through the rename.');
    assert.equal(r.branch, 'switchboard/task-x');
    assert.deepEqual(w.calls.aborted, [w.calls.open[0].id]);
  } finally { w_maxMs = undefined; }
});

test('a short worktree name that is taken falls back to the whole task id', async () => {
  const w = world();
  let first = true;
  w.ctx.checkouts.create = async (args) => {
    w.calls.created.push(args);
    if (first) { first = false; return { ok: false, reason: 'exists', message: 'A worktree for this task already exists.' }; }
    return { ok: true, worktreePath: WT, repoPath: PROJECT, branch: 'switchboard/task-x', baseCommit: 'abc123' };
  };
  const accepted = await startOk(w);
  assert.deepEqual(w.calls.created.map((c) => c.taskId), [accepted.id.slice(0, 8), accepted.id]);
});
