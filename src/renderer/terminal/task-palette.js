// --- Task palette: the task picker on the insertTask hotkey (#857) ---
//
// The session sidebar (spec 43) already inserted a task, as a fixed `Title (task #id)`. A handoff, a plan and a
// skill each have a picker and a template the user sets; a task had neither. This is the picker, and the template
// is the effective setting `taskInsertTemplate` (global, or the project's own), which the sidebar's task rows read as well — one text for one task,
// wherever it is picked from.
//
// The popover itself is `palette-core.js`; this file is only what makes it the TASK picker.
//
// It offers THIS project's open tasks (`status` open or in_progress, the same rows the sidebar lists) and nothing
// else. A terminal with no project gets nothing rather than every project's tasks, for the reason the plan picker
// gives: "could not tell which project" is not a licence to offer all of them.
//
// What it inserts is TEXT left in the prompt with one trailing space, never submitted: a task is something to talk
// about, not a command. Shift+Enter / Shift+click inserts the bare title.
//
// Free globals it reaches for, all at CALL time so tag order does not decide them — guarded anyway:
//   `insertResolvedText` (terminal-context-menu.js) · `window.openPalette` (palette-core.js)
//   `openTaskRows` (session/session-sidebar.js) — which tasks count as open, one answer for both surfaces
//   `registerCommandAction`, `focusedActionTerminal` (shell/command-palette.js)
//   `window.api.taskList` / `.getEffectiveSettings` (preload.js)
//
// Callers into this file: terminal-manager.js's hotkey, conversation-view.js's PALETTES, the command-palette row
// this file registers at its own tail (all `openTaskPalette`), and session-sidebar.js's `sidebarInsertText`
// (`taskInsertText`). Closing is the core's `closePalette` / `closePaletteForSession`.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // --- Pure logic (unit-tested in test/task-palette.test.js) ---

  const DEFAULT_TASK_INSERT_TEMPLATE = '{title} (task #{id})';

  /** Case-insensitive substring over the title and the note — the note is where the rest of a task is said. */
  function filterTaskRows(rows, query) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return list;
    return list.filter(t => String(t.title || '').toLowerCase().includes(q)
      || String(t.note || '').toLowerCase().includes(q));
  }

  /**
   * The text that goes into the prompt.
   *
   * `plain` is the bare title (Shift). Otherwise the template, with `{title}`, `{id}`, `{status}` and `{note}`
   * substituted. A template that resolves to nothing falls back to the default, then to the title: an insert of
   * an empty string is indistinguishable from a hotkey that is broken.
   */
  function taskInsertText(task, template, plain = false) {
    if (!task) return '';
    const title = String(task.title || '').trim();
    // No number, no reference: a task without an id reads as its bare title, as it did before the template.
    if (plain || !title || task.id == null || task.id === '') return title;
    const wanted = (typeof template === 'string' && template.trim()) ? template : DEFAULT_TASK_INSERT_TEMPLATE;
    // ONE pass with a callback: a title or note is data, so a `$&` in it is not a replacement pattern and a
    // `{note}` inside a title is not substituted a second time.
    const values = { title, id: String(task.id), status: task.status || '', note: String(task.note || '').trim() };
    const text = wanted.replace(/\{(title|id|status|note)\}/g, (_, key) => values[key]);
    return text.trim() ? text : title;
  }

  const TASK_PICKER = {
    id: 't',
    extraClass: 'task-palette',
    shortcut: 'insertTask',
    placeholder: 'Filter tasks…',
    ariaLabel: 'Filter tasks',
    listLabel: 'Tasks',
    failedText: 'Could not load tasks.',
    load: async ({ projectPath }) => {
      if (!projectPath) return { rows: [], extra: null };
      // Both at once: the tasks are a database read, the template a lookup, and neither waits on the other.
      const [res, settings] = await Promise.all([
        window.api.taskList({ projectPath }),
        window.api.getEffectiveSettings ? window.api.getEffectiveSettings(projectPath) : Promise.resolve(null),
      ]);
      const tasks = (res && res.tasks) || [];
      return {
        rows: typeof openTaskRows === 'function' ? openTaskRows(tasks) : tasks,
        extra: settings && settings.taskInsertTemplate,
      };
    },
    filter: (rows, query) => filterTaskRows(rows, query),
    rowKey: (t) => String(t.id),
    row: (t) => ({
      main: t.title,
      meta: t.status === 'in_progress' ? 'In progress' : `#${t.id}`,
      metaClass: 'tpal-meta',
    }),
    emptyText: ({ projectPath }) => (projectPath ? 'No open tasks in this project.' : 'This session has no project.'),
    noMatchText: (query) => `No task matches “${query}”.`,
    plainLabel: 'title only',
    pick: (task, { terminal, sessionId, extra, plain }) => {
      const text = taskInsertText(task, extra, plain);
      if (text && typeof insertResolvedText === 'function') {
        insertResolvedText(terminal, sessionId, text, { trailing: ' ' });
      }
    },
  };

  function openTaskPalette(terminal, sessionId) {
    return window.openPalette(TASK_PICKER, terminal, sessionId);
  }

  return { filterTaskRows, taskInsertText, DEFAULT_TASK_INSERT_TEMPLATE, openTaskPalette };
});

// --- The command-palette route to this picker -------------------------------------------------------
//
// The hotkey stays the way in; this is the second door, for the person who does not remember the chord. Absent
// without a mounted SURFACE to type into (`focusedActionTerminal`), exactly as the plan and skill rows are.
if (typeof registerCommandAction === 'function') registerCommandAction({
  id: 'insert.task',
  title: 'Insert a task',
  group: 'Insert',
  keywords: 'task todo reference insert',
  shortcutId: 'insertTask',
  available: () => !!(typeof focusedActionTerminal === 'function' && focusedActionTerminal()),
  run: () => {
    const focused = typeof focusedActionTerminal === 'function' ? focusedActionTerminal() : null;
    if (focused && typeof openTaskPalette === 'function') openTaskPalette(focused.terminal, focused.sessionId);
  },
});
