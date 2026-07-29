// Unit coverage for the re-bindable keyboard-shortcut matcher (public/shortcuts.js).
//
// The headline regression this guards: bare Ctrl+Arrow must NOT be a session-nav
// shortcut, so the terminal keeps Ctrl+Left/Right word-jump. Session nav now
// defaults to Ctrl/Cmd+Shift+Arrow (Shift, not Alt — Ctrl+Alt+Arrow is a common
// Linux workspace-switch binding).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFS,
  SHORTCUT_GROUPS,
  shortcutDefsByGroup,
  normalizeShortcuts,
  matchShortcut,
  isSessionNavShortcut,
  formatBinding,
  captureBinding,
} = require('../src/renderer/shell/shortcuts');

// Build a fake KeyboardEvent. `mods` is a string like 'ctrl+alt'.
function ev(key, mods = '', code) {
  const set = new Set(mods.split('+').filter(Boolean));
  return {
    key,
    code: code || key,
    ctrlKey: set.has('ctrl'),
    altKey: set.has('alt'),
    shiftKey: set.has('shift'),
    metaKey: set.has('meta'),
  };
}

const D = normalizeShortcuts(null); // defaults

test('defaults: session arrow nav requires Shift — bare Ctrl+Arrow is NOT a nav key', () => {
  // The whole point: Ctrl+Left/Right stays free for terminal word-jump.
  assert.equal(matchShortcut('sessionNavArrows', ev('ArrowLeft', 'ctrl'), false, D), false);
  assert.equal(matchShortcut('sessionNavArrows', ev('ArrowRight', 'ctrl'), false, D), false);
  assert.equal(isSessionNavShortcut(ev('ArrowLeft', 'ctrl'), false, D), false,
    'bare Ctrl+Arrow must not be blocked by the terminal');
  // Ctrl+Alt+Arrow is NOT the default (it clashes with Linux workspace switching).
  assert.equal(matchShortcut('sessionNavArrows', ev('ArrowLeft', 'ctrl+alt'), false, D), false);
});

test('defaults: Ctrl+Shift+Arrow matches session arrow nav (Linux/Windows)', () => {
  for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    assert.equal(matchShortcut('sessionNavArrows', ev(k, 'ctrl+shift'), false, D), true, k);
  }
  assert.equal(isSessionNavShortcut(ev('ArrowUp', 'ctrl+shift'), false, D), true);
});

test('defaults: Ctrl+Shift+[ / ] matches bracket nav via e.code (Shift-agnostic key)', () => {
  // On macOS Shift mutates e.key to { / }, so matching must use e.code.
  assert.equal(matchShortcut('sessionNavBrackets', ev('{', 'ctrl+shift', 'BracketLeft'), false, D), true);
  assert.equal(matchShortcut('sessionNavBrackets', ev('}', 'ctrl+shift', 'BracketRight'), false, D), true);
  // Without Shift it must not match.
  assert.equal(matchShortcut('sessionNavBrackets', ev('[', 'ctrl', 'BracketLeft'), false, D), false);
});

test('defaults: grid toggle is Ctrl+Shift+G (G case-insensitive)', () => {
  assert.equal(matchShortcut('gridToggle', ev('G', 'ctrl+shift', 'KeyG'), false, D), true);
  assert.equal(matchShortcut('gridToggle', ev('g', 'ctrl+shift', 'KeyG'), false, D), true);
  assert.equal(matchShortcut('gridToggle', ev('g', 'ctrl', 'KeyG'), false, D), false);
});

