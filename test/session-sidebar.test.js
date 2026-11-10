// The session sidebar's decisions (#817): its stored state and the figures it shows. The surface is the click test.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  sidebarStateOf, clampSidebarWidth, withSidebarState, patchSidebarState, rekeySidebarState, orderSidebarGroups, openTaskRows, sidebarContextFigures, sidebarServerRows, sidebarShownWidth,
  sidebarTokens, sidebarCategoryShare, sidebarBarSegments, contextLineDetails, repositoryRows,
  SESSION_SIDEBAR_KEEP, SESSION_SIDEBAR_WIDTH,
} = require('../src/renderer/session/session-sidebar');

test('a session nobody chose for is closed, at the default width, with the cheap groups open', () => {
  assert.deepEqual(sidebarStateOf({}, 's1'), { open: false, width: SESSION_SIDEBAR_WIDTH.default, groups: ['repository', 'tasks', 'context'] });
});

test('the global start state (#831) applies only to a session with no stored row', () => {
  assert.equal(sidebarStateOf({}, 's1', true).open, true, 'no row, default open');
  assert.equal(sidebarStateOf({}, 's1', false).open, false);
  assert.equal(sidebarStateOf({}, 's1', 'open').open, false, 'only the boolean true opens');
  const map = { a: { open: false, width: 300 }, b: { open: true, width: 300 } };
  assert.equal(sidebarStateOf(map, 'a', true).open, false, 'a stored closed row stays closed');
  assert.equal(sidebarStateOf(map, 'b', false).open, true, 'a stored open row stays open');
});

test('a write in a session with no row keeps the start state the default gave it (#831)', () => {
  // A width change in a session the default opened must not store it closed.
  assert.deepEqual(patchSidebarState({}, 's1', { width: 320 }, true, 7).s1, { open: true, width: 320, groups: ['repository', 'tasks', 'context'], at: 7 });
  assert.equal(patchSidebarState({}, 's1', { width: 320 }, false, 7).s1.open, false);
  // The patch wins over the default, and a stored row over both.
  assert.equal(patchSidebarState({}, 's1', { open: false }, true, 7).s1.open, false, 'closing by hand under default open');
  assert.equal(patchSidebarState({ s1: { open: false } }, 's1', { width: 320 }, true, 7).s1.open, false, 'a stored close survives a width change');
});

test('repository rows (#821): repository, branch with ahead/behind and state, worktree; none for a directory under no VCS', () => {
  assert.equal(repositoryRows({ ok: true, vcs: null }), null);
  assert.equal(repositoryRows({ ok: false }), null);
  const plain = repositoryRows({ ok: true, vcs: 'Git', repo: { name: 'app', path: '/r/app' }, worktree: null, branch: 'main', state: null, ahead: 0, behind: 0 });
  assert.deepEqual(plain.map(r => [r.main, r.meta]), [['app', 'repository'], ['main', 'branch']]);
  assert.equal(plain[0].title, '/r/app');
  const wt = repositoryRows({ ok: true, vcs: 'Git', repo: { name: 'app', path: '/r/app' }, worktree: { name: 'fix-1', path: '/r/app-wt/fix-1' },
    branch: 'fix-1', state: 'merging', ahead: 2, behind: 1 });
  assert.deepEqual(wt.map(r => [r.main, r.meta]), [['app', 'repository'], ['fix-1', '↑2 ↓1 · merging'], ['fix-1', 'worktree']]);
  // A rebase detaches HEAD: the parser answers no branch, the `.git` markers the state.
  const rebase = repositoryRows({ ok: true, vcs: 'Git', repo: { name: 'app', path: '/r/app' }, branch: null, state: 'rebasing' });
  assert.deepEqual(rebase.map(r => [r.main, r.meta]), [['app', 'repository'], ['detached HEAD', 'rebasing']]);
  const detached = repositoryRows({ ok: true, vcs: 'Git', repo: { name: 'app', path: '/r/app' }, branch: null, state: 'detached' });
  assert.deepEqual(detached.map(r => r.main), ['app', 'detached HEAD']);
  const noStatus = repositoryRows({ ok: true, vcs: 'Git', repo: { name: 'app', path: '/r/app' }, branch: null, state: null });
  assert.deepEqual(noStatus.map(r => r.main), ['app'], 'a status that could not be read leaves the branch row out');
});

