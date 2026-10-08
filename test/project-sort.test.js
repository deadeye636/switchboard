const { test } = require('node:test');
const assert = require('node:assert');
const { sortProjects, moveInProjectOrder } = require('../src/renderer/lib/project-sort.js');

// Helper to build a project with a single session at `modified`.
// `empty` → no sessions; `lastActivity` → an empty project that still carries a
// last-activity timestamp (all its sessions were archived).
function P(path, { fav = false, modified = '2026-01-01', missing = false, empty = false, displayName, lastActivity } = {}) {
  return {
    projectPath: path,
    favorited: fav,
    missing,
    displayName,
    lastActivity,
    sessions: empty ? [] : [{ modified }],
  };
}

const paths = arr => arr.map(p => p.projectPath);

test('activity: newest session first', () => {
  const r = sortProjects([
    P('a/old', { modified: '2026-01-01' }),
    P('a/new', { modified: '2026-06-01' }),
    P('a/mid', { modified: '2026-03-01' }),
  ], { projectSortMode: 'activity' });
  assert.deepStrictEqual(paths(r), ['a/new', 'a/mid', 'a/old']);
});

test('alpha: by display label (displayName wins)', () => {
  const r = sortProjects([
    P('z/charlie'),
    P('y/alpha', { displayName: 'Zeta' }),
    P('x/bravo'),
  ], { projectSortMode: 'alpha' });
  assert.deepStrictEqual(paths(r), ['x/bravo', 'z/charlie', 'y/alpha']);
});

test('manual: by projectOrder, unknown to end', () => {
  const r = sortProjects([
    P('a/one', { modified: '2026-01-01' }),
    P('a/two', { modified: '2026-02-01' }),
    P('a/new', { modified: '2026-09-01' }),
  ], { projectSortMode: 'manual', projectOrder: ['a/two', 'a/one'] });
  // a/two, a/one per order; a/new unknown → end
  assert.deepStrictEqual(paths(r), ['a/two', 'a/one', 'a/new']);
});

test('favoritesOwnList false: favorites first', () => {
  const r = sortProjects([
    P('a/plain', { modified: '2026-06-01' }),
    P('a/fav', { fav: true, modified: '2026-01-01' }),
  ], { projectSortMode: 'activity', favoritesOwnList: false });
  assert.deepStrictEqual(paths(r), ['a/fav', 'a/plain']);
});

test('favoritesOwnList true: no favorite priority', () => {
  const r = sortProjects([
    P('a/plain', { modified: '2026-06-01' }),
    P('a/fav', { fav: true, modified: '2026-01-01' }),
  ], { projectSortMode: 'activity', favoritesOwnList: true });
  // pure activity → plain (newer) first
  assert.deepStrictEqual(paths(r), ['a/plain', 'a/fav']);
});

test('missing and empty go to the end', () => {
  const r = sortProjects([
    P('a/missing', { missing: true, modified: '2026-09-01' }),
    P('a/empty', { empty: true }),
    P('a/normal', { modified: '2026-05-01' }),
  ], { projectSortMode: 'activity' });
  assert.strictEqual(paths(r)[0], 'a/normal');
  assert.strictEqual(paths(r)[paths(r).length - 1], 'a/missing');
});

test('all-archived project sorts by lastActivity, only never-used empties sink', () => {
  const r = sortProjects([
    P('a/old', { modified: '2026-01-01' }),
    P('a/archived', { empty: true, lastActivity: '2026-06-01' }),
    P('a/new', { modified: '2026-09-01' }),
    P('a/nevers', { empty: true }), // no lastActivity → genuinely empty → last
  ], { projectSortMode: 'activity' });
  assert.deepStrictEqual(paths(r), ['a/new', 'a/archived', 'a/old', 'a/nevers']);
});

test('lastActivity wins when it is newer than the visible session (#306)', () => {
  // a/archived still shows an older session; its newest work was archived. The project keeps the place
  // that work earned it — the rule used to be "visible session, else lastActivity", so archiving the
  // newest session dropped the project to wherever its second-newest one put it.
  const r = sortProjects([
    P('a/mid', { modified: '2026-05-01' }),
    P('a/archived', { modified: '2026-01-01', lastActivity: '2026-09-01' }),
  ], { projectSortMode: 'activity' });
  assert.deepStrictEqual(paths(r), ['a/archived', 'a/mid']);
});

