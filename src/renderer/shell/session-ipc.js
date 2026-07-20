// --- The session-lifecycle IPC listeners (#218, #228) ---
//
// The renderer's half of the main->renderer session protocol: terminal data, the MCP open-diff/open-file
// bridge, session detection and forking, process exit, terminal/session notices, structured attention
// signals, and the CLI busy-state spinner. Ten window.api.on* listeners that translate a main event into
// renderer state. Came out of app.js.
//
// THE COUPLING IS ONE-WAY, and that is why this is a clean cut despite its size: the listeners CONSUME
// app.js — they read its state and call its functions — but app.js never calls back into this file (the
// listeners are reached only by main, over IPC). So unlike search-bar.js / native-notifications.js /
// sidebar-filters.js, there is nothing in app.js to guard: no app.js call site depends on a name declared
// here. It writes no app.js `let` either — it mutates the session Maps/Sets in place and calls functions.
//
// A PLAIN CLASSIC SCRIPT that LOADS AFTER app.js, and after the other after-app.js shell modules, because
// its handlers call into several of them at event time: attention-engine.js (setActivity, applyAttention —
// loaded before app.js) and away-summary-banner.js (recordFileTouched — loaded after). All of those are
// call-time, inside the handler bodies, so load order only has to guarantee they exist by the first event,
// which "after app.js, events fire after boot" does. Registered before app.js the handlers would run into
// app.js state still in its TDZ; registered after, the state is bound.
//
// What it reaches into app.js at call time (read, or mutate a Map/Set in place; it rebinds no let):
//   openSessions, sessionMap, pendingSessions, userStoppedSessions (session tables),
//   activeSessionId, cachedAllProjects, cachedProjects, gridViewActive, sessionTimelineStore,
//   refreshSidebar, setActiveSession, trackActivity, recordTimelineEvent, and the terminal-header DOM
//   handles (placeholder, terminalHeader, terminalHeaderId/Name/PtyTitle, gridViewerCount).
//   Cross-module: setActivity / applyAttention (shell/attention-engine.js), recordFileTouched
//   (shell/away-summary-banner.js), classifyAttentionSignal (shared/attention-source.js).

// --- IPC listeners from main process ---

window.api.onTerminalData((sessionId, data) => {
  const entry = openSessions.get(sessionId);
  if (entry) {
    // PTY flow control: count received bytes; terminal-manager pauses the PTY
    // when too much output is in flight and resumes once xterm caught up (#81).
    if (typeof flowTrackReceived === 'function') flowTrackReceived(sessionId, data.length);
    let buf = terminalWriteBuffers.get(sessionId);
    if (!buf) {
      buf = { chunks: [], rafId: 0, timerId: 0 };
      terminalWriteBuffers.set(sessionId, buf);
    }
    buf.chunks.push(data);

    // DEC-2026 synchronized output is handled natively by xterm 6 (it defers painting
    // while ?2026h is active and flushes atomically on ?2026l). No app-level sync
    // buffering needed: the old syncDepth guard was redundant and mis-counted mixed
    // ?2026h/l markers landing in one coalesced IPC chunk, sticking syncDepth > 0 and
    // holding data until a 500 ms timeout — which left the prompt/status blank (#85).
    // Just coalesce writes on the next frame; xterm keeps redraws atomic.
    scheduleFlush(sessionId, buf);
  }
  // Update last activity time (noise-filtered)
  trackActivity(sessionId, data);
});

// Track files the agent touches so the "while you were away" recap can list
// them. These are additive listeners alongside file-panel.js's own handlers.
window.api.onMcpOpenDiff((sessionId, _diffId, data) => {
  recordFileTouched(sessionId, data && data.oldFilePath, 'diff');
});
window.api.onMcpOpenFile((sessionId, data) => {
  recordFileTouched(sessionId, data && data.filePath, 'open');
});

// Re-show the recap when the OS window regains focus for the active session.
window.addEventListener('focus', () => {
  if (!gridViewActive && activeSessionId && openSessions.has(activeSessionId)) {
    handleSessionViewed(activeSessionId);
  }
});

