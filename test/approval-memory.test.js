'use strict';
// #731: `src/app/approval-memory.js` keeps what the user allowed for a session (per session id, bounded) and in a
// project (as lines of a backend option in the project's settings blob).
const test = require('node:test');
const assert = require('node:assert/strict');

const memory = require('../src/app/approval-memory');

function setup() {
  const store = new Map();
  const persisted = [];
  let broadcasts = 0;
  memory.init({
    db: { getSetting: (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), setSetting: (k, v) => store.set(k, v) },
    persistSettingsBlob: (k, v) => { persisted.push(k); store.set(k, v); },
    broadcastSettingsChanged: () => { broadcasts++; },
    log: { info() {}, warn() {}, debug() {} },
  });
  return { store, persisted, broadcasts: () => broadcasts };
}

test('a session allow is kept per backend and session id, and carried once the runtime names its session', () => {
  setup();
  memory.rememberSession('b', 'launch', 'bash');
  memory.rememberSession('b', 'launch', 'edit');
  memory.rememberSession('b', 'launch', 'bash');
  assert.deepEqual([...memory.sessionKeys('b', 'launch')], ['bash', 'edit']);
  assert.equal(memory.sessionKeys('other', 'launch').size, 0, 'another backend\'s session is another entry');
  memory.carrySession('b', 'launch', 'real');
  assert.deepEqual([...memory.sessionKeys('b', 'real')], ['bash', 'edit']);
  assert.equal(memory.sessionKeys('b', 'launch').size, 0);
});

test('the session store is bounded to the newest sessions', () => {
  const { store } = setup();
  for (let i = 0; i < memory.SESSION_CAP + 5; i++) memory.rememberSession('b', `s${i}`, 'bash');
  assert.equal(Object.keys(store.get(memory.SESSIONS_KEY).entries).length, memory.SESSION_CAP);
});

test('project rules cascade like an option, and a written rule starts from the global ones', () => {
  const { store, persisted, broadcasts } = setup();
  store.set('global', { backendDefaults: { b: { rules: 'edit' } } });
  assert.deepEqual(memory.projectRules('b', '<project>', 'rules'), ['edit'], 'no project value: the global one');
  assert.equal(memory.rememberProjectRule('b', '<project>', 'rules', 'bash(npm test)'), true);
  assert.deepEqual(persisted, ['project:<project>']);
  assert.equal(broadcasts(), 1);
  assert.equal(store.get('project:<project>').backendDefaults.b.rules, 'edit\nbash(npm test)');
  assert.deepEqual(memory.projectRules('b', '<project>', 'rules'), ['edit', 'bash(npm test)']);
  memory.rememberProjectRule('b', '<project>', 'rules', 'bash(npm test)');
  assert.equal(persisted.length, 1, 'a rule already there is not written again');
  assert.equal(memory.rememberProjectRule('b', '<project>', 'rules', 'edit\nbash(*)'), false, 'a rule is one line');
  assert.equal(persisted.length, 1);
});

test('a worktree reads and writes its project\'s rules', () => {
  const { store } = setup();
  const project = '/code/app';
  const worktree = `${project}/.claude/worktrees/agent-a`;
  memory.rememberProjectRule('b', worktree, 'rules', 'write');
  assert.ok(store.has(`project:${project}`), 'written at the project, not at the worktree');
  assert.deepEqual(memory.projectRules('b', worktree, 'rules'), ['write']);
});
