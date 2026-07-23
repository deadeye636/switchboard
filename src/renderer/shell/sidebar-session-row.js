// --- One session row in the sidebar, and the two editors that mutate it in place (#218) ---
//
// `buildSessionItem` is the row: the status dot, the name, the backend badge, the health chip, the meta
// line, and every action button on it. `startRename` is the inline title edit; `positionPopover` places
// a popover against a row and wires its click-away.
//
// Came out of sidebar.js, where the row builder sat 1700 lines below the render path that calls it.
//
// `positionPopover` is here for a reason worth writing down rather than tidying away: sidebar.js never
// called it. Its ONLY caller is bookmarks/bookmarks-tags.js, which loads after this file and reads the
// name as a bare identifier. It ended up in sidebar.js because that is where the first popover was, and
// it stayed a "sidebar function" that the sidebar does not use. It travels with the row for now because
// the row is what it positions against; if a third caller appears, it belongs in lib/.
//
// A classic <script>, like the file it came from: nothing runs at parse time, so tag order only has to
// put it before its callers' first CLICK — which is any position on the page. It sits next to sidebar.js
// because that is where a reader will look for it.
//
// What it reaches back into sidebar.js for: `getSessionRuntimeState`, and nothing else. Everything else
// it needs comes from app.js's maps (activePtyIds, attentionSessions, responseReadySessions,
// sessionBusyState, subagentActiveSessions, lastActivityTime), the UMD helpers (getSessionStatus,
// getSessionHealth, getQuietDetailParts, getWorktreeLabel, ariaButton), `ICONS`, and the backend
// registry — all at call time, from a render. (The row's click/keyboard activation is delegated to a
// single listener on sidebarContent in sidebar-events.js — #218 opt6 — so this only sets the ARIA state.)
//
// (This list said shortSessionLabel/getSessionProjectLabel/folderId until a verifier checked: none of
// the three is in this file. In a renderer whose only import graph IS these headers, a wrong one is not
// untidy, it is misinformation — the next reader has nothing else to go on.)

