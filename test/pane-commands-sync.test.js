// Guard for the three lists that describe the same pane chords (#489 follow-up).
//
// `session-nav.js` already carried two of them and says why they may not drift: `PANE_SHORTCUTS` is what
// panes mode keeps away from the terminal, and the `paneActions` table is what each chord does. A chord in
// only one of them either does nothing or reaches the PTY as a control character (#350).
//
// #489 added a third — `PANE_COMMANDS`, the palette rows — and it has the same obligation for a different
// reason: a row whose `shortcutId` names a chord that no longer exists prints a stale hint, and a row that
// calls a method the dispatch table has stopped calling is a second, quieter way to do the same thing.
//
// Read off the SOURCE rather than by loading the module: `paneActions` is a local const inside the key
// handler, built per event from the event itself, and there is no way to reach it without an event. What
// can be checked without one is that the three lists name the same set, which is the property the file
// asks for in its own comments.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'shell', 'session-nav.js'), 'utf8');

/** The ids in `const PANE_SHORTCUTS = [ … ]`. */
function paneShortcuts() {
  const block = SRC.match(/const PANE_SHORTCUTS = \[([\s\S]*?)\];/);
  assert.ok(block, 'PANE_SHORTCUTS is gone or was renamed — this guard has to be renamed with it');
  return [...block[1].matchAll(/'([A-Za-z]+)'/g)].map(m => m[1]);
}

/** The keys of the `paneActions` dispatch table. */
function dispatchKeys() {
  const block = SRC.match(/const paneActions = \{([\s\S]*?)\n {4}\};/);
  assert.ok(block, 'the paneActions table is gone or was reshaped');
  return [...block[1].matchAll(/^\s{6}([A-Za-z]+):/gm)].map(m => m[1]);
}

/** The `shortcutId`s of the palette rows. */
function commandShortcutIds() {
  const block = SRC.match(/const PANE_COMMANDS = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'PANE_COMMANDS is gone or was renamed');
  return [...block[1].matchAll(/shortcutId: '([A-Za-z]+)'/g)].map(m => m[1]);
}

// The two that are deliberately NOT palette rows. Both hold a direction in the key press — which pane,
// which way — so a row for them would be a row that means nothing without one. Listed here rather than
// silently absent, so removing a row on purpose is a decision someone has to write down.
const NOT_COMMANDS = ['paneFocusDigit', 'paneTabNav'];

test('every pane chord is dispatched — the pair the file already required', () => {
  assert.deepEqual([...dispatchKeys()].sort(), [...paneShortcuts()].sort());
});

test('every pane chord is either a palette row or a documented exclusion', () => {
  const rows = new Set(commandShortcutIds());
  const missing = paneShortcuts().filter(id => !rows.has(id) && !NOT_COMMANDS.includes(id));
  assert.deepEqual(missing, [],
    'a new pane chord needs a palette row, or a line in NOT_COMMANDS saying why it has none');
});

test('no palette row names a chord that does not exist', () => {
  const chords = new Set(paneShortcuts());
  const stale = commandShortcutIds().filter(id => !chords.has(id));
  assert.deepEqual(stale, [], 'the row would print a hint for a key nothing answers to');
});

test('the exclusions are still chords, not a list that outlived them', () => {
  const chords = new Set(paneShortcuts());
  for (const id of NOT_COMMANDS) {
    assert.ok(chords.has(id), `${id} is excluded from the palette but is no longer a pane chord either`);
  }
});
