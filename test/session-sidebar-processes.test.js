'use strict';
// #834: the session sidebar's Processes group — what the session costs the machine, read from main's `processUsage`
// answer only while the group is open in a visible sidebar, and redrawn row by row.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');

const { processRows, sidebarCpu, sidebarBytes } = require('../src/renderer/session/session-sidebar');
const { setupSessionSidebar, closeSessionSidebarWindows } = require('./helpers/session-sidebar-dom');

const flush = () => new Promise((r) => setTimeout(r, 0));
after(closeSessionSidebarWindows);

const MB = 1024 * 1024;
const answerFor = (rows, extra = {}) => ({
  ok: true,
  supported: true,
  sessions: {
    s1: {
      running: true,
      total: { cpu: rows.reduce((n, r) => n + (r.cpu || 0), 0), memory: rows.reduce((n, r) => n + r.memory, 0), count: rows.length },
      rows,
      truncated: false,
      ...extra,
    },
  },
});

test('figures read short: CPU to a tenth with a floor, memory in MB or GB, nothing for no figure', () => {
  assert.equal(sidebarCpu(12.345), '12.3 %');
  assert.equal(sidebarCpu(0.04), '<0.1 %');
  assert.equal(sidebarCpu(0), '0.0 %');
  assert.equal(sidebarCpu(null), '');
  assert.equal(sidebarBytes(5.25 * MB), '5.3 MB');
  assert.equal(sidebarBytes(250 * MB), '250 MB');
  assert.equal(sidebarBytes(3 * 1024 * MB), '3.0 GB');
  assert.equal(sidebarBytes(0), '');
});

test('the rows: a total, then each process with its depth; a session with nothing running, an unsupported machine', () => {
  const model = processRows(answerFor([
    { pid: 10, name: 'pwsh.exe', depth: 0, cpu: 0.5, memory: 40 * MB },
    { pid: 11, name: 'claude.exe', depth: 1, cpu: 2, memory: 300 * MB },
  ]), 's1');
  assert.deepEqual(model.total, { main: 'Total · 2 processes', meta: '2.5 % · 340 MB' });
  assert.deepEqual(model.rows.map((r) => [r.key, r.main, r.depth]), [['10', 'pwsh.exe', 0], ['11', 'claude.exe', 1]]);
  assert.equal(processRows({ ok: true, supported: true, sessions: { s1: { running: false } } }, 's1').note, 'This session has no running process.');
  assert.equal(processRows({ ok: true, supported: false, message: 'Not installed.' }, 's1').note, 'Not installed.');
  assert.equal(processRows({ ok: false, error: 'x' }, 's1').note, 'The processes could not be read.');
  assert.equal(processRows(null, 's1').note, 'The processes could not be read.');
});

test('the open group reads once for its session and draws the tree', async () => {
  const h = setupSessionSidebar({ processUsage: () => answerFor([{ pid: 10, name: 'bash', depth: 0, cpu: 1, memory: 10 * MB }, { pid: 11, name: 'node', depth: 1, cpu: 3, memory: 20 * MB }]) });
  await flush(); await flush();
  assert.deepEqual(h.calls.usage, [['s1']]);
  const body = h.slot('processes').querySelector('.ssb-group-body');
  assert.equal(body.querySelector('.ssb-proc-total').textContent, 'Total · 2 processes4.0 % · 30.0 MB');
  assert.deepEqual([...body.querySelectorAll('.ssb-proc-row')].map((r) => r.dataset.pid), ['10', '11']);
  const pad = (i) => parseInt(body.querySelectorAll('.ssb-proc-row')[i].style.paddingLeft, 10);
  assert.ok(pad(1) > pad(0), 'a child sits in from its parent');
});

