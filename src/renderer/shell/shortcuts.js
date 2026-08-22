// --- Configurable keyboard shortcuts ---
// Single source of truth for the (re-bindable) session-navigation shortcuts.
//
// Loaded as a classic <script> in the renderer (exposes globals) AND require()-d
// by node tests (module.exports). Keep this file free of DOM/browser APIs.
//
// A "binding" describes a modifier combo plus, for the 'key' family, a literal
// key. The base key(s) of each action are fixed by its `family`:
//   arrows      → ArrowLeft/Right/Up/Down  (session/grid navigation)
//   brackets    → [ and ]                   (previous/next session)
//   commaPeriod → , and .                   (back/forward through visited sessions)
//   digits      → 1…9                       (pane focus, #309)
//   key         → a single literal CHARACTER (e.g. grid toggle = G)
//   code        → a single PHYSICAL key      (e.g. split = the Backslash key, #353)
// The user customises the *modifiers*; `primary` is Cmd on macOS / Ctrl elsewhere.
//
// WHY BOTH `key` AND `code`. A letter is the same character on every layout, so matching `e.key` is
// right for it and reads better in the settings. Punctuation is not: the Backslash key with Shift
// held reports `|` on a US layout, and a German layout has no Backslash key at all — `\` is AltGr+ß,
// and AltGr arrives as Ctrl+Alt, which the modifier check rejects. So `paneSplit`, defined as
// Shift plus the character `\`, could not be pressed on any keyboard from #309 until #353. It
// survived a live verification because a scripted keydown sets `key` directly, which no keyboard
// does. Anything that is not a letter belongs in the `code` family.

const DEFAULT_SHORTCUTS = {
  // Ctrl/Cmd+Shift+Arrows — moved off bare Ctrl+Arrows so the terminal keeps
  // word-jump (Ctrl+Left/Right) for editing. Shift (not Alt) avoids the
  // Ctrl+Alt+Arrow workspace-switch binding common on Linux desktops.
  sessionNavArrows: { primary: true, alt: false, shift: true },
  // Ctrl/Cmd+Shift+[ / ] — never conflicted with terminal editing, kept as-is.
  sessionNavBrackets: { primary: true, alt: false, shift: true },
  // Ctrl/Cmd+Shift+, / . — back / forward through visited sessions (#36).
  // Not Alt+Arrows as originally proposed: that is the terminal's word-jump
  // sequence, the same trade-off the sessionNavArrows note above rejects.
  sessionHistoryNav: { primary: true, alt: false, shift: true },
  // Ctrl/Cmd+Shift+G — toggle the grid overview.
  gridToggle: { primary: true, alt: false, shift: true, key: 'g' },
  // Ctrl/Cmd+Shift+B — bookmark the current message (transcript viewer) or the
  // active session (terminal). Shift keeps the terminal's bare Ctrl+B free.
  toggleBookmark: { primary: true, alt: false, shift: true, key: 'b' },
  // Ctrl/Cmd+Shift+T — create a task from the current transcript selection.
  createTask: { primary: true, alt: false, shift: true, key: 't' },
  // Ctrl/Cmd+Shift+V — open the saved-variable picker in the focused terminal.
  // (The Ctrl/Cmd+Shift+V paste event is suppressed for this press in
  // setupTerminalKeyBindings so it doesn't also paste.)
  insertVariable: { primary: true, alt: false, shift: true, key: 'v' },
  // Ctrl/Cmd+Shift+P — open the plan picker in the focused terminal (#453). Same family as the
  // variable picker beside it, and the same shape of popover, so one is learned from the other.
  insertPlan: { primary: true, alt: false, shift: true, key: 'p' },
  // Ctrl/Cmd+Shift+S — open the skill picker in the focused terminal (#462). Third of the same family.
  // Unlike the two above it, taking a row RUNS it: the picker submits the line unless the setting says
  // otherwise, because picking a skill is asking for it rather than quoting it.
  insertSkill: { primary: true, alt: false, shift: true, key: 's' },
  // Ctrl/Cmd+Shift+M — enter "move mode" on the focused grid card: bare arrows
  // reorder it, Shift+arrows resize it, Esc/Enter leave. A mode (rather than a
  // second arrow chord) keeps this off Ctrl+Alt+Arrow, which is the workspace
  // switcher on most Linux desktops — see the sessionNavArrows note above.
  gridMoveMode: { primary: true, alt: false, shift: true, key: 'm' },
  // The same chord as grid's, deliberately: the two modes cannot both be on, and "move mode" meaning
  // one thing in the app is worth more than two bindings nobody would remember apart (#356).
  paneMoveMode: { primary: true, alt: false, shift: true, key: 'm' },
  // Splitting, by PHYSICAL key (#353). Two keys, one per axis, with Alt reversing the direction:
  // `\` draws a vertical divider (left/right), `-` a horizontal one (up/down) — the shape Windows
  // Terminal uses. NOT bare Ctrl+\: that is 0x1c (SIGQUIT) to the PTY, so the terminal would lose it.
  paneSplit: { primary: true, alt: false, shift: true, code: 'Backslash' },
  paneSplitLeft: { primary: true, alt: true, shift: true, code: 'Backslash' },
  // Ctrl/Cmd+Shift+1..9 — focus the n-th pane. Shift matters here too: bare
  // Ctrl+3..8 are ESC/FS/GS/RS/US/DEL, all real control characters.
  paneFocusDigit: { primary: true, alt: false, shift: true },
  paneSplitDown: { primary: true, alt: false, shift: true, code: 'Minus' },
  paneSplitUp: { primary: true, alt: true, shift: true, code: 'Minus' },
  // Ctrl/Cmd+Shift+Z — zoom the active pane to fill the terminal area, and back. A toggle, not a
  // resize: the layout is untouched underneath, which is what tmux `prefix z` and Windows Terminal
  // `togglePaneZoom` do. Not Ctrl+Z: the terminal needs that (SIGTSTP).
  paneZoom: { primary: true, alt: false, shift: true, key: 'z' },
  // Ctrl/Cmd+Shift+W — close the active tab. Not bare Ctrl+W: that is a word-erase in every shell.
  paneCloseTab: { primary: true, alt: false, shift: true, key: 'w' },
  // Ctrl/Cmd+Shift+K — close the active pane. Deliberately not Q: on macOS Cmd+Shift+Q logs the
  // user out, and a binding whose default can end the session is not a default.
  paneClose: { primary: true, alt: false, shift: true, key: 'k' },
  // Ctrl/Cmd+Alt+[ / ] — previous/next tab WITHIN the active pane. The Shift pair next door
  // (sessionNavBrackets) walks the sidebar order across every pane, which is a different journey.
  paneTabNav: { primary: true, alt: true, shift: false },
};

