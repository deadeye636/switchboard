'use strict';
// #164: filtering the sidebar by SESSION tag. The mirror of the project-tag filter, one axis down —
// a project tag drops whole projects, a session tag drops session ROWS and a project disappears only as
// a consequence of having none left. An empty project row here would say "this project has no sessions",
// which is not what the filter found.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSessionTagMap, filterProjectSessionsByTags } = require('../public/session-tags-filter');

const rows = [
  { sessionId: 's1', tag: 'bug', color: '#f00' },
  { sessionId: 's1', tag: 'review', color: '#0f0' },
  { sessionId: 's2', tag: 'bug', color: '#f00' },
  { sessionId: 's3', tag: 'idea', color: '#00f' },
];

const projects = () => ([
  { projectPath: 'D:\\a', sessions: [{ sessionId: 's1' }, { sessionId: 's2' }] },
  { projectPath: 'D:\\b', sessions: [{ sessionId: 's3' }] },
  { projectPath: 'D:\\c', sessions: [{ sessionId: 's4' }] },   // untagged
]);

test('buildSessionTagMap turns the flat rows into sessionId -> tags', () => {
  const map = buildSessionTagMap(rows);
  assert.deepEqual([...map.get('s1')].sort(), ['bug', 'review']);
  assert.deepEqual([...map.get('s2')], ['bug']);
  assert.equal(map.has('s4'), false, 'an untagged session is simply not in the map');
  assert.equal(buildSessionTagMap(null).size, 0);
});

test('#164: an empty selection changes nothing', () => {
  const map = buildSessionTagMap(rows);
  const out = filterProjectSessionsByTags(projects(), map, new Set());
  assert.deepEqual(out.map(p => p.projectPath), ['D:\\a', 'D:\\b', 'D:\\c']);
  assert.equal(out[0].sessions.length, 2);
});

test('#164: one tag keeps the sessions carrying it, and drops the projects left with none', () => {
  const map = buildSessionTagMap(rows);
  const out = filterProjectSessionsByTags(projects(), map, new Set(['bug']));

  assert.deepEqual(out.map(p => p.projectPath), ['D:\\a'],
    'the project whose sessions are untagged is gone — not left standing as an empty row');
  assert.deepEqual(out[0].sessions.map(s => s.sessionId), ['s1', 's2']);
});

test('#164: several tags AND — a session must carry every one of them', () => {
  const map = buildSessionTagMap(rows);
  const out = filterProjectSessionsByTags(projects(), map, new Set(['bug', 'review']));

  assert.deepEqual(out.map(p => p.projectPath), ['D:\\a']);
  assert.deepEqual(out[0].sessions.map(s => s.sessionId), ['s1'],
    's2 carries bug but not review — the filter is an AND, like the project one');
});

test('#164: a tag nobody carries empties the sidebar rather than ignoring itself', () => {
  const map = buildSessionTagMap(rows);
  assert.deepEqual(filterProjectSessionsByTags(projects(), map, new Set(['nope'])), []);
});

test('#164: the input projects are not mutated — the filter hands back copies', () => {
  const map = buildSessionTagMap(rows);
  const input = projects();
  filterProjectSessionsByTags(input, map, new Set(['bug']));
  assert.equal(input[0].sessions.length, 2, 'the caller keeps its own list intact');
  assert.equal(input.length, 3);
});
