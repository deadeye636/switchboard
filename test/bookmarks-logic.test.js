'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  BOOKMARK_SESSION_ANCHOR,
  BOOKMARK_SCOPES,
  bookmarkScopeLabel,
  bookmarkLabel,
  bookmarkScopeFilter,
  filterBookmarks,
  sortBookmarks,
} = require('../src/renderer/bookmarks/bookmarks-logic.js');

const sample = [
  { id: 1, sessionId: 's1', entryIndex: 5, label: 'Important note', timestamp: null, createdAt: 100, projectDisplayName: 'switchboard', sessionName: 'sess A' },
  { id: 2, sessionId: 's1', entryIndex: 12, label: null, timestamp: null, createdAt: 300, projectDisplayName: 'switchboard', sessionName: 'sess B' },
  { id: 3, sessionId: 's2', entryIndex: -1, label: null, timestamp: null, createdAt: 200, projectDisplayName: 'other', sessionName: 'sess C' },
];

test('bookmarkLabel: stored label wins', () => {
  assert.strictEqual(bookmarkLabel(sample[0]), 'Important note');
});

test('bookmarkLabel: message index fallback', () => {
  assert.strictEqual(bookmarkLabel(sample[1]), 'Message #12');
});

test('bookmarkLabel: session anchor fallback', () => {
  assert.strictEqual(bookmarkLabel(sample[2]), 'Session bookmark');
  assert.strictEqual(sample[2].entryIndex, BOOKMARK_SESSION_ANCHOR);
});

test('bookmarkScopeLabel maps known scopes', () => {
  assert.strictEqual(bookmarkScopeLabel('session'), 'Session');
  assert.strictEqual(bookmarkScopeLabel('project'), 'Project');
  assert.strictEqual(bookmarkScopeLabel('global'), 'Global');
  assert.deepStrictEqual(BOOKMARK_SCOPES, ['session', 'project', 'global']);
});

test('bookmarkScopeFilter: session with context', () => {
  assert.deepStrictEqual(bookmarkScopeFilter('session', { sessionId: 's1', projectPath: '/p' }), { sessionId: 's1' });
});

test('bookmarkScopeFilter: project with context', () => {
  assert.deepStrictEqual(bookmarkScopeFilter('project', { sessionId: 's1', projectPath: '/p' }), { projectPath: '/p' });
});

test('bookmarkScopeFilter: global → empty (all)', () => {
  assert.deepStrictEqual(bookmarkScopeFilter('global', { sessionId: 's1', projectPath: '/p' }), {});
});

test('bookmarkScopeFilter: missing context falls back to all', () => {
  assert.deepStrictEqual(bookmarkScopeFilter('session', {}), {});
  assert.deepStrictEqual(bookmarkScopeFilter('project', { sessionId: 's1' }), {});
});

test('filterBookmarks: empty text returns a copy of all', () => {
  const out = filterBookmarks(sample, { text: '' });
  assert.strictEqual(out.length, 3);
  assert.notStrictEqual(out, sample);
});

test('filterBookmarks: matches label, session and project names (case-insensitive)', () => {
  assert.deepStrictEqual(filterBookmarks(sample, { text: 'important' }).map(b => b.id), [1]);
  assert.deepStrictEqual(filterBookmarks(sample, { text: 'sess c' }).map(b => b.id), [3]);
  assert.deepStrictEqual(filterBookmarks(sample, { text: 'switchboard' }).map(b => b.id), [1, 2]);
  assert.deepStrictEqual(filterBookmarks(sample, { text: 'message #12' }).map(b => b.id), [2]);
});

test('sortBookmarks: newest (default) and oldest by createdAt', () => {
  assert.deepStrictEqual(sortBookmarks(sample, 'newest').map(b => b.id), [2, 3, 1]);
  assert.deepStrictEqual(sortBookmarks(sample, 'oldest').map(b => b.id), [1, 3, 2]);
});

test('sortBookmarks: does not mutate the input', () => {
  const copy = sample.slice();
  sortBookmarks(sample, 'oldest');
  assert.deepStrictEqual(sample, copy);
});
