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
    maxMessageCount: 50,
    // Fewer than this many user turns (real back-and-forth).
    maxUserMessageCount: 5,
    // Below this many cache-read tokens. Claude Code re-reads the cached context
    // on every turn, so even a 5-message session realistically reads a few hundred
    // thousand tokens; this bound is set well above that (but far below the
    // multi-million "heavy session" health thresholds) so it only excludes
    // sessions that did genuinely heavy work in few turns.
    maxCacheReadTokens: 2_000_000,
    // No activity for at least this many days.
    minInactiveDays: 2,
  };

  function numberValue(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  // Returns a finite number for a known metric, or null when the metric is
  // absent/non-numeric. Used by the abandoned-short selector so a session with
  // unknown metrics is treated as "unknown" (not flagged) rather than silently
  // coerced to 0 (which would falsely flag it as abandoned).
  function knownMetric(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
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

      // Must be trivially small across every usage signal. If any metric is
      // unknown (missing/non-numeric) we do not flag the session, to avoid false
      // positives from incomplete data being coerced to 0.
      const messageCount = knownMetric(session.messageCount);
      const userMessageCount = knownMetric(session.userMessageCount);
      const cacheReadTokens = knownMetric(session.cacheReadTokens);
      if (messageCount === null || userMessageCount === null || cacheReadTokens === null) continue;
      if (messageCount >= thresholds.maxMessageCount) continue;
      if (userMessageCount >= thresholds.maxUserMessageCount) continue;
      if (cacheReadTokens >= thresholds.maxCacheReadTokens) continue;

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
