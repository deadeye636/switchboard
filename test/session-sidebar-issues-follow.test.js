'use strict';
// #882: the session sidebar's issues list follows main's refresh timer only while the Tasks & notes group is open and
// shown, says how closely it is watched, reads again when it becomes visible after a while, and has a control that
// reads only the issues.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { setupSessionSidebar, closeSessionSidebarWindows } = require('./helpers/session-sidebar-dom');

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };
after(closeSessionSidebarWindows);

const QUERY = { state: 'open', assignee: false, author: false };
const OLD = 3 * 60 * 1000;

async function open(extra = {}) {
  const h = setupSessionSidebar({ openGroups: ['tasks'], issues: {}, ...extra });
  await settle();
  return h;
}
const ops = (h) => h.calls.issueFollows.map((f) => (f.op === 'follow' ? `follow:${f.tier}` : 'unfollow'));
const taskReads = (h) => h.calls.reads.filter((g) => g === 'tasks').length;

test('an open, shown group follows with its project, query and tier, and reads the list once', async () => {
  const h = await open();
  assert.deepEqual(h.calls.issueFollows, [{ op: 'follow', id: 'issues-1', projectPath: '/p', query: QUERY, tier: 'focused' }]);
  assert.equal(h.calls.issueLists.length, 1);
  assert.ok(h.calls.issuesListener, 'subscribed to the notices');
});

test('issues switched off follow nothing', async () => {
  const h = await open({ issues: { enabled: false } });
  assert.deepEqual(h.calls.issueFollows, []);
  assert.equal(h.calls.issuesListener, null);
});

test('the tier follows the window focus and the active session', async () => {
  const h = await open();
  h.setFocus(false);
  h.setFocus(false);
  assert.deepEqual(ops(h), ['follow:focused', 'follow:visible'], 'an unchanged tier sends nothing');
  h.setFocus(true);
  assert.deepEqual(ops(h), ['follow:focused', 'follow:visible', 'follow:focused']);
  h.run('activeSessionId = "other"; sessionSidebarActiveChanged();');
  assert.equal(ops(h).pop(), 'follow:visible', 'another session is active');
  h.run('activeSessionId = "s1"; sessionSidebarActiveChanged();');
  assert.equal(ops(h).pop(), 'follow:focused');
});

test('becoming active reads again only when the last read is older than 2 minutes', async () => {
  const h = await open();
  const base = h.calls.issueLists.length;
  h.setFocus(false);
  h.setFocus(true);
  await settle();
  assert.equal(h.calls.issueLists.length, base, 'a fresh list is not read again');
  h.entry.sidebarIssuesReadAt = Date.now() - OLD;
  h.setFocus(false);
  h.setFocus(true);
  await settle();
  assert.equal(h.calls.issueLists.length, base + 1);
  assert.equal(h.calls.issueLists.at(-1).force, false, 'main\'s cache may answer');
  assert.equal(taskReads(h), 1, 'the tasks are not read again');
});

test('only the sidebar of the session that became active re-reads, and as a background read', async () => {
  const h = await open();
  h.entry.sidebarIssuesReadAt = Date.now() - OLD;
  h.run('activeSessionId = "other"; sessionSidebarActiveChanged();');
  await settle();
  const base = h.calls.issueLists.length;
  assert.equal(base, 1, 'another session became active: this sidebar did not');
  h.run('activeSessionId = "s1"; sessionSidebarActiveChanged();');
  await settle();
  assert.equal(h.calls.issueLists.length, base + 1);
  assert.deepEqual([h.calls.issueLists.at(-1).force, h.calls.issueLists.at(-1).background], [false, true]);
});

test('a read main declines (user away) leaves the list and the read time alone', async () => {
  let decline = false;
  const h = await open({ issues: { list: () => (decline ? null : undefined) } });
  const old = Date.now() - OLD;
  h.entry.sidebarIssuesReadAt = old;
  decline = true;
  h.setFocus(false);
  h.setFocus(true);
  await settle();
  assert.equal(h.calls.issueLists.at(-1).background, true);
  assert.equal(h.entry.sidebarIssuesReadAt, old);
  assert.match(h.root().querySelector('.ssb-issue-list').textContent, /First/);
});

test('an old answer main hands over while the user is away is drawn but is not a read', async () => {
  let mode = 'ok';
  const answer = (title) => ({ enabled: true, ok: true, provider: 'GitHub', issues: [{ number: 2, title, labels: [], author: 'a', state: 'open' }], limit: 100, query: QUERY, supports: {}, web: {} });
  const h = await open({ issues: { list: () => (mode === 'held' ? { ...answer('Old one'), held: true } : answer('First')) } });
  const old = Date.now() - OLD;
  h.entry.sidebarIssuesReadAt = old;
  mode = 'held';
  h.setFocus(false);
  h.setFocus(true);
  await settle();
  assert.match(h.root().querySelector('.ssb-issue-list').textContent, /Old one/);
  assert.equal(h.entry.sidebarIssuesReadAt, old, 'so the next becoming-active still re-reads');
  const before = h.calls.issueLists.length;
  h.setFocus(false);
  h.setFocus(true);
  await settle();
  assert.equal(h.calls.issueLists.length, before + 1);
});