test('each session keeps its own state', () => {
  const map = { a: { open: true, width: 300, groups: [] }, b: { open: false, width: 400, groups: ['handoffs'] } };
  assert.deepEqual(sidebarStateOf(map, 'a'), { open: true, width: 300, groups: [] });
  assert.deepEqual(sidebarStateOf(map, 'b'), { open: false, width: 400, groups: ['handoffs'] });
});

test('a stored width stays in range, and a broken one is the default', () => {
  assert.equal(clampSidebarWidth(10), SESSION_SIDEBAR_WIDTH.min);
  assert.equal(clampSidebarWidth(99999), SESSION_SIDEBAR_WIDTH.max);
  assert.equal(clampSidebarWidth('x'), SESSION_SIDEBAR_WIDTH.default);
});

test('the stored rows are bounded, and the newest stay', () => {
  let map = {};
  for (let i = 0; i < SESSION_SIDEBAR_KEEP + 5; i++) map = withSidebarState(map, `s${i}`, { open: true }, i);
  assert.equal(Object.keys(map).length, SESSION_SIDEBAR_KEEP);
  assert.ok(!map.s0);
  assert.ok(map[`s${SESSION_SIDEBAR_KEEP + 4}`]);
});

test('a re-key moves the state and leaves a session without one alone', () => {
  const map = { old: { open: true } };
  assert.deepEqual(rekeySidebarState(map, 'old', 'new'), { new: { open: true } });
  assert.equal(rekeySidebarState(map, 'other', 'new'), map, 'same object: nothing to write');
});

// #829: the groups' order is one global setting.
const GROUP_IDS = ['repository', 'tasks', 'handoffs', 'instructions', 'context', 'connectors'];

test('no saved order, or one that is not a list, is the default order', () => {
  assert.deepEqual(orderSidebarGroups(GROUP_IDS, undefined), GROUP_IDS);
  assert.deepEqual(orderSidebarGroups(GROUP_IDS, null), GROUP_IDS);
  assert.deepEqual(orderSidebarGroups(GROUP_IDS, 'context'), GROUP_IDS);
  assert.deepEqual(orderSidebarGroups(GROUP_IDS, []), GROUP_IDS);
});

test('a full saved order is kept as it is', () => {
  const saved = ['context', 'tasks', 'repository', 'connectors', 'handoffs', 'instructions'];
  assert.deepEqual(orderSidebarGroups(GROUP_IDS, saved), saved);
});

test('an unknown id is dropped and a repeat counts once', () => {
  assert.deepEqual(
    orderSidebarGroups(GROUP_IDS, ['context', 'gone', 'context', 42, 'repository', 'tasks', 'handoffs', 'instructions', 'connectors']),
    ['context', 'repository', 'tasks', 'handoffs', 'instructions', 'connectors'],
  );
});

test('a group the saved order does not name goes in after its default predecessor', () => {
  // `instructions` came in a later version: by default it follows `handoffs`, wherever the user put that.
  const saved = ['context', 'handoffs', 'repository', 'tasks', 'connectors'];
  assert.deepEqual(orderSidebarGroups(GROUP_IDS, saved), ['context', 'handoffs', 'instructions', 'repository', 'tasks', 'connectors']);
});

test('a missing first group goes first, and several missing ones keep their default order', () => {
  assert.deepEqual(
    orderSidebarGroups(GROUP_IDS, ['connectors', 'context', 'tasks', 'handoffs']),
    ['repository', 'connectors', 'context', 'tasks', 'handoffs', 'instructions'],
  );
});

test('the order is a new list, and neither input is changed', () => {
  const ids = Object.freeze(GROUP_IDS.slice());
  const saved = Object.freeze(['context', 'tasks']);
  const order = orderSidebarGroups(ids, saved);
  order.reverse();
  assert.deepEqual(ids, GROUP_IDS);
  assert.deepEqual(saved, ['context', 'tasks']);
  assert.notEqual(orderSidebarGroups(ids, undefined), ids);
});

test('only tasks still to do are listed', () => {
  const rows = openTaskRows([{ status: 'open' }, { status: 'in_progress' }, { status: 'done' }, { status: 'dropped' }, null]);
  assert.deepEqual(rows.map((t) => t.status), ['open', 'in_progress']);
});

