'use strict';
// #449 — how the Plans list divides into projects.
//
// The decisions live in views/plan-groups.js so a test can hand them data and check the answer, rather
// than grepping the view for a string. The case worth guarding is the plan with NO project: it is not an
// error, it cannot be repaired (the session that would name it is gone), and dropping it would hide a
// document the user can still open.
const test = require('node:test');
const assert = require('node:assert/strict');

const { planGroups, planGroupKey, planGroupLabel, PLAN_GROUP_UNATTRIBUTED } = require('../src/renderer/views/plan-groups');

const plan = (over) => ({ filePath: '/p/a.md', title: 'A', modified: '2026-08-01T10:00:00Z', ...over });

test('plans of one project land in one group', () => {
  const groups = planGroups([
    plan({ filePath: '/p/a.md', projectPath: '/proj/one', displayName: 'One' }),
    plan({ filePath: '/p/b.md', projectPath: '/proj/one', displayName: 'One' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].plans.length, 2);
  assert.equal(planGroupLabel(groups[0]), 'One');
});

test('the group key is the path, so two projects with one name stay apart', () => {
  const groups = planGroups([
    plan({ filePath: '/p/a.md', projectPath: '/work/api', displayName: 'API' }),
    plan({ filePath: '/p/b.md', projectPath: '/other/api', displayName: 'API' }),
  ]);
  assert.equal(groups.length, 2, 'the display name is not the identity');
  assert.notEqual(groups[0].key, groups[1].key);
});

test('a project falls back to its short name, then to its path', () => {
  assert.equal(planGroupLabel({ key: '/p', displayName: '', shortName: 'work/one', projectPath: '/p' }), 'work/one');
  assert.equal(planGroupLabel({ key: '/p', displayName: '', shortName: '', projectPath: '/p' }), '/p');
});

test('the newest plan decides a group\'s place, not the project', () => {
  const groups = planGroups([
    plan({ filePath: '/p/old.md', projectPath: '/proj/stale', displayName: 'Stale', modified: '2026-01-01T00:00:00Z' }),
    plan({ filePath: '/p/new.md', projectPath: '/proj/hot', displayName: 'Hot', modified: '2026-08-19T00:00:00Z' }),
  ]);
  assert.deepEqual(groups.map(g => g.displayName), ['Hot', 'Stale']);
});

test('order inside a group is left as it arrived', () => {
  const groups = planGroups([
    plan({ filePath: '/p/second.md', projectPath: '/p1', modified: '2026-01-01T00:00:00Z' }),
    plan({ filePath: '/p/first.md', projectPath: '/p1', modified: '2026-08-01T00:00:00Z' }),
  ]);
  // The caller already sorted; a second opinion here would fight it.
  assert.deepEqual(groups[0].plans.map(p => p.filePath), ['/p/second.md', '/p/first.md']);
});

test('a plan with no project is kept, in its own group, last', () => {
  const groups = planGroups([
    plan({ filePath: '/p/orphan.md', modified: '2026-08-19T00:00:00Z' }),
    plan({ filePath: '/p/known.md', projectPath: '/proj/one', displayName: 'One', modified: '2026-01-01T00:00:00Z' }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].displayName, 'One', 'the attributed project comes first even though it is older');
  assert.equal(groups[1].key, PLAN_GROUP_UNATTRIBUTED);
  assert.equal(groups[1].projectPath, null);
  assert.equal(groups[1].plans.length, 1);
});

test('the unattributed header states a fact, not a placeholder', () => {
  const label = planGroupLabel({ key: PLAN_GROUP_UNATTRIBUTED });
  assert.doesNotMatch(label, /unknown|unbekannt|n\/a/i, 'must not read like a failure of the app');
  assert.match(label, /session/i, 'it says what is actually missing');
});

test('an empty list produces no groups, and junk does not throw', () => {
  assert.deepEqual(planGroups([]), []);
  assert.deepEqual(planGroups(null), []);
  assert.deepEqual(planGroups([null, undefined]), []);
});

test('planGroupKey answers for a plan with no project', () => {
  assert.equal(planGroupKey({ projectPath: '/x' }), '/x');
  assert.equal(planGroupKey({}), PLAN_GROUP_UNATTRIBUTED);
  assert.equal(planGroupKey(null), PLAN_GROUP_UNATTRIBUTED);
});
