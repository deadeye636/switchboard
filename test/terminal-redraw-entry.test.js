'use strict';
// #479 — the user-reachable caller for `terminal-redraw`.
//
// The mechanism existed since the grid resize path and had no caller a user could reach: a process that
// attaches to a session's console and writes into the PTY leaves the running TUI in pieces, a tab switch
// does not repair it, and only a resize does.
//
// What is guarded here is the two ways the entry can be wrong in a way nobody sees: offering it where
// the main process returns silently (a click into nothing), and reaching for `\x0c` instead of the
// nudge (input injection whose meaning the running TUI decides, which is per-backend behaviour the core
// is not allowed to branch on).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripComments } = require('./helpers/strip-comments');

const root = (...p) => path.join(__dirname, '..', ...p);
const read = (...p) => stripComments(fs.readFileSync(root(...p), 'utf8'));

test('the tab context menu offers the redraw', () => {
  const panes = read('src', 'renderer', 'views', 'panes-view.js');
  const menu = panes.slice(panes.indexOf('function addTabItems('));
  const body = menu.slice(0, menu.indexOf('\n  }'));
  assert.match(body, /redrawTerminal\(sessionId\)/);
});

test('it is hidden for a plain terminal and disabled for a dead session', () => {
  const panes = read('src', 'renderer', 'views', 'panes-view.js');
  const menu = panes.slice(panes.indexOf('function addTabItems('));
  const body = menu.slice(0, menu.indexOf('\n  }'));
  // Both are silent no-ops in src/app/terminal/io.js, so an entry offered there is a click into nothing.
  assert.match(body, /isPlainTerminalTab\(sessionId\)/);
  assert.match(body, /activePtyIds\.has\(sessionId\)/);
});

test('"is this a terminal" is its own reader, not closeStopsProcess', () => {
  const panes = read('src', 'renderer', 'views', 'panes-view.js');
  assert.match(panes, /function isPlainTerminalTab\(/);
  // closeStopsProcess answers "does closing stop it", which is a different question: with
  // terminalCloseBehavior 'keep' a terminal answers false and with tabCloseBehavior 'stopSession' an
  // agent answers true — so reading it here would offer the entry in exactly the wrong places.
  assert.match(panes, /isPlainTerminalTab\(sessionId\)\s*\n?\s*\?/, 'closeStopsProcess must call the shared reader');
});

test('the redraw is the column nudge, never a Ctrl+L into the PTY', () => {
  const io = read('src', 'app', 'terminal', 'io.js');
  const handler = io.slice(io.indexOf("ipc.on('terminal-redraw'"));
  const body = handler.slice(0, handler.indexOf('\n  });'));
  assert.match(body, /_lastCols \+ 1/, 'the nudge is a resize by one column and back');
  assert.ok(!/\\x0c/.test(body) && !/\\f/.test(body), 'a form feed is input injection, not a display operation');

  const panes = read('src', 'renderer', 'views', 'panes-view.js');
  assert.ok(!/\\x0c/.test(panes), 'and the renderer must not send one either');
});

test('the menu label says what the redraw costs', () => {
  // A context-menu item has nowhere else to say it: the nudge re-wraps the buffer, which drops the
  // selection (#459). `item(label, fn, opts)` supports disabled/danger and has no description slot.
  const panes = read('src', 'renderer', 'views', 'panes-view.js');
  assert.match(panes, /item\('Redraw \(clears selection\)'/);
});
