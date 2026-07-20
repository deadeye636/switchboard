// --- The bar above the grid: status filter chips + bulk actions (#218) ---
//
// Everything between the toolbar and the cards: the chips that filter by status, and the three buttons
// that act on whatever the chips admit — Step (focus the next session wanting attention), Mark ready
// seen (clear the unread flags, with an undo), Stop running (kill the running PTYs, after asking).
// Came out of grid-view.js, where it sat above the card lifecycle it has nothing to do with.
//
// Nothing outside this file calls any of it: grid-view.js renders the bar (renderGridStatusFilters,
// renderGridBulkActions) and that is the whole surface. The five functions below them are what those
// two build their buttons out of.
//
// The STATE stays behind, on purpose. `gridStatusFilter` is declared in grid-view.js and so are the
// three accessors this reads through (getGridRuntimeState, getGridOpenSessions,
// getGridAllowedSessionIds): the composition point owns the state, the modules render it. That is the
// same line #213 drew through main.js.
//
// Worth knowing about `gridStatusFilter`, since this file is where you will look for it: it has THREE
// writers across THREE files — renderGridStatusFilters here, showGridView in grid-view.js (it resets a
// filter that admits nothing), and terminal-manager.js, which resets it when a session it wants to show
// would be filtered away. Each writer also writes localStorage itself. Not this pass's to fix — this is
// motion, not design — but it is the shape of a bug waiting: a fourth writer that forgets the
// localStorage line loses the setting on reload, and nothing would say so.
//
// A classic <script>, like the file it came from: same shared global lexical scope.

function renderGridStatusFilters() {
  const container = document.getElementById('grid-status-filters');
  if (!container) return;

  const counts = getStatusCounts(getGridOpenSessions(), getGridRuntimeState());
  const filters = [
    ['all', 'All', counts.all],
    ['attention', 'Needs You', counts.attention],
    ['ready', 'Ready', counts.ready],
    ['active', 'Running', counts.active],
  ];

  container.innerHTML = '';
  for (const [key, label, count] of filters) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'grid-status-filter' + (gridStatusFilter === key ? ' active' : '');
    btn.dataset.filter = key;
    btn.textContent = `${label} ${count}`;
    btn.disabled = key !== 'all' && count === 0;
    btn.addEventListener('click', () => {
      window._setGridStatusFilter(key);
      showGridView();
    });
    container.appendChild(btn);
  }
}

// --- Bulk actions (Spec 06) ---

function gridSessionLabel(sessionId) {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId) || (entry && entry.session);
  return cleanDisplayName(session && (session.name || session.aiTitle || session.summary)) || sessionId;
}

function gridSessionProject(sessionId) {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId) || (entry && entry.session);
  if (!session || !session.projectPath) return '';
  return session.projectPath.split('/').filter(Boolean).slice(-2).join('/');
}

function renderGridBulkActions() {
  const container = document.getElementById('grid-bulk-actions');
  if (!container) return;

  const targets = bulkTargets(getGridOpenSessions(), getGridRuntimeState(), gridStatusFilter);
  container.innerHTML = '';

  const stepBtn = document.createElement('button');
  stepBtn.type = 'button';
  stepBtn.className = 'grid-bulk-btn';
  stepBtn.innerHTML = '<span class="grid-bulk-icon" aria-hidden="true">▶</span> Step';
  stepBtn.title = 'Focus the next session needing attention';
  stepBtn.disabled = targets.queue.length === 0;
  stepBtn.addEventListener('click', () => stepThroughQueue(targets.queue));
  container.appendChild(stepBtn);

  const seenBtn = document.createElement('button');
  seenBtn.type = 'button';
  seenBtn.className = 'grid-bulk-btn';
  seenBtn.textContent = `Mark ${targets.readyToClear.length} ready seen`;
  seenBtn.title = 'Clear the unread "ready" flag for every ready session in view';
  seenBtn.disabled = targets.readyToClear.length === 0;
  seenBtn.addEventListener('click', () => markAllReadySeen(targets.readyToClear));
  container.appendChild(seenBtn);

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'grid-bulk-btn grid-bulk-btn-danger';
  stopBtn.textContent = `Stop ${targets.runningToStop.length} running`;
  stopBtn.title = 'Stop every running session in view (asks for confirmation)';
  stopBtn.disabled = targets.runningToStop.length === 0;
  stopBtn.addEventListener('click', () => stopAllRunning(targets.runningToStop));
  container.appendChild(stopBtn);

}

// Step ▶ — focus the next attention/ready session relative to the focused card,
// wrapping around. Pure traversal, no confirmation.
function stepThroughQueue(queue) {
  if (!queue || queue.length === 0) return;
  const currentIdx = queue.indexOf(gridFocusedSessionId);
  const next = queue[(currentIdx + 1) % queue.length];
  if (next) focusGridCard(next);
}

// Mark N ready seen — clear the unread flag for each ready session, with an
// Undo toast that re-adds them to responseReadySessions.
//
// Undo restores a set the user saw a moment ago, and the sessions have kept running in between: one
// of them may have started a new turn since. Restoring it as "ready" on top of that would assert two
// states at once, so it goes through markResponseReady, which drops the ones that are working (#252).
// Those sessions are not lost — they show as Working, which is what they are.
function markAllReadySeen(readyToClear) {
  if (!readyToClear || readyToClear.length === 0) return;
  const cleared = readyToClear.slice();
  for (const sid of cleared) clearUnread(sid);
  if (gridViewActive) showGridView();

  const count = cleared.length;
  showControlToast({
    message: `Marked ${count} ready session${count !== 1 ? 's' : ''} as seen`,
    actionLabel: 'Undo',
    onAction: () => {
      for (const sid of cleared) {
        if (activePtyIds.has(sid)) markResponseReady(sid);
      }
      refreshSessionStatusViews();
    },
  });
}

// Stop N running — destructive. Always confirm with counts + names before
// terminating anything; cancel does nothing.
async function stopAllRunning(runningToStop) {
  if (!runningToStop || runningToStop.length === 0) return;
  const ids = runningToStop.slice();
  const count = ids.length;
  const details = ids.map(sid => ({ label: gridSessionLabel(sid), value: gridSessionProject(sid) || '—' }));

  const confirmed = await showControlDialog({
    title: `Stop ${count} running session${count !== 1 ? 's' : ''}?`,
    message: 'This terminates the running process for each session below. Their history stays available in the sidebar.',
    confirmLabel: `Stop ${count} session${count !== 1 ? 's' : ''}`,
    tone: 'danger',
    details,
  });
  if (!confirmed) return;

  for (const sid of ids) {
    // Mark user-stopped like the single-session stop, so these don't get the
    // "re-click to relaunch" banner or a timed tab auto-close (issue #78).
    if (typeof window._markUserStopped === 'function') window._markUserStopped(sid);
    await window.api.stopSession(sid);
    recordTimelineEvent(sid, 'stopped', 'Session stopped', 'Stopped via grid bulk action.');
    activePtyIds.delete(sid);
  }
  refreshSidebar();
  if (gridViewActive) showGridView();
}
