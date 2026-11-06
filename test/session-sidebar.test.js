// The session sidebar's decisions (#817): its stored state and the figures it shows. The surface is the click test.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  sidebarStateOf, clampSidebarWidth, withSidebarState, rekeySidebarState, openTaskRows, sidebarContextFigures, sidebarServerRows, sidebarShownWidth,
  SESSION_SIDEBAR_KEEP, SESSION_SIDEBAR_WIDTH,
} = require('../src/renderer/session/session-sidebar');

test('a session nobody chose for is closed, at the default width, with the cheap groups open', () => {
  assert.deepEqual(sidebarStateOf({}, 's1'), { open: false, width: SESSION_SIDEBAR_WIDTH.default, groups: ['tasks', 'context'] });
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

test('both surfaces mount it, the re-key moves it, and both toolbars offer it', () => {
  assert.match(read('src', 'renderer', 'terminal', 'terminal-manager.js'), /sessionSidebarMount\(entry\)/);
  assert.match(read('src', 'renderer', 'session', 'conversation-view.js'), /sessionSidebarMount\(entry\)/);
  assert.match(read('src', 'renderer', 'shell', 'session-ipc.js'), /rekeySessionSidebar\(oldId, newId\)/);
  assert.match(read('src', 'renderer', 'views', 'panes-view.js'), /sessionSidebarToggle\(sessionId\)/);
  assert.match(read('src', 'renderer', 'app.js'), /sessionSidebarToggle\(/);
});