test('a tick patches only what changed: a row that stays keeps its element, a gone one leaves, a new one comes in order', async () => {
  let rows = [{ pid: 10, name: 'bash', depth: 0, cpu: 1, memory: 10 * MB }, { pid: 11, name: 'node', depth: 1, cpu: 3, memory: 20 * MB }];
  const h = setupSessionSidebar({ processUsage: () => answerFor(rows) });
  await flush(); await flush();
  const body = h.slot('processes').querySelector('.ssb-group-body');
  const bash = body.querySelector('[data-pid="10"]');
  const bashMeta = bash.querySelector('.ssb-row-meta').textContent;
  rows = [{ pid: 10, name: 'bash', depth: 0, cpu: 1, memory: 10 * MB }, { pid: 12, name: 'git', depth: 1, cpu: 0, memory: 5 * MB }];
  await h.run('sidebarTickProcesses(__entry)');
  assert.equal(body.querySelector('[data-pid="10"]'), bash, 'the unchanged row is the same element');
  assert.equal(bash.querySelector('.ssb-row-meta').textContent, bashMeta);
  assert.equal(body.querySelector('[data-pid="11"]'), null);
  assert.deepEqual([...body.querySelectorAll('.ssb-proc-row')].map((r) => r.dataset.pid), ['10', '12']);
  assert.match(body.querySelector('.ssb-proc-total').textContent, /Total · 2 processes/);
});

test('nothing is measured while the window is hidden or the sidebar is out of view; a closed or hidden group ends the poll', async () => {
  const h = setupSessionSidebar({ processUsage: () => answerFor([{ pid: 10, name: 'bash', depth: 0, cpu: 1, memory: MB }]) });
  await flush(); await flush();
  const asked = () => h.calls.usage.length;
  const before = asked();
  Object.defineProperty(h.w.document, 'hidden', { configurable: true, get: () => true });
  await h.run('sidebarTickProcesses(__entry)');
  assert.equal(asked(), before, 'a hidden window measures nothing');
  assert.ok(h.run('!!__entry.sidebarProcessTimer'), 'and waits for the next tick');
  Object.defineProperty(h.w.document, 'hidden', { configurable: true, get: () => false });
  h.element.classList.remove('visible');
  await h.run('sidebarTickProcesses(__entry)');
  assert.equal(asked(), before, 'a sidebar out of view measures nothing');
  h.element.classList.add('visible');
  await h.run('sidebarTickProcesses(__entry)');
  assert.equal(asked(), before + 1, 'in view again, it measures');

  h.slot('processes').querySelector('.ssb-group').open = false;
  await h.run('clearTimeout(__entry.sidebarProcessTimer); sidebarTickProcesses(__entry)');
  assert.equal(asked(), before + 1);
  assert.equal(h.run('__entry.sidebarProcessTimer'), null, 'a closed group ends the poll');
});

test('a session closed or moved away with the group open ends the poll before anything is measured', async () => {
  const h = setupSessionSidebar({ processUsage: () => answerFor([{ pid: 10, name: 'bash', depth: 0, cpu: 1, memory: MB }]) });
  await flush(); await flush();
  const before = h.calls.usage.length;
  h.element.remove(); // what destroySession does to the view, which keeps its `visible` class
  await h.run('sidebarTickProcesses(__entry)');
  assert.equal(h.calls.usage.length, before);
  assert.equal(h.run('__entry.sidebarProcessTimer'), null);

  const g = setupSessionSidebar({ processUsage: () => answerFor([{ pid: 10, name: 'bash', depth: 0, cpu: 1, memory: MB }]) });
  await flush(); await flush();
  const asked = g.calls.usage.length;
  g.run('openSessions.delete("s1")');
  await g.run('sidebarTickProcesses(__entry)');
  assert.equal(g.calls.usage.length, asked, 'an entry this window no longer holds measures nothing');
  assert.equal(g.run('__entry.sidebarProcessTimer'), null);
});

test('a row whose process moved in the tree takes its new indentation', async () => {
  let rows = [{ pid: 10, name: 'bash', depth: 0, cpu: 0, memory: MB }, { pid: 12, name: 'git', depth: 2, cpu: 0, memory: MB }];
  const h = setupSessionSidebar({ processUsage: () => answerFor(rows) });
  await flush(); await flush();
  const git = h.slot('processes').querySelector('[data-pid="12"]');
  assert.equal(git.style.paddingLeft, '24px');
  rows = [rows[0], { ...rows[1], depth: 1 }];
  await h.run('sidebarTickProcesses(__entry)');
  assert.equal(git.style.paddingLeft, '14px');
});

test('closing the sidebar ends the poll', async () => {
  const h = setupSessionSidebar({ processUsage: () => answerFor([{ pid: 10, name: 'bash', depth: 0, cpu: 1, memory: MB }]) });
  await flush(); await flush();
  assert.ok(h.run('!!__entry.sidebarProcessTimer'));
  h.run('sessionSidebarToggle("s1")');
  assert.equal(h.run('__entry.sidebarProcessTimer'), null);
});
