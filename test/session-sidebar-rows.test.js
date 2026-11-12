'use strict';
// #822 — the session sidebar's one row pattern (spec 43): what each kind of row inserts, copies and offers, and the
// markup that carries it. The surface (clicks, focus, dialogs) is the click test's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  sidebarRowActions, sidebarRowModel, sidebarInsertText, sidebarCopyText, sidebarItemHtml,
} = require('../src/renderer/session/session-sidebar');
const { skillInsertText } = require('../src/renderer/terminal/skill-palette');
const { taskInsertText } = require('../src/renderer/terminal/task-palette');

const helpers = { skillInsertText, taskInsertText };

test('each kind offers only the buttons it can honour', () => {
  assert.deepEqual(sidebarRowActions('task', { id: 1 }), ['open', 'copy']);
  assert.deepEqual(sidebarRowActions('issue', { number: 3, url: 'https://x/3' }), ['open', 'copy']);
  assert.deepEqual(sidebarRowActions('issue', { number: 3 }), ['copy'], 'no url, no open');
  assert.deepEqual(sidebarRowActions('handoff', { filePath: '/h.md' }), ['open', 'copy']);
  assert.deepEqual(sidebarRowActions('handoff', {}), []);
  assert.deepEqual(sidebarRowActions('skill', { id: 'abc' }), ['edit']);
  assert.deepEqual(sidebarRowActions('skill', {}), [], 'no inventory id, no edit');
  assert.deepEqual(sidebarRowActions('server', {}), []);
});

test('a task inserts its title and a reference; Shift the bare title', () => {
  assert.equal(sidebarInsertText('task', { id: 7, title: ' Fix it ' }, { helpers }), 'Fix it (task #7)');
  assert.equal(sidebarInsertText('task', { id: 7, title: 'Fix it' }, { helpers, template: 'Task {id}: {title}' }), 'Task 7: Fix it');
  assert.equal(sidebarInsertText('task', { id: 7, title: 'Fix it' }, { plain: true, helpers }), 'Fix it');
  assert.equal(sidebarCopyText('task', { id: 7, title: 'Fix it' }), 'Fix it');
});

test('an issue inserts and copies its id', () => {
  assert.equal(sidebarInsertText('issue', { number: 42, title: 't' }), '#42');
  assert.equal(sidebarCopyText('issue', { number: 42 }), '#42');
});

test('a handoff inserts its path, template or not (requirement 4)', () => {
  const h = { filePath: '/p/h.md', title: 'T' };
  assert.equal(sidebarInsertText('handoff', h, { helpers }), '/p/h.md');
  assert.equal(sidebarInsertText('handoff', h, { helpers, template: 'Read {path} ({title})' }), '/p/h.md');
  assert.equal(sidebarInsertText('handoff', h, { helpers, plain: true }), '/p/h.md');
  assert.equal(sidebarCopyText('handoff', h), '/p/h.md');
});

test('a skill key never falls back to a bare name; a memory row reads the neutral path', () => {
  assert.equal(sidebarRowModel('skill', { name: 'a' }, '', 3).key, 'skill:#3');
  assert.equal(sidebarRowModel('skill', { name: 'a', filePath: '/a.md' }).key, 'skill:/a.md');
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/session/session-sidebar.js'), 'utf8');
  assert.ok(/l\.id === 'memory' && typeof r\.path === 'string'/.test(src));
});

test('a skill inserts the invocation the backend gave; text only when it has none; Shift changes nothing', () => {
  assert.equal(sidebarInsertText('skill', { name: 's', invocation: '/s', filePath: '/s.md' }, { helpers }), '/s');
  assert.equal(sidebarInsertText('skill', { name: 's', invocation: '/s' }, { helpers, plain: true }), '/s');
  assert.equal(sidebarInsertText('skill', { name: 's', filePath: '/s.md' }, { helpers, template: 'Use {name} at {path}' }), 'Use s at /s.md');
  assert.equal(sidebarCopyText('skill', { name: 's' }), '', 'a skill has no copy button');
});

test('the row model per kind, and the markup escapes it and keeps the buttons beside the row button', () => {
  global.escapeHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  try {
    const task = sidebarRowModel('task', { id: 2, title: '<i>x</i>', status: 'in_progress' });
    assert.deepEqual([task.key, task.meta, task.actions], ['task:2', 'In progress', ['open', 'copy']]);
    const html = sidebarItemHtml(task);
    assert.ok(!html.includes('<i>'), 'the title is escaped');
    assert.match(html, /<div class="ssb-item"><button type="button" class="ssb-row"[^>]*data-ssb="row"[^>]*><span/);
    assert.equal((html.match(/data-ssb="act"/g) || []).length, 2);
    assert.ok(/<\/button><span class="ssb-acts"><button/.test(html), 'buttons are siblings, never nested in the row button');
    assert.ok(/class="ssb-head-btn ssb-act"/.test(html) && /aria-label="Open &lt;i>x/.test(html));
    const issue = sidebarRowModel('issue', { number: 9, title: 'T', url: 'https://x/9' });
    assert.equal(issue.main, '#9 T');
    const skill = sidebarRowModel('skill', { name: 'n', filePath: '/n.md' });
    assert.ok(!sidebarItemHtml(skill).includes('ssb-acts'), 'no buttons, no wrapper');
    assert.equal(sidebarRowModel('server', {}), null);
  } finally { delete global.escapeHtml; }
});

test('the surface keeps one way in: no second insert, no backend id, memory files and servers wired', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/session/session-sidebar.js'), 'utf8');
  assert.equal((src.match(/insertResolvedText\(/g) || []).length, 1, 'one call site');
  assert.ok(/l\.id === 'memory'[^\n]*instructionRow/.test(src));
  assert.ok(src.includes('data-ssb="servers"') && src.includes('openSessionServers('));
  assert.ok(src.includes("cat: 'plugins-skills'"));
});