window.api.onSessionDetected((tempId, realId) => {
  const entry = openSessions.get(tempId);
  if (!entry) return;

  entry.session.sessionId = realId;
  if (activeSessionId === tempId) setActiveSession(realId);

  // Re-key in openSessions
  openSessions.delete(tempId);
  openSessions.set(realId, entry);
  const previousEvents = sessionTimelineStore.eventsBySession.get(tempId);
  if (previousEvents) {
    sessionTimelineStore.eventsBySession.delete(tempId);
    sessionTimelineStore.eventsBySession.set(realId, previousEvents.map(event => ({ ...event, sessionId: realId })));
  }
  recordTimelineEvent(realId, 'started', 'Session detected', 'Claude wrote its real session id.');

  terminalHeaderId.textContent = realId;
  terminalHeaderName.textContent = 'New session';

  // Refresh sidebar to show the new session, then select it
  loadProjects().then(() => {
    const item = document.querySelector(`[data-session-id="${realId}"]`);
    if (item) {
      document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
    }
  });
  pollActiveSessions();
});

window.api.onSessionForked((oldId, newId) => {
  const entry = openSessions.get(oldId);
  if (!entry) return;

  entry.session.sessionId = newId;
  if (activeSessionId === oldId) setActiveSession(newId);

  openSessions.delete(oldId);
  openSessions.set(newId, entry);
  const previousEvents = sessionTimelineStore.eventsBySession.get(oldId);
  if (previousEvents) {
    sessionTimelineStore.eventsBySession.delete(oldId);
    sessionTimelineStore.eventsBySession.set(newId, previousEvents.map(event => ({ ...event, sessionId: newId })));
  }
  recordTimelineEvent(newId, 'forked', 'Session forked', `Forked from ${oldId}.`);

  // Re-key file panel state for the new session ID
  if (typeof rekeyFilePanelState === 'function') rekeyFilePanelState(oldId, newId);

  // Re-key pending session to newId so sidebar item persists until DB has real data
  const pendingEntry = pendingSessions.get(oldId);
  pendingSessions.delete(oldId);
  if (pendingEntry) {
    // Re-key only: the pending shape is { session, projectPath, folder } with no
    // own sessionId field (the Map key carries it); entry.session.sessionId was
    // already updated above (issue #75 — removed a dead write to a phantom field).
    pendingSessions.set(newId, pendingEntry);
  }
  sessionMap.delete(oldId);
  sessionMap.set(newId, entry.session);

  terminalHeaderId.textContent = newId;

  loadProjects().then(() => {
    const item = document.querySelector(`[data-session-id="${newId}"]`);
    if (item) {
      document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      const summary = item.querySelector('.session-summary');
      if (summary) terminalHeaderName.textContent = summary.textContent;
    }
  });
  pollActiveSessions();
});

// Clear the main terminal area to the idle placeholder (no active session).
// Exposed for the session-tabs close fallback: when the closed tab was the active
// one and no other tab remains, the strip has nothing to switch to.
window.clearActiveTerminalView = function () {
  setActiveSession(null);
  terminalHeader.style.display = 'none';
  placeholder.style.display = '';
};