// Settings groups, in render order. `SHORTCUT_DEFS[].group` points at one of these.
const SHORTCUT_GROUPS = [
  { id: 'general', label: 'General' },
  { id: 'grid', label: 'Grid' },
  { id: 'panes', label: 'Panes' },
];

// Metadata for rendering the settings UI and resolving each action's key family.
const SHORTCUT_DEFS = [
  {
    id: 'sessionNavArrows',
    label: 'Navigate sessions / grid',
    description: 'Move between sessions (single view) or between cells (grid view)',
    family: 'arrows',
    group: 'general',
  },
  {
    id: 'sessionNavBrackets',
    label: 'Previous / next session',
    description: 'Cycle to the previous or next session',
    family: 'brackets',
    group: 'general',
  },
  {
    id: 'sessionHistoryNav',
    label: 'Back / forward through visited sessions',
    description: 'Step back and forward through the sessions you visited, in the order you visited them',
    family: 'commaPeriod',
    group: 'general',
  },
  {
    id: 'toggleBookmark',
    label: 'Bookmark message',
    description: 'Bookmark the focused transcript message, or the active session from the terminal',
    family: 'key',
    group: 'general',
  },
  {
    id: 'createTask',
    label: 'Create task',
    description: 'Create a task from the selection (transcript or terminal); no selection in the terminal makes a session task',
    family: 'key',
    group: 'general',
  },
  {
    id: 'insertVariable',
    label: 'Insert variable',
    description: 'Open the saved-variable picker in the focused terminal and insert one at the cursor',
    family: 'key',
    group: 'general',
  },
  {
    id: 'insertPlan',
    label: 'Insert plan',
    description: 'Open the plan picker in the focused terminal and insert a reference to one at the cursor',
    family: 'key',
    group: 'general',
  },
  {
    id: 'insertSkill',
    label: 'Insert skill',
    description: 'Open the skill picker in the focused terminal and hand the chosen skill to the CLI',
    family: 'key',
    group: 'general',
  },
  {
    id: 'gridToggle',
    label: 'Toggle grid view',
    description: 'Show or hide the session grid overview',
    family: 'key',
    group: 'grid',
  },
  {
    id: 'gridMoveMode',
    label: 'Move / resize grid card',
    description: 'Enter move mode on the focused grid card: arrows reorder it, Shift+arrows resize it, Esc or Enter leaves',
    family: 'key',
    group: 'grid',
  },
  {
    id: 'paneSplit',
    label: 'Split pane to the right',
    description: 'Split the active pane to the right; the new pane takes focus and the next session you open lands there',
    family: 'code',
    group: 'panes',
  },
  {
    id: 'paneSplitLeft',
    label: 'Split pane to the left',
    description: 'Split the active pane to the left; the new pane takes focus and the next session you open lands there',
    family: 'code',
    group: 'panes',
  },
  {
    id: 'paneSplitDown',
    label: 'Split pane downward',
    description: 'Split the active pane downward; the new pane takes focus and the next session you open lands there',
    family: 'code',
    group: 'panes',
  },
  {
    id: 'paneSplitUp',
    label: 'Split pane upward',
    description: 'Split the active pane upward; the new pane takes focus and the next session you open lands there',
    family: 'code',
    group: 'panes',
  },
  {
    id: 'paneFocusDigit',
    label: 'Focus pane 1…9',
    description: 'Focus the n-th pane in reading order',
    family: 'digits',
    group: 'panes',
  },
  {
    id: 'paneTabNav',
    label: 'Previous / next tab in this pane',
    description: 'Step through the tabs of the focused pane; the session-navigation pair next to it walks every pane instead',
    family: 'brackets',
    group: 'panes',
  },
  {
    id: 'paneZoom',
    label: 'Zoom pane',
    description: 'Make the focused pane fill the terminal area, and the same key puts the layout back unchanged',
    family: 'key',
    group: 'panes',
  },
  {
    id: 'paneCloseTab',
    label: 'Close tab',
    description: 'Close the focused pane’s active tab, following the configured close behaviour',
    family: 'key',
    group: 'panes',
  },
  {
    id: 'paneMoveMode',
    label: 'Move a tab between panes',
    description: 'Enter move mode on the active tab: arrows move it to the pane in that direction, Esc or Enter leaves',
    family: 'key',
    group: 'panes',
  },
  {
    id: 'paneClose',
    label: 'Close pane',
    description: 'Close the focused pane; it asks first when that would stop running processes',
    family: 'key',
    group: 'panes',
  },
];

