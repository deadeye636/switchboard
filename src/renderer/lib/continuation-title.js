// A session that only just continued another one borrows its name (#229).
//
// A `/clear` re-keys a session onto a new id (#223), and the session it lands on has said nothing yet —
// its whole transcript is the command that ended the previous one. The row would be titled after that
// command; the session it continues has a name a reader recognises.
//
// So: while a row has NOTHING of its own AND a lineage parent, it shows the parent's name with a
// continuation marker. The moment the session has text of its own — the first prompt, or the title the
// CLI writes for it — that wins by itself, because `name || aiTitle || summary` already prefers both over
// the summary this touches. That is the hand-off, and nothing here has to be undone for it.
//
// **This file holds no transcript format, and must not grow one.** Whether a row is still only its
// opening command is a question about a backend's own store, so a backend ANSWERS it and the core passes
// the answer along as `openedWithCommand` (`src/index/projects-view.js`). Claude reads its own markup in
// its own folder; every other backend declines until its format has been measured. A regex over
// `<command-name>` here would be one backend's grammar in the renderer — invisible to
// `test/backend-integrations.test.js`, which looks for backend IDs, and to the path guard, which looks
// for store layouts. Ask the field.
//
// **The borrowed name is a LABEL, and the original stays reachable as `summaryRaw`.** Anything taking a
// summary somewhere it stops being a label — the heading of a written handoff, the goal line of a prompt
// typed at an agent, the prefill of the rename box, which is STORED — reads `summaryRaw || summary`, or it
// asserts the parent's work as this session's under this session's name. Nothing here is persisted: the
// pass rewrites one field on the loaded rows and the next payload re-derives it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Prepended so the row reads as a continuation rather than as a second copy of the parent: it is one
  // character, it needs no legend, and it survives a plain-text copy.
  const CONTINUATION_PREFIX = '↳ ';

  // The name a parent lends out: whatever a reader would see for it, minus a borrowed one — a chain of
  // cleared sessions borrows from the last one that has a name of its own, not from its neighbour's
  // borrowed copy, so the prefix never stacks. A parent that is itself only an opening command has
  // nothing to lend.
  function lentName(session) {
    if (!session) return '';
    const own = session.name || session.aiTitle || '';
    if (own) return String(own).trim();
    if (session.openedWithCommand) return '';
    const summary = String(session.summary || '').trim();
    if (!summary) return '';
    if (summary.startsWith(CONTINUATION_PREFIX)) return summary.slice(CONTINUATION_PREFIX.length);
    return summary;
  }

  /**
   * Rewrite the display summary of every row that is still only its opening command.
   *
   * `sessions` is the flat list of loaded rows; `getSession` resolves a session id to a row (the
   * renderer's `sessionMap.get`). Walks up the lineage chain so a run of clears in one folder still
   * finds the session the work started in, with the same cycle guard and the same 25-hop cap as the
   * sidebar's chain walk — lineage is a tree and a corrupted row must not spin here. The cap is per ROW,
   * so on a chain longer than that the rows nearest the head resolve and the oldest keep their command;
   * a lineage that deep is already past what the sidebar draws.
   */
  function applyContinuationTitles(sessions, getSession) {
    if (!Array.isArray(sessions) || typeof getSession !== 'function') return;
    for (const session of sessions) {
      if (!session) continue;
      // The moment a row has words of its own, the borrow is over — and `summaryRaw` has to go with it.
      // The renderer keeps ONE object per session across payloads (`dedup` in app.js merges onto it), so a
      // leftover field is not inert: it is what the handoff filename, the agent prompt's goal line and the
      // rename box read, and they would go on saying `/clear` long after the row said something else.
      if (!session.lineageParentId || !session.openedWithCommand) {
        if (session.summaryRaw) delete session.summaryRaw;
        continue;
      }
      const seen = new Set([session.sessionId]);
      let parentId = session.lineageParentId;
      let guard = 0;
      while (parentId && !seen.has(parentId) && guard++ < 25) {
        seen.add(parentId);
        const parent = getSession(parentId);
        if (!parent) break;
        const name = lentName(parent);
        if (name) {
          // Kept so the paths that write a summary somewhere permanent can ask for what this session
          // actually said, rather than for the name it is borrowing.
          if (!session.summaryRaw) session.summaryRaw = session.summary;
          session.summary = CONTINUATION_PREFIX + name;
          break;
        }
        parentId = parent.lineageParentId;
      }
    }
  }

  return { applyContinuationTitles, CONTINUATION_PREFIX };
});
