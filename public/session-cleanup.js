(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const CLEANUP_AGE_PRESETS = [3, 7, 30];
  const DEFAULT_CLEANUP_AGE_DAYS = 7;
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Thresholds describing an "abandoned short" session: one that was started,
  // barely used, and then left untouched. Every condition must hold for a
  // session to qualify, so the category only ever surfaces genuinely trivial,
  // stale sessions. Values are deliberately conservative.
  const ABANDONED_SHORT_DEFAULTS = {
    // Fewer than this many total transcript entries.
    maxMessageCount: 15,
    // Fewer than this many user turns (real back-and-forth).
    maxUserMessageCount: 3,
    // Below this many cache-read tokens (almost no real work happened).
    maxCacheReadTokens: 50_000,
    // No activity for at least this many days.
    minInactiveDays: 7,
  };

  function numberValue(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function sessionActivityTime(session, runtime = {}) {
    const runtimeTime = runtime.lastActivityTime?.get?.(session.sessionId);
    const value = runtimeTime || session.modified || session.created;
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
  }

  function projectLabel(projectPath) {
    return projectPath ? projectPath.split('/').filter(Boolean).slice(-2).join('/') : 'Other';
  }

  function getSpringCleaningCandidates(projects = [], options = {}) {
    const ageDays = CLEANUP_AGE_PRESETS.includes(Number(options.ageDays))
      ? Number(options.ageDays)
      : DEFAULT_CLEANUP_AGE_DAYS;
    const now = options.now ? new Date(options.now) : new Date();
    const nowMs = now.getTime();
    const runtime = {
      activePtyIds: options.activePtyIds || new Set(),
      lastActivityTime: options.lastActivityTime,
    };
    const cutoffMs = nowMs - ageDays * DAY_MS;
    const candidates = [];

    for (const project of projects) {
      for (const session of project.sessions || []) {
        if (!session?.sessionId) continue;
        if (session.archived) continue;
        if (session.starred) continue;
        if (runtime.activePtyIds.has(session.sessionId)) continue;
        const activityMs = sessionActivityTime(session, runtime);
        if (!activityMs || activityMs > cutoffMs) continue;
        candidates.push({
          projectPath: project.projectPath,
          projectLabel: projectLabel(project.projectPath),
          session,
          activityMs,
          ageDays: Math.max(0, Math.floor((nowMs - activityMs) / DAY_MS)),
        });
      }
    }

    return candidates.sort((a, b) => b.activityMs - a.activityMs);
  }

  function getAbandonedShortSessions(sessions = [], options = {}) {
    const thresholds = { ...ABANDONED_SHORT_DEFAULTS, ...(options.thresholds || {}) };
    const now = options.now ? new Date(options.now) : new Date();
    const nowMs = now.getTime();
    const runtime = {
      activePtyIds: options.activePtyIds || new Set(),
      lastActivityTime: options.lastActivityTime,
    };
    const cutoffMs = nowMs - thresholds.minInactiveDays * DAY_MS;
    const results = [];

    for (const session of sessions) {
      if (!session?.sessionId) continue;
      // Never touch sessions the user has protected or that are not real chats.
      if (session.archived) continue;
      if (session.starred) continue;
      if (session.type === 'terminal') continue;
      // Never touch a session with a live PTY (running/open).
      if (runtime.activePtyIds.has(session.sessionId)) continue;

      // Must be inactive: last activity older than the inactivity window.
      const activityMs = sessionActivityTime(session, runtime);
      if (!activityMs || activityMs > cutoffMs) continue;

      // Must be trivially small across every usage signal.
      if (numberValue(session.messageCount) >= thresholds.maxMessageCount) continue;
      if (numberValue(session.userMessageCount) >= thresholds.maxUserMessageCount) continue;
      if (numberValue(session.cacheReadTokens) >= thresholds.maxCacheReadTokens) continue;

      results.push({
        projectPath: session.projectPath,
        projectLabel: projectLabel(session.projectPath),
        session,
        activityMs,
        ageDays: Math.max(0, Math.floor((nowMs - activityMs) / DAY_MS)),
      });
    }

    return results.sort((a, b) => b.activityMs - a.activityMs);
  }

  function summarizeSpringCleaningSelection(candidates = [], selectedIds = new Set()) {
    const selected = candidates.filter(item => selectedIds.has(item.session.sessionId));
    return {
      selectedCount: selected.length,
      projectCount: new Set(selected.map(item => item.projectPath || '')).size,
    };
  }

  return {
    CLEANUP_AGE_PRESETS,
    DEFAULT_CLEANUP_AGE_DAYS,
    ABANDONED_SHORT_DEFAULTS,
    getSpringCleaningCandidates,
    getAbandonedShortSessions,
    summarizeSpringCleaningSelection,
  };
});