// Defs of one group, in SHORTCUT_DEFS order. Unknown/missing `group` falls into
// the first group so a new def can never vanish from the settings UI.
function shortcutDefsByGroup(groupId) {
  const known = new Set(SHORTCUT_GROUPS.map(g => g.id));
  const fallback = SHORTCUT_GROUPS[0].id;
  return SHORTCUT_DEFS.filter(d => (known.has(d.group) ? d.group : fallback) === groupId);
}

function getDef(id) {
  return SHORTCUT_DEFS.find((d) => d.id === id) || null;
}

// Merge a stored (possibly partial / untrusted) shortcuts object over the
// defaults, keeping only the fields each binding is allowed to carry.
function normalizeShortcuts(stored) {
  const out = {};
  for (const def of SHORTCUT_DEFS) {
    const base = DEFAULT_SHORTCUTS[def.id];
    const s = (stored && typeof stored === 'object' && stored[def.id]) || null;
    const b = {
      primary: s && typeof s.primary === 'boolean' ? s.primary : base.primary,
      alt: s && typeof s.alt === 'boolean' ? s.alt : base.alt,
      shift: s && typeof s.shift === 'boolean' ? s.shift : base.shift,
    };
    if (def.family === 'key') {
      b.key = s && typeof s.key === 'string' && s.key.length === 1
        ? s.key.toLowerCase()
        : base.key;
    }
    if (def.family === 'code') {
      // A `code` is a KeyboardEvent.code — a name, not a character, so it is kept verbatim.
      b.code = s && typeof s.code === 'string' && s.code ? s.code : base.code;
    }
    out[def.id] = b;
  }
  return out;
}

// Which physical-key family does this keyboard event belong to?
function keyFamily(e) {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return 'arrows';
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') return 'brackets';
  if (e.code === 'Comma' || e.code === 'Period') return 'commaPeriod';
  // Digit1..Digit9 by CODE, not by key: on a German layout Shift+1 produces '!',
  // so matching the character would make the chord layout-dependent (#309).
  if (/^Digit[1-9]$/.test(e.code || '')) return 'digits';
  return 'key';
}

function modifiersMatch(binding, e, isMac) {
  const primary = isMac ? e.metaKey : e.ctrlKey;
  const secondary = isMac ? e.ctrlKey : e.metaKey; // cross-modifier must be off
  if (secondary) return false;
  return (
    !!binding.primary === !!primary &&
    !!binding.alt === !!e.altKey &&
    !!binding.shift === !!e.shiftKey
  );
}