test('defaults: insert-variable is Ctrl+Shift+V (V case-insensitive, Shift required)', () => {
  assert.equal(matchShortcut('insertVariable', ev('V', 'ctrl+shift', 'KeyV'), false, D), true);
  assert.equal(matchShortcut('insertVariable', ev('v', 'ctrl+shift', 'KeyV'), false, D), true);
  // Bare Ctrl+V stays the paste key (Shift is required for the picker).
  assert.equal(matchShortcut('insertVariable', ev('v', 'ctrl', 'KeyV'), false, D), false);
  // macOS uses Cmd as primary.
  assert.equal(matchShortcut('insertVariable', ev('v', 'meta+shift', 'KeyV'), true, D), true);
  assert.equal(formatBinding('insertVariable', false, D), 'Ctrl+Shift+V');
});

test('defaults: bookmark toggle is Ctrl+Shift+B (B case-insensitive, Shift required)', () => {
  assert.equal(matchShortcut('toggleBookmark', ev('B', 'ctrl+shift', 'KeyB'), false, D), true);
  assert.equal(matchShortcut('toggleBookmark', ev('b', 'ctrl+shift', 'KeyB'), false, D), true);
  // Bare Ctrl+B stays free for the terminal (Shift is required).
  assert.equal(matchShortcut('toggleBookmark', ev('b', 'ctrl', 'KeyB'), false, D), false);
  // macOS uses Cmd as primary.
  assert.equal(matchShortcut('toggleBookmark', ev('b', 'meta+shift', 'KeyB'), true, D), true);
  assert.equal(formatBinding('toggleBookmark', false, D), 'Ctrl+Shift+B');
});

test('macOS: primary modifier is Cmd; holding Ctrl as well blocks the match', () => {
  // Cmd+Shift+Arrow on mac
  assert.equal(matchShortcut('sessionNavArrows', ev('ArrowLeft', 'meta+shift'), true, D), true);
  // Ctrl+Shift+Arrow on mac (no Cmd) must NOT match — primary is Cmd on mac.
  assert.equal(matchShortcut('sessionNavArrows', ev('ArrowLeft', 'ctrl+shift'), true, D), false);
  // Cmd+Ctrl+Shift+Arrow — cross modifier (Ctrl) held → rejected.
  assert.equal(matchShortcut('sessionNavArrows', ev('ArrowLeft', 'meta+ctrl+shift'), true, D), false);
});

test('rebinding: a custom binding (plain Alt+Arrow) matches and the default no longer does', () => {
  const custom = normalizeShortcuts({ sessionNavArrows: { primary: false, alt: true, shift: false } });
  assert.equal(matchShortcut('sessionNavArrows', ev('ArrowLeft', 'alt'), false, custom), true);
  assert.equal(matchShortcut('sessionNavArrows', ev('ArrowLeft', 'ctrl+shift'), false, custom), false);
});

test('normalizeShortcuts: merges partial input over defaults and ignores garbage', () => {
  const n = normalizeShortcuts({ sessionNavArrows: { alt: true }, bogusKey: { primary: true }, gridToggle: { key: 'k' } });
  // alt overridden to true, primary/shift fall back to default (true/true).
  assert.deepEqual(n.sessionNavArrows, { primary: true, alt: true, shift: true });
  // unrelated keys dropped.
  assert.equal('bogusKey' in n, false);
  // gridToggle key honoured.
  assert.equal(n.gridToggle.key, 'k');
  // every known def is present.
  for (const def of SHORTCUT_DEFS) assert.ok(n[def.id], def.id);
});

test('shortcutDefsByGroup: every def lands in exactly one rendered group', () => {
  const grouped = SHORTCUT_GROUPS.flatMap(g => shortcutDefsByGroup(g.id));
  assert.equal(grouped.length, SHORTCUT_DEFS.length);
  assert.deepEqual(
    [...new Set(grouped.map(d => d.id))].sort(),
    SHORTCUT_DEFS.map(d => d.id).sort(),
  );
});

