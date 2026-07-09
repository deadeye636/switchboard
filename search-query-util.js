'use strict';

// Shared FTS5 query building for the main-thread search (db.js searchByType)
// and the read-only search worker (workers/search-query.js) (#79). Keep this
// module free of Electron and native dependencies — the worker and plain
// node:test both require it.

// FTS_QUERY_MAX_CHARS caps the length of the query string passed to FTS5.
// A trigram-tokenized FTS5 table with tokenize='trigram' builds one trigram per
// 3-char sliding window. When the query is wrapped in double-quotes (phrase query),
// FTS5 intersects ALL trigram doclists in order — a 60-char URL produces ~58
// overlapping trigrams. Common trigrams like "://" or "git" can appear in tens of
// thousands of rows; intersecting all doclists as a contiguous phrase forces FTS5
// to scan enormous intermediate sets and blocks the querying thread for ~60 s.
// Capping the query at 48 chars limits the phrase to ≤46 trigrams (safe upper bound
// for a synchronous main-thread query on a 4000+ session index) while covering any
// plausible hand-typed search string. Longer inputs (pasted URLs, long stack traces)
// are silently truncated — the first 48 chars remain actionable search terms.
const FTS_QUERY_MAX_CHARS = 48;

// Build the FTS5 MATCH expression: truncate first (so escaping cannot extend
// the phrase past the cap), wrap in double quotes for exact substring matching
// with the trigram tokenizer (prevents FTS5 from splitting on punctuation,
// e.g. "spec.md" → "spec" + "md"), and optionally restrict to the title column.
function buildFtsMatch(query, titleOnly) {
  const bounded = (query || '').slice(0, FTS_QUERY_MAX_CHARS);
  const escaped = '"' + bounded.replace(/"/g, '""') + '"';
  return titleOnly ? 'title:' + escaped : escaped;
}

module.exports = { FTS_QUERY_MAX_CHARS, buildFtsMatch };
