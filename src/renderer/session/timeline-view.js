// --- Session timeline viewer (#302, split from app.js) ---
//
// The full-screen timeline overlay for one session: the event list, its kind-filter dropdown, and the
// show/render entry points. A self-contained viewer like jsonl-viewer.js / stats-view.js.
//
// It only READS app.js state, never writes it (the #218 shadowing trap), so it stays a plain classic
// script (no UMD wrapper) and its top-level function names live in the shared global lexical scope, exactly
// as they did inside app.js. It MUST load AFTER app.js: the two filter listeners at the bottom run at PARSE
// time and read app.js's DOM consts. The three functions are reached only at call time, so their callers'
// load order does not matter.
//
// Free globals it reaches for:
//   app.js state/DOM: sessionMap, sessionTimelineStore, placeholder, terminalArea, and the DOM consts
//     timelineViewer, timelineViewerTitle, timelineViewerSessionId, timelineViewerBody,
//     timelineSearchInput, timelineKindFilter
//   session/session-timeline.js: getTimelineEvents, filterTimelineEvents, formatTimelineEvent, getTimelineKinds
//   lib/utils.js: escapeHtml, cleanDisplayName
//   views/plans-memory-view.js: hidePlanViewer
//
// Callers (all at call time): app.js (recordTimelineEvent), shell/away-summary-banner.js,
// shell/sidebar-events.js.

function renderTimelineViewer(sessionId) {
  const session = sessionMap.get(sessionId);
  const events = getTimelineEvents(sessionTimelineStore, sessionId);
  const filteredEvents = filterTimelineEvents(events, {
    query: timelineSearchInput?.value || '',
    kind: timelineKindFilter?.value || 'all',
  });
  const displayName = cleanDisplayName(session?.name || session?.aiTitle || session?.summary) || sessionId;

  timelineViewer.dataset.sessionId = sessionId;
  timelineViewerTitle.textContent = displayName;
  timelineViewerSessionId.textContent = sessionId;
  timelineViewerBody.innerHTML = '';
  renderTimelineFilters(events);

  if (events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'timeline-empty';
    empty.textContent = 'No timeline events yet. Switchboard will record session starts, attention requests, ready states, exits, stops, and forks from this point forward.';
    timelineViewerBody.appendChild(empty);
    return;
  }

  if (filteredEvents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'timeline-empty';
    empty.textContent = 'No timeline events match the current filter.';
    timelineViewerBody.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'timeline-list';
  for (const event of filteredEvents) {
    const formatted = formatTimelineEvent(event);
    const row = document.createElement('div');
    row.className = `timeline-event timeline-event-kind-${formatted.kind}`;
    row.innerHTML = `
      <div class="timeline-event-header">
        <span class="timeline-event-time">${escapeHtml(formatted.time)}</span>
        <span class="timeline-event-label">${escapeHtml(formatted.label)}</span>
      </div>
      ${formatted.detail ? `<div class="timeline-event-detail">${escapeHtml(formatted.detail)}</div>` : ''}
    `;
    list.appendChild(row);
  }
  timelineViewerBody.appendChild(list);
}

function renderTimelineFilters(events) {
  if (!timelineKindFilter) return;
  const current = timelineKindFilter.value || 'all';
  const labels = {
    started: 'Started',
    busy: 'Working',
    idle: 'Idle',
    'needs-attention': 'Needs attention',
    'response-ready': 'Ready',
    exited: 'Exited',
    stopped: 'Stopped',
    forked: 'Forked',
  };
  timelineKindFilter.innerHTML = '<option value="all">All events</option>';
  for (const kind of getTimelineKinds(events)) {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = labels[kind] || kind;
    timelineKindFilter.appendChild(option);
  }
  timelineKindFilter.value = [...timelineKindFilter.options].some(option => option.value === current) ? current : 'all';
}

function showTimelineViewer(session) {
  hidePlanViewer();
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  timelineViewer.style.display = 'flex';
  if (timelineSearchInput) timelineSearchInput.value = '';
  if (timelineKindFilter) timelineKindFilter.value = 'all';
  renderTimelineViewer(session.sessionId);
}

if (timelineSearchInput) {
  timelineSearchInput.addEventListener('input', () => {
    const sessionId = timelineViewer.dataset.sessionId;
    if (sessionId) renderTimelineViewer(sessionId);
  });
}

if (timelineKindFilter) {
  timelineKindFilter.addEventListener('change', () => {
    const sessionId = timelineViewer.dataset.sessionId;
    if (sessionId) renderTimelineViewer(sessionId);
  });
}
