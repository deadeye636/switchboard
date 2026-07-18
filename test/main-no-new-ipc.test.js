'use strict';
// main.js does not grow back (#222).
//
// #213 took main.js from 5011 lines to ~2470 by moving eleven blocks into `src/app/` and `src/watch/`.
// What is left is a composition root plus the 86 IPC handlers below, which stayed on purpose: they are
// thin, they share no state, and moving them would buy churn and nothing else.
//
// That is also the problem. Writing the NEXT handler into main.js is the natural thing to do — there are
// 86 of them there showing you how. Do it a few more times and the split was cosmetic.
//
// So this is the invariant, and it is deliberately NOT "main.js has no handler bodies" (it has 86 and
// they are staying): main.js gains no NEW ones. The list below is grandfathered by name. A new handler
// fails here until it either moves into a module or is added to the list on purpose, with the reason.
//
// The set is compared BOTH ways. A stale entry — a handler that moved into a module but stayed in the
// list — is not just untidy: it is a hole, because it would let that same handler be written back into
// main.js later and pass. Moving one out means deleting its line here, and the failure says so.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN = path.join(__dirname, '..', 'src', 'main.js');

// The 86 handlers #213 deliberately left in main.js. Append to this list ONLY with a reason, and only
// after asking whether the handler belongs in one of the modules in CLAUDE.md's "Where an IPC handler
// goes" table. Shrinking it is always right.
const GRANDFATHERED = [
  'archive-session', 'backend-can-fork', 'backends-list', 'bookmark-counts-by-project', 'bookmark-list',
  'bookmark-list-admin', 'bookmark-remove', 'bookmark-toggle', 'clipboard-write-text', 'delete-handoff',
  'delete-worktree', 'env-refs-check', 'get-about-info', 'get-active-sessions',
  'get-active-terminals', 'get-app-version', 'get-projects',
  'get-shell-profiles', 'get-stats-from-db', 'get-usage', 'get-windows-build',
  'handoff-transcript-path', 'index-worker-status', 'list-handoffs', 'list-subagents',
  'mcp-diff-response', 'open-external', 'open-external-terminal', 'open-in-editor', 'open-path',
  'profiles-delete', 'profiles-list', 'profiles-save', 'profiles-set-default', 'profiles-validate',
  'project-tags-all', 'project-tags-get', 'project-tags-list-all', 'project-tags-set', 'read-clipboard',
  'read-file-dataurl', 'read-file-for-panel', 'read-session-jsonl',
  'read-subagent-jsonl', 'rebuild-cache', 'refresh-stats', 'rename-session',
  'run-custom-launcher', 'save-clipboard-image', 'save-file-for-panel', 'save-handoff',
  'search', 'session-backends-get-all', 'session-tags-all', 'session-tags-get',
  'session-tags-set', 'set-log-level', 'start-subagent-watch', 'stop-session', 'stop-subagent-watch',
  'tag-def-color', 'tag-def-create', 'tag-def-delete', 'tag-def-flags', 'tag-def-rename', 'tag-defs-list',
  'tags-list-all', 'task-create', 'task-list', 'task-open-counts', 'task-remove', 'task-update',
  'toggle-star', 'unwatch-file', 'watch-file', 'worktree-status',
];
// Shrank by 10 in #227: get-plans/read-plan/save-plan/get-memories/read-memory/save-memory/
// get-work-files/read-work-file/delete-work-file moved to src/app/plans-memory.js, and the dead
// get-stats handler was deleted. A name left here would let its handler be written back into main.js.

// Where a new handler goes instead. A red test that only says "no" ends as a new allow-list entry, so it
// has to name the alternative. CLAUDE.md's "Where an IPC handler goes" carries the same seven modules in
// prose — a rule with no mechanism gets skipped, a mechanism with no rule just gets an entry added to its
// list. Change one, change the other. The test below checks that every module named here still exists, so
// at least the advice cannot rot into a dead path.
const WHERE_IT_GOES = `
A NEW IPC handler does not go in src/main.js. Pick the module that owns the area:

  src/app/windows.js          windows, the settings window, zoom, the close guard
  src/app/settings.js         the settings blob, the cascade, export/import
  src/app/notifications.js    notifications, the badge, the tray
  src/app/variables.js        saved variables and secret materialization
  src/app/hooks.js            the Claude Code hook server
  src/app/terminal/spawn.js   opening a terminal
  src/app/terminal/io.js      terminal input/resize/redraw/flow control
  src/app/plans-memory.js     the Plans, Memory and Work-Files tabs

Wire it the way those do:

  function registerIpc(ipc) { ipc.handle('my-thing', ...); }   // takes ipc — do NOT require electron
  function init(ctx) { ... }                                   // ctx carries the DB and Electron

  main.js:  const mine = require('./app/mine'); mine.init(ctx); mine.registerIpc(ipcMain);
  preload.js: add the window.api.* binding

The ctx rules, and each one is paid for:
  - A const passes straight through. A let ONLY as a getter (getMainWindow()) — a captured mainWindow
    addresses a window that no longer exists after a reopen, and the UI silently stops updating.
  - NEVER top-level-require('../db/db') — it resolves DATA_DIR at module load, before main.js sets it,
    and the dev build then writes to the installed app's database. (test/main-modules-no-db.test.js)
  - Electron arrives through ctx too, which is what keeps the module loadable in node --test. That is the
    whole point: the code that moved out got its first real test the day it stopped importing electron.

If it genuinely belongs in main.js anyway, add its name to GRANDFATHERED in this file WITH the reason.
That is a deliberate act, which is the only thing being asked for here.
`;

