'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  TASK_STATUS_ORDER,
  taskStatusLabel,
  taskScopeLabel,
  nextTaskStatus,
  filterTasks,
  sortTasks,
} = require('../public/tasks-logic.js');

const sample = [
  { id: 1, title: 'Fix scroll bug', note: 'header clipped', quote: null, status: 'open', createdAt: 100, updatedAt: 400, projectDisplayName: 'switchboard', sessionName: 'sess A' },
  { id: 2, title: 'Refactor db', note: null, quote: 'CREATE TABLE tasks', status: 'in_progress', createdAt: 300, updatedAt: 150, projectDisplayName: 'switchboard', sessionName: 'sess B' },
  { id: 3, title: 'Write docs', note: null, quote: null, status: 'done', createdAt: 200, updatedAt: 250, projectDisplayName: 'other', sessionName: 'sess C' },
  { id: 4, title: 'Old idea', note: null, quote: null, status: 'dropped', createdAt: 50, updatedAt: 500, projectDisplayName: 'other', sessionName: 'sess D' },
];

test('nextTaskStatus cycles through the status order and wraps', () => {
  assert.strictEqual(nextTaskStatus('open'), 'in_progress');
  assert.strictEqual(nextTaskStatus('in_progress'), 'done');
  assert.strictEqual(nextTaskStatus('done'), 'dropped');
  assert.strictEqual(nextTaskStatus('dropped'), 'open');
  // Unknown status → treated as index -1, so wraps to the first entry.
  assert.strictEqual(nextTaskStatus('bogus'), TASK_STATUS_ORDER[0]);
});

test('status/scope labels are human-readable with fallbacks', () => {
  assert.strictEqual(taskStatusLabel('in_progress'), 'In progress');
  assert.strictEqual(taskStatusLabel('open'), 'Open');
  assert.strictEqual(taskStatusLabel('weird'), 'weird');
  assert.strictEqual(taskScopeLabel('message'), 'Message');
  assert.strictEqual(taskScopeLabel('project'), 'Project');
});

test('filterTasks by status ("all" keeps everything)', () => {
  assert.strictEqual(filterTasks(sample, { status: 'all' }).length, 4);
  const open = filterTasks(sample, { status: 'open' });
  assert.deepStrictEqual(open.map(t => t.id), [1]);
});

test('filterTasks text search spans title, note, quote and names (case-insensitive)', () => {
  assert.deepStrictEqual(filterTasks(sample, { text: 'CLIPPED' }).map(t => t.id), [1]);   // note
  assert.deepStrictEqual(filterTasks(sample, { text: 'create table' }).map(t => t.id), [2]); // quote
  assert.deepStrictEqual(filterTasks(sample, { text: 'sess c' }).map(t => t.id), [3]);      // session name
  assert.deepStrictEqual(filterTasks(sample, { text: 'other' }).map(t => t.id), [3, 4]);    // project name
  assert.strictEqual(filterTasks(sample, { text: 'nomatch' }).length, 0);
});

test('filterTasks combines status and text', () => {
  const r = filterTasks(sample, { status: 'in_progress', text: 'switchboard' });
  assert.deepStrictEqual(r.map(t => t.id), [2]);
});

test('sortTasks newest/oldest by createdAt', () => {
  assert.deepStrictEqual(sortTasks(sample, 'newest').map(t => t.id), [2, 3, 1, 4]);
  assert.deepStrictEqual(sortTasks(sample, 'oldest').map(t => t.id), [4, 1, 3, 2]);
});

test('sortTasks updated/updated_oldest by updatedAt', () => {
  assert.deepStrictEqual(sortTasks(sample, 'updated').map(t => t.id), [4, 1, 3, 2]);
  assert.deepStrictEqual(sortTasks(sample, 'updated_oldest').map(t => t.id), [2, 3, 1, 4]);
});

test('sortTasks by status follows the status order, newest within a status', () => {
  const byStatus = sortTasks(sample, 'status').map(t => t.id);
  // open(1) → in_progress(2) → done(3) → dropped(4)
  assert.deepStrictEqual(byStatus, [1, 2, 3, 4]);
});

test('sortTasks does not mutate the input array', () => {
  const before = sample.map(t => t.id);
  sortTasks(sample, 'oldest');
  assert.deepStrictEqual(sample.map(t => t.id), before);
});
