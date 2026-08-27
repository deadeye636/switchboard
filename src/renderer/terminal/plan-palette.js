// --- Plan palette: the plan picker on the insertPlan hotkey (#453) ---
//
// Handing a plan to a running CLI meant finding the file in the sidebar, copying its path and typing a
// sentence around it. The app knows the plans and knows which project the terminal belongs to, so this is
// two keystrokes.
//
// The popover itself is `palette-core.js` (#462); this file is only what makes it the PLAN picker. It
// was the second instance of the saved-variable palette (#207) before that core existed, and the two
// files had drifted into being the same 200 lines twice.
//
// What it inserts is a REFERENCE, never the plan itself. A plan runs to hundreds of lines; it belongs in
// the agent's context through the agent's own file tools, not pasted into a prompt.
//
// It offers THIS project's plans and nothing else. `getPlans()` returns every project's, and the picker
// used to draw the rest under their project names — reachable, on the argument that a plan written in one
// project is sometimes what you want to hand to another. It is the wrong default: the list a hotkey opens
// mid-session is a list of things about to be handed to an agent, and a foreign plan in it is a foreign
// codebase's instructions one Enter away. A plan nothing could attribute is dropped for the same reason —
// unattributed is not "mine", it is unknown. The Plans tab still lists everything, and that is where
// borrowing across projects belongs, deliberately rather than by keystroke.
//
// Free globals it reaches for, all at CALL time so tag order does not decide them — guarded anyway:
//   `insertResolvedText` (terminal-context-menu.js) · `window.openPalette` (palette-core.js)
//   `paletteMetaWithDate` (palette-core.js) — the row's date, worded like the Plans list (#475)
//   `window.api.getPlans` / `.getEffectiveSettings` (preload.js)
//
// Callers into this file: terminal-manager.js's hotkey and the command-palette row this file
// registers at its own tail (both `openPlanPalette`). Closing is the core's
// `closePalette` / `closePaletteForSession`.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // --- Pure logic (unit-tested in test/plan-palette.test.js) ---

  const DEFAULT_PLAN_INSERT_TEMPLATE = 'Follow the plan at {path}';

  /**
   * Case-insensitive substring over the title AND the filename.
   *
   * Both, because the two answer different questions: the title is what the plan is about, the filename
   * is what a generated slug happens to be called — and the slug is the only handle someone has who saw
   * the file on disk rather than in this list.
   */
  function filterPlans(rows, query) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return list;
    return list.filter(p => String(p.title || '').toLowerCase().includes(q)
      || String(p.filename || '').toLowerCase().includes(q));
  }

  /**
   * The rows this terminal may be offered: the plans attributed to ITS project, in the order they came.
   *
   * A terminal with no project of its own gets nothing rather than everything — "I could not tell which
   * project this is" is not a licence to offer every project's plans, it is the case where the picker has
   * no answer. Same for a plan with no `projectPath`: attribution is a lookup against the session that
   * wrote it (`attributePlans` in `src/app/plans-memory.js`), so a miss means the plan's origin is
   * unknown, not that it is local.
   */
  function plansForProject(rows, projectPath) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (!projectPath) return [];
    return list.filter(plan => plan.projectPath === projectPath);
  }

  /**
   * The text that goes into the prompt.
   *
   * A template rather than a fixed sentence, for the same reason a saved variable has one: what a CLI
   * should be told about a plan is a matter of taste and of which CLI it is. A template that resolves to
   * nothing falls back to the default — a hotkey that inserts an empty string is indistinguishable from
   * one that is broken.
   */
  function planInsertText(plan, template) {
    if (!plan) return '';
    const raw = (typeof template === 'string' && template.trim()) ? template : DEFAULT_PLAN_INSERT_TEMPLATE;
    const text = raw
      .replace(/\{path\}/g, plan.filePath || '')
      .replace(/\{title\}/g, plan.title || '')
      .replace(/\{filename\}/g, plan.filename || '');
    return text.trim() ? text : (plan.filePath || '');
  }

  const PLAN_PICKER = {
    id: 'p',
    extraClass: 'plan-palette',
    shortcut: 'insertPlan',
    placeholder: 'Filter plans…',
    ariaLabel: 'Filter plans',
    listLabel: 'Plans',
    failedText: 'Could not load plans.',
    load: async ({ projectPath }) => {
      // Both at once: the template is a setting, the plans are a disk read, and neither waits on the other.
      const [plansRes, settings] = await Promise.all([
        window.api.getPlans(),
        window.api.getEffectiveSettings ? window.api.getEffectiveSettings(projectPath) : Promise.resolve(null),
      ]);
      // Scoped HERE, once, rather than at render: the count in the corner, the filter and the highlight
      // all read these rows, and a filter applied in only some of those places is how a foreign plan
      // gets back in.
      return {
        rows: plansForProject((plansRes && plansRes.plans) || [], projectPath),
        extra: settings && settings.planInsertTemplate,
      };
    },
    filter: (rows, query) => filterPlans(rows, query),
    rowKey: (p) => p.filePath,
    // The filename AND when the plan last changed (#475): the list is newest first, and the picker is
    // where "which of these five" gets decided without the Plans list open beside it.
    row: (p) => ({
      main: p.title || p.filename,
      meta: (typeof paletteMetaWithDate === 'function')
        ? paletteMetaWithDate(p.filename, p.modified) : p.filename,
      metaClass: 'ppal-file',
    }),
    // Which of the two nothings this is, said plainly: a project with no plans reads as a broken hotkey
    // otherwise, and a terminal the app cannot place is a different problem with a different fix.
    emptyText: ({ projectPath }) => (projectPath ? 'No plans in this project.' : 'This session has no project.'),
    noMatchText: (query) => `No plan matches “${query}”.`,
    /** A reference, plus one trailing space and no newline — never submitted. */
    pick: (plan, { terminal, sessionId, extra }) => {
      const text = planInsertText(plan, extra);
      if (text && typeof insertResolvedText === 'function') {
        insertResolvedText(terminal, sessionId, text, { trailing: ' ' });
      }
    },
  };

  function openPlanPalette(terminal, sessionId) {
    return window.openPalette(PLAN_PICKER, terminal, sessionId);
  }

  return {
    filterPlans, plansForProject, planInsertText, DEFAULT_PLAN_INSERT_TEMPLATE, openPlanPalette,
  };
});

// --- The command-palette route to this picker (#489) -----------------------------------------------
//
// The hotkey stays the way in; this is the second door, for the person who does not remember the chord.
// Registered here rather than in a central list, which is the registry's whole point: the picker that
// owns the behaviour owns the row, and `shortcutId` makes the row print the key it also answers to.
//
// Absent without a mounted terminal, because that is what the picker types into — `focusedActionTerminal`
// answers null for a session whose CLI has exited or that panes mode never mounted.
if (typeof registerCommandAction === 'function') registerCommandAction({
  id: 'insert.plan',
  title: 'Insert a reference to a plan',
  group: 'Insert',
  keywords: 'plan document reference insert follow',
  shortcutId: 'insertPlan',
  available: () => !!(typeof focusedActionTerminal === 'function' && focusedActionTerminal()),
  run: () => {
    const focused = typeof focusedActionTerminal === 'function' ? focusedActionTerminal() : null;
    if (focused && typeof openPlanPalette === 'function') openPlanPalette(focused.terminal, focused.sessionId);
  },
});
