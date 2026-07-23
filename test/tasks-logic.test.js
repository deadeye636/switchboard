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
} = require('../src/renderer/views/tasks-logic.js');

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

// --- createTask's entryIndex / scope derivation ---
//
// better-sqlite3 is compiled against Electron's Node ABI and cannot be required under plain
// node:test (the constraint auto-hide / main-ctx-db-wiring document), so this (a) mirrors the
// derivation in src/db/tasks-store.js and (b) source-guards the real file so the two stay in step.
//
// The case that made this worth a test: `Number(null)` is 0, not NaN. An explicit
// `entryIndex: null` — which is exactly what the renderer's createFromSource sends for a task made
// from the TERMINAL — passed the finite-and-non-negative check, was stored as index 0, and the task
// was filed as scope 'message'. It then read as "Message" in the list and jumped to the first line
// of the transcript instead of to its session.

function deriveEntryIndex(raw) {
  return raw == null || raw === ''
    ? null
    : (Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : null);
}

function deriveScope({ scope, entryIndex, sessionId }) {
  const SCOPES = ['project', 'session', 'message'];
  const idx = deriveEntryIndex(entryIndex);
  return SCOPES.includes(scope) ? scope : (idx != null ? 'message' : (sessionId ? 'session' : 'project'));
}

test('entryIndex: absent stays absent, 0 is a real index', () => {
  assert.strictEqual(deriveEntryIndex(null), null);
  assert.strictEqual(deriveEntryIndex(undefined), null);
  assert.strictEqual(deriveEntryIndex(''), null);
  assert.strictEqual(deriveEntryIndex(0), 0);        // the FIRST message is a legitimate anchor
  assert.strictEqual(deriveEntryIndex('7'), 7);
  assert.strictEqual(deriveEntryIndex(-1), null);
  assert.strictEqual(deriveEntryIndex('abc'), null);
});

test('scope: an explicit entryIndex: null is a session task, not a message task', () => {
  // From the terminal: a session, no message anchor.
  assert.strictEqual(deriveScope({ entryIndex: null, sessionId: 's1' }), 'session');
  // From a transcript block: message, including block 0.
  assert.strictEqual(deriveScope({ entryIndex: 0, sessionId: 's1' }), 'message');
  assert.strictEqual(deriveScope({ entryIndex: 4, sessionId: 's1' }), 'message');
  // Neither: a project task.
  assert.strictEqual(deriveScope({ entryIndex: null, sessionId: null }), 'project');
  // An explicit scope always wins over the derivation.
  assert.strictEqual(deriveScope({ scope: 'project', entryIndex: 3, sessionId: 's1' }), 'project');
});

test('tasks-store guards absent BEFORE it looks at the number', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'db', 'tasks-store.js'), 'utf8');
  // The null/'' rejection must come first — a bare Number(t.entryIndex) check is the bug.
  assert.match(src, /rawEntryIndex == null \|\| rawEntryIndex === ''/,
    'tasks-store.js must reject an absent entryIndex before coercing it to a number');
});
