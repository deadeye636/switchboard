const test = require('node:test');
const assert = require('node:assert/strict');

const { decideNotifications, FLOOD_MAX, FLOOD_WINDOW_MS } = require('../src/renderer/shell/notification-policy');

function snapshot(attention = [], ready = []) {
  return { attention: new Set(attention), ready: new Set(ready) };
}

test('transition into attention while unfocused emits one notification, badge=1', () => {
  const result = decideNotifications({
    prev: snapshot(),
    next: snapshot(['s1']),
    windowFocused: false,
    settings: { enabled: true, notifyOnReady: false },
    now: 100000,
  });

  assert.equal(result.notifications.length, 1);
  assert.equal(result.notifications[0].kind, 'attention');
  assert.deepEqual(result.notifications[0].sessionIds, ['s1']);
  assert.equal(result.badgeCount, 1);
});

test('window focused suppresses notifications but badge still reflects count', () => {
  const result = decideNotifications({
    prev: snapshot(),
    next: snapshot(['s1', 's2']),
    windowFocused: true,
    settings: { enabled: true, notifyOnReady: false },
    now: 1000,
  });

  assert.equal(result.notifications.length, 0);
  assert.equal(result.badgeCount, 2);
});

test('disabled setting emits nothing and badge stays 0', () => {
  const result = decideNotifications({
    prev: snapshot(),
    next: snapshot(['s1']),
    windowFocused: false,
    settings: { enabled: false, notifyOnReady: true },
    now: 1000,
  });

  assert.equal(result.notifications.length, 0);
  assert.equal(result.badgeCount, 0);
});

test('two sessions ready at once give one notification each when notifyOnReady on', () => {
  const result = decideNotifications({
    prev: snapshot(),
    next: snapshot([], ['s1', 's2']),
    windowFocused: false,
    settings: { enabled: true, notifyOnReady: true },
    now: 5000,
  });

  assert.equal(result.notifications.length, 2);
  assert.deepEqual(result.notifications.map((n) => n.sessionId), ['s1', 's2']);
  assert.ok(result.notifications.every((n) => n.kind === 'ready'));
  assert.equal(result.badgeCount, 2);
});

test('each notification names its session and project', () => {
  const result = decideNotifications({
    prev: snapshot(),
    next: snapshot(['s1']),
    windowFocused: false,
    settings: { enabled: true },
    now: 1,
    describeSession: (id) => ({ name: `Fix ${id}`, project: 'alpha', projectKey: '/p/alpha' }),
  });
  const n = result.notifications[0];
  assert.equal(n.title, 'Fix s1');
  assert.match(n.body, /alpha/);
  assert.match(n.body, /needs your attention/);
  assert.equal(n.projectKey, '/p/alpha');
});

test('an unknown session still gets a usable title', () => {
  const result = decideNotifications({
    prev: snapshot(), next: snapshot(['s1']), windowFocused: false, settings: {}, now: 1,
  });
  assert.equal(result.notifications[0].title, 'Session');
});

test('a session in both sets is announced once, as attention', () => {
  const result = decideNotifications({
    prev: snapshot(), next: snapshot(['s1'], ['s1']), windowFocused: false,
    settings: { notifyOnReady: true }, now: 1,
  });
  assert.equal(result.notifications.length, 1);
  assert.equal(result.notifications[0].kind, 'attention');
});

test('ready transitions emit nothing and are excluded from badge when notifyOnReady off', () => {
  const result = decideNotifications({
    prev: snapshot(['a']),
    next: snapshot(['a'], ['s1', 's2']),
    windowFocused: false,
    settings: { enabled: true, notifyOnReady: false },
    now: 5000,
  });

  assert.equal(result.notifications.length, 0);
  // Only the unchanged attention session contributes to the badge.
  assert.equal(result.badgeCount, 1);
});

test('flood guard: beyond FLOOD_MAX the rest folds into one summary entry', () => {
  const ids = Array.from({ length: FLOOD_MAX + 3 }, (_, i) => `s${i}`);
  const result = decideNotifications({
    prev: snapshot(), next: snapshot(ids), windowFocused: false, settings: {}, now: 1,
  });
  assert.equal(result.notifications.length, FLOOD_MAX + 1);
  const summary = result.notifications[FLOOD_MAX];
  assert.equal(summary.summary, true);
  assert.deepEqual(summary.sessionIds, ids.slice(FLOOD_MAX));
  assert.match(summary.body, /^3 more sessions need your attention/);
  assert.equal(result.badgeCount, ids.length);
});

