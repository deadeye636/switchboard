// --- "While you were away": the recap banner (#218) ---
//
// The DOM half of the away summary. The PURE half is shell/away-summary.js — buildAwaySummary and the
// shaping of what to say — which is UMD, so it is require()-able and tested. This mounts the banner over
// the live terminal, tracks which files an agent touched, and takes the banner down again. Came out of
// app.js. Same division as update-restart.js/session-restore.js and usage-status.js/statusbar-usage.js.
//
// A PLAIN CLASSIC SCRIPT — no IIFE, no UMD factory — because everything it reaches for is a top-level
// declaration of another classic script and therefore resolves at CALL time through the shared global
// lexical scope. That is what makes this a move rather than a rewrite. What it reaches into, by file,
// because the header is the only import graph this renderer has:
//
//   app.js                  openSessions, activeSessionId, sessionMap, terminalArea (DOM handles),
//                           and it is app.js that CALLS in: recordFileTouched from the MCP bridge
//                           listeners, handleSessionViewed when a session takes focus
//   shell/away-summary.js   buildAwaySummary (UMD → window property)
//   lib/utils.js            escapeHtml, formatDate
//
// IT OWNS ITS OWN STATE and that state stays here: awaySummaryEl, awaySummarySessionId and
// awaySummaryInputDisposable are read and written by nothing else — which is why they moved with it while
// app.js's session maps did not. Counting readers is how that call is made, not taste.
//
// THE TWO ENTRY POINTS app.js still calls are `recordFileTouched` (from the open-diff / open-file IPC
// listeners) and `handleSessionViewed` (from the focus path). Both are called at run time from inside
// listeners, so the load order cannot break them.

// --- "While you were away" summary ---------------------------------------
//
// Tracks files an agent touched (via the MCP open-diff/open-file bridge) and,
// when you refocus a session that changed while you were elsewhere, surfaces a
// compact, dismissible recap above the live terminal. The terminal is never
// hidden or unmounted.

let awaySummaryEl = null;
let awaySummarySessionId = null;
let awaySummaryInputDisposable = null;

// The files an agent touched, and when the user last looked, live in the RECORD now (#396) — they had
// exactly the lifetime bug the timeline had, in the same surface: a reload emptied them, so the recap
// lost the files half of what it was built to report and could no longer tell a first look from a
// return. Both are noted through main, which writes them, so every window sees the same answer.
//
// `file-touched` carries the path in `detail` and the kind ('diff' / 'open') in `label`. That is enough
// to rebuild what the pure recap builder takes, and it needs no table of its own.

function recordFileTouched(sessionId, path, kind) {
  if (!sessionId || !path) return;
  window.api.noteTimelineEvent(sessionId, 'file-touched', kind || 'open', path);
}

/** Rebuild the recap's `filesTouched` from the record: newest first, deduped by path in the builder. */
function awaySummaryFilesFor(sessionId) {
  return getTimelineEvents(sessionTimelineStore, sessionId)
    .filter((event) => event && event.kind === 'file-touched' && event.detail)
    .map((event) => ({ path: event.detail, at: event.at, kind: event.label || 'open' }));
}

/** When the user last looked at this session, or null if they never have. */
function lastViewedAtFor(sessionId) {
  const seen = getTimelineEvents(sessionTimelineStore, sessionId)
    .find((event) => event && event.kind === 'viewed');
  return seen ? seen.at : null;
}

// Called at the focus choke point. Renders the recap for sessions that changed
// while unfocused, then records the new "last viewed" timestamp.
/**
 * Is the recap switched on (#384)? Default ON — only an explicit `false` turns it off, the same shape
 * every other opt-out setting in this renderer uses.
 *
 * Read at call time rather than cached: the settings window applies live, and a cached copy would keep
 * showing the banner until the next reload.
 */
function awaySummaryEnabled() {
  return !(typeof appGlobalSettings !== 'undefined' && appGlobalSettings.awaySummary === false);
}