// opts.noLineageThread — do NOT append this row's own folded-ancestors thread. Set when a row is itself
// being rendered AS an ancestor inside another head's thread, so the flat chain does not recurse (#193).
// opts.ancestorCopy — this row is one of possibly SEVERAL views of the same session (lineage is a tree, so
// a shared ancestor renders under every head that walks through it). It therefore gets no `si-` id: a
// duplicate id is not a cosmetic problem, it is what morphdom keys its node matching on (#288).
function buildSessionItem(session, opts = {}) {
  const item = document.createElement('div');
  item.className = 'session-item';
  if (!opts.ancestorCopy) item.id = 'si-' + session.sessionId;
  if (session.type === 'terminal') item.classList.add('is-terminal');
  if (session.archived) item.classList.add('archived-item');
  if (activePtyIds.has(session.sessionId)) item.classList.add('has-running-pty');
  if (attentionSessions.has(session.sessionId)) item.classList.add('needs-attention');
  if (responseReadySessions.has(session.sessionId)) item.classList.add('response-ready');
  if (sessionBusyState.get(session.sessionId)) item.classList.add('cli-busy');
  // Subagent-activity overlay (#112): two-color dot while a subagent works here.
  if (subagentActiveSessions.has(session.sessionId)) item.classList.add('subagent-active');
  item.dataset.sessionId = session.sessionId;

  const modified = lastActivityTime.get(session.sessionId) || new Date(session.modified);
  const timeStr = formatDate(modified);
  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary);
  const status = getSessionStatus(session, getSessionRuntimeState());
  const health = getSessionHealth(session);
  item.classList.add(status.className);
  item.classList.add(health.className);

  const row = document.createElement('div');
  row.className = 'session-row';

  // Pin
  const pin = document.createElement('span');
  pin.className = 'session-pin' + (session.starred ? ' pinned' : '');
  pin.title = session.starred ? 'Unpin session' : 'Pin session';
  pin.setAttribute('aria-label', pin.title);
  ariaButton(pin, pin.title); // role/tabindex; the click comes from the delegated sidebar listener (#218 opt6)
  pin.innerHTML = session.starred
    ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37 .722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37 .722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>';

  // Status dot — driven by the same helper the chip is, so the two never disagree (#254). It used to be
  // toggled by activePtyIds directly and coloured by CSS cascading over item-level classes, a second
  // computation that could contradict the chip. Now it carries status.className and the CSS keys on that.
  const dot = document.createElement('span');
  // `status-dot` is the shared marker every view's dot carries (#269): the spinner/ripple/glow motion
  // is defined once against `.status-dot.status-*` and the sidebar, grid and tab dots all get it.
  dot.className = 'session-status-dot status-dot ' + status.className;

  const indicators = document.createElement('div');
  indicators.className = 'session-indicators';
  indicators.appendChild(pin);
  indicators.appendChild(dot);

  // Provider badge (T-3.4). Deliberately OFF for a single-backend user: badging every row when they all
  // came from the same CLI would be pure noise. It appears in "mixed mode" — ≥2 backends are in play
  // (computeShowAllBadges) — and on any individual row that is not the default, so a session can never be
  // mistaken for one of the default backend's. That second half needs a KNOWN default; see below.
  if (session.type !== 'terminal' && window.sessionBackendId) {
    const backendId = window.sessionBackendId(session);
    // The badge means "this row is NOT the one you would assume". That claim needs a default to compare
    // against, and `_defaultBackendId` is '' until the registry answers — and stays '' when nothing is
    // launchable at all (#225). With no default there is no assumption to correct, so the claim is not
    // made and `_showAllBadges` decides alone (it has its own registry-less fallback: what the sessions
    // themselves say). Writing `|| 'claude'` here, as this did, asserted the assumption instead of
    // checking it — on an install where Claude is switched off, every row was measured against a backend
    // the user does not run.
    const knownDefault = window._defaultBackendId;
    const isNonDefault = !!knownDefault && backendId !== knownDefault;
    if (window._showAllBadges || isNonDefault) {
      const descriptor = window.getBackend ? window.getBackend(backendId) : null;
      const badge = document.createElement('span');
      badge.className = 'session-backend-badge backend-' + backendId;
      badge.textContent = (descriptor && descriptor.monogram)
        || (window.backendMonogram ? window.backendMonogram(backendId) : backendId.slice(0, 2));
      badge.title = descriptor ? descriptor.label : backendId;
      if (window.backendIconColour) badge.style.background = window.backendIconColour(descriptor?.icon || backendId);
      indicators.appendChild(badge);
    }
  }

  // Info block
  const info = document.createElement('div');
  info.className = 'session-info';

  const summaryEl = document.createElement('div');
  summaryEl.className = 'session-summary';
  summaryEl.textContent = displayName;

  const detailEl = document.createElement('div');
  detailEl.className = 'session-card-details';

  const statusChip = document.createElement('span');
  statusChip.className = `session-detail-pill session-status-chip ${status.className}`;
  statusChip.textContent = status.label;
  detailEl.appendChild(statusChip);
  if (health.state !== 'healthy') {
    const healthChip = document.createElement('button');
    healthChip.type = 'button';
    healthChip.className = `session-detail-pill session-health-chip ${health.className}`;
    healthChip.textContent = health.label;
    healthChip.title = 'Create handoff';
    healthChip.setAttribute('aria-label', `Create handoff for ${displayName}`);
    detailEl.appendChild(healthChip);
  }
  // Open-task badge — count of open/in-progress tasks anchored to this session.
  const openTaskCount = (window.tasksView && typeof window.tasksView.openTaskCount === 'function')
    ? window.tasksView.openTaskCount(session.sessionId) : 0;
  if (openTaskCount > 0) {
    const taskChip = document.createElement('button');
    taskChip.type = 'button';
    taskChip.className = 'session-detail-pill session-task-chip';
    taskChip.textContent = `${openTaskCount} ${openTaskCount === 1 ? 'Task' : 'Tasks'}`;
    taskChip.title = 'Open tasks for this session';
    taskChip.setAttribute('aria-label', `${openTaskCount} open tasks for ${displayName || session.sessionId}`);
    taskChip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof openTasksView === 'function') {
        openTasksView({ sessionId: session.sessionId }, 'Session · ' + (displayName || session.sessionId));
      }
    });
    detailEl.appendChild(taskChip);
  }

  const quietParts = getQuietDetailParts({
    timeLabel: timeStr,
    session,
    includeMetrics: health.state !== 'healthy',
  });
  const worktreeLabel = getWorktreeLabel(session);
  if (worktreeLabel) quietParts.push(worktreeLabel);
  if (typeof getSessionFilePanelSummary === 'function') {
    const fileSummary = getSessionFilePanelSummary(session.sessionId);
    if (fileSummary?.label) {
      quietParts.push(`${fileSummary.type === 'diff' ? 'Diff' : 'File'} ${fileSummary.label}`);
    }
  }
  if (quietParts.length > 0) {
    const quietLine = document.createElement('div');
    quietLine.className = 'session-quiet-details';
    quietLine.textContent = quietParts.join(' · ');
    detailEl.appendChild(quietLine);
  }


  if (session.type === 'terminal') {
    const badge = document.createElement('span');
    badge.className = 'terminal-badge';
    badge.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>';
    summaryEl.prepend(badge);
  }
  info.appendChild(summaryEl);
  if (detailEl.children.length > 0) info.appendChild(detailEl);

  // Action buttons container
  const actions = document.createElement('div');
  actions.className = 'session-actions';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'session-stop-btn';
  stopBtn.title = 'Stop session';
  stopBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>';

  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'session-archive-btn';
  archiveBtn.title = session.archived ? 'Unarchive' : 'Archive';
  archiveBtn.innerHTML = ICONS.archive(16);

  const forkBtn = document.createElement('button');
  forkBtn.className = 'session-fork-btn';
  forkBtn.title = 'Fork session';
  forkBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M8 3h-5v5"/><path d="M21 3l-7.536 7.536a5 5 0 0 0-1.464 3.534v6.93"/><path d="M3 3l7.536 7.536a5 5 0 0 1 1.464 3.534v.93"/></svg>';

  const jsonlBtn = document.createElement('button');
  jsonlBtn.className = 'session-jsonl-btn';
  jsonlBtn.title = 'View messages';
  jsonlBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>';

  const copyIdBtn = document.createElement('button');
  copyIdBtn.className = 'session-copy-id-btn';
  copyIdBtn.title = 'Copy session ID';
  copyIdBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

  const tagsBtn = document.createElement('button');
  tagsBtn.className = 'session-tags-btn';
  tagsBtn.title = 'Edit tags';
  tagsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.2" fill="currentColor" stroke="none"/></svg>';

  const timelineBtn = document.createElement('button');
  timelineBtn.className = 'session-timeline-btn';
  timelineBtn.title = 'View timeline';
  timelineBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6v6l4 2"/><circle cx="12" cy="12" r="9"/></svg>';

  const launchConfigBtn = document.createElement('button');
  launchConfigBtn.className = 'session-launch-config-btn';
  launchConfigBtn.title = 'Resume with config';
  launchConfigBtn.innerHTML = ICONS.launchConfig(14);

  const handoffBtn = document.createElement('button');
  handoffBtn.className = 'session-handoff-btn';
  handoffBtn.title = 'Create handoff';
  handoffBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7h8"/><path d="M8 11h8"/><path d="M8 15h5"/><path d="M5 3h14a2 2 0 0 1 2 2v14l-4-3H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/></svg>';

  actions.appendChild(stopBtn);
  actions.appendChild(copyIdBtn);
  // Tags hang on the sessionId, which a terminal row has too — so this sits with the other
  // labelling actions, above the guard, not with the ones that open a transcript.
  actions.appendChild(tagsBtn);
  if (session.type !== 'terminal') {
    // Always offered. It used to appear only once the session was judged unhealthy, which meant you
    // discovered the feature the day the app started nagging you — and could not reach it at the moment
    // it is worth most: deliberately handing over at a clean breakpoint, before a session gets expensive.
    // The RECOMMENDATION still shows, as emphasis on the button (and in the health chip beside it); the
    // button's existence was never the signal.
    if (health.state !== 'healthy') handoffBtn.classList.add('recommended');
    handoffBtn.title = health.state !== 'healthy'
      ? `Create handoff — ${health.label}`
      : 'Create handoff';
    actions.appendChild(handoffBtn);

    // Only offer Fork where the backend can actually do it. Offering it anyway does NOT degrade into
    // "nothing happens" — it launches a fresh, empty session that has no relation to the one the user
    // forked, which is worse than not offering it at all.
    // `getBackend` and `sessionBackendId` live in the same file, so the second guard only fires if the
    // registry is missing — and then `getBackend` is gone too and this is already null. Naming Claude
    // there decided Fork's visibility from a backend the session may not be (#225).
    const sessionBackend = typeof getBackend === 'function'
      ? getBackend(typeof sessionBackendId === 'function' ? sessionBackendId(session) : '')
      : null;
    // A profile runs the claude binary, so it forks like Claude. An unknown backend (a row from a
    // backend that is no longer registered) is assumed not to fork.
    const canFork = sessionBackend
      ? (sessionBackend.isProfile ? true : sessionBackend.supportsFork === true)
      : false;
    if (canFork) actions.appendChild(forkBtn);
    actions.appendChild(timelineBtn);
    actions.appendChild(jsonlBtn);
    // "Resume with config" sits next to the other session-starting actions; Archive is the odd one out
    // (it removes the row), so it goes last, away from the buttons that launch something.
    actions.appendChild(launchConfigBtn);
    actions.appendChild(archiveBtn);
  }

  row.appendChild(indicators);
  row.appendChild(info);
  row.appendChild(actions);
  item.appendChild(row);

  // The collapsed thread of idle ancestors this session folded (#193 — Model A: they fold under the head,
  // not as separate rows). Suppressed when this row is itself an ancestor inside another thread (no recursion).
  if (!opts.noLineageThread && typeof buildLineageThread === 'function') {
    const thread = buildLineageThread(session);
    if (thread) item.appendChild(thread);
  }

  // Tag chips (renders synchronously from the bookmarks-tags cache).
  window._decorateSessionItem?.(item, session);

  // Button semantics for the row (#218 opt6): the click/keyboard activation comes from the delegated
  // listener on sidebarContent, so only the ARIA state is set here, at build time, where morphdom keeps
  // it. A row under a missing project is neutralised by the slim rebind pass (it must not open).
  ariaButton(item, 'Open ' + (displayName || session.sessionId));

  return item;
}

