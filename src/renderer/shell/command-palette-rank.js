// --- Ranking for the command palette (#274) ---
//
// Why this is not the sidebar's search: that one is a trigram FTS query dispatched to the index worker
// over IPC, and it refuses anything shorter than three characters because the tokenizer cannot answer.
// A command palette has to answer the FIRST keystroke, over three kinds of thing at once, without a
// round trip — so it matches in the renderer, over data the window already holds.
//
// The matcher is subsequence-with-bonuses, the shape every command palette uses: the query's characters
// must appear in order, and where they appear decides the score. That is what makes "csp" find
// "Collapse sidebar projects" while a substring match finds nothing at all.
//
// Electron-free and DOM-free on purpose (UMD like sidebar-state.js), so the scoring can be tested
// without a window — the pickers above it are the part that needs the app.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // A word starts after a space, a separator, or at a case change (fooBar → Bar). Matching one is worth
  // more than matching a letter in the middle of a word, which is what makes initials work.
  function isBoundary(text, i) {
    if (i === 0) return true;
    const prev = text[i - 1];
    if (/[\s/\\._:-]/.test(prev)) return true;
    return prev === prev.toLowerCase() && text[i] !== text[i].toLowerCase();
  }

  // Score `query` against `text`, or null when the characters do not appear in order.
  //
  // The numbers are relative, not absolute: a boundary hit outweighs several body hits, and an unbroken
  // run outweighs the same characters scattered, so "plan" prefers "Plans" over "Pane layout".
  //
  // The gap penalty is what keeps a long sentence from winning on boundary bonuses alone: every word start
  // it happens to contain pays +6, which is how "Some window that is chaotic" outscored "Switchboard" for
  // the query "switch" before it existed. It is capped, because past a certain distance one more skipped
  // character says nothing new — and uncapped it would bury the initials match ("tso" for "Toggle session
  // overview") that the boundary bonus exists to reward.
  function scoreMatch(text, query) {
    if (!query) return 0;
    const hay = String(text || '');
    const lowHay = hay.toLowerCase();
    const lowQ = query.toLowerCase();
    let score = 0;
    let from = 0;
    let lastIndex = -2;
    let firstIndex = -1;
    let matched = 0;
    for (const ch of lowQ) {
      if (ch === ' ') continue; // a space in the query separates words, it does not have to be matched
      const at = lowHay.indexOf(ch, from);
      if (at === -1) return null;
      if (firstIndex < 0) firstIndex = at;
      else score -= Math.min(at - lastIndex - 1, 10) * 0.75; // what the match had to skip to get here
      matched += 1;
      score += 1;
      if (isBoundary(hay, at)) score += 6;
      if (at === lastIndex + 1) score += 3;   // consecutive characters read as one hit
      if (at === 0) score += 4;               // the very first character is the strongest signal there is
      lastIndex = at;
      from = at + 1;
    }
    if (!matched) return 0;
    // A short name that matched is a better answer than a long one that matched the same characters.
    return score + Math.max(0, 24 - hay.length) / 8;
  }

  // Rank entries against a query. An entry is `{ title, subtitle, keywords, kindRank, recency }`:
  //   title     — what the row says, and what is matched hardest
  //   subtitle  — the project, the path; matched at a discount so it can disambiguate without ruling
  //   keywords  — words that should find the row but are not on it ("mosaic" for the grid toggle)
  //   kindRank  — a small per-kind nudge, so an action outranks a session that scored the same
  //   recency   — ms timestamp; the ONLY order for the empty query, and a tiebreaker otherwise
  //
  // The empty query is not a search, it is a starting point: most recent first, so the palette opens on
  // what the user was last doing rather than on an arbitrary slice of everything.
  function rankEntries(entries, query, { limit = 40 } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const q = String(query || '').trim();
    if (!q) {
      // Recency first, and only then the kind. An empty palette is "what was I doing", so the sessions
      // lead; the actions have no timestamp and settle behind them, where a verb the user has not typed
      // yet belongs.
      return [...list]
        .sort((a, b) => (b.recency || 0) - (a.recency || 0) || (b.kindRank || 0) - (a.kindRank || 0))
        .slice(0, limit);
    }
    const scored = [];
    for (const entry of list) {
      const title = scoreMatch(entry.title, q);
      const subtitle = entry.subtitle ? scoreMatch(entry.subtitle, q) : null;
      const keywords = entry.keywords ? scoreMatch(entry.keywords, q) : null;
      // Best of the three, each weighted by how much it says about the row.
      const best = Math.max(
        title === null ? -Infinity : title,
        subtitle === null ? -Infinity : subtitle * 0.45,
        keywords === null ? -Infinity : keywords * 0.7,
      );
      if (best === -Infinity) continue;
      scored.push({ entry, score: best + (entry.kindRank || 0) });
    }
    scored.sort((a, b) => b.score - a.score || (b.entry.recency || 0) - (a.entry.recency || 0));
    return scored.slice(0, limit).map(s => s.entry);
  }

  return { scoreMatch, rankEntries };
});