function readMain() {
  return fs.readFileSync(MAIN, 'utf8');
}

// ipcMain.handle('name' / ipcMain.on('name — the literal-name form, which is the only form used.
// `handleOnce`/`once` are in here because they register a channel exactly like their siblings do; neither
// appears in main.js today, and the point is that adding one does not walk past this guard.
// Longest alternative first — `handle` would otherwise match inside `handleOnce` and fail on the paren.
//
// WHAT THIS GUARD CANNOT SEE, stated plainly so nobody mistakes green for proof:
//   - `const im = ipcMain; im.handle('x', …)` — an alias defeats a textual match on `ipcMain.`.
//   - a handler registered by a helper in ANOTHER file that main.js requires and calls.
// Neither is cheap to catch by reading text, and neither is what actually happens: the thing this guards
// against is someone appending handler #87 next to the 86 that are already here, because that is the
// natural move. The second case also does not violate the invariant — a handler in another file is a
// handler that is not in main.js, which is the whole ask. Where it belongs is judgement, and the issue
// deliberately keeps that out of scope.
const LITERAL = /ipcMain\.(?:handleOnce|handle|once|on)\(\s*(['"])([^'"]+)\1/g;
// Every registration, literal-named or not. The two counts must match, or something registers a name
// this guard cannot see.
const ANY = /ipcMain\.(?:handleOnce|handle|once|on)\(/g;

function registeredNames(src) {
  return [...src.matchAll(LITERAL)].map(m => m[2]);
}

test('the modules this guard points a new handler at still exist', () => {
  // The advice IS the mechanism here — "no" alone ends as a new allow-list entry. A renamed module would
  // leave the failure message pointing at a path nobody can find, and the next reader would shrug and
  // append to GRANDFATHERED instead.
  const paths = [...WHERE_IT_GOES.matchAll(/(src\/[\w/-]+\.js)/g)].map(m => m[1]);
  assert.ok(paths.length >= 7, 'the table in this file names the modules a handler can go in');

  const missing = paths.filter(p => !fs.existsSync(path.join(__dirname, '..', p)));
  assert.deepEqual(missing, [],
    `this guard's failure message sends a new handler to module(s) that do not exist: ${missing.join(', ')}\n` +
    'Fix WHERE_IT_GOES here and the matching table in CLAUDE.md.');
});

test('main.js registers no IPC handler this guard cannot read', () => {
  const src = readMain();
  const all = (src.match(ANY) || []).length;
  const literal = registeredNames(src).length;

  assert.equal(literal, all,
    `${all - literal} ipcMain.handle/on call(s) in main.js do not use a literal channel name, so the ` +
    'allow-list below cannot see them. Register with a string literal — a computed channel name walks ' +
    'straight past this guard.');
});

test('main.js has gained no new IPC handler', () => {
  const names = registeredNames(readMain());

  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dupes, [], `registered twice in main.js: ${dupes.join(', ')}`);

  const added = names.filter(n => !GRANDFATHERED.includes(n)).sort();
  const removed = GRANDFATHERED.filter(n => !names.includes(n)).sort();

  assert.deepEqual(added, [],
    `new IPC handler(s) in src/main.js: ${added.join(', ')}\n${WHERE_IT_GOES}`);

  assert.deepEqual(removed, [],
    `these are in this file's GRANDFATHERED list but no longer in main.js: ${removed.join(', ')}\n\n` +
    'If you moved them into a module: delete those lines from GRANDFATHERED — that is the whole fix, ' +
    'and thank you. The list has to shrink when main.js does, because a name left standing here would ' +
    'let that handler be written back into main.js later and pass.');
});
