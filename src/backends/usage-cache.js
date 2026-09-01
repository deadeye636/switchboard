// usage-cache.js — keep the last GOOD usage reading per backend, so a failed poll shows yesterday's
// number marked as stale instead of blanking the status bar (#191: one cache entry per backend).

const DEFAULT_USAGE_RETRY_SECONDS = 5 * 60;

// Did this reading actually measure something? A reading is successful when it carries at least one
// bucket or a quota — NOT merely "some key is set". Every reading now arrives with `backendId`, `label`
// and `live` stamped on it by the collector, so a "does any non-underscore key have a value" test (what
// this used to do) would call an error response successful and cache it over the last good one.
function isSuccessfulUsage(usage) {
  if (!usage || usage._error || usage._rateLimited) return false;
  const hasBuckets = Array.isArray(usage.buckets) && usage.buckets.length > 0;
  const hasQuota = !!usage.quota && Number.isFinite(Number(usage.quota.percent));
  return hasBuckets || hasQuota;
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
  // The backend's own sentence first: Codex names its reason (`workspace_member_credits_depleted` →
  // "Your workspace credits are used up."), and "Usage API rate limited" would talk over it about an API
  // it never called (#494).
  if (usage?._rateLimited) return usage.message || 'Usage API rate limited';
  if (usage?._error) return usage.message || 'Could not fetch usage data.';
  if (usage?._noData) return usage.message || 'No newer limit reported yet';
  return 'Usage unavailable';
}

/**
 * WHY the cached reading is being served — not the same question as what went wrong (#494).
 *
 * "The last fetch failed" was said for all three, and for `_noData` it is simply untrue: nothing was
 * fetched and nothing failed, the backend has just not written a newer number. The renderer picks its
 * wording from this.
 */
function usageStaleKind(usage) {
  if (usage?._rateLimited) return 'rate-limited';
  if (usage?._error) return 'error';
  if (usage?._noData) return 'no-data';
  return 'error';
}

// A backend that is installed but has never reported a limit (Codex, never run) is NOT a failure and has
// nothing to fall back to. Pass it through untouched rather than dressing it up as an error.
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
        // Identity is re-stamped by the collector after this returns, but keep whatever the live
        // response knew so a cached body can never claim to be another backend.
        backendId: usage?.backendId || cachedUsage.backendId,
        _stale: true,
        _staleKind: usageStaleKind(usage),
        _staleMessage: usageFailureMessage(usage),
        _retryAfterSeconds: retrySecondsForUsage(usage),
        _cachedAt: cachedValue.fetchedAt || null,
      },
      cacheValue: null,
      fromCache: true,
    };
  }

  return {
    response: usage || { _error: true, message: 'Could not fetch usage data.' },
    cacheValue: null,
    fromCache: false,
  };
}

module.exports = {
  DEFAULT_USAGE_RETRY_SECONDS,
  isSuccessfulUsage,
  usageFailureMessage,
  usageStaleKind,
  retrySecondsForUsage,
  buildCachedUsageValue,
  withMainProcessUsageCache,
};
