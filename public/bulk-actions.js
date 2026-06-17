(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./session-status'));
  } else {
    Object.assign(root, factory(root));
  }
})(typeof window !== 'undefined' ? window : globalThis, function (sessionStatus) {
  const { getFilteredSessionsByStatus, getSessionStatus, getAttentionInboxItems } = sessionStatus;

  // Compute the session sets each bulk action operates on, scoped to the
  // currently filtered grid view. Kept pure (Electron-free) so the dangerous
  // part — *what* gets acted on — is unit-tested.
  //
  // Returns:
  //   readyToClear  — response-ready sessions in the visible set
  //   runningToStop — busy|running sessions in the visible set
  //   queue         — attention+ready sessions ordered by inbox priority
  function bulkTargets(sessions, runtime = {}, filter = 'all') {
    const visible = getFilteredSessionsByStatus(sessions || [], runtime, filter);

    const readyToClear = [];
    const runningToStop = [];
    for (const session of visible) {
      const status = getSessionStatus(session, runtime);
      if (status.key === 'response-ready') readyToClear.push(session.sessionId);
      if (status.key === 'busy' || status.key === 'running') runningToStop.push(session.sessionId);
    }

    const queue = getAttentionInboxItems(visible, runtime)
      .filter(item => item.status.key === 'needs-attention' || item.status.key === 'response-ready')
      .map(item => item.session.sessionId);

    return { readyToClear, runningToStop, queue };
  }

  return { bulkTargets };
});