// --- Presence (#386) ---------------------------------------------------------
//
// The recap answers "what happened while I was GONE", and it used to be triggered by a focus change on
// one session — so it fired while you sat there switching sessions, and stayed silent when you walked
// away from a window that stayed in front. Whether you were away is a fact about the machine, not
// about a window, so main owns it (`app/presence.js`) and tells every window when an absence ended.
//
// `awaySince` is the point events are listed from: everything before it happened while you were here,
// and the attention inbox is the surface for that. Sessions already shown for THIS absence are
// remembered, so returning and opening four sessions gives four recaps, and opening one of them again
// an hour later gives none.
let currentAbsence = null;
const absenceShownFor = new Set();

// Every sign of life, throttled — this fires on every keystroke and every pointer move, and the answer
// only ever changes by minutes. `send`, so nothing waits on it.
const PRESENCE_REPORT_MS = 15_000;
let lastPresenceReport = 0;
function reportPresence() {
  const now = Date.now();
  if (now - lastPresenceReport < PRESENCE_REPORT_MS) return;
  lastPresenceReport = now;
  try { window.api.reportPresenceActivity?.(); } catch { /* older main process */ }
}
// `keydown` and `pointerdown` are the user; `focus` is the window coming back. `mousemove` is
// deliberately NOT in the list: it fires while a hand rests on a desk that gets nudged, which is
// exactly the presence this must not infer.
for (const evt of ['keydown', 'pointerdown', 'wheel']) {
  window.addEventListener(evt, reportPresence, { capture: true, passive: true });
}
window.addEventListener('focus', () => { lastPresenceReport = 0; reportPresence(); });

window.api.onPresenceReturned?.((absence) => {
  if (!absence || !Number.isFinite(absence.awaySince)) return;
  currentAbsence = absence;
  absenceShownFor.clear(); // a new absence — every session may say what it missed
});

// ASYNC since #396: the history lives in the main process, and this window may not have fetched this
// session's yet. Callers do not await it — a recap is allowed to appear a frame late — but the read
// below must not run before the answer is in, or a session whose history simply had not arrived yet
// reads as "nothing happened while you were away", which is the one thing this must never say wrongly.
async function handleSessionViewed(sessionId) {
  if (!sessionId) return;
  // Still STAMPED when the recap is off, so switching it back on does not report an "away" that
  // stretches to whenever it was turned off.
  if (!awaySummaryEnabled()) {
    // Still STAMPED when the recap is off, so switching it back on does not report an "away" that
    // stretches to whenever it was turned off.
    window.api.noteTimelineEvent(sessionId, 'viewed', 'Viewed', '');
    if (awaySummarySessionId) hideAwaySummary();
    return;
  }
  await ensureTimelineLoaded(sessionId);
  // An ABSENCE is the trigger, not a focus change (#386) — and each session says what it missed once
  // per absence. A previous LOOK still gates the very first one: nothing was missed before you had
  // ever seen the session.
  const previous = lastViewedAtFor(sessionId);
  const away = (currentAbsence && previous && !absenceShownFor.has(sessionId)) ? currentAbsence : null;
  let summary = null;
  if (away && !gridViewActive && typeof buildAwaySummary === 'function') {
    absenceShownFor.add(sessionId);
    summary = buildAwaySummary({
      events: getTimelineEvents(sessionTimelineStore, sessionId),
      filesTouched: awaySummaryFilesFor(sessionId),
      // Where the absence started, not where you last looked: everything in between happened while
      // you were here, and the inbox carried it.
      lastViewedAt: away.awaySince,
      now: new Date(),
    });
  }
  // Read BEFORE this is written, or the look being recorded now would be the one that gates it.
  window.api.noteTimelineEvent(sessionId, 'viewed', 'Viewed', '');

  if (summary && summary.hasChanges) {
    renderAwaySummary(sessionId, summary);
  } else if (awaySummarySessionId) {
    // Focused something with nothing new — clear any stale banner.
    hideAwaySummary();
  }
}

function ensureAwaySummaryEl() {
  if (awaySummaryEl) return awaySummaryEl;
  awaySummaryEl = document.createElement('div');
  awaySummaryEl.id = 'away-summary';
  awaySummaryEl.hidden = true;
  const anchor = document.getElementById('grid-viewer') || document.getElementById('terminals');
  if (anchor && anchor.parentNode === terminalArea) {
    terminalArea.insertBefore(awaySummaryEl, anchor);
  } else {
    terminalArea.appendChild(awaySummaryEl);
  }
  return awaySummaryEl;
}

