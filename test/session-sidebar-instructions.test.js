'use strict';
// #823 T8 — the session sidebar's Instructions group (spec 43, spec 44). Main's answer for one session (the owner CLI's
// files, global and project, with the preview path), and the renderer's pure halves: the scope split and the row markup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sess-instr-'));
for (const id of ['claude', 'codex', 'hermes', 'pi', 'agy']) {
  const dir = path.join(root, id, 'store');
  fs.mkdirSync(dir, { recursive: true });
  process.env['SWITCHBOARD_STORE_' + id.toUpperCase()] = dir;
}
const project = path.join(root, 'project');
fs.mkdirSync(project, { recursive: true });

const backends = require('../src/backends');
const inventory = require('../src/app/resource-inventory');
const instructions = require('../src/app/instruction-files');
const backendResources = require('../src/app/backend-resources');
const skills = require('../src/app/skills');
const { instructionGroups, instructionRow, SESSION_SIDEBAR_GROUPS } = require('../src/renderer/session/session-sidebar');

test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

function write(file, body = 'x\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
const noLog = { debug() {}, warn() {}, error() {}, info() {} };
const states = () => new Map([[project, { registered: true }]]);
inventory.init({ backends, log: noLog });
backendResources.init({ backends, log: noLog });
skills.init({ backends, log: noLog, dataDir: path.join(root, 'data'), effectiveSettings: () => ({}), projectStates: states });
instructions.init({ backends, log: noLog, db: { getProjectStates: states, getAllFolderMeta: () => new Map() } });

write(path.join(path.dirname(process.env.SWITCHBOARD_STORE_CODEX), 'AGENTS.md'), '# codex global\n');
write(path.join(project, 'AGENTS.md'), '# project agents\n');
write(path.join(project, 'GEMINI.md'), '# project gemini\n');

test('a session sees the global and project files of its own CLI, with the path for the preview', () => {
  const a = instructions.getSessionInstructions({ projectPath: project, backendId: 'codex' });
  assert.equal(a.ok, true);
  assert.equal(a.declined, null);
  assert.deepEqual(a.rows.map(r => `${r.scope}:${r.label}`), ['global:AGENTS.md', 'project:AGENTS.md']);
  assert.ok(a.rows.every(r => /^[0-9a-f]{16}$/.test(r.id) && path.isAbsolute(r.path) && r.section));
  assert.ok(!a.rows.some(r => r.label === 'GEMINI.md'), 'another CLI\'s file is not this session\'s');
});

test('a project off the register contributes nothing, and a CLI with none answers a sentence', () => {
  const off = instructions.getSessionInstructions({ projectPath: path.join(root, 'elsewhere'), backendId: 'codex' });
  assert.deepEqual(off.rows.map(r => r.scope), ['global']);
  const none = instructions.getSessionInstructions({ projectPath: null, backendId: 'agy' });
  assert.deepEqual(none.rows, []);
  assert.match(none.declined, /keeps no instructions here/);
  assert.match(instructions.getSessionInstructions({ backendId: 'nope' }).declined, /keeps no instruction files/);
});

test('the group rows split by scope, drop rows without a path, and the row escapes its text', () => {
  const groups = instructionGroups({ ok: true, rows: [
    { id: 'a', label: 'A', scope: 'project', path: '/p/A' }, { id: 'b', label: 'B', scope: 'global', path: '/g/B' }, { id: 'c', label: 'C', scope: 'global' },
  ] });
  assert.deepEqual(groups.map(g => [g.label, g.rows.map(r => r.id)]), [['Global', ['b']], ['Project', ['a']]]);
  assert.deepEqual(instructionGroups({ ok: false }), []);
  global.escapeHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  try {
    const html = instructionRow({ label: '<b>x</b>', path: '/a"b' });
    assert.match(html, /data-ssb="open-file"/);
    assert.ok(!html.includes('<b>') && html.includes('data-path="/a&quot;b"'));
  } finally { delete global.escapeHtml; }
});

test('the group sits between Handoffs and Context and is closed by default', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/session/session-sidebar.js'), 'utf8');
  const order = [...src.matchAll(/^    id: '(\w+)',$/gm)].map(m => m[1]);
  assert.deepEqual(order.slice(0, 4), ['tasks', 'handoffs', 'instructions', 'context']);
  assert.ok(!/SESSION_SIDEBAR_OPEN_GROUPS = \[[^\]]*instructions/.test(src));
  assert.equal(typeof SESSION_SIDEBAR_GROUPS, 'undefined', 'the surface table is not part of the pure exports');
});

test('a group drawn closed reads on its first real open; one drawn open reads nothing on its own toggle', () => {
  const { sidebarToggleAction } = require('../src/renderer/session/session-sidebar');
  // Drawn closed starts with closedOnce set (buildSidebar), so the user's first open loads.
  assert.equal(sidebarToggleAction({ open: true, closedOnce: true, inView: true }), 'load');
  assert.equal(sidebarToggleAction({ open: true, closedOnce: true, inView: false }), 'stale');
  // Drawn open: the one toggle it fires by itself was read by showSidebar already.
  assert.equal(sidebarToggleAction({ open: true, closedOnce: false, inView: true }), 'none');
  assert.equal(sidebarToggleAction({ open: false, closedOnce: false, inView: true }), 'closed');
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/renderer/session/session-sidebar.js'), 'utf8');
  assert.match(src, /if \(!section\.open\) section\._closedOnce = true;/, 'buildSidebar marks the groups it draws closed');
});
