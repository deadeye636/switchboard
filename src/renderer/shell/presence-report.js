// --- Presence: this window's input, reported to main (#386, #426, #673) ---
//
// `presence-returned` is main's one global answer to "the user was gone, from T, for D"
// (`src/app/presence.js`). This is the other half — REPORTING — and every window does it, which is why it
// is a file of its own: presence is about the MACHINE, and a window that owns no inbox is still somewhere
// the user can be. It lived in `away-overview-view.js` until #673, and so only the main and the detached
// windows reported; the settings, changes and diff windows are separate pages that never load that file,
// and review in one of them counted as time away.
//
// It is the FAST path, not the only one: since #673 main also polls the OS idle time, which covers input
// in every other application but notices a return only on its next poll. A keystroke here is announced
// at once.
//
// A PLAIN CLASSIC SCRIPT, self-contained in an IIFE: it is loaded by four pages with four different
// script lists (`index.html`, `settings.html`, `changed-files.html`, `diff-window.html`), so it reaches
// for nothing but the preload.
//
//   preload                  reportPresenceActivity
//
// #426 is why it stands beside the surface it feeds rather than inside it: the listeners lived in a
// banner that was deleted, nothing took them over, and the recap became unreachable from ordinary use
// while every check of it — each calling `reportPresenceActivity` itself — stayed green.
(function () {
  'use strict';

  // Throttled, because this fires on every keystroke and every pointer press while the answer only ever
  // changes by minutes. `send`, so nothing waits on it.
  const PRESENCE_REPORT_MS = 15_000;
  let lastPresenceReport = 0;
  function sendPresence() {
    try { window.api?.reportPresenceActivity?.(); } catch { /* an older main process */ }
  }
  function reportPresence() {
    const now = Date.now();
    if (now - lastPresenceReport < PRESENCE_REPORT_MS) return;
    lastPresenceReport = now;
    sendPresence();
  }

  // `keydown`, `pointerdown` and `wheel` are the user doing something; `focus` is the window coming back,
  // and it BYPASSES the throttle because that is the moment the answer changes — a return that lands
  // inside the window of the last report is the one report that must not be skipped. It does not use the
  // throttle up either (#673): a focus may carry no input at all (an unlock, a focus the app caused), and
  // main discards such a report against the OS idle time — so the first keystroke after it has to reach
  // main at once rather than wait out a throttle the focus started.
  //
  // `mousemove` is deliberately absent HERE: it fires while a hand rests on a desk that gets nudged, and a
  // window has no business inferring presence from that. The OS idle time main polls since #673 does not
  // make the distinction — any mouse movement resets it — so a nudged mouse does count as presence at the
  // machine level. Spec 03 records that as a known limit; this listener list is not where it is decided.
  for (const evt of ['keydown', 'pointerdown', 'wheel']) {
    window.addEventListener(evt, reportPresence, { capture: true, passive: true });
  }
  window.addEventListener('focus', sendPresence);
})();
