'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { buildProjectTagMap, filterProjectsByTags } = require('../src/renderer/bookmarks/project-tags-filter.js');

test('buildProjectTagMap groups tags per project', () => {
  const rows = [
    { projectPath: '/a', tag: 'work', color: '#111' },
    { projectPath: '/a', tag: 'urgent', color: '#222' },
    { projectPath: '/b', tag: 'work', color: '#111' },
  ];
  const map = buildProjectTagMap(rows);
  assert.deepStrictEqual([...map.get('/a')].sort(), ['urgent', 'work']);
  assert.deepStrictEqual([...map.get('/b')], ['work']);
  assert.strictEqual(map.has('/c'), false);
});

test('buildProjectTagMap tolerates junk rows', () => {
  const map = buildProjectTagMap([null, {}, { projectPath: '/a' }, { tag: 'x' }, { projectPath: '/a', tag: 'ok' }]);
  assert.deepStrictEqual([...map.get('/a')], ['ok']);
  assert.strictEqual(map.size, 1);
});

test('buildProjectTagMap handles non-array input', () => {
  assert.strictEqual(buildProjectTagMap(undefined).size, 0);
  assert.strictEqual(buildProjectTagMap(null).size, 0);
});

const PROJECTS = [
  { projectPath: '/a' },
  { projectPath: '/b' },
  { projectPath: '/c' },
];
const MAP = buildProjectTagMap([
  { projectPath: '/a', tag: 'work' },
  { projectPath: '/a', tag: 'urgent' },
  { projectPath: '/b', tag: 'work' },
]);

test('empty selection returns all projects (no-op)', () => {
  assert.deepStrictEqual(filterProjectsByTags(PROJECTS, MAP, new Set()), PROJECTS);
  assert.deepStrictEqual(filterProjectsByTags(PROJECTS, MAP, []), PROJECTS);
});

test('single tag keeps projects that have it', () => {
  const out = filterProjectsByTags(PROJECTS, MAP, new Set(['work']));
  assert.deepStrictEqual(out.map((p) => p.projectPath), ['/a', '/b']);
});

test('AND match: project must have every selected tag', () => {
  const out = filterProjectsByTags(PROJECTS, MAP, new Set(['work', 'urgent']));
  assert.deepStrictEqual(out.map((p) => p.projectPath), ['/a']);
});

test('untagged projects are excluded when a filter is active', () => {
  const out = filterProjectsByTags(PROJECTS, MAP, new Set(['work']));
  assert.strictEqual(out.some((p) => p.projectPath === '/c'), false);
});

test('a selected tag no project has yields empty result', () => {
  assert.deepStrictEqual(filterProjectsByTags(PROJECTS, MAP, new Set(['ghost'])), []);
});

test('non-Map tagMap is treated as no tags (filter active -> empty)', () => {
  assert.deepStrictEqual(filterProjectsByTags(PROJECTS, {}, new Set(['work'])), []);
});

test('handles non-array projects input', () => {
  assert.deepStrictEqual(filterProjectsByTags(null, MAP, new Set(['work'])), []);
});
