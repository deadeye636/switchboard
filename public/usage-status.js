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
      level: value >= 80 ? 'high' : 'normal',
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
        level: value >= 80 ? 'high' : 'normal',
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
      level: highest >= 80 ? 'high' : 'normal',
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
      if (Number.isFinite(seconds) && seconds > 0) return (seconds * 1000) + 5000;
    }
    return 5 * 60 * 1000;
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

  return { formatUsageStatus, getUsageLimitCards, getUsageRefreshDelayMs, withCachedUsageFallback };
});