// Does this event trigger the given action under the current bindings?
function matchShortcut(id, e, isMac, shortcuts) {
  const def = getDef(id);
  if (!def) return false;
  const sc = (shortcuts && shortcuts[id]) || DEFAULT_SHORTCUTS[id];
  if (!modifiersMatch(sc, e, isMac)) return false;
  if (def.family === 'arrows') return keyFamily(e) === 'arrows';
  if (def.family === 'brackets') return keyFamily(e) === 'brackets';
  if (def.family === 'commaPeriod') return keyFamily(e) === 'commaPeriod';
  if (def.family === 'digits') return keyFamily(e) === 'digits';
  if (def.family === 'key') {
    const want = (sc.key || DEFAULT_SHORTCUTS[id].key || '').toLowerCase();
    return (e.key || '').toLowerCase() === want;
  }
  if (def.family === 'code') {
    // By the PHYSICAL key: what `e.key` reports for it depends on the layout and on Shift (#353).
    return (e.code || '') === (sc.code || DEFAULT_SHORTCUTS[id].code || '');
  }
  return false;
}

// Is this event any session-navigation shortcut (arrows, brackets, or the
// visit-history pair)? Used by xterm to block the key without the terminal
// acting on it.
function isSessionNavShortcut(e, isMac, shortcuts) {
  return (
    matchShortcut('sessionNavArrows', e, isMac, shortcuts) ||
    matchShortcut('sessionNavBrackets', e, isMac, shortcuts) ||
    matchShortcut('sessionHistoryNav', e, isMac, shortcuts)
  );
}

// Human-readable label, e.g. "Ctrl+Alt+←/→" or "Cmd+Shift+[ / ]".
function formatBinding(id, isMac, shortcuts) {
  const def = getDef(id);
  if (!def) return '';
  const sc = (shortcuts && shortcuts[id]) || DEFAULT_SHORTCUTS[id];
  const parts = [];
  if (sc.primary) parts.push(isMac ? 'Cmd' : 'Ctrl');
  if (sc.alt) parts.push(isMac ? 'Option' : 'Alt');
  if (sc.shift) parts.push('Shift');
  if (def.family === 'arrows') parts.push('←/→/↑/↓');
  else if (def.family === 'brackets') parts.push('[ / ]');
  else if (def.family === 'commaPeriod') parts.push(', / .');
  else if (def.family === 'digits') parts.push('1…9');
  else if (def.family === 'code') parts.push(codeLabel(sc.code || DEFAULT_SHORTCUTS[id].code));
  else parts.push((sc.key || DEFAULT_SHORTCUTS[id].key || '').toUpperCase());
  return parts.join('+');
}

// What to call a physical key on screen. The character it usually carries where that is unambiguous,
// otherwise the code itself — a label has to name a key the user can find, and for a layout where
// the Backslash key does not exist there is no honest character to print.
const CODE_LABELS = {
  Backslash: '\\', Minus: '-', Equal: '=', Slash: '/', Backquote: '`',
  Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Comma: ',', Period: '.', Space: 'Space',
};
function codeLabel(code) {
  if (!code) return '';
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  return String(code).replace(/^(Key|Digit)/, '');
}

// Build a binding from a captured keydown event (for the settings rebind UI).
// Returns null while the chord is incomplete (only modifiers, or no modifier,
// or a 'key'-family action without a literal key yet).
function captureBinding(e, def, isMac) {
  if (['Control', 'Alt', 'Shift', 'Meta', 'CapsLock'].includes(e.key)) return null;
  // The cross-modifier (Ctrl on mac / Meta elsewhere) isn't representable in a
  // binding, and matchShortcut rejects events that hold it — so refuse to capture
  // a combo that includes it (would otherwise produce an unmatchable binding).
  const secondary = isMac ? e.ctrlKey : e.metaKey;
  if (secondary) return null;
  const primary = isMac ? e.metaKey : e.ctrlKey;
  const binding = { primary: !!primary, alt: !!e.altKey, shift: !!e.shiftKey };
  // Require at least one modifier so we never shadow a bare arrow / letter.
  if (!binding.primary && !binding.alt && !binding.shift) return null;
  if (def.family === 'key') {
    if (e.key && e.key.length === 1) binding.key = e.key.toLowerCase();
    else return null;
  }
  if (def.family === 'code') {
    // The physical key, whatever character it happens to produce under these modifiers (#353).
    if (e.code) binding.code = e.code;
    else return null;
  }
  return binding;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_SHORTCUTS,
    SHORTCUT_DEFS,
    SHORTCUT_GROUPS,
    shortcutDefsByGroup,
    normalizeShortcuts,
    keyFamily,
    matchShortcut,
    isSessionNavShortcut,
    formatBinding,
    codeLabel,
    captureBinding,
  };
}