test('flood guard: recent emissions inside the window use up the budget', () => {
  const now = 100000;
  const recent = Array.from({ length: FLOOD_MAX }, () => now - 1000);
  const result = decideNotifications({
    prev: snapshot(['a']), next: snapshot(['a', 'b']), windowFocused: false, settings: {}, now, recent,
  });
  assert.equal(result.notifications.length, 1);
  assert.equal(result.notifications[0].summary, true);
  assert.match(result.notifications[0].body, /^1 more session needs|^1 more session need/);
});

test('flood guard: emissions older than the window are forgotten', () => {
  const now = 100000;
  const recent = Array.from({ length: FLOOD_MAX }, () => now - FLOOD_WINDOW_MS);
  const result = decideNotifications({
    prev: snapshot(['a']), next: snapshot(['a', 'b']), windowFocused: false, settings: {}, now, recent,
  });
  assert.equal(result.notifications.length, 1);
  assert.equal(result.notifications[0].sessionId, 'b');
});

test('a session that left the set is reported as cleared, even while focused', () => {
  const result = decideNotifications({
    prev: snapshot(['s1', 's2']), next: snapshot(['s2']), windowFocused: true, settings: {}, now: 1,
  });
  assert.deepEqual(result.cleared, ['s1']);
  assert.equal(result.clearSummary, false);
  assert.equal(result.notifications.length, 0);
});

test('the summary is cleared once all its folded sessions have left the sets', () => {
  const ids = Array.from({ length: FLOOD_MAX + 2 }, (_, i) => `s${i}`);
  const first = decideNotifications({
    prev: snapshot(), next: snapshot(ids), windowFocused: false, settings: {}, now: 1,
  });
  assert.equal(first.summary.shownCount, 2);
  // One folded session leaves: the summary stays (it still stands for the other).
  const partial = decideNotifications({
    prev: snapshot(ids), next: snapshot(ids.slice(0, -1)), windowFocused: false, settings: {}, now: 2,
    summary: first.summary,
  });
  assert.equal(partial.clearSummary, false);
  // Everything leaves.
  const gone = decideNotifications({
    prev: snapshot(ids.slice(0, -1)), next: snapshot(), windowFocused: false, settings: {}, now: 3,
    summary: partial.summary,
  });
  assert.equal(gone.clearSummary, true);
  assert.deepEqual(gone.summary.ids, []);
});

test('the summary survives while only its non-folded sessions leave', () => {
  const ids = Array.from({ length: FLOOD_MAX + 2 }, (_, i) => `s${i}`);
  const first = decideNotifications({
    prev: snapshot(), next: snapshot(ids), windowFocused: false, settings: {}, now: 1,
  });
  const result = decideNotifications({
    prev: snapshot(ids), next: snapshot(ids.slice(FLOOD_MAX)), windowFocused: false, settings: {}, now: 2,
    summary: first.summary,
  });
  assert.equal(result.clearSummary, false);
  assert.deepEqual(result.summary.ids, ids.slice(FLOOD_MAX));
});

