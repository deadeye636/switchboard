'use strict';
// #835: session sidebar groups can be hidden and shown again, from a right-click list in the sidebar or from
// Settings → Sessions. One global setting (`sessionSidebarHidden`); a hidden group reads nothing. jsdom, with the real
// lib/sidebar-groups.js, lib/variable-order.js and session/session-sidebar.js loaded as the page loads them.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SESSION_SIDEBAR_GROUP_NAMES, hiddenSidebarGroups, withSidebarGroupHidden } = require('../src/renderer/lib/sidebar-groups');
const { setupSessionSidebar: setup, closeSessionSidebarWindows, ALL_GROUPS: ALL } = require('./helpers/session-sidebar-dom');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', p), 'utf8');
const flush = () => new Promise((r) => setTimeout(r, 0));
after(closeSessionSidebarWindows);

test('the names list and the sidebar\'s loaders name the same groups in the same order', () => {
  const h = setup();
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(SESSION_SIDEBAR_GROUPS.map((g) => g.id))')), ALL);
  assert.deepEqual([...h.root().querySelectorAll('.ssb-group > summary > .ssb-group-name')].map((s) => s.textContent),
    SESSION_SIDEBAR_GROUP_NAMES.map((g) => g.label));
});

test('the stored list: unknown ids dropped, repeats once, not a list hides nothing; a change keeps the default order', () => {
  assert.deepEqual(hiddenSidebarGroups(['context', 'nope', 'context', 'tasks']), ['context', 'tasks']);
  assert.deepEqual(hiddenSidebarGroups('context'), []);
  assert.deepEqual(hiddenSidebarGroups(undefined), []);
  assert.deepEqual(withSidebarGroupHidden(['context'], 'repository', true), ['repository', 'context']);
  assert.deepEqual(withSidebarGroupHidden(['context', 'tasks'], 'context', false), ['tasks']);
  assert.deepEqual(withSidebarGroupHidden(null, 'nope', true), []);
});

test('a hidden group is not drawn and reads nothing; the others read as before', async () => {
  const h = setup({ hidden: ['repository', 'handoffs'] });
  await flush(); await flush();
  assert.equal(h.slot('repository').hidden, true);
  assert.equal(h.slot('handoffs').hidden, true);
  assert.equal(h.slot('tasks').hidden, false);
  assert.ok(!h.calls.reads.includes('repository'));
  assert.ok(!h.calls.reads.includes('handoffs'));
  assert.ok(h.calls.reads.includes('tasks'));
  assert.ok(h.calls.reads.includes('connectors'));
  assert.equal(h.root().querySelector('.ssb-empty').hidden, true, 'no note while something is shown');
});

test('a right click on a heading lists every group with its check; a click shows or hides it and writes once', async () => {
  const h = setup({ hidden: ['handoffs'] });
  await flush(); await flush();
  h.calls.reads.length = 0;
  h.rightClick(h.slot('tasks').querySelector('summary'));
  assert.ok(h.pop(), 'the list opens');
  assert.deepEqual([...h.pop().querySelectorAll('[data-group-toggle]')].map((b) => [b.dataset.groupToggle, b.getAttribute('aria-checked')]),
    ALL.map((id) => [id, id === 'handoffs' ? 'false' : 'true']));
  assert.equal(h.w.document.activeElement, h.item('repository'), 'the first entry takes the caret');

  h.item('handoffs').click();
  await flush(); await flush();
  assert.deepEqual(h.calls.merged.at(-1), ['global', { sessionSidebarHidden: [] }]);
  assert.equal(h.calls.notified, 1, 'the other windows are told');
  assert.equal(h.slot('handoffs').hidden, false);
  assert.ok(h.calls.reads.includes('handoffs'), 'a group shown again that is open reads now');
  assert.equal(h.item('handoffs').getAttribute('aria-checked'), 'true');
  assert.ok(h.pop(), 'the list stays open for the next choice');

  h.item('context').click();
  await flush();
  assert.deepEqual(h.calls.merged.at(-1), ['global', { sessionSidebarHidden: ['context'] }]);
  assert.equal(h.slot('context').hidden, true);
});

