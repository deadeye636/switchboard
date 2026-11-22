'use strict';
// A task's row actions (#804 T8, spec 41): the worktree a task session worked in, removed by session id. The worktree
// service is a fake; its own refusals are tested against real git in task-worktree.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');

const actions = require('../src/app/task-actions');

const WT = '/data/wt/the-task';

function world({ cached = { projectPath: WT }, owned = [{ worktreePath: WT, branch: 'switchboard/task-x' }], live = 0, remove } = {}) {
  const calls = { removed: [], pushed: 0, liveAsked: [] };
  actions.init({
    getCachedSession: (id) => (id === 'task-session' ? cached : null),
    activeSessions: new Map(),
    liveSessionsIn: (p) => { calls.liveAsked.push(p); return live; },
    checkouts: {
      list: () => owned,
      remove: async (args) => { calls.removed.push(args); return remove ? remove(args) : { ok: true, removed: true, branch: 'switchboard/task-x' }; },
    },
    notifyProjectsChanged: () => { calls.pushed += 1; },
    log: { warn() {} },
  });
  return calls;
}

test('a task session\'s worktree is removed by its session id; the branch is answered and the sidebar told', async () => {
  const calls = world();
  assert.deepEqual(await actions.removeWorktree('task-session', {}), { ok: true, removed: true, branch: 'switchboard/task-x' });
  assert.deepEqual(calls.removed, [{ worktreePath: WT, force: false }]);
  assert.equal(calls.pushed, 1);
});

test('a session that does not work in an app-made worktree is refused, and nothing is asked of git', async () => {
  const calls = world({ owned: [] });
  assert.deepEqual(await actions.removeWorktree('task-session', {}), { ok: false, error: actions.SENTENCES.notATask });
  assert.deepEqual(await actions.removeWorktree('nobody', {}), { ok: false, error: actions.SENTENCES.noSession });
  assert.deepEqual(await actions.removeWorktree(42, {}), { ok: false, error: actions.SENTENCES.noSession });
  assert.deepEqual(calls.removed, []);
});

test('a live session in the worktree refuses the removal', async () => {
  const calls = world({ live: 1 });
  assert.deepEqual(await actions.removeWorktree('task-session', {}), { ok: false, error: actions.SENTENCES.running });
  assert.deepEqual(calls.removed, []);
  assert.deepEqual(calls.liveAsked, [WT], 'asked of the one live-session reading, for the worktree');
});

test('uncommitted changes answer dirty; only force removes them', async () => {
  const calls = world({ remove: ({ force }) => (force ? { ok: true, removed: true, branch: 'b' } : { ok: false, reason: 'dirty', message: 'This worktree has changes that are not committed.' }) });
  assert.deepEqual(await actions.removeWorktree('task-session', {}), { ok: false, dirty: true, error: 'This worktree has changes that are not committed.' });
  assert.equal((await actions.removeWorktree('task-session', { force: true })).ok, true);
  assert.deepEqual(calls.removed.map((c) => c.force), [false, true]);
});

test("force is only the user's confirmed true; a throwing service and a missing one answer a sentence", async () => {
  const calls = world();
  await actions.removeWorktree('task-session', { force: 'yes' });
  assert.deepEqual(calls.removed.map((c) => c.force), [false], 'a truthy value is not a confirmation');
  world({ remove: () => { throw new Error('/a/local/path'); } });
  assert.deepEqual(await actions.removeWorktree('task-session', {}), { ok: false, error: actions.SENTENCES.failed });
  actions.init(null);
  assert.deepEqual(await actions.removeWorktree('task-session', {}), { ok: false, error: actions.SENTENCES.notReady });
});
