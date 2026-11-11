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

test('the summary is cleared once nothing is announced any more', () => {
  const result = decideNotifications({
    prev: snapshot(['s1']), next: snapshot(), windowFocused: false, settings: {}, now: 1,
  });
  assert.deepEqual(result.cleared, ['s1']);
  assert.equal(result.clearSummary, true);
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
