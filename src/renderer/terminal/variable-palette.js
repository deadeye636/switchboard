// --- Variable palette: the saved-variable picker on the insertVariable hotkey (#207) ---
//
// Ctrl/Cmd+Shift+V used to open the terminal context menu at the CARET: no filter, no arrow keys, and
// in a different place on every invocation, so the eye had to find it before the hand could use it.
// This is its replacement — anchored to the LOWER HALF of the terminal it belongs to, so it is always
// in the same place, with a filter that has focus the moment it opens.
//
// The popover itself is `palette-core.js` (#462); this file is only what makes it the VARIABLE picker.
// Anything about geometry, focus recovery, outside clicks or the listbox lives there, once.
//
// Deliberately NOT a merge: the terminal-header quick-pick (variables-panel.js) and the right-click
// Variables submenu (terminal-context-menu.js) keep their own design and are untouched.
//
// No value preview. `list-saved-variables` serializes without the value (`includeValue = false` in
// src/app/variables.js), and that is the right default — the renderer has no business holding a
// secret's plaintext. Rows show the name, the scope group and a secret marker.
//
// SECURITY: Enter never TYPES a plaintext secret. It goes through the same main-process path the other
// two pickers use — `resolveVariableInsert` returns an insert template (raw value, temp-file path or a
// shell ref). The one exception is main's own consent path: for shells with no inline-ref support it
// answers `{fallback:'copy', value}`, and that value IS plaintext in the renderer for the length of a
// clipboard write. Identical to what the context menu and the quick-pick already do.
//
// Free globals it reaches for, all at CALL time, so tag order does not decide them — guarded anyway:
//   `insertResolvedText` (terminal-context-menu.js) · `window.showControlToast`
//   (dialogs/control-dialogs.js) · `window.openVariablesTab` (app.js) · `window.openPalette`
//   (palette-core.js) · `window.api.listSavedVariables` / `.resolveVariableInsert` / `.writeClipboard`
//   (preload.js)
//
// Callers into this file: terminal-manager.js's hotkey and the command-palette row this file
// registers at its own tail (both `openVariablePalette`). Closing is the core's
// `closePalette` / `closePaletteForSession` — one call closes whichever picker is open, so app.js,
// grid-view.js and terminal-manager.js no longer name this one.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // --- Pure logic (unit-tested in test/variable-palette.test.js) ---

  // Case-insensitive substring over the NAME, order preserved. A blank query keeps everything, so
  // opening the palette shows the full list rather than nothing.
  function filterVariables(rows, query) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return list;
    return list.filter(v => String(v.name || '').toLowerCase().includes(q));
  }

  // Global first, then project — the same order the other pickers use.
  function groupForList(rows) {
    const global = rows.filter(v => v.scope !== 'project');
    const project = rows.filter(v => v.scope === 'project');
    return [
      { key: 'global', label: 'Global', rows: global },
      { key: 'project', label: 'Project', rows: project },
    ].filter(g => g.rows.length);
  }

  // The list the arrow keys walk MUST be the list the eye reads. The rows arrive sorted by name with
  // the scopes interleaved, while the groups render global-then-project — so walking the raw order
  // made the highlight jump around the screen. Everything downstream uses this flattened order.
  function displayOrder(rows) {
    return groupForList(rows).flatMap(g => g.rows);
  }

  // Insert the picked variable: resolved value plus ONE trailing space and no newline, so the line is
  // never submitted by accident and the next word does not run into the value.
  async function insertVariableRow(variable, { terminal, sessionId }) {
    try {
      const res = await window.api.resolveVariableInsert(variable.id, sessionId);
      if (res && res.ok && typeof res.text === 'string') {
        // An empty value would insert a lone space — say so instead of pretending something happened.
        if (!res.text) {
          window.showControlToast?.({ message: `“${variable.name}” is empty`, timeoutMs: 3000 });
        } else if (typeof insertResolvedText === 'function') {
          insertResolvedText(terminal, sessionId, res.text, { trailing: ' ' });
        }
      } else if (res && res.fallback === 'copy') {
        await window.api.writeClipboard(res.value || '');
        window.showControlToast?.({ message: "Secret copied — paste manually (shell doesn't support inline refs)", timeoutMs: 3000 });
      } else {
        // A malformed/undefined result must not fail silently — same fallback the quick-pick uses.
        window.showControlToast?.({ message: res?.error || 'Could not resolve variable', timeoutMs: 3000 });
      }
    } catch { /* variable gone / decrypt failed — no-op, same as the context menu */ }
  }

  const VARIABLE_PICKER = {
    id: 'v',
    shortcut: 'insertVariable',
    placeholder: 'Filter variables…',
    ariaLabel: 'Filter variables',
    listLabel: 'Saved variables',
    failedText: 'Could not load variables.',
    // Ctrl/Cmd+Shift+V fires a native paste alongside the keydown that opens us.
    swallowOpeningPaste: true,
    load: async ({ projectPath }) => ({ rows: await window.api.listSavedVariables(projectPath) }),
    filter: (rows, query) => displayOrder(filterVariables(rows, query)),
    groups: (rows) => groupForList(rows),
    rowKey: (v) => v.id,
    row: (v) => ({ main: v.name, meta: v.secret ? 'secret' : null }),
    // The picker this replaced offered "No variables — manage…" as a real menu item, so the hotkey
    // must not become a dead end when there is nothing to insert (#207 / the old #89 behaviour).
    emptyText: () => ({ before: 'No variables yet. Press ', key: 'Enter', after: ' to open the Variables tab.' }),
    noMatchText: (query) => `No variable matches “${query}”.`,
    emptyEnter: () => { window.openVariablesTab?.(); },
    pick: insertVariableRow,
  };

  function openVariablePalette(terminal, sessionId) {
    return window.openPalette(VARIABLE_PICKER, terminal, sessionId);
  }

  return { filterVariables, groupForList, displayOrder, openVariablePalette };
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
  id: 'insert.variable',
  title: 'Insert a saved variable',
  group: 'Insert',
  keywords: 'variable secret credential snippet insert paste',
  shortcutId: 'insertVariable',
  available: () => !!(typeof focusedActionTerminal === 'function' && focusedActionTerminal()),
  run: () => {
    const focused = typeof focusedActionTerminal === 'function' ? focusedActionTerminal() : null;
    if (focused && typeof openVariablePalette === 'function') openVariablePalette(focused.terminal, focused.sessionId);
  },
});
