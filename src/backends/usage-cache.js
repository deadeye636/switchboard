// usage-cache.js — keep the last GOOD usage reading per backend, so a failed poll shows yesterday's
// number marked as stale instead of blanking the status bar (#191: one cache entry per backend).

const DEFAULT_USAGE_RETRY_SECONDS = 5 * 60;

// How long a cached reading may still SUPPRESS a managed probe (#604).
//
// A backend that can only be read by starting a process of its own is asked not to, once there is a
// stored reading — `hasCachedUsage` on the fetch context, which agy turns into `allowLaunch`. The key it
// comes from (`usage:lastSuccessful:<id>`) is persistent and was never cleared, aged or invalidated, so
// the FIRST successful reading switched that probe off for the life of the installation. Measured on an
// installed instance: a figure stamped three days earlier, served once a minute, with no probe in the log
// and the neutral "limits unavailable" reason under it — indistinguishable from a source that cannot
// answer today.
//
// Six hours is the compromise, against a number that can be a plan change or a different account old.
// It is NOT a setting — a knob for how often the app may start a CLI in the background is a question
// nobody has asked.
//
// IT BOUNDS THE FAILING CYCLE TOO, and that took a second stamp. A failed reading must not overwrite the
// good one — that is what keeps a figure on screen — so `fetchedAt` does not move when a probe fails, and
// a gate that read only `fetchedAt` would stand open from the first failure onwards. What bounded that
// was the probe's own backoff (#509: 5 → 10 → 20 → 40 → 60 min, capped), settling at one spawn an hour;
// an install that succeeded once and later lost its credentials would have gone from probing never to
// probing hourly. So a failed ATTEMPT is stamped as well (`probedAt`), the reading beside it untouched,
// and the gate reads whichever of the two is newer.
//
// An install that has NEVER had a successful reading has nothing to stamp and keeps today's behaviour:
// the backoff is the only thing bounding it, exactly as #509 left it.
const USAGE_GATE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function stampMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// May the stored entry still stand in for a fresh reading, for the purpose of the gate above?
//
// An entry with no usable timestamp answers NO. `buildCachedUsageValue` has always written one, so this
// is defensive rather than a case anyone has seen — and it is the older half of the trade: an unreadable
// stamp costs one probe, while treating it as fresh restores exactly the permanent lock-out this exists
// to end.
function cachedUsageIsFresh(cachedValue, nowMs = Date.now(), maxAgeMs = USAGE_GATE_MAX_AGE_MS) {
  const stamps = [stampMs(cachedValue?.fetchedAt), stampMs(cachedValue?.probedAt)]
    // A stamp from the future is a clock that moved, not a recent anything.
    .filter((ms) => ms !== null && ms <= nowMs);
  if (stamps.length === 0) return false;
  return (nowMs - Math.max(...stamps)) < maxAgeMs;
}

// Remember that a probe was ALLOWED and did not produce a reading, so the window governs the failing
// case as well. The stored reading and its own `fetchedAt` are carried over untouched: this records an
// attempt, it does not claim a measurement. Answers null when there is nothing to record — an install
// with no stored reading has no gate to hold open in the first place.
//
// What the stamp says exactly is "the gate was open and nothing came back", NOT "a process was started".
// Only agy reads `hasCachedUsage` at all; for a backend that reads a file, a fruitless cycle stamps this
// and nothing consumes it. That is one settings write per window per backend, and it is worth less
// confusion than a second key that only one backend would ever fill.
function touchProbeAttempt(cachedValue, at = new Date()) {
  if (!isSuccessfulUsage(cachedValue?.usage)) return null;
  return { ...cachedValue, probedAt: at instanceof Date ? at.toISOString() : String(at) };
}

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
  USAGE_GATE_MAX_AGE_MS,
  cachedUsageIsFresh,
  touchProbeAttempt,
  isSuccessfulUsage,
  usageFailureMessage,
  usageStaleKind,
  retrySecondsForUsage,
  buildCachedUsageValue,
  withMainProcessUsageCache,
};