window.api.onProcessExited((sessionId, exitCode) => {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId);
  const userStopped = userStoppedSessions.has(sessionId);
  userStoppedSessions.delete(sessionId);
  if (entry) {
    entry.closed = true;
    recordTimelineEvent(sessionId, 'exited', 'Process exited', `Exit code ${exitCode}.`);
    // Write a visible exit banner so the user can see when the process ended
    // and read any error output it printed (claude / devbox / shell stderr).
    // Without this, a fast-failing pre-launch command would tear down the
    // terminal before the user could read the error. Skip it for a deliberate
    // stop/archive — the "re-click to relaunch" hint is misleading there.
    if (!userStopped) {
      try {
        const colour = exitCode === 0 ? '\x1b[2m' : '\x1b[33m';
        entry.terminal.write(
          `\r\n${colour}── session exited (code ${exitCode}) — re-click this session in the sidebar to relaunch, or click another to dismiss ──\x1b[0m\r\n`
        );
      } catch {}
    }
  }

  // Plain terminal sessions are ephemeral — destroy immediately and remove from
  // the sidebar. Claude sessions stay mounted (see below) so the user can read
  // the exit reason.
  if (session?.type === 'terminal') {
    if (entry) destroySession(sessionId);
    if (gridViewActive) {
      gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
    } else if (activeSessionId === sessionId) {
      setActiveSession(null);
      terminalHeader.style.display = 'none';
      placeholder.style.display = '';
    }
    pendingSessions.delete(sessionId);
    // A plain terminal is gone for good — it leaves the sidebar and sessionMap here, so this is the
    // lifecycle point that drops its attention state. The repaint no longer does (#259): a session that
    // stays mounted (Claude) keeps its flags until opened, but one that is fully removed can never be
    // opened to clear them, so they are cleared here instead.
    attentionSessions.delete(sessionId);
    attentionReason.delete(sessionId);
    responseReadySessions.delete(sessionId);
    sessionBusyState.delete(sessionId);
    finishedAt.delete(sessionId);
    for (const projList of [cachedProjects, cachedAllProjects]) {
      for (const proj of projList) {
        proj.sessions = proj.sessions.filter(s => s.sessionId !== sessionId);
      }
    }
    sessionMap.delete(sessionId);
    refreshSidebar();
    pollActiveSessions();
    return;
  }

  // Claude sessions: keep the terminal mounted with the exit banner visible so
  // the user can read what happened. Cleanup is deferred — openSession destroys
  // the closed entry when the user re-clicks the session (existing behavior).
  // If the session was pending (no .jsonl was written), leave the sidebar
  // entry in place too so the user has somewhere to relaunch from; it'll be
  // tidied up by the regular pending-reconciliation pass once it's clear no
  // real session file is coming.

  // A deliberately stopped session leaves the grid with its process (#130). One
  // that died on its own keeps its card, so the exit banner stays readable and the
  // session can be relaunched from it. destroySession drops the card and fixes the
  // header count; showGridView reflows the survivors into the freed slot.
  if (gridViewActive && userStopped) {
    destroySession(sessionId);
    showGridView();
  }

  if (gridViewActive) {
    gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
  }

  if (userStopped) {
    // Deliberate stop/archive: close the tab now (no timed auto-close, no banner).
    // closeTabNow switches to a neighbour tab or the placeholder in tabs mode; a
    // no-op in grid/legacy where the stop/archive handlers manage the view.
    if (typeof window.closeTabNow === 'function') window.closeTabNow(sessionId);
  } else if (typeof window.scheduleTabAutoClose === 'function') {
    // Tabs mode: optionally auto-close the tab after the exit (setting-driven; the
    // scheduler no-ops in grid mode and honours the mode/delay from settings).
    window.scheduleTabAutoClose(sessionId, exitCode);
  }

  pollActiveSessions();
});

// --- Terminal notifications (iTerm2 OSC 9 — "needs attention") ---
// The OSC-9 regex now lives in public/attention-source.js (one source of truth,
// shared with the hook path). classifyAttentionSignal returns needs-attention for
// the four CLI notification types and ready for "waiting for your input".
window.api.onTerminalNotification((sessionId, message) => {
  applyAttention(sessionId, classifyAttentionSignal({ source: 'osc9', payload: message }));

  // Show in header if active
  if (sessionId === activeSessionId && terminalHeaderPtyTitle) {
    terminalHeaderPtyTitle.textContent = message;
    terminalHeaderPtyTitle.style.display = '';
  }
});

// --- Session notices (#151) ---
// Something the app knows about the session that the session itself cannot say — today: its backend has
// no record of it, so no busy/idle state can be shown. Deliberately a toast and NOT an attention signal:
// nothing is waiting for the user, and lighting the row up would be a lie of a different kind.
window.api.onSessionNotice((sessionId, message) => {
  if (!message || typeof showControlToast !== 'function') return;
  const session = sessionMap.get(sessionId);
  const name = session ? (session.name || session.aiTitle || session.summary || '') : '';
  showControlToast({ message: name ? `${name}: ${message}` : message, timeoutMs: 8000 });
});

// --- Structured attention signals from Claude Code hooks (spec 05) ---
// main.js already normalized the raw hook JSON via attention-source.js; trust it.
window.api.onAttentionSignal((signal) => {
  if (!signal || !signal.sessionId) return;
  applyAttention(signal.sessionId, {
    kind: signal.kind,
    reason: signal.reason,
    source: signal.source || 'hook',
    agentId: signal.agentId || null,
    agentType: signal.agentType || null,
  });
});

// --- CLI busy state (OSC 0 title spinner detection) ---
window.api.onCliBusyState((sessionId, busy) => {
  setActivity(sessionId, busy);
});
