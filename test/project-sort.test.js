const { test } = require('node:test');
const assert = require('node:assert');
const { sortProjects } = require('../public/project-sort.js');

// Helper to build a project with a single session at `modified`.
function P(path, { fav = false, modified = '2026-01-01', missing = false, empty = false, displayName } = {}) {
  return {
    projectPath: path,
    favorited: fav,
    missing,
    displayName,
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
