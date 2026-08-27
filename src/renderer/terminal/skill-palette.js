// --- Skill palette: the skill picker on the insertSkill hotkey (#462) ---
//
// Handing a skill to a running CLI meant remembering its name and typing the invocation the way that
// particular CLI wants it. The app knows which skills exist and which CLI is in the terminal, so this is
// two keystrokes.
//
// The popover itself is `palette-core.js`; this file is only what makes it the SKILL picker.
//
// TWO KINDS OF ROW, and the difference is what gets typed:
//   - the BACKEND's own skills, which the CLI can run from its prompt. Main hands over the string to
//     type (`invocation`) — a slash command for one CLI, something else for the next.
//   - SWITCHBOARD's own skills, which belong to no CLI, plus every backend skill whose CLI has no
//     in-session invocation. Those go in as text, through the template in the settings cascade, and the
//     toast says so — an insert that silently differs from the one beside it reads as a bug.
//
// `invocation` is DECIDED IN MAIN. This file never learns which backend it is talking to, which is the
// rule the whole renderer is held to: a `switch (backendId)` here would put a CLI's syntax in the layer
// that must not know any.
//
// IT PRESSES ENTER, unlike the variable and plan pickers beside it. Those insert material INTO a
// sentence the user is still writing; picking a skill is asking for it to run. `submitSkillOnPick` turns
// that off for anyone who wants to read the line before it goes.
//
// Free globals it reaches for, all at CALL time so tag order does not decide them — guarded anyway:
//   `insertResolvedText` (terminal-context-menu.js) · `sessionMap` (app.js) · `sessionBackendId`
//   (backends/backend-registry.js) · `window.showControlToast` (dialogs/control-dialogs.js)
//   `window.openPalette` (palette-core.js) · `window.api.getSkills` / `.getEffectiveSettings` (preload.js)
//
// Callers into this file: terminal-manager.js's hotkey (`openSkillPalette`). Closing is the core's
// `closePalette` / `closePaletteForSession`.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // --- Pure logic (unit-tested in test/skill-palette.test.js) ---

  const DEFAULT_SKILL_INSERT_TEMPLATE = 'Use the skill at {path}';

  /**
   * Case-insensitive substring over the NAME and the ORIGIN.
   *
   * The origin too, because it is the answer to the other question this list gets asked: not "which
   * skill" but "what does this project add on top of mine" — typing the project's name is how someone
   * sees that set on its own.
   */
  function filterSkills(rows, query) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return list;
    return list.filter(s => String(s.name || '').toLowerCase().includes(q)
      || String(s.origin || '').toLowerCase().includes(q));
  }

  /**
   * What goes into the prompt.
   *
   * A skill the CLI can run is handed over as ITS invocation, exactly as main resolved it. Everything
   * else is a reference to the document, which every CLI can read with its own file tools — a template,
   * because how a CLI should be told about a document is a matter of taste and of which CLI it is. A
   * template that resolves to nothing falls back to the default, then to the bare path: an insert of an
   * empty string is indistinguishable from a hotkey that is broken.
   */
  function skillInsertText(skill, template) {
    if (!skill) return '';
    if (skill.invocation) return skill.invocation;
    const raw = (typeof template === 'string' && template.trim()) ? template : DEFAULT_SKILL_INSERT_TEMPLATE;
    const text = raw
      .replace(/\{path\}/g, skill.filePath || '')
      .replace(/\{name\}/g, skill.name || '');
    return text.trim() ? text : (skill.filePath || '');
  }

  const SKILL_PICKER = {
    id: 's',
    extraClass: 'skill-palette',
    shortcut: 'insertSkill',
    placeholder: 'Filter skills…',
    ariaLabel: 'Filter skills',
    listLabel: 'Skills',
    enterLabel: 'run',
    failedText: 'Could not load skills.',
    load: async ({ projectPath, sessionId }) => {
      const session = (typeof sessionMap !== 'undefined' && sessionId) ? sessionMap.get(sessionId) : null;
      const backendId = (typeof sessionBackendId === 'function') ? sessionBackendId(session) : null;
      // Both at once: the skills are a disk read, the settings are a lookup, and neither waits on the other.
      const [res, settings] = await Promise.all([
        window.api.getSkills(projectPath, backendId),
        window.api.getEffectiveSettings ? window.api.getEffectiveSettings(projectPath) : Promise.resolve(null),
      ]);
      return {
        rows: (res && res.skills) || [],
        extra: {
          template: settings && settings.skillInsertTemplate,
          // Only an explicit false turns it off — a settings blob that has never been saved must still
          // behave like the default, which is that picking a skill runs it.
          submit: !(settings && settings.submitSkillOnPick === false),
        },
      };
    },
    filter: (rows, query) => filterSkills(rows, query),
    rowKey: (s) => s.filePath,
    row: (s) => ({ main: s.name, meta: s.origin, metaClass: 'spal-origin' }),
    // Two nothings with different fixes: a session whose CLI has no skills and none of our own, against
    // a terminal the app cannot place well enough to look for a project's.
    emptyText: ({ projectPath }) => (projectPath
      ? 'No skills for this session.'
      : 'No skills — and this session has no project.'),
    noMatchText: (query) => `No skill matches “${query}”.`,
    pick: (skill, { terminal, sessionId, extra }) => {
      const text = skillInsertText(skill, extra && extra.template);
      if (!text || typeof insertResolvedText !== 'function') return;
      const submit = !extra || extra.submit !== false;
      // No trailing space when it is submitted — the newline is what follows, and a space before it is
      // a trailing space in the CLI's history.
      insertResolvedText(terminal, sessionId, text, { trailing: submit ? '' : ' ', submit });
      if (!skill.invocation) {
        window.showControlToast?.({
          message: `“${skill.name}” inserted as text — this CLI has no skill command`,
          timeoutMs: 3000,
        });
      }
    },
  };

  function openSkillPalette(terminal, sessionId) {
    return window.openPalette(SKILL_PICKER, terminal, sessionId);
  }

  return { filterSkills, skillInsertText, DEFAULT_SKILL_INSERT_TEMPLATE, openSkillPalette };
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
  id: 'insert.skill',
  title: 'Run a skill in this terminal',
  group: 'Insert',
  keywords: 'skill command run prompt',
  shortcutId: 'insertSkill',
  available: () => !!(typeof focusedActionTerminal === 'function' && focusedActionTerminal()),
  run: () => {
    const focused = typeof focusedActionTerminal === 'function' ? focusedActionTerminal() : null;
    if (focused && typeof openSkillPalette === 'function') openSkillPalette(focused.terminal, focused.sessionId);
  },
});
