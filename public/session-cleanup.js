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
    getSpringCleaningCandidates,
    summarizeSpringCleaningSelection,
  };
});
