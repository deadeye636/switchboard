'use strict';
// Which settings a load of `settings.html` is about (#365, #593).
//
// `settingsQuery` is the one place the scope is decided, and since #593 it also answers a second
// question: a worktree has no settings of its own, so a window opened for one is about its PROJECT. That
// resolution has to happen before the window loads — the query travels with the load, and a message
// would have to be re-sent on every re-seed — which leaves the query as the only place a test can see it.
//
// `src/app/windows.js` requires `electron` at module load, but only for the constructors it calls later;
// under plain node the destructured names are undefined and nothing here touches them.

const test = require('node:test');
const assert = require('node:assert/strict');

const { settingsQuery } = require('../src/app/windows');

const PROJECT = 'D:\\repo';
const WORKTREE = PROJECT + '\\.claude\\worktrees\\wt1';
const NESTED = WORKTREE + '\\.claude\\worktrees\\wt2';

test('the global scope carries no path', () => {
  assert.deepEqual(settingsQuery('global'), { scope: 'global' });
  assert.deepEqual(settingsQuery('project', ''), { scope: 'global' },
    'a project scope with no path is not a project scope');
});

test('a project is about itself', () => {
  assert.deepEqual(settingsQuery('project', PROJECT), { scope: 'project', path: PROJECT });
});

test('a worktree is about its project, and says which worktree it came from', () => {
  // The label is the whole reason the name is here: the row that was clicked said `wt1` and the title
  // says the project's name, and without a word about it the screen looks like the wrong screen.
  assert.deepEqual(settingsQuery('project', WORKTREE),
    { scope: 'project', path: PROJECT, worktree: 'wt1' });
});

test('a worktree of a worktree resolves to the same project, and names the one it came from', () => {
  assert.deepEqual(settingsQuery('project', NESTED),
    { scope: 'project', path: PROJECT, worktree: 'wt2' },
    'the path walks to the project; the label is the worktree the user actually clicked');
});

test('two worktrees of one project produce different queries', () => {
  // `openSettingsWindow` compares the serialised query to decide whether an already-open window is
  // showing "the same thing" and can simply be focused. Without the label these two would be identical,
  // so opening the second one would have shown the first one's note.
  const a = JSON.stringify(settingsQuery('project', PROJECT + '\\.claude\\worktrees\\a'));
  const b = JSON.stringify(settingsQuery('project', PROJECT + '\\.claude\\worktrees\\b'));
  const plain = JSON.stringify(settingsQuery('project', PROJECT));
  assert.notEqual(a, b);
  assert.notEqual(a, plain, 'and neither is the same as opening the project directly');
});