test('shortcutDefsByGroup: a def with a missing/unknown group still renders, in the first group', () => {
  // Guards the settings UI: a new def that forgets `group` must not vanish.
  const spliced = { id: 'temp', label: 't', description: 'd', family: 'key' };
  SHORTCUT_DEFS.push(spliced);
  try {
    assert.ok(shortcutDefsByGroup(SHORTCUT_GROUPS[0].id).some(d => d.id === 'temp'));
  } finally {
    SHORTCUT_DEFS.pop();
  }
});

test('shortcutDefsByGroup: grid actions are grouped under grid', () => {
  const gridIds = shortcutDefsByGroup('grid').map(d => d.id);
  assert.deepEqual(gridIds, ['gridToggle', 'gridMoveMode']);
});

test('normalizeShortcuts: rejects non-single-char grid key, falls back to default', () => {
  const n = normalizeShortcuts({ gridToggle: { key: 'gg' } });
  assert.equal(n.gridToggle.key, DEFAULT_SHORTCUTS.gridToggle.key);
});

test('formatBinding: human-readable labels per platform', () => {
  assert.equal(formatBinding('sessionNavArrows', false, D), 'Ctrl+Shift+←/→/↑/↓');
  assert.equal(formatBinding('sessionNavArrows', true, D), 'Cmd+Shift+←/→/↑/↓');
  assert.equal(formatBinding('sessionNavBrackets', false, D), 'Ctrl+Shift+[ / ]');
  assert.equal(formatBinding('sessionHistoryNav', false, D), 'Ctrl+Shift+, / .');
  assert.equal(formatBinding('gridToggle', false, D), 'Ctrl+Shift+G');
});

test('sessionHistoryNav matches Comma/Period by code, under the right modifiers', () => {
  assert.equal(matchShortcut('sessionHistoryNav', ev(',', 'ctrl+shift', 'Comma'), false, D), true);
  assert.equal(matchShortcut('sessionHistoryNav', ev('.', 'ctrl+shift', 'Period'), false, D), true);
  // Bare and wrong-modifier presses must reach the terminal untouched.
  assert.equal(matchShortcut('sessionHistoryNav', ev(',', '', 'Comma'), false, D), false);
  assert.equal(matchShortcut('sessionHistoryNav', ev(',', 'ctrl', 'Comma'), false, D), false);
  assert.equal(matchShortcut('sessionHistoryNav', ev(',', 'ctrl+alt+shift', 'Comma'), false, D), false);
  // A different key under the same chord is not this shortcut.
  assert.equal(matchShortcut('sessionHistoryNav', ev(';', 'ctrl+shift', 'Semicolon'), false, D), false);
});

test('isSessionNavShortcut covers the history pair, so xterm blocks it', () => {
  // Without this the chord would reach the PTY instead of switching sessions.
  assert.equal(isSessionNavShortcut(ev(',', 'ctrl+shift', 'Comma'), false, D), true);
  assert.equal(isSessionNavShortcut(ev('.', 'ctrl+shift', 'Period'), false, D), true);
  assert.equal(isSessionNavShortcut(ev(',', '', 'Comma'), false, D), false);
});

// --- #353: a chord on a punctuation key has to survive the keyboard ----------

