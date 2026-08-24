// --- What the command palette can DO, declared by whoever owns the doing (#274) ---
//
// The alternative was a table of actions in the palette itself, and this repo has paid for that shape
// before: a central list keyed by feature is a file every new feature has to edit to look finished, and
// one whose author forgot leaves a gap nobody sees. So the palette holds no actions. Each owner registers
// its own at the tail of its file — sidebar-collapse.js registers collapse/expand-all, grid-view.js the
// overview toggle — and the palette asks this registry what exists at the moment it opens.
//
// Registration happens at PARSE time, into a function defined here. That direction is the safe one under
// the renderer's load-order rules: a later file calling into an earlier one. So this file loads before
// every file that registers, and the palette (which only READS) loads after them.
//
// `available()` is asked per open, never at registration: whether the grid toggle applies depends on the
// display mode, which changes while the app runs.
const commandActions = [];

/**
 * Declare one action.
 *   id        — stable, unique; the row identity
 *   title     — what the row says, in the app's own words ("Toggle session overview")
 *   keywords  — words that should find it but are not in the title ("mosaic", "grid")
 *   group     — the heading it sits under
 *   available — optional; called per open, false hides the row
 *   run       — what taking the row does. May be async; the palette is already closed when it runs.
 */
function registerCommandAction(action) {
  if (!action || !action.id || typeof action.run !== 'function') return;
  const existing = commandActions.findIndex(a => a.id === action.id);
  // Re-registering replaces rather than duplicates: a file re-parsed by a reload must not leave two rows.
  if (existing >= 0) commandActions[existing] = action;
  else commandActions.push(action);
}

/** The actions that apply right now, in registration order. */
function listCommandActions() {
  return commandActions.filter(a => {
    if (typeof a.available !== 'function') return true;
    try { return a.available() !== false; } catch { return false; }
  });
}
