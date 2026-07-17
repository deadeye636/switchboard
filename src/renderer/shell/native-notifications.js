// --- Native notifications, the dock badge and the tray funnel (Spec 01) (#218, #228) ---
//
// The DOM/OS half of attention notifications: it feeds the renderer's live attention/ready state to the
// pure decideNotifications (shell/notification-policy.js — UMD, tested), then forwards the result to main
// over IPC as a native notification, a dock-badge count and a tray summary. It also tracks window focus
// (a focused window suppresses notifications) and handles the click on a native notification. Came out of
// app.js. Same pure/DOM division as the other shell/ cuts.
//
// A PLAIN CLASSIC SCRIPT that LOADS AFTER app.js — the same requirement search-bar.js has, for the same
// reason. Its parse-time side effects register listeners whose bodies reach app.js's live state
// (`sessionMap`, `attentionSessions`, `responseReadySessions`, `openSession`, `clearNotifications`,
// `getAllKnownSessionsForStatus`). Those resolve at call time, so loading after app.js means they are
// bound by the time any listener fires. The IPC listener is why this matters more than for a pure DOM
// cluster: `window.api.onFocusSession(...)` registers at parse time and main can deliver a focus-session
// the instant it is armed — loaded before app.js, an early delivery would run its handler into app.js
// bindings still in their TDZ. Loaded after, app.js is fully parsed first.
//
// It declares and owns all of its own state (notificationSettings, windowFocused, lastNotifiedAt,
// prevNotificationSnapshot) and writes none of app.js's — nothing here is a foreign `let` write, unlike
// search-bar.js. app.js reaches IN at two call-time points: syncNativeNotifications (from
// refreshSessionStatusViews) and window._setNotificationSettings (from the settings re-apply and boot),
// the latter a window property this file assigns at parse time.
//
// What it reaches into, by file:
//   app.js                          sessionMap, attentionSessions, responseReadySessions, openSession,
//                                   clearNotifications, getAllKnownSessionsForStatus
//   shell/notification-policy.js    decideNotifications (UMD → window property)

// --- Native notification + dock badge + tray funnel (Spec 01) ---
// Every attention/ready transition reaches refreshSessionStatusViews(), which
// calls syncNativeNotifications() below. The actual decision (what to notify,
// coalescing, throttle, badge count) lives in the pure, unit-tested
// notification-policy.js module — this just feeds it state and forwards results
// to the main process over IPC.
let notificationSettings = { enabled: true, notifyOnReady: false };
let windowFocused = typeof document !== 'undefined' ? document.hasFocus() : true;
let lastNotifiedAt = 0;
let prevNotificationSnapshot = { attention: new Set(), ready: new Set() };

// Bridge for settings-panel.js so toggles apply without a restart.
window._setNotificationSettings = (settings) => {
  notificationSettings = {
    enabled: settings?.enabled !== false,
    notifyOnReady: !!settings?.notifyOnReady,
  };
  syncNativeNotifications();
};

function buildTraySummary() {
  const attention = attentionSessions.size;
  const ready = responseReadySessions.size;
  const parts = [];
  if (attention) parts.push(`${attention} need${attention === 1 ? 's' : ''} you`);
  if (ready) parts.push(`${ready} ready`);
  return parts.length ? `Switchboard — ${parts.join(' · ')}` : 'Switchboard';
}

function syncNativeNotifications() {
  if (typeof decideNotifications !== 'function' || !window.api) return;
  const next = {
    attention: new Set(attentionSessions),
    ready: new Set(responseReadySessions),
  };
  const now = Date.now();
  const result = decideNotifications({
    prev: prevNotificationSnapshot,
    next,
    windowFocused,
    settings: notificationSettings,
    now,
    lastNotifiedAt,
  });

  for (const notification of result.notifications) {
    window.api.notify({
      title: notification.title,
      body: notification.body,
      sessionId: notification.sessionIds[0],
    });
  }
  if (result.notifications.length > 0) lastNotifiedAt = now;

  window.api.setBadge(result.badgeCount);
  window.api.setTraySummary(buildTraySummary());

  prevNotificationSnapshot = next;
}

function setWindowFocused(focused) {
  windowFocused = focused;
  // Regaining focus may have cleared attended sessions; recompute the badge and
  // reset the transition baseline so we don't re-notify on the next change.
  syncNativeNotifications();
}
window.addEventListener('focus', () => setWindowFocused(true));
window.addEventListener('blur', () => setWindowFocused(false));
document.addEventListener('visibilitychange', () => {
  setWindowFocused(!document.hidden && document.hasFocus());
});

// Clicking a native notification focuses the window and opens that session.
window.api.onFocusSession((sessionId) => {
  if (!sessionId) return;
  setWindowFocused(true);
  let session = sessionMap.get(sessionId);
  if (!session) {
    session = getAllKnownSessionsForStatus().find((s) => s.sessionId === sessionId);
  }
  if (session) openSession(session);
  clearNotifications(sessionId);
});