test('a running conversation answers first, a terminal from its transcript, and nothing is not zero', () => {
  assert.deepEqual(sidebarContextFigures({ percent: 5, tokens: 10, window: 200, model: 'M' }, { percent: 90 }), { percent: 5, tokens: 10, window: 200, model: 'M' });
  assert.equal(sidebarContextFigures(null, { percent: 62, windowTokens: 200 }).percent, 62);
  assert.equal(sidebarContextFigures(null, null), null);
  assert.equal(sidebarContextFigures({}, undefined), null);
});

// #758: the neutral shape the backend answers. No field here names a backend.
const BREAKDOWN = {
  categories: [
    { label: 'Messages', tokens: 500, kind: 'used', slot: 1 },
    { label: 'Empty', tokens: 0, kind: 'used', slot: 2 },
    { label: 'Buffer', tokens: 250, kind: 'buffer', slot: null },
    { label: 'Free', tokens: 9000, kind: 'free', slot: null },
    { label: 'Deferred', tokens: 700, kind: 'deferred', slot: null },
  ],
  lists: [{ id: 'memory', label: 'Memory files', rows: [
    { name: 'a.md', tokens: 40 }, { name: 'b.md', tokens: 30 }, { name: 'c.md', tokens: 20 }, { name: 'd.md', tokens: 10 },
  ] }],
};

test('tokens read short, and a deferred category or a missing window has no share', () => {
  assert.deepEqual([sidebarTokens(999), sidebarTokens(52200), sidebarTokens(1000000), sidebarTokens(undefined)], ['999', '52.2k', '1.0M', '0']);
  assert.equal(sidebarCategoryShare(BREAKDOWN.categories[0], 10000), '5.0 %');
  assert.equal(sidebarCategoryShare(BREAKDOWN.categories[4], 10000), '');
  assert.equal(sidebarCategoryShare(BREAKDOWN.categories[0], null), '');
});

test('the bar draws what is used and the buffer, and neither free space, nothing nor what is not in the context', () => {
  assert.deepEqual(sidebarBarSegments(BREAKDOWN, 10000).map((s) => [s.label, s.width]), [['Messages', 5], ['Buffer', 2.5]]);
  assert.deepEqual(sidebarBarSegments(BREAKDOWN, 0), []);
});

test('the session line says what is used and the largest files, and a baseline says so first', () => {
  const lines = contextLineDetails({ breakdown: BREAKDOWN });
  assert.deepEqual(lines, ['Messages: 500', '', 'Largest memory files:', 'a.md: 40', 'b.md: 30', 'c.md: 20']);
  assert.match(contextLineDetails({ baseline: true, breakdown: BREAKDOWN })[0], /Nothing has been sent yet/);
  assert.deepEqual(contextLineDetails({ percent: 5 }), [], 'a backend without a breakdown adds nothing');
  assert.deepEqual(contextLineDetails(null), []);
  assert.deepEqual(contextLineDetails({ breakdown: { categories: [] } }), [], 'a half breakdown does not throw in the status line');
});

test('the room taken is capped by the box, and a hidden box keeps the stored width', () => {
  assert.equal(sidebarShownWidth(280, 1500), 280);
  assert.equal(sidebarShownWidth(280, 300), 180);
  assert.equal(sidebarShownWidth(280, 0), 280);
});

test('a terminal shows its stored model beside the fill', () => {
  assert.equal(sidebarContextFigures(null, { percent: 62 }, 'claude-x').model, 'claude-x');
  assert.equal(sidebarContextFigures({ percent: 5, model: 'M' }, null, 'other').model, 'M');
});

