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
  //   recency   — ms timestamp; the tiebreaker on a query, and the order within a group without one
  //   group     — the heading this row sits under, used only by the empty query (see below)
  //
  // THE EMPTY QUERY IS A MENU, NOT A SEARCH, and this is the part that was wrong (#488). It used to be
  // recency alone, on the reasoning that an empty palette is "what was I doing" — which reads well and
  // fails in use: sessions carry a timestamp, actions carry none, so every command sat behind every
  // session and, past the row limit, was not on screen at all. A palette opened with nothing typed is
  // being asked what the app can DO; where you were is one keystroke away either way.
  //
  // `emptyGroups` is that policy, and it lives with the caller rather than here: `[{ group, limit }]`,
  // in the order the groups should appear, each taking at most `limit` rows by recency. A group the
  // caller did not name is appended after them rather than dropped — a list that silently loses a whole
  // kind is the failure this is fixing, not a smaller version of it.
  function rankEntries(entries, query, { limit = 40, emptyGroups = null } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const q = String(query || '').trim();
    if (!q) {
      const byRecency = (a, b) => (b.recency || 0) - (a.recency || 0) || (b.kindRank || 0) - (a.kindRank || 0);
      if (!Array.isArray(emptyGroups) || !emptyGroups.length) {
        return [...list].sort(byRecency).slice(0, limit);
      }
      const named = new Set(emptyGroups.map(g => g && g.group));
      const out = [];
      for (const spec of emptyGroups) {
        const rows = list.filter(e => e && e.group === spec.group).sort(byRecency);
        const take = Number.isFinite(spec.limit) ? spec.limit : rows.length;
        out.push(...rows.slice(0, Math.max(0, take)));
      }
      out.push(...list.filter(e => !e || !named.has(e.group)).sort(byRecency));
      return out.slice(0, limit);
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
