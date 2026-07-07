// --- Transcript in-viewer search: pure logic (#86) ---
// Given the transcript messages as plain data, find the ones containing a term
// (optionally restricted to a role) and build a short snippet around the first
// hit. Free of DOM/browser APIs so the renderer (jsonl-search.js) and node tests
// share one implementation.
//
// Loaded as a classic <script> in the renderer (exposes globals) AND require()-d
// by node tests (module.exports). Keep this file free of DOM references.

// Build a one-line snippet centered on the match at [at, at+len), with ellipses
// when the surrounding text is clipped. `context` chars are kept on each side.
function transcriptSnippet(text, at, len, context) {
  const ctx = context == null ? 40 : context;
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  // `at` indexes the original text; re-locate on the whitespace-collapsed string
  // so the snippet window lines up (the collapse only shrinks, never grows).
  const matched = String(text || '').substr(at, len).replace(/\s+/g, ' ').trim();
  const pos = matched ? src.toLowerCase().indexOf(matched.toLowerCase()) : -1;
  if (pos === -1) return src.length > ctx * 2 ? src.slice(0, ctx * 2) + '…' : src;
  const start = Math.max(0, pos - ctx);
  const end = Math.min(src.length, pos + matched.length + ctx);
  return (start > 0 ? '…' : '') + src.slice(start, end) + (end < src.length ? '…' : '');
}

// messages: [{ entryIndex, role, text }]. term: search string. typeFilter:
// 'all' | 'assistant' | 'user'. Returns one entry per matching message:
// [{ entryIndex, role, count, snippet }], in transcript order.
function searchTranscript(messages, term, typeFilter) {
  const t = String(term || '').trim().toLowerCase();
  if (!t) return [];
  const role = typeFilter && typeFilter !== 'all' ? typeFilter : null;
  const out = [];
  for (const m of messages || []) {
    if (role && m.role !== role) continue;
    const text = String(m.text || '');
    const lower = text.toLowerCase();
    let idx = lower.indexOf(t);
    if (idx === -1) continue;
    const first = idx;
    let count = 0;
    while (idx !== -1) { count++; idx = lower.indexOf(t, idx + t.length); }
    out.push({
      entryIndex: m.entryIndex,
      role: m.role,
      count,
      snippet: transcriptSnippet(text, first, t.length),
    });
  }
  return out;
}

// Total occurrences across all matched messages (drives the "N matches" count).
function countTranscriptMatches(matches) {
  return (matches || []).reduce((n, m) => n + (m.count || 0), 0);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    transcriptSnippet,
    searchTranscript,
    countTranscriptMatches,
  };
}
