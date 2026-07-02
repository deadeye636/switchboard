(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function pct(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.max(0, Math.min(100, Math.round(number)));
  }

  // Four-tier usage scale: green (normal) → yellow (moderate) → orange (high) →
  // red (critical). Shared by the status-bar summary and the per-bucket cards so
  // colours stay consistent everywhere.
  function usageLevel(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return 'normal';
    if (v >= 95) return 'critical';
    if (v >= 80) return 'high';
    if (v >= 50) return 'moderate';
    return 'normal';
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
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `$${amount.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
  }

  function quotaStatus(usage) {
    const value = pct(usage.extraUsage);
    if (value === null) return null;
    const currency = usage.extraUsageCurrency || 'USD';
    const used = formatMoney(usage.extraUsageUsed, currency);
    const limit = formatMoney(usage.extraUsageLimit, currency);
    const hasAmounts = usage.extraUsageUsed !== undefined && usage.extraUsageLimit !== undefined;
    return {
      text: hasAmounts ? `Quota: ${used} / ${limit} (${value}%)` : `Quota: ${value}%`,
      title: hasAmounts ? `Monthly extra usage quota: ${used} used of ${limit}` : 'Monthly extra usage quota',
      level: usageLevel(value),
      percent: value,
    };
  }

  function getUsageLimitCards(usage = {}) {
    const cards = [
      { key: 'session', label: 'Current session', resetKey: 'sessionReset' },
      { key: 'weekAll', label: 'Week (all models)', resetKey: 'weekAllReset' },
      { key: 'weekSonnet', label: 'Week (Sonnet)', resetKey: 'weekSonnetReset' },
      { key: 'weekOpus', label: 'Week (Opus)', resetKey: 'weekOpusReset' },
    ].map(item => {
      const value = pct(usage[item.key]);
      if (value === null) return null;
      return {
        key: item.key,
        label: item.label,
        percent: value,
        detail: null,
        level: usageLevel(value),
        reset: usage[item.resetKey] || null,
      };
    }).filter(Boolean);

    const quota = quotaStatus(usage);
    if (quota) {
      cards.push({
        key: 'extraUsage',
        label: 'Extra usage quota',
        percent: quota.percent,
        detail: quota.text.replace(/^Quota: /, '').replace(/ \(\d+%\)$/, ''),
        level: quota.level,
        reset: null,
      });
    }

    return cards;
  }

  function formatUsageStatus(usage = {}) {
    if (usage._rateLimited) {
      return {
        text: 'Usage rate limited',
        title: rateLimitTitle(usage.retryAfterSeconds),
        level: 'warning',
        percent: null,
      };
    }
    if (usage._error) {
      return {
        text: 'Usage unavailable',
        title: usage.message || 'Could not fetch Claude usage data.',
        level: 'warning',
        percent: null,
      };
    }

    const quota = quotaStatus(usage);

    const items = [
      ['session', '5h'],
      ['weekAll', '7d'],
      ['weekSonnet', 'Sonnet'],
      ['weekOpus', 'Opus'],
    ].map(([key, label]) => {
      const value = pct(usage[key]);
      return value === null ? null : { key, label, value };
    }).filter(Boolean);

    if (items.length === 0) {
      const status = quota || { text: '', title: '', level: 'empty', percent: null };
      if (usage._stale && status.title) {
        status.title = `${status.title} · Using cached usage. ${retryTitle(usage._retryAfterSeconds)}${usage._staleMessage ? ` Last error: ${usage._staleMessage}` : ''}`;
      }
      return status;
    }

    const sessionItem = items.find(item => item.key === 'session');
    const reset = sessionItem && usage.sessionReset ? ` · resets ${usage.sessionReset}` : '';
    const highest = Math.max(...items.map(item => item.value), quota?.percent || 0);
    const status = {
      text: `Usage: ${items.map(item => `${item.label} ${item.value}%`).join(' · ')}${quota ? ` · Quota ${quota.percent}%` : ''}`,
      title: sessionItem
        ? `Current 5-hour usage: ${sessionItem.value}%${reset}`
        : 'Claude usage',
      level: usageLevel(highest),
      percent: highest,
    };
    if (usage._stale) {
      status.title = `${status.title} · Using cached usage. ${retryTitle(usage._retryAfterSeconds)}${usage._staleMessage ? ` Last error: ${usage._staleMessage}` : ''}`;
    }
    return status;
  }

  function getUsageRefreshDelayMs(usage = {}) {
    if (usage._rateLimited) {
      const seconds = Number(usage.retryAfterSeconds || 0);
      // Honour the server's retry-after, but cap it so a large value (the usage
      // API occasionally returns very long windows) can't leave the quota frozen
      // for the better part of an hour. We re-check at most every 5 minutes; if
      // still limited we just back off again — a single lightweight GET is cheap.
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.min((seconds * 1000) + 5000, 5 * 60 * 1000);
      }
    }
    return 60 * 1000;
  }

  function withCachedUsageFallback(usage = {}, cachedUsage = null) {
    if ((!usage?._error && !usage?._rateLimited) || !cachedUsage || cachedUsage._error || cachedUsage._rateLimited) return usage;
    const fallbackMessage = usage._rateLimited
      ? 'Usage API rate limited'
      : (usage.message || 'Could not fetch Claude usage data.');
    return {
      ...cachedUsage,
      _stale: true,
      _staleMessage: fallbackMessage,
      _retryAfterSeconds: Math.ceil(getUsageRefreshDelayMs(usage) / 1000),
    };
  }

  // 3-tier colour scale for the status-bar bars: green (ok) → orange (warn) → red
  // (crit). Thresholds are user-configurable (defaults mirror Claude's rough 60/80).
  function usageLevel3(value, warn = 60, crit = 80) {
    const v = Number(value);
    if (!Number.isFinite(v)) return 'ok';
    if (v >= crit) return 'crit';
    if (v >= warn) return 'warn';
    return 'ok';
  }

  // Bars shown inline in the status bar: 5h, 7d, and the extra-usage quota (only when
  // >0%). `thresholds` is keyed by bar key (session / weekAll / extraUsage), each
  // { warn, crit }; missing keys fall back to usageLevel3's defaults. Returns
  // [{ key, label, percent, level }].
  function getUsageBars(usage = {}, thresholds = {}) {
    const th = (key) => thresholds[key] || {};
    const bars = [];
    for (const [key, label] of [['session', '5h'], ['weekAll', '7d']]) {
      const value = pct(usage[key]);
      if (value === null) continue;
      const t = th(key);
      bars.push({ key, label, percent: value, level: usageLevel3(value, t.warn, t.crit) });
    }
    const quotaPct = pct(usage.extraUsage);
    if (quotaPct !== null && quotaPct > 0) {
      const t = th('extraUsage');
      bars.push({ key: 'extraUsage', label: 'Quota', percent: quotaPct, level: usageLevel3(quotaPct, t.warn, t.crit) });
    }
    return bars;
  }

  // Multi-line tooltip: every window with its reset time (24h, already formatted),
  // plus the extra-usage quota with its $ amounts.
  function getUsageTooltip(usage = {}) {
    const lines = ['Claude usage'];
    const rows = [
      ['session', '5h (session)', 'sessionReset'],
      ['weekAll', '7d (all models)', 'weekAllReset'],
      ['weekSonnet', '7d (Sonnet)', 'weekSonnetReset'],
      ['weekOpus', '7d (Opus)', 'weekOpusReset'],
    ];
    for (const [key, label, resetKey] of rows) {
      const value = pct(usage[key]);
      if (value === null) continue;
      const reset = usage[resetKey] ? ` — resets ${usage[resetKey]}` : '';
      lines.push(`${label}: ${value}%${reset}`);
    }
    const quotaPct = pct(usage.extraUsage);
    if (quotaPct !== null) {
      const currency = usage.extraUsageCurrency || 'USD';
      const hasAmounts = usage.extraUsageUsed !== undefined && usage.extraUsageLimit !== undefined;
      const amounts = hasAmounts
        ? ` (${formatMoney(usage.extraUsageUsed, currency)} / ${formatMoney(usage.extraUsageLimit, currency)})`
        : '';
      lines.push(`Extra usage quota: ${quotaPct}%${amounts}`);
    }
    if (usage._stale) lines.push('(cached — usage API unavailable)');
    return lines.join('\n');
  }

  return { formatUsageStatus, getUsageLimitCards, getUsageRefreshDelayMs, withCachedUsageFallback, usageLevel3, getUsageBars, getUsageTooltip };
});
