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

function recordFileTouched(sessionId, path, kind) {
  if (!sessionId || !path) return;
  let map = filesTouchedSinceViewed.get(sessionId);
  if (!map) {
    map = new Map();
    filesTouchedSinceViewed.set(sessionId, map);
  }
  map.set(path, { at: new Date().toISOString(), kind });
}

function awaySummaryFilesFor(sessionId) {
  const map = filesTouchedSinceViewed.get(sessionId);
  if (!map) return [];
  return [...map.entries()].map(([path, meta]) => ({ path, at: meta.at, kind: meta.kind }));
}

// Called at the focus choke point. Renders the recap for sessions that changed
// while unfocused, then records the new "last viewed" timestamp.
function handleSessionViewed(sessionId) {
  if (!sessionId) return;
  const previous = lastViewedTime.get(sessionId);
  let summary = null;
  if (previous && !gridViewActive && typeof buildAwaySummary === 'function') {
    summary = buildAwaySummary({
      events: getTimelineEvents(sessionTimelineStore, sessionId),
      filesTouched: awaySummaryFilesFor(sessionId),
      lastViewedAt: previous,
      now: new Date(),
    });
  }
  lastViewedTime.set(sessionId, new Date());

  if (summary && summary.hasChanges) {
    renderAwaySummary(sessionId, summary);
    // Recap is now showing the snapshot — reset the per-session file tally.
    filesTouchedSinceViewed.delete(sessionId);
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

function dismissAwaySummary(sessionId) {
  if (sessionId) filesTouchedSinceViewed.delete(sessionId);
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

  // Auto-dismiss as soon as the user types into this terminal.
  const entry = openSessions.get(sessionId);
  if (entry && entry.terminal && typeof entry.terminal.onData === 'function') {
    awaySummaryInputDisposable = entry.terminal.onData(() => dismissAwaySummary(sessionId));
  }
  awaySummarySessionId = sessionId;
}