function positionPopover(popover, anchorEl) {
  document.body.appendChild(popover);
  const rect = anchorEl.getBoundingClientRect();
  const popoverHeight = popover.offsetHeight;
  if (rect.bottom + 4 + popoverHeight > window.innerHeight) {
    popover.style.top = (rect.top - popoverHeight - 4) + 'px';
  } else {
    popover.style.top = (rect.bottom + 4) + 'px';
  }
  popover.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - popover.offsetWidth - 8)) + 'px';

  function onClickOutside(e) {
    if (!popover.contains(e.target) && e.target !== anchorEl) {
      popover.remove();
      document.removeEventListener('mousedown', onClickOutside);
    }
  }
  setTimeout(() => document.addEventListener('mousedown', onClickOutside), 0);
}

function startRename(summaryEl, session) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = session.name || session.aiTitle || session.summary;

  summaryEl.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newName = input.value.trim();
    const fallback = session.aiTitle || session.summary;
    const nameToSave = (newName && newName !== fallback) ? newName : null;
    await window.api.renameSession(session.sessionId, nameToSave);
    session.name = nameToSave;

    const newSummary = document.createElement('div');
    newSummary.className = 'session-summary';
    newSummary.textContent = nameToSave || fallback;
    // No per-node dblclick — the delegated listener on sidebarContent re-triggers rename (#218 opt6).
    input.replaceWith(newSummary);
  };

  input.addEventListener('blur', save);
  // Stop key events from bubbling to sidebarContent's delegated keyboard handler (the row is a
  // role="button" ancestor) / global shortcuts — otherwise Space (which activates a button-like element
  // on keyUP) ends the rename instead of inserting a space (issue #94).
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.removeEventListener('blur', save);
      const restored = document.createElement('div');
      restored.className = 'session-summary';
      restored.textContent = session.name || session.aiTitle || session.summary;
      // No per-node dblclick — the delegated listener re-triggers rename (#218 opt6).
      input.replaceWith(restored);
    }
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
}
