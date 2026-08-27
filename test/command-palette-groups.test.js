'use strict';
// #488 / #489 — what the command palette SHOWS, as opposed to how it scores.
//
// Two things are pinned here, and both were wrong or missing before:
//
//   The palette opened on sessions alone. Commands sat behind every one of them and, past the row limit,
//   were not on the list at all — so the palette answered "where was I" and never "what can this do".
//
//   A row that also has a hotkey says so. The palette competing with the keyboard instead of teaching it
//   is how a chord stays unknown; the chord is printed on the row, and it comes from the SAME binding
//   table the key handler matches against, so a rebound key cannot leave a stale hint behind.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REN = path.join(__dirname, '..', 'src', 'renderer');
const RANK = fs.readFileSync(path.join(REN, 'shell', 'command-palette-rank.js'), 'utf8');
const PALETTE = fs.readFileSync(path.join(REN, 'shell', 'command-palette.js'), 'utf8');
const shortcuts = require('../src/renderer/shell/shortcuts.js');

// The renderer's classic scripts share one scope; the test builds the part command-palette.js reaches.
function load({ actions = [], sessions = [], projects = [] } = {}) {
  const ctx = vm.createContext({});
  ctx.window = ctx;
  ctx.console = console;
  ctx.listCommandActions = () => actions;
  ctx.sessionMap = new Map(sessions.map(s => [s.sessionId, s]));
  ctx.cachedAllProjects = projects;
  ctx.activePtyIds = new Set(sessions.filter(s => s.running).map(s => s.sessionId));
  ctx.lastActivityTime = new Map();
  ctx.cleanDisplayName = (s) => (s || '').trim();
  ctx.isMac = false;
  ctx.appShortcuts = null;                        // the defaults, which is what a fresh install has
  ctx.formatBinding = shortcuts.formatBinding;
  vm.runInContext(RANK, ctx);
  vm.runInContext(PALETTE, ctx);
  // A top-level `const` is not a property of the context — it lives in the script's lexical scope — so
  // the picker definition is fetched by evaluating its name rather than read off the object.
  ctx.PALETTE_DEF = vm.runInContext('COMMAND_PALETTE', ctx);
  return ctx;
}

const SESSION = (id, name, recency) => ({ sessionId: id, name, modified: new Date(recency).toISOString() });

test('an empty palette leads with the commands, then the sessions', () => {
  const ctx = load({
    actions: [{ id: 'plan.create', title: 'Write a plan', group: 'Plan', run() {} }],
    sessions: [SESSION('s1', 'yesterday', 1000), SESSION('s2', 'just now', 9000)],
    projects: [{ projectPath: '/dev/shop' }],
  });
  const shown = ctx.PALETTE_DEF.filter(ctx.commandPaletteEntries(), '');
  const groups = ctx.PALETTE_DEF.groups(shown);

  // Copied into this realm first: an array built inside the VM has that realm's prototype, and a
  // strict deep-equal compares prototypes.
  assert.deepEqual([...groups.map(g => g.label)], ['Commands', 'Sessions', 'Projects']);
  assert.equal(groups[0].rows[0].title, 'Write a plan');
  assert.deepEqual([...groups[1].rows.map(r => r.title)], ['just now', 'yesterday'], 'newest first inside the group');
});

test('sessions cannot crowd the commands out, however many there are', () => {
  const many = Array.from({ length: 60 }, (_, i) => SESSION('s' + i, 'session ' + i, 1000 + i));
  const ctx = load({
    actions: [{ id: 'a', title: 'Write a plan', group: 'Plan', run() {} }],
    sessions: many,
    projects: [{ projectPath: '/dev/shop' }],
  });
  const shown = ctx.PALETTE_DEF.filter(ctx.commandPaletteEntries(), '');
  const labels = ctx.PALETTE_DEF.groups(shown).map(g => g.label);

  assert.equal(labels[0], 'Commands');
  assert.ok(labels.includes('Projects'), 'the project group still gets its slice — no group is dropped silently');
});

test('typing puts the best match first, and its group leads', () => {
  const ctx = load({
    actions: [{ id: 'a', title: 'Write a plan', group: 'Plan', run() {} }],
    sessions: [SESSION('s1', 'plan the migration', 9000)],
  });
  const shown = ctx.PALETTE_DEF.filter(ctx.commandPaletteEntries(), 'write a plan');
  assert.equal(shown[0].title, 'Write a plan');
  assert.equal(ctx.PALETTE_DEF.groups(shown)[0].label, 'Commands');

  // …and the other way round, which is the property the fixed order would have broken.
  const jump = ctx.PALETTE_DEF.filter(ctx.commandPaletteEntries(), 'migration');
  assert.equal(jump[0].title, 'plan the migration');
  assert.equal(ctx.PALETTE_DEF.groups(jump)[0].label, 'Sessions');
});

test('an action with a shortcut prints the chord, one without prints nothing extra', () => {
  const ctx = load({
    actions: [
      { id: 'insert.plan', title: 'Insert a reference to a plan', group: 'Insert', shortcutId: 'insertPlan', run() {} },
      { id: 'plan.create', title: 'Write a plan', group: 'Plan', run() {} },
    ],
  });
  const rows = ctx.commandPaletteEntries().map(e => ctx.PALETTE_DEF.row(e));
  assert.equal(rows[0].meta, 'Insert · Ctrl+Shift+P');
  assert.equal(rows[1].meta, 'Plan');
});

test('an unknown shortcut id leaves the row alone rather than printing a broken hint', () => {
  const ctx = load({ actions: [{ id: 'x', title: 'X', group: 'View', shortcutId: 'noSuchShortcut', run() {} }] });
  assert.equal(ctx.PALETTE_DEF.row(ctx.commandPaletteEntries()[0]).meta, 'View');
});
