(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const METRIC_THRESHOLDS = {
    userMessageCount: { amber: 21, red: 30 },
    cacheReadTokens: { amber: 14_000_000, red: 20_000_000 },
    activeMinutes: { amber: 168, red: 240 },
    messageCount: { amber: 210, red: 300 },
  };
  const ACTIVITY_AGE_THRESHOLDS_MS = {
    amber: 30 * 60 * 1000,
    red: 2 * 60 * 60 * 1000,
  };

  function numberValue(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? number : 0;
  }

  function formatCompact(value) {
    const number = numberValue(value);
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
    if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`;
    return String(Math.round(number));
  }

  function formatDuration(minutes) {
    const value = numberValue(minutes);
    if (value >= 60) {
      const hours = value / 60;
      return `${Number.isInteger(hours) ? hours : hours.toFixed(1).replace(/\.0$/, '')}h`;
    }
    return value ? `${Math.round(value)}m` : '';
  }

  function getWorktreeLabel(session = {}) {
    const match = String(session.projectPath || '').match(/\/\.claude\/worktrees\/([^/]+)\/?$/);
    return match ? `Worktree ${match[1]}` : '';
  }

  function getSessionMetricLabels(session = {}) {
    const parts = [];
    if (numberValue(session.userMessageCount)) parts.push(`${formatCompact(session.userMessageCount)} turns`);
    if (numberValue(session.cacheReadTokens)) parts.push(`${formatCompact(session.cacheReadTokens)} cache`);
    const duration = formatDuration(session.activeMinutes);
    if (duration) parts.push(`${duration} active`);
    return parts;
  }

  function getQuietDetailParts({ timeLabel, session = {}, includeMetrics = false } = {}) {
    const parts = [];
    if (timeLabel) parts.push(String(timeLabel));
    if (numberValue(session.messageCount)) parts.push(`${formatCompact(session.messageCount)} msgs`);
    if (includeMetrics) parts.push(...getSessionMetricLabels(session));
    return parts;
  }

  function getMetricTrafficLevel(metric, value) {
    const thresholds = METRIC_THRESHOLDS[metric];
    if (!thresholds) return 'green';
    const number = numberValue(value);
    if (number >= thresholds.red) return 'red';
    if (number >= thresholds.amber) return 'amber';
    return 'green';
  }

  function getActivityTrafficLevel(activityTime, now = new Date()) {
    const time = activityTime instanceof Date ? activityTime.getTime() : new Date(activityTime).getTime();
    const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (!Number.isFinite(time) || !Number.isFinite(nowTime)) return 'green';
    const ageMs = Math.max(0, nowTime - time);
    if (ageMs >= ACTIVITY_AGE_THRESHOLDS_MS.red) return 'red';
    if (ageMs >= ACTIVITY_AGE_THRESHOLDS_MS.amber) return 'amber';
    return 'green';
  }

  return {
    getWorktreeLabel,
    getSessionMetricLabels,
    getQuietDetailParts,
    getMetricTrafficLevel,
    getActivityTrafficLevel,
  };
});
