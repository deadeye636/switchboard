const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTimelineStore,
  hydrateTimeline,
  isTimelineLoaded,
  dropTimeline,
  addTimelineEvent,
  getTimelineEvents,
  formatTimelineEvent,
  filterTimelineEvents,
  getTimelineKinds,
} = require('../src/renderer/session/session-timeline');

// Since #396 this store is a read-through CACHE of what main holds, so a session has to be fetched
// before an appended event means anything. `hydrateTimeline(store, id, [])` is what a fetch that came
// back empty looks like.
test('addTimelineEvent records newest events first', () => {
  const store = createTimelineStore();
  hydrateTimeline(store, 's1', []);
  addTimelineEvent(store, 's1', 'started', 'Session started', { at: '2026-06-12T10:00:00.000Z' });
  addTimelineEvent(store, 's1', 'busy', 'Agent started working', { at: '2026-06-12T10:01:00.000Z' });

  assert.deepEqual(getTimelineEvents(store, 's1').map(event => event.kind), ['busy', 'started']);
});

test('addTimelineEvent caps per-session history', () => {
  const store = createTimelineStore({ maxEventsPerSession: 2 });
  hydrateTimeline(store, 's1', []);
  addTimelineEvent(store, 's1', 'a', 'first', { at: '2026-06-12T10:00:00.000Z' });
  addTimelineEvent(store, 's1', 'b', 'second', { at: '2026-06-12T10:01:00.000Z' });
  addTimelineEvent(store, 's1', 'c', 'third', { at: '2026-06-12T10:02:00.000Z' });

  assert.deepEqual(getTimelineEvents(store, 's1').map(event => event.kind), ['c', 'b']);
});

test('an event for a session this window never fetched is dropped', () => {
  const store = createTimelineStore();
  const written = addTimelineEvent(store, 'never-fetched', 'busy', 'Agent working');

  assert.equal(written, null);
  assert.deepEqual(getTimelineEvents(store, 'never-fetched'), [],
    'a one-event history looks complete and is not — the fetch decides, not the first push');
});

test('"not fetched" and "fetched, nothing there" are different answers', () => {
  const store = createTimelineStore();
  assert.equal(isTimelineLoaded(store, 's1'), false);
  assert.deepEqual(getTimelineEvents(store, 's1'), []);

  hydrateTimeline(store, 's1', []);
  assert.equal(isTimelineLoaded(store, 's1'), true);
  assert.deepEqual(getTimelineEvents(store, 's1'), [],
    'same empty list, and the recap must be able to tell the two apart');
});

test('hydrateTimeline REPLACES, and caps what it is handed', () => {
  const store = createTimelineStore({ maxEventsPerSession: 2 });
  hydrateTimeline(store, 's1', [{ kind: 'stale', sessionId: 's1' }]);
  hydrateTimeline(store, 's1', [
    { kind: 'c', sessionId: 's1' }, { kind: 'b', sessionId: 's1' }, { kind: 'a', sessionId: 's1' },
  ]);

  assert.deepEqual(getTimelineEvents(store, 's1').map(e => e.kind), ['c', 'b'],
    'main is the record — a merge would preserve exactly the divergence this ends');
});

test('hydrateTimeline survives an answer that is not a list', () => {
  const store = createTimelineStore();
  hydrateTimeline(store, 's1', null);
  assert.deepEqual(getTimelineEvents(store, 's1'), []);
  assert.equal(isTimelineLoaded(store, 's1'), true, 'a failed shape is still an answer');
});

test('dropTimeline forgets a session so the next read fetches it again', () => {
  const store = createTimelineStore();
  hydrateTimeline(store, 's1', [{ kind: 'busy', sessionId: 's1' }]);
  dropTimeline(store, 's1');

  assert.equal(isTimelineLoaded(store, 's1'), false);
  assert.deepEqual(getTimelineEvents(store, 's1'), []);
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