test('a background read that fails keeps the last good list and the read time', async () => {
  let fail = false;
  const h = await open({ issues: { list: () => (fail ? { enabled: true, ok: false, message: 'gh did not answer in time.' } : undefined) } });
  const old = Date.now() - OLD;
  h.entry.sidebarIssuesReadAt = old;
  fail = true;
  h.setFocus(false);
  h.setFocus(true);
  await settle();
  assert.equal(h.calls.issueLists.at(-1).background, true);
  assert.match(h.root().querySelector('.ssb-issue-list').textContent, /First/);
  assert.doesNotMatch(h.root().querySelector('.ssb-issue-list').textContent, /did not answer/);
  assert.equal(h.entry.sidebarIssuesReadAt, old);
  fail = false;
  h.root().querySelector('[data-ssb="issues-refresh"]').click();
  await settle();
  assert.ok(h.entry.sidebarIssuesReadAt > old, 'a user\'s read does count');
});

test('a notice, the refresh control and the group load are the user\'s reads, not background ones', async () => {
  const h = await open();
  h.calls.issuesListener({ projectPath: '/p', query: QUERY });
  h.root().querySelector('[data-ssb="issues-refresh"]').click();
  await settle();
  assert.deepEqual(h.calls.issueLists.map((l) => l.background), [false, false, false]);
});

test('closing the group, hiding it and closing the sidebar each unfollow', async () => {
  let h = await open();
  h.slot('tasks').querySelector('.ssb-group').open = false;
  await settle();
  assert.equal(ops(h).pop(), 'unfollow', 'group closed');

  h = await open();
  h.run('sessionSidebarSetHidden(["tasks"])');
  assert.equal(ops(h).pop(), 'unfollow', 'group hidden');
  assert.equal(h.calls.issuesListener, null, 'and the subscription is given back');

  h = await open();
  h.run('sessionSidebarToggle("s1")');
  assert.equal(ops(h).pop(), 'unfollow', 'sidebar closed');
});

test('a tab out of view unfollows and, back in view with an old list, follows and reads again', async () => {
  const h = await open();
  h.element.classList.remove('visible');
  await settle();
  assert.equal(ops(h).pop(), 'unfollow');
  const base = h.calls.issueLists.length;
  h.entry.sidebarIssuesReadAt = Date.now() - OLD;
  h.element.classList.add('visible');
  await settle();
  assert.equal(ops(h).pop(), 'follow:focused');
  assert.equal(h.calls.issueLists.length, base + 1);
});

test('a hidden window (minimised) unfollows and a shown one follows again', async () => {
  const h = await open();
  Object.defineProperty(h.w.document, 'hidden', { configurable: true, get: () => true });
  h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
  assert.equal(ops(h).pop(), 'unfollow');
  Object.defineProperty(h.w.document, 'hidden', { configurable: true, get: () => false });
  h.w.document.dispatchEvent(new h.w.Event('visibilitychange'));
  assert.equal(ops(h).pop(), 'follow:focused');
});

test('a destroyed tab unfollows: the teardown calls it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'terminal', 'terminal-manager.js'), 'utf8');
  assert.match(src, /sidebarUnfollowIssues\(entry\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8'), /sessionSidebarActiveChanged\(\)/);
});

test('a notice for the followed project and query asks for the issues alone, from main\'s cache', async () => {
  const h = await open();
  const base = h.calls.issueLists.length;
  const tasks = taskReads(h);
  h.calls.issuesListener({ projectPath: '/other', query: QUERY });
  h.calls.issuesListener({ projectPath: '/p', query: { state: 'closed', assignee: false, author: false } });
  await settle();
  assert.equal(h.calls.issueLists.length, base, 'another project or query is not ours');
  h.calls.issuesListener({ projectPath: '/p', query: QUERY });
  await settle();
  assert.equal(h.calls.issueLists.length, base + 1);
  assert.equal(h.calls.issueLists.at(-1).force, false);
  assert.equal(taskReads(h), tasks);
});

test('the refresh control is a styled head button and reads only the issues, forced', async () => {
  const h = await open();
  const btn = h.root().querySelector('[data-ssb="issues-refresh"]');
  assert.ok(btn && btn.classList.contains('ssb-head-btn'), 'the existing button style');
  assert.equal(btn.getAttribute('aria-label'), 'Reload the issues');
  const base = h.calls.issueLists.length;
  const tasks = taskReads(h);
  btn.click();
  await settle();
  assert.equal(h.calls.issueLists.length, base + 1);
  assert.equal(h.calls.issueLists.at(-1).force, true);
  assert.equal(taskReads(h), tasks, 'no task read');
  assert.ok(h.root().querySelector('[data-ssb="issues-refresh"]'), 'the control is still there after the redraw');
  assert.match(h.root().querySelector('.ssb-issue-list').textContent, /First/);
});

test('the sidebar Reload reads the issues forced, as before', async () => {
  const h = await open();
  h.root().querySelector('[data-ssb="refresh"]').click();
  await settle();
  assert.equal(h.calls.issueLists.at(-1).force, true);
});

test('a filter change that moves the query follows under the new query', async () => {
  const h = await open();
  await h.run('sidebarChangeIssueFilter(__entry, { state: "closed" })');
  await settle();
  const last = h.calls.issueFollows.filter((f) => f.op === 'follow').at(-1);
  assert.equal(last.query.state, 'closed');
});
