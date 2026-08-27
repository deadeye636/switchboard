'use strict';
// #274 — the command palette's ranking, tested where it is pure.
//
// The cases are the ones that decide whether the palette feels right: initials have to beat a stray body
// match, the empty query has to be "what I was last doing" rather than an arbitrary slice, and a query
// that matches nothing must return nothing rather than everything.
const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreMatch, rankEntries } = require('../src/renderer/shell/command-palette-rank');

test('a subsequence matches, characters out of order do not', () => {
  assert.notEqual(scoreMatch('Collapse all sidebar sections', 'cas'), null);
  assert.equal(scoreMatch('Collapse all sidebar sections', 'zz'), null);
  assert.equal(scoreMatch('abc', 'cb'), null, 'order is part of the match, not a suggestion');
});

test('word starts beat letters buried in a word', () => {
  const initials = scoreMatch('Toggle session overview', 'tso');
  const buried = scoreMatch('Toggle session overview', 'ggl');
  assert.ok(initials > buried, `${initials} should beat ${buried}`);
});

test('a run of consecutive characters beats the same characters scattered', () => {
  const together = scoreMatch('Switchboard', 'switch');
  const scattered = scoreMatch('Some window that is chaotic', 'switch');
  assert.ok(scattered === null || together > scattered);
});

test('a short name wins over a long one that matched the same way', () => {
  assert.ok(scoreMatch('Plans', 'plan') > scoreMatch('Plans for the quarter, revised again', 'plan'));
});

test('an empty query is recency order, not a search', () => {
  const rows = rankEntries([
    { title: 'old', recency: 10 },
    { title: 'new', recency: 300 },
    { title: 'middle', recency: 100 },
  ], '');
  assert.deepEqual(rows.map(r => r.title), ['new', 'middle', 'old']);
});

test('an action outranks a session that matched just as well', () => {
  const rows = rankEntries([
    { title: 'overview', kindRank: 0, recency: 999 },
    { title: 'overview', kindRank: 3, recency: 0 },
  ], 'overview');
  assert.equal(rows[0].kindRank, 3, 'the verb the user typed is more likely the action');
});

test('the subtitle can find a row, at a discount', () => {
  const rows = rankEntries([
    { title: 'Nightly run', subtitle: 'acme/backend' },
    { title: 'acme notes', subtitle: 'other/place' },
  ], 'acme');
  assert.equal(rows.length, 2, 'both are reachable');
  assert.equal(rows[0].title, 'acme notes', 'a title match still beats a subtitle match');
});

test('keywords reach a row whose title does not carry the word', () => {
  const rows = rankEntries([{ title: 'Toggle session overview', keywords: 'grid mosaic cards' }], 'mosaic');
  assert.equal(rows.length, 1);
});

test('a query that matches nothing returns nothing', () => {
  assert.deepEqual(rankEntries([{ title: 'Plans' }, { title: 'Stats' }], 'zzzz'), []);
});

test('the limit caps the list, keeping the best', () => {
  const entries = Array.from({ length: 80 }, (_, i) => ({ title: 'session ' + i, recency: i }));
  assert.equal(rankEntries(entries, '', { limit: 10 }).length, 10);
  assert.equal(rankEntries(entries, 'session', { limit: 5 }).length, 5);
});

test('a missing entry list is answered with an empty one, not a throw', () => {
  assert.deepEqual(rankEntries(undefined, 'x'), []);
  assert.deepEqual(rankEntries(null, ''), []);
});

test('with no group policy an empty query is still plain recency order', () => {
  const rows = rankEntries([
    { title: 'Toggle session overview', kindRank: 3, recency: 0 },
    { title: 'yesterday', kindRank: 0, recency: 100 },
    { title: 'just now', kindRank: 0, recency: 900 },
  ], '');
  assert.deepEqual(rows.map(r => r.title), ['just now', 'yesterday', 'Toggle session overview']);
});

// #488 — the empty palette used to be recency alone, which put every command behind every session and,
// past the row limit, off the list entirely. The order is now the caller's policy.
const MENU = [
  { group: 'Commands', limit: Infinity },
  { group: 'Sessions', limit: 2 },
  { group: 'Projects', limit: 1 },
];

test('an empty query leads with the commands, then the recent sessions', () => {
  const rows = rankEntries([
    { title: 'yesterday', group: 'Sessions', recency: 100 },
    { title: 'Toggle session overview', group: 'Commands', recency: 0 },
    { title: 'just now', group: 'Sessions', recency: 900 },
    { title: 'shop', group: 'Projects', recency: 0 },
  ], '', { emptyGroups: MENU });
  assert.deepEqual(rows.map(r => r.title), ['Toggle session overview', 'just now', 'yesterday', 'shop']);
});

test('each group takes at most its slice, so the longest one cannot eat the list', () => {
  const sessions = [1, 2, 3, 4, 5].map(n => ({ title: 's' + n, group: 'Sessions', recency: n * 10 }));
  const rows = rankEntries([
    ...sessions,
    { title: 'Write a plan', group: 'Commands', recency: 0 },
    { title: 'shop', group: 'Projects', recency: 0 },
  ], '', { emptyGroups: MENU });
  assert.deepEqual(rows.map(r => r.title), ['Write a plan', 's5', 's4', 'shop'],
    'the two newest sessions, and the project still gets its row');
});

test('a group the policy never mentions is appended, not dropped', () => {
  const rows = rankEntries([
    { title: 'Toggle', group: 'Commands', recency: 0 },
    { title: 'something new', group: 'Bookmarks', recency: 5 },
  ], '', { emptyGroups: MENU });
  assert.deepEqual(rows.map(r => r.title), ['Toggle', 'something new'],
    'a kind added later shows up behind the named ones rather than vanishing');
});

test('a typed query ignores the group policy — ranking decides', () => {
  const rows = rankEntries([
    { title: 'overview', group: 'Sessions', kindRank: 0, recency: 999 },
    { title: 'ov', group: 'Commands', kindRank: 3, recency: 0 },
  ], 'ov', { emptyGroups: MENU });
  assert.equal(rows[0].title, 'ov', 'the shorter, better match wins whatever group it is in');
});