test('repeated overflow inside one window gives one summary, then the cumulative count', () => {
  const now = 1000;
  const ids = Array.from({ length: FLOOD_MAX + 1 }, (_, i) => `s${i}`);
  const first = decideNotifications({
    prev: snapshot(), next: snapshot(ids), windowFocused: false, settings: {}, now,
  });
  assert.equal(first.notifications.filter((n) => n.summary).length, 1);
  assert.match(first.notifications[FLOOD_MAX].body, /^1 more session /);
  const recent = Array.from({ length: FLOOD_MAX }, () => now);
  // Two more overflow inside the window: no second summary, the count is kept.
  const more = [...ids, 'x1', 'x2'];
  const second = decideNotifications({
    prev: snapshot(ids), next: snapshot(more), windowFocused: false, settings: {}, now: now + 2000,
    recent, summary: first.summary,
  });
  assert.equal(second.notifications.length, 0);
  assert.deepEqual(second.summary.ids, [ids[FLOOD_MAX], 'x1', 'x2']);
  assert.equal(second.summary.shownCount, 1);
  // The window has passed: the next sync shows the cumulative count once, with nothing new pending.
  const third = decideNotifications({
    prev: snapshot(more), next: snapshot(more), windowFocused: false, settings: {}, now: now + FLOOD_WINDOW_MS,
    summary: second.summary,
  });
  assert.equal(third.notifications.length, 1);
  assert.match(third.notifications[0].body, /^3 more sessions /);
  assert.equal(third.summary.shownCount, 3);
  // And not again.
  const fourth = decideNotifications({
    prev: snapshot(more), next: snapshot(more), windowFocused: false, settings: {}, now: now + FLOOD_WINDOW_MS + 1,
    summary: third.summary,
  });
  assert.equal(fourth.notifications.length, 0);
});

test('a summary shown in the same sync as its old sessions left is not cleared right after', () => {
  const ids = Array.from({ length: FLOOD_MAX + 1 }, (_, i) => `s${i}`);
  const first = decideNotifications({
    prev: snapshot(), next: snapshot(ids), windowFocused: false, settings: {}, now: 1,
  });
  assert.equal(first.summary.shownCount, 1);
  // Past the window, every old session leaves and a new burst overflows in the same sync.
  const fresh = Array.from({ length: FLOOD_MAX + 2 }, (_, i) => `n${i}`);
  const next = decideNotifications({
    prev: snapshot(ids), next: snapshot(fresh), windowFocused: false, settings: {}, now: 1 + FLOOD_WINDOW_MS,
    summary: first.summary,
  });
  assert.equal(next.notifications.filter((n) => n.summary).length, 1, 'a new summary is shown');
  assert.equal(next.clearSummary, false, 'and not cleared in the same breath');
});

test('turning notifications off clears what the old settings had announced', () => {
  const off = decideNotifications({
    prev: snapshot(['a'], ['r']), next: snapshot(['a'], ['r']), windowFocused: false,
    settings: { enabled: false, notifyOnReady: true },
    prevSettings: { enabled: true, notifyOnReady: true }, now: 1,
  });
  assert.deepEqual(off.cleared.sort(), ['a', 'r']);
  const readyOff = decideNotifications({
    prev: snapshot(['a'], ['r']), next: snapshot(['a'], ['r']), windowFocused: false,
    settings: { enabled: true, notifyOnReady: false },
    prevSettings: { enabled: true, notifyOnReady: true }, now: 1,
  });
  assert.deepEqual(readyOff.cleared, ['r']);
});

test('a fresh renderer asks main to clear everything once', () => {
  const fresh = decideNotifications({
    prev: snapshot(), next: snapshot(['a']), windowFocused: false, settings: {}, now: 1, fresh: true,
  });
  assert.equal(fresh.clearAll, true);
  const later = decideNotifications({
    prev: snapshot(), next: snapshot(['a']), windowFocused: false, settings: {}, now: 1,
  });
  assert.equal(later.clearAll, false);
});

test('a ready-only exit does not clear when notifyOnReady is off', () => {
  const result = decideNotifications({
    prev: snapshot([], ['s1']), next: snapshot(), windowFocused: false, settings: {}, now: 1,
  });
  assert.deepEqual(result.cleared, []);
  assert.equal(result.clearSummary, false);
});

test('no transition (session already in set) emits nothing', () => {
  const result = decideNotifications({
    prev: snapshot(['s1']),
    next: snapshot(['s1']),
    windowFocused: false,
    settings: { enabled: true, notifyOnReady: false },
    now: 10000,
  });

  assert.equal(result.notifications.length, 0);
  assert.equal(result.badgeCount, 1);
});

test('accepts array snapshots as well as Sets', () => {
  const result = decideNotifications({
    prev: { attention: [], ready: [] },
    next: { attention: ['s1'], ready: [] },
    windowFocused: false,
    settings: { enabled: true },
    now: 100000,
  });

  assert.equal(result.notifications.length, 1);
  assert.equal(result.badgeCount, 1);
});
