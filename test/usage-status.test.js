const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatUsageStatus,
  getUsageLimitCards,
  getUsageRefreshDelayMs,
  withCachedUsageFallback,
  usageLevel3,
  getUsageBars,
  getUsageTooltip,
} = require('../public/usage-status');

test('formatUsageStatus summarizes current usage buckets compactly', () => {
  const result = formatUsageStatus({
    session: 12,
    weekAll: 38,
    weekSonnet: 44,
    weekOpus: 4,
    sessionReset: '1pm (BST)',
  });

  assert.deepEqual(result, {
    text: 'Usage: 5h 12% · 7d 38% · Sonnet 44% · Opus 4%',
    title: 'Current 5-hour usage: 12% · resets 1pm (BST)',
    level: 'normal',
    percent: 44,
  });
});

test('formatUsageStatus marks high usage when any bucket is near the limit', () => {
  const result = formatUsageStatus({ session: 85, weekAll: 42 });

  assert.equal(result.level, 'high');
  assert.equal(result.text, 'Usage: 5h 85% · 7d 42%');
  assert.equal(result.percent, 85);
});

test('formatUsageStatus uses the green→yellow→orange→red four-tier scale', () => {
  // green (normal) below 50%
  assert.equal(formatUsageStatus({ session: 30 }).level, 'normal');
  // yellow (moderate) at 50–79%
  assert.equal(formatUsageStatus({ session: 50 }).level, 'moderate');
  assert.equal(formatUsageStatus({ session: 72 }).level, 'moderate');
  // orange (high) at 80–94%
  assert.equal(formatUsageStatus({ session: 80 }).level, 'high');
  // red (critical) at 95%+
  assert.equal(formatUsageStatus({ session: 96 }).level, 'critical');
});

test('getUsageLimitCards level reflects the four-tier scale per bucket', () => {
  const cards = getUsageLimitCards({ session: 30, weekAll: 60, weekSonnet: 88, weekOpus: 99 });
  assert.deepEqual(cards.map(c => c.level), ['normal', 'moderate', 'high', 'critical']);
});

test('formatUsageStatus shows extra usage quota when rate-limit buckets are unavailable', () => {
  const result = formatUsageStatus({
    extraUsage: 88,
    extraUsageUsed: 176958,
    extraUsageLimit: 200000,
    extraUsageCurrency: 'USD',
  });

  assert.deepEqual(result, {
    text: 'Quota: $1,769.58 / $2,000.00 (88%)',
    title: 'Monthly extra usage quota: $1,769.58 used of $2,000.00',
    level: 'high',
    percent: 88,
  });
});

test('getUsageLimitCards includes quota-only usage as a progress card', () => {
  const result = getUsageLimitCards({
    extraUsage: 91,
    extraUsageUsed: 183546,
    extraUsageLimit: 200000,
    extraUsageCurrency: 'USD',
  });

  assert.deepEqual(result, [{
    key: 'extraUsage',
    label: 'Extra usage quota',
    percent: 91,
    detail: '$1,835.46 / $2,000.00',
    level: 'high',
    reset: null,
  }]);
});

test('formatUsageStatus marks cached usage after an unavailable response', () => {
  const result = formatUsageStatus({
    extraUsage: 88,
    extraUsageUsed: 176958,
    extraUsageLimit: 200000,
    extraUsageCurrency: 'USD',
    _stale: true,
    _staleMessage: 'Could not fetch usage',
    _retryAfterSeconds: 300,
  });

  assert.equal(result.text, 'Quota: $1,769.58 / $2,000.00 (88%)');
  assert.equal(result.level, 'high');
  assert.match(result.title, /Using cached usage/);
  assert.match(result.title, /Retrying in ~5 mins/);
  assert.match(result.title, /Could not fetch usage/);
});

test('withCachedUsageFallback preserves last successful usage on unavailable response', () => {
  const cached = { session: 20, extraUsage: 40 };
  const result = withCachedUsageFallback({ _error: true, message: 'No token' }, cached);

  assert.equal(result.session, 20);
  assert.equal(result.extraUsage, 40);
  assert.equal(result._stale, true);
  assert.equal(result._staleMessage, 'No token');
});

