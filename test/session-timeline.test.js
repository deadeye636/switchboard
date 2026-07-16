const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTimelineStore,
  addTimelineEvent,
  getTimelineEvents,
  formatTimelineEvent,
  filterTimelineEvents,
  getTimelineKinds,
} = require('../src/renderer/session/session-timeline');

test('addTimelineEvent records newest events first', () => {
  const store = createTimelineStore();
  addTimelineEvent(store, 's1', 'started', 'Session started', { at: '2026-06-12T10:00:00.000Z' });
  addTimelineEvent(store, 's1', 'busy', 'Agent started working', { at: '2026-06-12T10:01:00.000Z' });

  assert.deepEqual(getTimelineEvents(store, 's1').map(event => event.kind), ['busy', 'started']);
});

test('addTimelineEvent caps per-session history', () => {
  const store = createTimelineStore({ maxEventsPerSession: 2 });
  addTimelineEvent(store, 's1', 'a', 'first', { at: '2026-06-12T10:00:00.000Z' });
  addTimelineEvent(store, 's1', 'b', 'second', { at: '2026-06-12T10:01:00.000Z' });
  addTimelineEvent(store, 's1', 'c', 'third', { at: '2026-06-12T10:02:00.000Z' });

  assert.deepEqual(getTimelineEvents(store, 's1').map(event => event.kind), ['c', 'b']);
});

test('formatTimelineEvent includes time, label, and detail', () => {
  const formatted = formatTimelineEvent({
    at: '2026-06-12T10:01:00.000Z',
    kind: 'needs-attention',
    label: 'Needs attention',
    detail: 'Claude needs permission',
  });

  assert.equal(formatted.label, 'Needs attention');
  assert.equal(formatted.detail, 'Claude needs permission');
  assert.match(formatted.time, /^\d{2}:\d{2}$/);
});

test('filterTimelineEvents searches labels and details case-insensitively', () => {
  const events = [
    { kind: 'busy', label: 'Agent working', detail: 'Claude activity started.' },
    { kind: 'needs-attention', label: 'Needs human attention', detail: 'Permission required' },
    { kind: 'exited', label: 'Process exited', detail: 'Exit code 0.' },
  ];

  assert.deepEqual(filterTimelineEvents(events, { query: 'permission' }).map(e => e.kind), ['needs-attention']);
  assert.deepEqual(filterTimelineEvents(events, { query: 'AGENT' }).map(e => e.kind), ['busy']);
});

test('filterTimelineEvents filters by event kind', () => {
  const events = [
    { kind: 'busy', label: 'Agent working', detail: '' },
    { kind: 'needs-attention', label: 'Needs human attention', detail: '' },
    { kind: 'exited', label: 'Process exited', detail: '' },
  ];

  assert.deepEqual(filterTimelineEvents(events, { kind: 'needs-attention' }).map(e => e.kind), ['needs-attention']);
  assert.deepEqual(filterTimelineEvents(events, { kind: 'all' }).map(e => e.kind), ['busy', 'needs-attention', 'exited']);
});

test('getTimelineKinds returns unique event kinds in first-seen order', () => {
  const events = [
    { kind: 'busy' },
    { kind: 'exited' },
    { kind: 'busy' },
    { kind: 'needs-attention' },
  ];

  assert.deepEqual(getTimelineKinds(events), ['busy', 'exited', 'needs-attention']);
});
