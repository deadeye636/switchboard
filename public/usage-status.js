(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Pure formatting for the usage bar and the Stats cards. Bucket-driven since #191: it used to read
  // `usage.session` / `usage.weekAll` / `usage.weekSonnet` — Claude's window names, hardcoded in the one
  // module that is supposed to know nothing about any backend. A backend now hands us a list of buckets
  // and this renders whatever is in it, which is how Codex's derived windows (and, later, Antigravity's
  // per-model quotas) get a bar without a line changing here.

  function pct(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.max(0, Math.min(100, Math.round(number)));
  }

  // Four-tier usage scale for the Stats cards: green → yellow → orange → red.
  function usageLevel(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return 'normal';
    if (v >= 95) return 'critical';
    if (v >= 80) return 'high';
    if (v >= 50) return 'moderate';
    return 'normal';
  }

  // 3-tier colour scale for the status-bar bars: green (ok) → orange (warn) → red (crit).
  function usageLevel3(value, warn = 60, crit = 80) {
    const v = Number(value);
    if (!Number.isFinite(v)) return 'ok';
    if (v >= crit) return 'crit';
    if (v >= warn) return 'warn';
    return 'ok';
  }

  function rateLimitTitle(seconds) {
    const value = Number(seconds || 0);
    if (!Number.isFinite(value) || value <= 0) return 'Usage API rate limited. Try again later.';
    const mins = Math.ceil(value / 60);
    return `Usage API rate limited. Try again in ~${mins} min${mins === 1 ? '' : 's'}.`;
  }

  function retryTitle(seconds) {
    const value = Number(seconds || 0);
    if (!Number.isFinite(value) || value <= 0) return 'Retrying soon.';
    const mins = Math.ceil(value / 60);
    return `Retrying in ~${mins} min${mins === 1 ? '' : 's'}.`;
  }

  function formatMoney(value, currency = 'USD') {
    const amount = Number(value || 0) / 100;
    try {
      return new Intl.NumberFormat('en', {
        style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `$${amount.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
  }

  // "as of 3 hours ago" — only ever shown for a NON-live backend. Codex's figure is the state at its last
  // turn; rendering it beside Claude's live number with no caveat would turn a three-day-old percentage
  // into a current one, which is the one thing this bar must not do.
  function observedAgo(iso) {
    if (!iso) return null;
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return null;
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  // Is this reading old enough that the number should be visibly hedged? Only applies to non-live
  // backends — a live one is either fresh or explicitly flagged `_stale` by the cache.
  function isStaleReading(usage = {}, maxAgeMinutes = 60) {
    if (usage.live || !usage.observedAt) return false;
    const then = new Date(usage.observedAt).getTime();
    if (!Number.isFinite(then)) return false;
    return (Date.now() - then) / 60000 > maxAgeMinutes;
  }

  function quotaStatus(usage) {
    const q = usage && usage.quota;
    const value = q ? pct(q.percent) : null;
    if (value === null) return null;
    const currency = q.currency || 'USD';
    const hasAmounts = q.used !== null && q.used !== undefined && q.limit !== null && q.limit !== undefined;
    const used = formatMoney(q.used, currency);
    const limit = formatMoney(q.limit, currency);
    return {
      text: hasAmounts ? `Quota: ${used} / ${limit} (${value}%)` : `Quota: ${value}%`,
      title: hasAmounts ? `Extra usage quota: ${used} used of ${limit}` : 'Extra usage quota',
      level: usageLevel(value),
      percent: value,
      amounts: hasAmounts ? `${used} / ${limit}` : null,
    };
  }

  // Stats cards for ONE backend: every bucket it reports (not just the two in the bar) plus its quota.
  function getUsageLimitCards(usage = {}) {
    const cards = (usage.buckets || []).map(bucket => {
      const value = pct(bucket.percent);
      if (value === null) return null;
      return {
        key: bucket.key,
        label: bucket.cardLabel || bucket.label,
        percent: value,
        detail: null,
        level: usageLevel(value),
        reset: bucket.reset || null,
      };
    }).filter(Boolean);

    const quota = quotaStatus(usage);
    if (quota) {
      cards.push({
        key: 'quota',
        label: 'Extra usage quota',
        percent: quota.percent,
        detail: quota.amounts,
        level: quota.level,
        reset: null,
      });
    }
    return cards;
  }

  // The status-bar bars for ONE backend: the buckets it flagged `bar`, plus its quota when non-zero.
  // `thresholds` is keyed by TIER ('short' / 'long'), each { warn, crit } — not by a window name, so a
  // backend that invents its own windows still gets coloured correctly.
  function getUsageBars(usage = {}, thresholds = {}) {
    const th = (tier) => thresholds[tier] || {};
    const bars = [];
    for (const bucket of usage.buckets || []) {
      if (!bucket.bar) continue;
      const value = pct(bucket.percent);
      if (value === null) continue;
      const t = th(bucket.tier || 'long');
      bars.push({ key: bucket.key, label: bucket.label, percent: value, level: usageLevel3(value, t.warn, t.crit) });
    }
    const quota = quotaStatus(usage);
    if (quota && quota.percent > 0) {
      const t = th('long');
      bars.push({ key: 'quota', label: 'Quota', percent: quota.percent, level: usageLevel3(quota.percent, t.warn, t.crit) });
    }
    return bars;
  }

  // The compact single-label fallback: no bars to draw (error, rate limit, no data yet).
  function formatUsageStatus(usage = {}) {
    const who = usage.label || 'Usage';
    if (usage._rateLimited) {
      return { text: `${who}: rate limited`, title: rateLimitTitle(usage.retryAfterSeconds), level: 'warning', percent: null };
    }
    if (usage._error) {
      return { text: `${who}: unavailable`, title: usage.message || 'Could not fetch usage data.', level: 'warning', percent: null };
    }
    if (usage._noData) {
      // Installed and switched on, but it has never reported a limit. Say that; a 0% would read as
      // "you have used none of your quota", which is a claim we cannot make.
      return { text: `${who}: no data yet`, title: `${who} has not reported a usage limit yet.`, level: 'empty', percent: null };
    }
    return { text: '', title: '', level: 'empty', percent: null };
  }

  // Multi-line tooltip for ONE backend: every window with its reset, the quota with its amounts, and —
  // for a non-live backend — when the figure was actually true.
  //
  // A CACHED reading says WHY it is cached and when it will be tried again. Dimming a number without
  // saying what went wrong just makes it look broken: the whole point of falling back to the last good
  // reading is that the user can still trust it while knowing it is not fresh.
  function getUsageTooltip(usage = {}) {
    const lines = [`${usage.label || 'Usage'}${usage.live ? '' : ' (as of its last run)'}`];
    for (const bucket of usage.buckets || []) {
      const value = pct(bucket.percent);
      if (value === null) continue;
      const reset = bucket.reset ? ` — resets ${bucket.reset}` : '';
      lines.push(`${bucket.cardLabel || bucket.label}: ${value}%${reset}`);
    }
    const quota = quotaStatus(usage);
    if (quota) lines.push(`Extra usage quota: ${quota.percent}%${quota.amounts ? ` (${quota.amounts})` : ''}`);
    if (!usage.live && usage.observedAt) {
      const ago = observedAgo(usage.observedAt);
      if (ago) lines.push(`Measured ${ago}.`);
    }
    if (usage._stale) {
      const why = usage._staleMessage ? ` Last error: ${usage._staleMessage}` : '';
      lines.push(`Cached — the last fetch failed. ${retryTitle(usage._retryAfterSeconds)}${why}`);
    }
    return lines.join('\n');
  }

  function getUsageRefreshDelayMs(usage = {}) {
    if (usage._rateLimited) {
      const seconds = Number(usage.retryAfterSeconds || 0);
      // Honour the server's retry-after, but cap it so a large value can't leave the quota frozen for
      // the better part of an hour. A single lightweight GET is cheap.
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.min((seconds * 1000) + 5000, 5 * 60 * 1000);
      }
    }
    return 60 * 1000;
  }

  // The poll interval for the whole bar: the shortest any backend asks for.
  function getUsagePollDelayMs(payload = {}) {
    const list = payload.backends || [];
    if (list.length === 0) return 60 * 1000;
    return Math.min(...list.map(getUsageRefreshDelayMs));
  }

  // Which backends the status bar draws: the ones that reported, in the order they came, minus the ones
  // the user unticked. `selection` is the stored map — an ABSENT key means "not decided", which shows the
  // segment; only an explicit `false` hides it. That distinction is the whole reason it is a map and not
  // a list: disabling a backend must not silently erase the wish to see it (#191).
  function selectedUsageBackends(payload = {}, selection = {}) {
    return (payload.backends || []).filter(u => selection[u.backendId] !== false);
  }

  return {
    formatUsageStatus, getUsageLimitCards, getUsageRefreshDelayMs, getUsagePollDelayMs,
    usageLevel3, getUsageBars, getUsageTooltip,
    selectedUsageBackends, observedAgo, isStaleReading,
  };
});