test('a right click on a group\'s rows is not the list, and a click outside closes it', async () => {
  const h = setup();
  await flush();
  h.rightClick(h.slot('tasks').querySelector('.ssb-group-body'));
  assert.equal(h.pop(), null);
  h.rightClick(h.root().querySelector('.ssb-head'));
  assert.ok(h.pop());
  h.w.document.body.dispatchEvent(new h.w.MouseEvent('pointerdown', { bubbles: true }));
  assert.equal(h.pop(), null);
});

test('every group hidden: the sidebar says how to bring them back, and the note opens the list', async () => {
  const h = setup({ hidden: ['context'] });
  await flush();
  for (const id of ALL.filter((g) => g !== 'context')) {
    h.rightClick(h.root().querySelector('.ssb-head'));
    h.item(id).click();
    await flush();
  }
  const empty = h.root().querySelector('.ssb-empty');
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /Right-click here, or use Settings → Sessions/);
  h.w.document.body.dispatchEvent(new h.w.MouseEvent('pointerdown', { bubbles: true }));
  h.rightClick(empty);
  assert.ok(h.pop());
  h.item('tasks').click();
  await flush();
  assert.equal(empty.hidden, true);
});

test('the keys: the context-menu key opens it under the heading, arrows move, Escape closes and gives the caret back', async () => {
  const h = setup();
  await flush();
  const summary = h.slot('tasks').querySelector('summary');
  summary.focus();
  h.rightClick(summary, { clientX: 0, clientY: 0, button: 0 });
  assert.ok(h.pop());
  const key = (k) => h.pop().dispatchEvent(new h.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  key('ArrowDown');
  assert.equal(h.w.document.activeElement, h.item('processes'));
  key('End');
  assert.equal(h.w.document.activeElement, h.item('connectors'));
  key('ArrowDown');
  assert.equal(h.w.document.activeElement, h.item('repository'), 'it wraps');
  key('Escape');
  assert.equal(h.pop(), null);
  assert.equal(h.w.document.activeElement, summary);
  h.rightClick(summary, { clientX: 0, clientY: 0, button: 0 });
  key('Tab');
  assert.equal(h.pop(), null, 'Tab closes it too');
  assert.equal(h.w.document.activeElement, summary, 'and the caret goes back, not to the top of the page');
});

test('Alt+Down on a grip steps past a hidden neighbour, which keeps its place', async () => {
  const h = setup({ hidden: ['processes'] });
  await flush();
  const grip = h.slot('repository').querySelector('.ssb-grip');
  grip.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
  await flush();
  assert.deepEqual(h.calls.merged.at(-1), ['global', { sessionSidebarOrder: ['processes', 'context', 'repository', 'tasks', 'handoffs', 'instructions', 'connectors'] }]);
});

test('a change from another window is applied and not written back; a failed write puts the old list back', async () => {
  const h = setup();
  await flush();
  h.run('appGlobalSettings.sessionSidebarHidden = ["instructions"]; sessionSidebarHiddenChanged();');
  assert.equal(h.slot('instructions').hidden, true);
  assert.equal(h.calls.merged.length, 0);

  const f = setup({ hidden: ['instructions'], mergeFails: true });
  await flush();
  f.rightClick(f.root().querySelector('.ssb-head'));
  f.item('context').click();
  assert.equal(f.slot('context').hidden, true, 'applied at once');
  await flush(); await flush();
  assert.equal(f.slot('context').hidden, false, 'and taken back when the write fails');
  assert.equal(f.slot('instructions').hidden, true);
  assert.equal(f.calls.toasts.length, 1);
});

test('reapplyGlobalSettings applies the hidden list too', () => {
  const app = read('app.js');
  const at = app.indexOf('sessionSidebarOrderChanged();');
  assert.ok(at > 0);
  assert.ok(app.slice(at, at + 400).includes('sessionSidebarHiddenChanged()'));
});
