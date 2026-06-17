const test = require('node:test');
const assert = require('node:assert/strict');

const { decideNotifications, COALESCE_WINDOW_MS } = require('../public/notification-policy');

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
    lastNotifiedAt: 0,
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
    lastNotifiedAt: 0,
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
    lastNotifiedAt: 0,
  });

  assert.equal(result.notifications.length, 0);
  assert.equal(result.badgeCount, 0);
});

test('two sessions ready at once coalesce into one notification when notifyOnReady on', () => {
  const result = decideNotifications({
    prev: snapshot(),
    next: snapshot([], ['s1', 's2']),
    windowFocused: false,
    settings: { enabled: true, notifyOnReady: true },
    now: 5000,
    lastNotifiedAt: 0,
  });

  assert.equal(result.notifications.length, 1);
  assert.equal(result.notifications[0].kind, 'ready');
  assert.equal(result.notifications[0].sessionIds.length, 2);
  assert.match(result.notifications[0].body, /2 sessions/);
  assert.equal(result.badgeCount, 2);
});

test('ready transitions emit nothing and are excluded from badge when notifyOnReady off', () => {
  const result = decideNotifications({
    prev: snapshot(['a']),
    next: snapshot(['a'], ['s1', 's2']),
    windowFocused: false,
    settings: { enabled: true, notifyOnReady: false },
    now: 5000,
    lastNotifiedAt: 0,
  });

  assert.equal(result.notifications.length, 0);
  // Only the unchanged attention session contributes to the badge.
  assert.equal(result.badgeCount, 1);
});

test('throttle window suppresses a second emit inside COALESCE_WINDOW_MS', () => {
  const lastNotifiedAt = 1000;
  const result = decideNotifications({
    prev: snapshot(['s1']),
    next: snapshot(['s1', 's2']),
    windowFocused: false,
    settings: { enabled: true, notifyOnReady: false },
    now: lastNotifiedAt + COALESCE_WINDOW_MS - 1,
    lastNotifiedAt,
  });

  assert.equal(result.notifications.length, 0);
  // Badge still reflects both sessions even though the notification is throttled.
  assert.equal(result.badgeCount, 2);
});

test('emit allowed once the throttle window has fully elapsed', () => {
  const lastNotifiedAt = 1000;
  const result = decideNotifications({
    prev: snapshot(['s1']),
    next: snapshot(['s1', 's2']),
    windowFocused: false,
    settings: { enabled: true, notifyOnReady: false },
    now: lastNotifiedAt + COALESCE_WINDOW_MS,
    lastNotifiedAt,
  });

  assert.equal(result.notifications.length, 1);
  assert.deepEqual(result.notifications[0].sessionIds, ['s2']);
});

test('no transition (session already in set) emits nothing', () => {
  const result = decideNotifications({
    prev: snapshot(['s1']),
    next: snapshot(['s1']),
    windowFocused: false,
    settings: { enabled: true, notifyOnReady: false },
    now: 10000,
    lastNotifiedAt: 0,
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
    lastNotifiedAt: 0,
  });

  assert.equal(result.notifications.length, 1);
  assert.equal(result.badgeCount, 1);
});
