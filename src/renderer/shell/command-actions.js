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
// display mode, which changes while the app runs. `title` and `group` may be functions for the same
// reason — an action that acts on what has focus has to say WHICH thing, and that is not knowable at
// registration (#473).
const commandActions = [];

/**
 * Declare one action.
 *   id        — stable, unique; the row identity
 *   title     — what the row says, in the app's own words ("Toggle session overview"). A function is
 *               called per open, for an action whose subject changes ("Write a handoff for “x”")
 *   keywords  — words that should find it but are not in the title ("mosaic", "grid")
 *   group     — the heading it sits under; a function, like `title`, when it names a subject
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

// A field that may be declared as a function, resolved at the moment the palette opens. A thrower is
// worth no more than a missing one: the action still applies, it just failed to name itself.
function resolveActionField(value, fallback) {
  if (typeof value !== 'function') return value;
  try {
    const resolved = value();
    return (typeof resolved === 'string' && resolved) ? resolved : fallback;
  } catch { return fallback; }
}

/**
 * The actions that apply right now, in registration order — with `title` and `group` already strings.
 *
 * Resolved HERE rather than at each reader, so nothing downstream has to know a field can be a function:
 * the palette's row builder, the ranker and anything later all see the same shape they always saw.
 */
function listCommandActions() {
  return commandActions.filter(a => {
    if (typeof a.available !== 'function') return true;
    try { return a.available() !== false; } catch { return false; }
  }).map(a => ((typeof a.title === 'function' || typeof a.group === 'function')
    ? { ...a, title: resolveActionField(a.title, a.id), group: resolveActionField(a.group, 'Action') }
    : a));
}