function hideAwaySummary() {
  if (awaySummaryInputDisposable) {
    try { awaySummaryInputDisposable.dispose(); } catch { /* noop */ }
    awaySummaryInputDisposable = null;
  }
  if (awaySummaryEl) {
    awaySummaryEl.hidden = true;
    awaySummaryEl.innerHTML = '';
    delete awaySummaryEl.dataset.sessionId;
  }
  awaySummarySessionId = null;
}

// Dismissing hides the banner and nothing else. It used to also clear that session's file tally, which
// was the only way to stop the next recap repeating the same files — the record answers that by time
// now (everything since the absence began), so there is nothing to reset and nothing to lose.
function dismissAwaySummary() {
  hideAwaySummary();
}

function awaySummaryBasename(path) {
  if (!path) return '';
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || String(path);
}

function renderAwaySummary(sessionId, summary) {
  const el = ensureAwaySummaryEl();
  el.dataset.sessionId = sessionId;
  const reduceMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.classList.toggle('no-motion', !!reduceMotion);

  const eventsHtml = summary.events.map(event => `
    <li class="away-summary-event away-kind-${escapeHtml(event.kind)}">
      <span class="away-summary-event-time">${escapeHtml(event.time)}</span>
      <span class="away-summary-event-label">${escapeHtml(event.label)}</span>
      ${event.detail ? `<span class="away-summary-event-detail">${escapeHtml(event.detail)}</span>` : ''}
    </li>`).join('');

  const moreHtml = summary.extraEventCount
    ? `<li class="away-summary-more">+${summary.extraEventCount} earlier event${summary.extraEventCount === 1 ? '' : 's'}</li>`
    : '';

  const filesHtml = summary.files.length
    ? `<div class="away-summary-files">
        <span class="away-summary-files-label">Files touched</span>
        ${summary.files.map(file => `<span class="away-summary-file" data-kind="${escapeHtml(file.kind)}" title="${escapeHtml(file.path)}">${escapeHtml(awaySummaryBasename(file.path))}</span>`).join('')}
      </div>`
    : '';

  el.innerHTML = `
    <div class="away-summary-head">
      <span class="away-summary-title">While you were away</span>
      ${summary.sinceText ? `<span class="away-summary-since">${escapeHtml(summary.sinceText)}</span>` : ''}
      ${summary.waitingOnYou ? '<span class="away-summary-waiting">Waiting on you</span>' : ''}
      <button class="away-summary-close" type="button" aria-label="Dismiss summary" title="Dismiss">&times;</button>
    </div>
    ${eventsHtml || moreHtml ? `<ul class="away-summary-events">${eventsHtml}${moreHtml}</ul>` : ''}
    ${filesHtml}
    <div class="away-summary-actions">
      <button class="away-summary-timeline-link" type="button">View full timeline</button>
    </div>
  `;
  el.hidden = false;

  const closeBtn = el.querySelector('.away-summary-close');
  if (closeBtn) closeBtn.addEventListener('click', () => dismissAwaySummary(sessionId));
  const timelineLink = el.querySelector('.away-summary-timeline-link');
  if (timelineLink) {
    timelineLink.addEventListener('click', () => {
      const session = sessionMap.get(sessionId)
        || (openSessions.get(sessionId) && openSessions.get(sessionId).session);
      if (session && typeof showTimelineViewer === 'function') {
        showTimelineViewer(session);
      } else if (typeof renderTimelineViewer === 'function') {
        renderTimelineViewer(sessionId);
      }
    });
  }

  // Auto-dismiss as soon as the user types into this terminal — and ONLY then (#384). `onData` is
  // everything bound for the PTY, the terminal's own answers included, so this used to fire on the
  // focus report that revealing a session necessarily produces: the recap was rendered and dismissed
  // in the same beat, which is why it was almost never seen. `isUserInput` is the filter, and it lives
  // in the pure half so it can be tested against the shapes rather than clicked at.
  const entry = openSessions.get(sessionId);
  if (entry && entry.terminal && typeof entry.terminal.onData === 'function') {
    awaySummaryInputDisposable = entry.terminal.onData((data) => {
      if (typeof isUserInput === 'function' && !isUserInput(data)) return;
      dismissAwaySummary(sessionId);
    });
  }
  awaySummarySessionId = sessionId;
}
