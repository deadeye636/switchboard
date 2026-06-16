const DEFAULT_USAGE_RETRY_SECONDS = 5 * 60;

function isSuccessfulUsage(usage) {
  if (!usage || usage._error || usage._rateLimited) return false;
  return Object.keys(usage).some(key => !key.startsWith('_') && usage[key] !== undefined && usage[key] !== null);
}

function retrySecondsForUsage(usage) {
  if (usage?._rateLimited) {
    const seconds = Number(usage.retryAfterSeconds || 0);
    if (Number.isFinite(seconds) && seconds > 0) return seconds + 5;
  }
  return DEFAULT_USAGE_RETRY_SECONDS;
}

function buildCachedUsageValue(usage, fetchedAt = new Date()) {
  return {
    usage,
    fetchedAt: fetchedAt instanceof Date ? fetchedAt.toISOString() : String(fetchedAt),
  };
}

function usageFailureMessage(usage) {
  if (usage?._rateLimited) return 'Usage API rate limited';
  if (usage?._error) return usage.message || 'Could not fetch Claude usage data.';
  return 'Usage unavailable';
}

function withMainProcessUsageCache(usage, cachedValue) {
  if (isSuccessfulUsage(usage)) {
    return {
      response: usage,
      cacheValue: buildCachedUsageValue(usage),
      fromCache: false,
    };
  }

  const cachedUsage = cachedValue?.usage;
  if (isSuccessfulUsage(cachedUsage)) {
    return {
      response: {
        ...cachedUsage,
        _stale: true,
        _staleMessage: usageFailureMessage(usage),
        _retryAfterSeconds: retrySecondsForUsage(usage),
        _cachedAt: cachedValue.fetchedAt || null,
      },
      cacheValue: null,
      fromCache: true,
    };
  }

  return {
    response: usage || { _error: true, message: 'Could not fetch Claude usage data.' },
    cacheValue: null,
    fromCache: false,
  };
}

module.exports = {
  DEFAULT_USAGE_RETRY_SECONDS,
  isSuccessfulUsage,
  retrySecondsForUsage,
  buildCachedUsageValue,
  withMainProcessUsageCache,
};
