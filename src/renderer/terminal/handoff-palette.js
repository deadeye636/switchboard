// --- Handoff palette: the handoff picker on the insertHandoff hotkey (#469) ---
//
// Handing a saved handoff to a running CLI meant opening the project menu, resuming into a fresh session
// and losing the one you were in. There was no way to say "read this packet" to the agent already in front
// of you. The app knows the project's handoffs and knows which project this terminal belongs to, so this
// is two keystrokes.
//
// The popover itself is `palette-core.js` (#462); this file is only what makes it the HANDOFF picker —
// the fourth of the same family, after the saved-variable picker (#207), the plan picker (#453) and the
// skill picker (#462).
//
// What it inserts is a REFERENCE, never the packet. A handoff runs to hundreds of lines and belongs in
// the agent's context through the agent's own file tools, not pasted into a prompt. And the line is NOT
// submitted, which is deliberately the plan picker's behaviour rather than the skill picker's: a handoff
// is context for what comes next, not an instruction to act on it.
//
// It offers THIS project's handoffs and nothing else. Main scopes the list to the project it is asked
// about, and a terminal the app cannot place gets nothing rather than everything — the same rule, and the
// same reason, as the plan picker's: a list a hotkey opens mid-session is a list of things about to be
// handed to an agent, and another project's handoff in it is another codebase's context one Enter away.
//
// Free globals it reaches for, all at CALL time so tag order does not decide them — guarded anyway:
//   `insertResolvedText` (terminal-context-menu.js) · `window.openPalette` (palette-core.js)
//   `window.api.listHandoffs` / `.getEffectiveSettings` (preload.js)
//   `window.startHandoffForSession` (handoff/handoff.js) — what the empty state's Enter opens (#473)
//   `paletteMetaWithDate` (palette-core.js) — the row's date, worded like the Plans list (#475)
//
// Callers into this file: terminal-manager.js's hotkey (`openHandoffPalette`). Closing is the core's
// `closePalette` / `closePaletteForSession`.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // --- Pure logic (unit-tested in test/handoff-palette.test.js) ---

  const DEFAULT_HANDOFF_INSERT_TEMPLATE = 'Continue from the handoff at {path}';

  /**
   * Case-insensitive substring over the TITLE and the FILENAME.
   *
   * Both, because the two answer different questions: the title is what the handoff is about, the filename
   * is the dated slug it was saved under — and the slug is the only handle someone has who saw the file on
   * disk rather than in this list.
   */
  function filterHandoffs(rows, query) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return list;
    return list.filter(h => String(h.title || h.label || '').toLowerCase().includes(q)
      || String(h.filename || '').toLowerCase().includes(q));
  }

  /**
   * The rows this terminal may be offered: the handoffs of ITS project, in the order they came.
   *
   * Main already scopes its answer to the project it was asked about, and this is the second half of the
   * same rule rather than a duplicate of it — the payload is filtered where it is rendered, so a row that
   * arrived without a project (or with someone else's) cannot reach the list by some other route. A
   * terminal with no project of its own gets nothing rather than everything: "I could not tell which
   * project this is" is not a licence to offer every project's packets.
   */
  function handoffsForProject(rows, projectPath) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (!projectPath) return [];
    return list.filter(h => !h.projectPath || h.projectPath === projectPath);
  }

  /**
   * The text that goes into the prompt.
   *
   * A template rather than a fixed sentence, for the same reason the plan reference has one: what a CLI
   * should be told about a document is a matter of taste and of which CLI it is. A template that resolves
   * to nothing falls back to the path — a hotkey that inserts an empty string is indistinguishable from
   * one that is broken.
   */
  function handoffInsertText(handoff, template) {
    if (!handoff) return '';
    const raw = (typeof template === 'string' && template.trim()) ? template : DEFAULT_HANDOFF_INSERT_TEMPLATE;
    const text = raw
      .replace(/\{path\}/g, handoff.filePath || '')
      .replace(/\{title\}/g, handoff.title || handoff.label || '')
      .replace(/\{filename\}/g, handoff.filename || '');
    return text.trim() ? text : (handoff.filePath || '');
  }

  /**
   * Which of the two nothings this is, and whether Enter can do anything about it.
   *
   * Said plainly, because a project with no handoffs reads as a broken hotkey otherwise, and a terminal
   * the app cannot place is a different problem with a different fix. The offer to write one is made only
   * where it would work: it needs a session to be about and a project to be saved into, and a message
   * naming a key that does nothing is worse than the message without it.
   */
  function handoffEmptyState({ projectPath, sessionId } = {}) {
    if (!projectPath) return { text: 'This session has no project.', createFor: null };
    if (!sessionId) return { text: 'No handoffs in this project.', createFor: null };
    return {
      text: { before: 'No handoffs in this project. Press ', key: 'Enter', after: ' to write one.' },
      createFor: sessionId,
    };
  }

  const HANDOFF_PICKER = {
    id: 'h',
    extraClass: 'handoff-palette',
    shortcut: 'insertHandoff',
    placeholder: 'Filter handoffs…',
    ariaLabel: 'Filter handoffs',
    listLabel: 'Handoffs',
    failedText: 'Could not load handoffs.',
    load: async ({ projectPath }) => {
      // Both at once: the template is a setting, the handoffs are a disk read, and neither waits on the
      // other.
      const [rows, settings] = await Promise.all([
        window.api.listHandoffs(projectPath),
        window.api.getEffectiveSettings ? window.api.getEffectiveSettings(projectPath) : Promise.resolve(null),
      ]);
      return {
        rows: handoffsForProject(rows || [], projectPath),
        extra: settings && settings.handoffInsertTemplate,
      };
    },
    filter: (rows, query) => filterHandoffs(rows, query),
    rowKey: (h) => h.filePath,
    // Both halves are on the row because both are searchable: filtering on a filename that is nowhere on
    // screen is a match the user cannot account for. The date rides along (#475) — `modified` first,
    // because a packet somebody edited after writing is a different document than the one that was saved.
    row: (h) => {
      const file = h.sourceDir ? `${h.sourceDir}/${h.filename}` : h.filename;
      return {
        main: h.title || h.label || h.filename,
        meta: (typeof paletteMetaWithDate === 'function')
          ? paletteMetaWithDate(file, h.modified || h.createdAt) : file,
        metaClass: 'hpal-file',
      };
    },
    emptyText: (ctx) => handoffEmptyState(ctx).text,
    // A picker with nothing to pick offers the thing that would give it something (#473) — the variable
    // picker's move, and for the same reason: an empty list on a hotkey reads as a broken hotkey.
    emptyEnter: (ctx) => {
      const { createFor } = handoffEmptyState(ctx);
      if (createFor) window.startHandoffForSession?.(createFor);
    },
    noMatchText: (query) => `No handoff matches “${query}”.`,
    /** A reference, plus one trailing space and no newline — never submitted. */
    pick: (handoff, { terminal, sessionId, extra }) => {
      const text = handoffInsertText(handoff, extra);
      if (text && typeof insertResolvedText === 'function') {
        insertResolvedText(terminal, sessionId, text, { trailing: ' ' });
      }
    },
  };

  function openHandoffPalette(terminal, sessionId) {
    return window.openPalette(HANDOFF_PICKER, terminal, sessionId);
  }

  return {
    filterHandoffs, handoffsForProject, handoffInsertText, handoffEmptyState,
    DEFAULT_HANDOFF_INSERT_TEMPLATE, openHandoffPalette,
  };
});
