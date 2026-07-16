'use strict';

// Tests for the FTS query-length cap. The logic lives in search-query-util.js
// (shared by db.js searchByType and workers/search-query.js, #79) and is
// Electron-free, so the real implementation is tested directly — no
// better-sqlite3 required.
//
// Tests assert:
//   (a) Normal short queries still produce the double-quoted phrase form
//       (FTS5 substring matching preserved for e.g. "spec.md").
//   (b) Over-long queries are truncated via FTS_QUERY_MAX_CHARS so the phrase
//       cannot exceed ~46 trigrams (≤48-char input → ≤46 trigrams).
//   (c) Both consumers actually route through the shared module.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { FTS_QUERY_MAX_CHARS, buildFtsMatch } = require(path.join(root, 'src', 'db', 'search-query-util'));

// ---------------------------------------------------------------------------
// 1. The cap itself
// ---------------------------------------------------------------------------

test('FTS_QUERY_MAX_CHARS is 48 or fewer (keeps phrase query safe on main thread)', () => {
  assert.equal(typeof FTS_QUERY_MAX_CHARS, 'number');
  assert.ok(
    FTS_QUERY_MAX_CHARS <= 48,
    `FTS_QUERY_MAX_CHARS must be ≤48 to keep the trigram phrase safe; got ${FTS_QUERY_MAX_CHARS}`
  );
});

// ---------------------------------------------------------------------------
// 2. buildFtsMatch behavior (the real implementation, not a replica)
// ---------------------------------------------------------------------------

function trigramCount(phrase) {
  // Number of trigrams FTS5 must match for a phrase of this length.
  // A phrase of N chars produces max(0, N - 2) trigrams.
  return Math.max(0, phrase.length - 2);
}

test('normal short query produces quoted-phrase expression unchanged', () => {
  assert.equal(buildFtsMatch('spec.md'), '"spec.md"', 'Short query must be double-quoted as-is');
});

test('query containing a double-quote is escaped', () => {
  assert.equal(buildFtsMatch('say "hello"'), '"say ""hello"""', 'Double-quotes inside query must be doubled');
});

test('null/undefined query yields the empty phrase instead of throwing', () => {
  assert.equal(buildFtsMatch(null), '""');
  assert.equal(buildFtsMatch(undefined), '""');
});

test('60-char URL is truncated to ≤ FTS_QUERY_MAX_CHARS before quoting', () => {
  const url = 'https://gitlab.com/skaleet/product/tagpay/-/merge_requests/25629';
  assert.ok(url.length > FTS_QUERY_MAX_CHARS, 'test URL must be longer than the cap');
  const inner = buildFtsMatch(url).replace(/^"|"$/g, '');
  assert.ok(
    inner.length <= FTS_QUERY_MAX_CHARS,
    `Phrase length ${inner.length} must be ≤ FTS_QUERY_MAX_CHARS (${FTS_QUERY_MAX_CHARS})`
  );
});

test('truncation happens before quote-escaping (escaping cannot extend the phrase past the cap)', () => {
  // 48 quotes: sliced to 48 first, then each doubled — inner length 96 would
  // only be possible if the slice ran first (escape-then-slice would cap at 48).
  const quotes = '"'.repeat(FTS_QUERY_MAX_CHARS + 10);
  const inner = buildFtsMatch(quotes).replace(/^"|"$/, '').replace(/"$/, '');
  assert.equal(
    inner.length,
    FTS_QUERY_MAX_CHARS * 2,
    'Each of the 48 sliced quotes must be doubled — slice must run before escape'
  );
});

test('trigram count for bounded URL is ≤ 46 (phrase-intersect safe for main thread)', () => {
  const url = 'https://gitlab.com/skaleet/product/tagpay/-/merge_requests/25629';
  const inner = buildFtsMatch(url).replace(/^"|"$/g, '');
  const ngrams = trigramCount(inner);
  assert.ok(
    ngrams <= 46,
    `Trigram count ${ngrams} must be ≤ 46 (FTS_QUERY_MAX_CHARS - 2) to be safe`
  );
});

test('titleOnly mode prefixes "title:" before the quoted phrase', () => {
  assert.match(buildFtsMatch('spec', true), /^title:"spec"$/, 'titleOnly must prefix title:');
});

// ---------------------------------------------------------------------------
// 3. Both consumers route through the shared module (source check)
// ---------------------------------------------------------------------------

test('search-store.js searchByType uses the shared buildFtsMatch', () => {
  // The FTS queries moved out of db.js into search-store.js with #217. The point of the assertion is
  // unchanged: the MATCH string must be built by the shared helper, so main and the search worker bound
  // a query the same way (#79) — one of them capping and the other not is how a stray long query used to
  // take the process down.
  const dbSrc = fs.readFileSync(path.join(root, 'src', 'db', 'search-store.js'), 'utf8');
  assert.match(dbSrc, /require\(['"]\.\/search-query-util['"]\)/, 'search-store.js must import search-query-util');
  assert.match(dbSrc, /buildFtsMatch\s*\(/, 'search-store.js must call buildFtsMatch');
});

test('search worker uses the shared buildFtsMatch', () => {
  const workerSrc = fs.readFileSync(path.join(root, 'src', 'workers', 'search-query.js'), 'utf8');
  assert.match(workerSrc, /require\(['"]\.\.\/db\/search-query-util['"]\)/, 'worker must import search-query-util');
  assert.match(workerSrc, /buildFtsMatch\s*\(/, 'worker must call buildFtsMatch');
});
