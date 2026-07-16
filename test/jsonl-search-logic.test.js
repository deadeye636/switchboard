'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  transcriptSnippet,
  searchTranscript,
  countTranscriptMatches,
} = require('../src/renderer/jsonl/jsonl-search-logic.js');

const msgs = [
  { entryIndex: 0, role: 'user', text: 'Please fix the scroll bug in the header' },
  { entryIndex: 1, role: 'assistant', text: 'I fixed the scroll bug. The header no longer clips.' },
  { entryIndex: 2, role: 'user', text: 'thanks' },
  { entryIndex: 3, role: 'assistant', text: 'Bug bug BUG everywhere' },
];

test('searchTranscript: matches across roles, one entry per message with count', () => {
  const res = searchTranscript(msgs, 'bug', 'all');
  assert.deepStrictEqual(res.map(r => r.entryIndex), [0, 1, 3]);
  assert.deepStrictEqual(res.map(r => r.count), [1, 1, 3]);
});

test('searchTranscript: case-insensitive', () => {
  assert.strictEqual(searchTranscript(msgs, 'BUG', 'all').length, 3);
  assert.strictEqual(searchTranscript(msgs, 'HeAdEr', 'all').length, 2);
});

test('searchTranscript: type filter LLM (assistant)', () => {
  const res = searchTranscript(msgs, 'bug', 'assistant');
  assert.deepStrictEqual(res.map(r => r.entryIndex), [1, 3]);
});

test('searchTranscript: type filter Prompt (user)', () => {
  const res = searchTranscript(msgs, 'bug', 'user');
  assert.deepStrictEqual(res.map(r => r.entryIndex), [0]);
});

test('searchTranscript: empty/whitespace term returns nothing', () => {
  assert.deepStrictEqual(searchTranscript(msgs, '', 'all'), []);
  assert.deepStrictEqual(searchTranscript(msgs, '   ', 'all'), []);
});

test('searchTranscript: no match returns empty', () => {
  assert.deepStrictEqual(searchTranscript(msgs, 'zzz', 'all'), []);
});

test('countTranscriptMatches: totals occurrences', () => {
  assert.strictEqual(countTranscriptMatches(searchTranscript(msgs, 'bug', 'all')), 5);
  assert.strictEqual(countTranscriptMatches([]), 0);
});

test('transcriptSnippet: contains the match and ellipsizes long context', () => {
  const long = 'x'.repeat(100) + 'NEEDLE' + 'y'.repeat(100);
  const snip = transcriptSnippet(long, 100, 6);
  assert.ok(snip.includes('NEEDLE'));
  assert.ok(snip.startsWith('…') && snip.endsWith('…'));
});

test('transcriptSnippet: collapses whitespace', () => {
  const snip = transcriptSnippet('a\n\n  spaced   term   here', 9, 4);
  assert.ok(!/\s{2,}/.test(snip));
});
