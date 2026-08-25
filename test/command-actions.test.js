'use strict';
// #473 — the command-action registry, and the one thing it gained: a title that is resolved per open.
//
// WHY THIS EXISTS:
//   An action that acts on what has focus cannot name its subject at registration — the subject is
//   whatever is focused when the palette opens. So `title` and `group` may be functions, and this file
//   pins the two halves that matter: they are resolved for the reader (nothing downstream may have to
//   know a field can be a function), and a resolver that throws or returns nothing must not take the
//   action out of the list — an action that failed to name itself still applies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'shell', 'command-actions.js'), 'utf8');

// A fresh registry per test: registration is parse-time and global, so a shared one would leak.
function registry() {
  const ctx = vm.createContext({});
  vm.runInContext(SRC, ctx);
  return ctx;
}

test('a string title is handed back untouched', () => {
  const ctx = registry();
  ctx.registerCommandAction({ id: 'a', title: 'Toggle session overview', group: 'View', run: () => {} });
  const [row] = ctx.listCommandActions();
  assert.equal(row.title, 'Toggle session overview');
  assert.equal(row.group, 'View');
});

test('a function title is resolved at list time, not at registration', () => {
  const ctx = registry();
  let name = 'first';
  ctx.registerCommandAction({ id: 'a', title: () => `Write a handoff for “${name}”`, run: () => {} });
  assert.equal(ctx.listCommandActions()[0].title, 'Write a handoff for “first”');
  name = 'second';
  assert.equal(ctx.listCommandActions()[0].title, 'Write a handoff for “second”',
    'the subject changes while the app runs — resolving once would pin the wrong session');
});

test('a title that throws or resolves to nothing falls back rather than dropping the row', () => {
  const ctx = registry();
  ctx.registerCommandAction({ id: 'thrower', title: () => { throw new Error('x'); }, run: () => {} });
  ctx.registerCommandAction({ id: 'blank', title: () => '', group: () => '', run: () => {} });
  const rows = ctx.listCommandActions();
  assert.equal(rows.length, 2, 'failing to name itself is not a reason to disappear');
  assert.equal(rows[0].title, 'thrower');
  assert.equal(rows[1].title, 'blank');
  assert.equal(rows[1].group, 'Action');
});

test('resolving does not lose run, keywords or available', async () => {
  const ctx = registry();
  let ran = 0;
  ctx.registerCommandAction({
    id: 'a', title: () => 'X', keywords: 'k', available: () => true, run: () => { ran += 1; },
  });
  const [row] = ctx.listCommandActions();
  assert.equal(row.keywords, 'k');
  await row.run();
  assert.equal(ran, 1);
});

test('available still decides, and it is asked before the title is resolved', () => {
  const ctx = registry();
  let titleCalls = 0;
  ctx.registerCommandAction({
    id: 'a', title: () => { titleCalls += 1; return 'X'; }, available: () => false, run: () => {},
  });
  assert.equal(ctx.listCommandActions().length, 0);
  assert.equal(titleCalls, 0, 'a hidden action must not pay for a name nobody reads');
});

test('re-registering replaces rather than duplicating', () => {
  const ctx = registry();
  ctx.registerCommandAction({ id: 'a', title: 'one', run: () => {} });
  ctx.registerCommandAction({ id: 'a', title: 'two', run: () => {} });
  const rows = ctx.listCommandActions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'two');
});