test('withCachedUsageFallback preserves last successful usage on rate limit response', () => {
  const cached = { session: 20, extraUsage: 40 };
  const result = withCachedUsageFallback({ _rateLimited: true, retryAfterSeconds: 120 }, cached);

  assert.equal(result.session, 20);
  assert.equal(result.extraUsage, 40);
  assert.equal(result._stale, true);
  assert.equal(result._staleMessage, 'Usage API rate limited');
  assert.equal(result._retryAfterSeconds, 125);
});

test('formatUsageStatus returns useful rate-limit and error states', () => {
  assert.deepEqual(formatUsageStatus({ _rateLimited: true, retryAfterSeconds: 120 }), {
    text: 'Usage rate limited',
    title: 'Usage API rate limited. Try again in ~2 mins.',
    level: 'warning',
    percent: null,
  });

  assert.deepEqual(formatUsageStatus({ _error: true, message: 'No token' }), {
    text: 'Usage unavailable',
    title: 'No token',
    level: 'warning',
    percent: null,
  });
});

test('usageLevel3 maps to green/orange/red at the configured thresholds', () => {
  assert.equal(usageLevel3(59, 60, 80), 'ok');
  assert.equal(usageLevel3(60, 60, 80), 'warn');
  assert.equal(usageLevel3(79, 60, 80), 'warn');
  assert.equal(usageLevel3(80, 60, 80), 'crit');
  assert.equal(usageLevel3(100, 60, 80), 'crit');
  // custom thresholds
  assert.equal(usageLevel3(50, 40, 70), 'warn');
  assert.equal(usageLevel3(70, 40, 70), 'crit');
});

test('getUsageBars returns 5h + 7d, and quota only when >0%', () => {
  const th = { session: { warn: 60, crit: 80 }, weekAll: { warn: 60, crit: 80 }, extraUsage: { warn: 60, crit: 80 } };
  const bars = getUsageBars({ session: 17, weekAll: 82, extraUsage: 0 }, th);
  assert.deepEqual(bars.map(b => [b.label, b.percent, b.level]), [
    ['5h', 17, 'ok'],
    ['7d', 82, 'crit'],
  ]);

  const withQuota = getUsageBars({ session: 65, extraUsage: 12 }, th);
  assert.deepEqual(withQuota.map(b => [b.label, b.percent, b.level]), [
    ['5h', 65, 'warn'],
    ['Quota', 12, 'ok'],
  ]);

  assert.deepEqual(getUsageBars({}), []);
});

test('getUsageBars applies per-window thresholds (5h vs 7d coloured differently)', () => {
  const bars = getUsageBars({ session: 50, weekAll: 50 }, {
    session: { warn: 40, crit: 90 }, // 50 → orange
    weekAll: { warn: 60, crit: 80 }, // 50 → green
  });
  assert.equal(bars.find(b => b.key === 'session').level, 'warn');
  assert.equal(bars.find(b => b.key === 'weekAll').level, 'ok');
});

test('getUsageTooltip lists every window with reset times and quota amounts', () => {
  const tip = getUsageTooltip({
    session: 17, sessionReset: '14:30 (CEST)',
    weekAll: 7, weekAllReset: 'Jul 8 at 09:00 (CEST)',
    weekSonnet: 3, weekOpus: 12,
    extraUsage: 0, extraUsageUsed: 0, extraUsageLimit: 5000, extraUsageCurrency: 'USD',
  });
  assert.match(tip, /5h \(session\): 17% — resets 14:30 \(CEST\)/);
  assert.match(tip, /7d \(all models\): 7% — resets Jul 8 at 09:00 \(CEST\)/);
  assert.match(tip, /7d \(Sonnet\): 3%/);
  assert.match(tip, /7d \(Opus\): 12%/);
  assert.match(tip, /Extra usage quota: 0% \(\$0\.00 \/ \$50\.00\)/);
});

test('getUsageRefreshDelayMs respects usage API retry-after windows', () => {
  assert.equal(getUsageRefreshDelayMs({ _rateLimited: true, retryAfterSeconds: 120 }), 125000);
  // Large retry-after windows are capped at 5 minutes so usage never freezes for an hour.
  assert.equal(getUsageRefreshDelayMs({ _rateLimited: true, retryAfterSeconds: 3600 }), 300000);
  assert.equal(getUsageRefreshDelayMs({ session: 12 }), 60000);
  assert.equal(getUsageRefreshDelayMs({ _error: true }), 60000);
});