test('the header button has its siblings\' rules', () => {
  const css = read('src', 'renderer', 'style.css');
  assert.equal((css.match(/#terminal-sidebar-btn,/g) || []).length, (css.match(/#terminal-tasks-btn,/g) || []).length);
});

test('the server rows are read from the answer the session gives, and a refusal leaves the row out', () => {
  assert.deepEqual(sidebarServerRows({ ok: true, list: { title: 'MCP servers', rows: [{ name: 'a' }] } }), [{ name: 'a' }]);
  assert.deepEqual(sidebarServerRows({ ok: true, list: { title: 'x', rows: [] } }), []);
  assert.equal(sidebarServerRows({ ok: false, error: 'no' }), null);
  assert.equal(sidebarServerRows(null), null);
});

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('the terminal makes room through the padding FitAddon subtracts, and a grid card has no sidebar', () => {
  const css = read('src', 'renderer', 'style.css');
  assert.match(css, /\.terminal-container\.sidebar-open:not\(\.grid-mode\) \.xterm \{\s*padding-right: var\(--session-sidebar-width\)/);
  assert.match(css, /\.terminal-container\.grid-mode \.session-sidebar \{\s*display: none/);
});

// #829. A source check, because the drag is the click test's: what it pins is the two halves that make a stray drop
// harmless — the drag carries its own type, and the terminal container under the sidebar lets that type through.
test('a group drag carries its own type, and the terminal container does not claim it', () => {
  const sidebar = read('src', 'renderer', 'session', 'session-sidebar.js');
  assert.match(sidebar, /setData\(SESSION_SIDEBAR_GROUP_MIME, dragId\)/);
  const manager = read('src', 'renderer', 'terminal', 'terminal-manager.js');
  const isPaneTabDrag = manager.slice(manager.indexOf('function isPaneTabDrag('), manager.indexOf('function setupDragAndDrop('));
  assert.match(isPaneTabDrag, /SESSION_SIDEBAR_GROUP_MIME/);
});

test('a move is stored key-scoped and told to the other windows, which apply it from their settings reload', () => {
  const sidebar = read('src', 'renderer', 'session', 'session-sidebar.js');
  const commit = sidebar.slice(sidebar.indexOf('function commitSidebarGroupOrder('), sidebar.indexOf('function wireSidebarGroupOrder('));
  assert.match(commit, /mergeSetting\('global', \{ sessionSidebarOrder: /);
  assert.match(commit, /notifySettingsChanged\(\)/);
  assert.match(commit, /const cache = [^;]*appGlobalSettings/, 'the sender is skipped by the broadcast, so it updates its own cache');
  assert.match(commit, /if \(cache\) cache\.sessionSidebarOrder = ids\.slice\(\)/);
  assert.match(commit, /\.catch\([\s\S]*cache\.sessionSidebarOrder = previous[\s\S]*sessionSidebarSetOrder\(sessionSidebarGroupOrder\(\)\)/, 'a failed write puts the order back');
  const app = read('src', 'renderer', 'app.js');
  const reapply = app.slice(app.indexOf('async function reapplyGlobalSettings('), app.indexOf('\n}\n', app.indexOf('async function reapplyGlobalSettings(')));
  assert.match(reapply, /sessionSidebarOrderChanged\(\)/);
});

test('a settings change reaches every window, detached session windows included', () => {
  // #829: the broadcast named the main and the settings window, so a detached window never re-applied a global
  // setting. A source check: `windows.js` needs Electron at load.
  const windows = read('src', 'app', 'windows.js');
  const broadcast = windows.slice(windows.indexOf('function broadcastSettingsChanged('), windows.indexOf('\n}\n', windows.indexOf('function broadcastSettingsChanged(')));
  assert.match(broadcast, /BrowserWindow\.getAllWindows\(\)/);
  assert.match(broadcast, /webContents !== except/, 'the sender still applies its own change and is skipped');
});

test('a settings reload switches the GPU renderer only when the setting changed', () => {
  // #829: every global write now reaches every window, and `_setGpuAcceleration` reloads WebGL into every open
  // terminal past the per-mode policy. An unchanged value must not do that.
  const app = read('src', 'renderer', 'app.js');
  const reapply = app.slice(app.indexOf('async function reapplyGlobalSettings('), app.indexOf('\n}\n', app.indexOf('async function reapplyGlobalSettings(')));
  assert.match(reapply, /_getGpuAcceleration\(\) !== gpuMode[\s\S]{0,80}_setGpuAcceleration\?\.\(gpuMode\)/);
});

test('the grip sits beside the group, never inside its summary', () => {
  const sidebar = read('src', 'renderer', 'session', 'session-sidebar.js');
  assert.match(sidebar, /<\/details>\s*<button type="button" class="ssb-grip"/);
});

test('both surfaces mount it, the re-key moves it, and both toolbars offer it', () => {
  assert.match(read('src', 'renderer', 'terminal', 'terminal-manager.js'), /sessionSidebarMount\(entry\)/);
  assert.match(read('src', 'renderer', 'session', 'conversation-view.js'), /sessionSidebarMount\(entry\)/);
  assert.match(read('src', 'renderer', 'shell', 'session-ipc.js'), /rekeySessionSidebar\(oldId, newId\)/);
  assert.match(read('src', 'renderer', 'views', 'panes-view.js'), /sessionSidebarToggle\(sessionId\)/);
  assert.match(read('src', 'renderer', 'app.js'), /sessionSidebarToggle\(/);
});