test('a stale lastActivity never holds a project back (#306)', () => {
  // The other direction: lastActivity is the max across all sessions, so it can only ever equal or
  // trail the visible one — but if a caller hands us an older figure the newer session must still win.
  const r = sortProjects([
    P('a/live', { modified: '2026-09-01', lastActivity: '2026-01-01' }),
    P('a/mid', { modified: '2026-05-01' }),
  ], { projectSortMode: 'activity' });
  assert.deepStrictEqual(paths(r), ['a/live', 'a/mid']);
});

test('manual: missing and empty projects follow the order, they are not moved to the end (#772)', () => {
  const r = sortProjects([
    P('a/normal', { modified: '2026-05-01' }),
    P('a/missing', { missing: true }),
    P('a/empty', { empty: true }),
  ], { projectSortMode: 'manual', projectOrder: ['a/missing', 'a/empty', 'a/normal'] });
  assert.deepStrictEqual(paths(r), ['a/missing', 'a/empty', 'a/normal']);
});

test('manual: favorites stay pinned even when the order puts a missing one first (#772)', () => {
  const r = sortProjects([
    P('a/missing', { missing: true }),
    P('a/fav', { fav: true }),
  ], { projectSortMode: 'manual', favoritesOwnList: false, projectOrder: ['a/missing', 'a/fav'] });
  assert.deepStrictEqual(paths(r), ['a/fav', 'a/missing']);
});

test('manual respects favorites block when pinned', () => {
  const r = sortProjects([
    P('a/restA', { modified: '2026-01-01' }),
    P('a/favB', { fav: true, modified: '2026-01-01' }),
    P('a/restC', { modified: '2026-01-01' }),
    P('a/favD', { fav: true, modified: '2026-01-01' }),
  ], { projectSortMode: 'manual', favoritesOwnList: false, projectOrder: ['a/restC', 'a/restA', 'a/favD', 'a/favB'] });
  // favorites first (favD, favB per order), then rest (restC, restA per order)
  assert.deepStrictEqual(paths(r), ['a/favD', 'a/favB', 'a/restC', 'a/restA']);
});

test('moveInProjectOrder: only the dragged project moves; unrendered ones keep their place (#773)', () => {
  // A filter shows b and d only. Dragging d before b must leave a, c and e where they were.
  const r = moveInProjectOrder(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', 'e'], 'd', 'b', false);
  assert.deepStrictEqual(r, ['a', 'd', 'b', 'c', 'e']);
});

test('moveInProjectOrder: drop after a target', () => {
  assert.deepStrictEqual(moveInProjectOrder(['a', 'b', 'c'], [], 'a', 'c', true), ['b', 'c', 'a']);
});

test('moveInProjectOrder: projects the saved order lacks are appended in render order, then the move applies', () => {
  // Nothing saved yet: the render order is the base, so the first drag does not reshuffle the rest.
  assert.deepStrictEqual(moveInProjectOrder([], ['x', 'y', 'z'], 'z', 'x', false), ['z', 'x', 'y']);
  // Saved a, b; c is new and shown after them.
  assert.deepStrictEqual(moveInProjectOrder(['a', 'b'], ['b', 'a', 'c'], 'c', 'b', false), ['a', 'c', 'b']);
});

test('moveInProjectOrder: entries for projects no list knows are kept', () => {
  // A hidden project is in no list the renderer holds; its saved place must survive a drag.
  assert.deepStrictEqual(moveInProjectOrder(['h', 'a', 'b'], ['a', 'b'], 'b', 'a', false), ['h', 'b', 'a']);
});

test('moveInProjectOrder: a drop on itself changes nothing; a duplicate keeps its last place, as sortProjects ranks it', () => {
  assert.deepStrictEqual(moveInProjectOrder(['a', 'b', 'a'], ['b'], 'a', 'a', false), ['b', 'a']);
});