test('the split chords fire from the events a REAL keyboard sends', () => {
  const sc = normalizeShortcuts(null);
  // A US layout with Shift held on the Backslash key sends key "|", never "\".
  const usSplit = { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
  assert.equal(matchShortcut('paneSplit', usSplit, false, sc), true);
  // A German layout has no Backslash key; the physical key in that position sends something else
  // again — the code is what both have in common.
  const deSplit = { key: '#', code: 'Backslash', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
  assert.equal(matchShortcut('paneSplit', deSplit, false, sc), true);
});

test('all four split directions are distinct chords (#353)', () => {
  const sc = normalizeShortcuts(null);
  const ev = (code, mods) => ({
    key: 'x', code, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: false,
  });
  const right = ev('Backslash', { ctrl: true, shift: true });
  const left = ev('Backslash', { ctrl: true, shift: true, alt: true });
  const down = ev('Minus', { ctrl: true, shift: true });
  const up = ev('Minus', { ctrl: true, shift: true, alt: true });
  const hits = (e) => ['paneSplit', 'paneSplitLeft', 'paneSplitDown', 'paneSplitUp']
    .filter((id) => matchShortcut(id, e, false, sc));
  assert.deepEqual(hits(right), ['paneSplit']);
  assert.deepEqual(hits(left), ['paneSplitLeft']);
  assert.deepEqual(hits(down), ['paneSplitDown']);
  assert.deepEqual(hits(up), ['paneSplitUp']);
});

test('a split chord does not claim the control character the terminal needs (#353)', () => {
  const sc = normalizeShortcuts(null);
  // Bare Ctrl+\ is SIGQUIT to the PTY and must stay the terminal's.
  const sigquit = { key: '\\', code: 'Backslash', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false };
  for (const id of ['paneSplit', 'paneSplitLeft', 'paneSplitDown', 'paneSplitUp']) {
    assert.equal(matchShortcut(id, sigquit, false, sc), false, id);
  }
});

test('formatBinding names a physical key by the character it usually carries (#353)', () => {
  const sc = normalizeShortcuts(null);
  assert.equal(formatBinding('paneSplit', false, sc), 'Ctrl+Shift+\\');
  assert.equal(formatBinding('paneSplitUp', false, sc), 'Ctrl+Alt+Shift+-');
});

test('captureBinding records the physical key for a code-family action (#353)', () => {
  const def = SHORTCUT_DEFS.find((d) => d.id === 'paneSplit');
  const captured = captureBinding(
    { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false },
    def, false,
  );
  assert.deepEqual(captured, { primary: true, alt: false, shift: true, code: 'Backslash' });
  // And a rebind survives normalisation, so Save actually sticks.
  const sc = normalizeShortcuts({ paneSplit: captured });
  assert.equal(sc.paneSplit.code, 'Backslash');
});

test('a letter chord still matches by character, not by code (#353)', () => {
  const sc = normalizeShortcuts(null);
  // A German layout puts Z where a US one puts Y. `paneZoom` is the letter Z wherever it sits.
  const zOnQwertz = { key: 'Z', code: 'KeyY', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
  assert.equal(matchShortcut('paneZoom', zOnQwertz, false, sc), true);
});

test('captureBinding: needs a modifier + real key; rejects bare/modifier-only presses', () => {
  const arrowsDef = SHORTCUT_DEFS.find(d => d.id === 'sessionNavArrows');
  const keyDef = SHORTCUT_DEFS.find(d => d.id === 'gridToggle');
  // modifier-only keydown → incomplete
  assert.equal(captureBinding(ev('Control', 'ctrl'), arrowsDef, false), null);
  // bare arrow (no modifier) → rejected so we never shadow plain arrows
  assert.equal(captureBinding(ev('ArrowLeft'), arrowsDef, false), null);
  // Ctrl+Alt+Arrow → captured (arrows family ignores the specific key)
  assert.deepEqual(captureBinding(ev('ArrowRight', 'ctrl+alt'), arrowsDef, false),
    { primary: true, alt: true, shift: false });
  // key family without a literal char → incomplete
  assert.equal(captureBinding(ev('ArrowLeft', 'ctrl'), keyDef, false), null);
  // key family with a char → captured incl. key
  assert.deepEqual(captureBinding(ev('K', 'ctrl+shift', 'KeyK'), keyDef, false),
    { primary: true, alt: false, shift: true, key: 'k' });
  // cross-modifier held (Meta on Linux) → rejected: would be an unmatchable binding
  assert.equal(captureBinding(ev('ArrowRight', 'ctrl+meta+alt'), arrowsDef, false), null);
  // on macOS the cross-modifier is Ctrl
  assert.equal(captureBinding(ev('ArrowRight', 'meta+ctrl+shift'), arrowsDef, true), null);
});
