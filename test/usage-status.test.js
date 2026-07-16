const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatUsageStatus,
  getUsageLimitCards,
  getUsageRefreshDelayMs,
  getUsagePollDelayMs,
  usageLevel3,
  getUsageBars,
  getUsageTooltip,
  selectedUsageBackends,
  isStaleReading,
} = require('../src/renderer/shell/usage-status');

// One backend's reading, in the shape every backend now reports (#191). Nothing in here names a window:
// the labels and tiers come from the backend, which is what lets Codex's derived windows — and, later,
// Antigravity's per-model quotas — render without a line changing in this module.
const claude = () => ({
  backendId: 'claude',
  label: 'Claude Code',
  live: true,
  buckets: [
    { key: 'session', label: '5h', percent: 12, reset: '13:00 (BST)', tier: 'short', bar: true, cardLabel: 'Current session' },
    { key: 'weekAll', label: '7d', percent: 38, tier: 'long', bar: true, cardLabel: 'Week (all models)' },
    { key: 'weekSonnet', label: 'Sonnet', percent: 44, tier: 'long', bar: false, cardLabel: 'Week (Sonnet)' },
  ],
  quota: null,
});

test('the bar shows only the buckets the backend flagged for it', () => {
  const bars = getUsageBars(claude());
  // Sonnet reports a percentage but is not a bar — four windows wide would cost more than it tells you.
  assert.deepEqual(bars.map(b => b.label), ['5h', '7d']);
  assert.deepEqual(bars.map(b => b.percent), [12, 38]);
});

test('thresholds are keyed by TIER, not by a window name', () => {
  // A short-cycle bucket at 65% is already amber; a long-cycle one at 65% is not. Same number, different
  // meaning — and a backend that invents its own windows still gets coloured, because it declares a tier.
  const bars = getUsageBars({
    backendId: 'codex',
    buckets: [
      { key: 'primary', label: '5h', percent: 65, tier: 'short', bar: true },
      { key: 'secondary', label: '7d', percent: 65, tier: 'long', bar: true },
    ],
  }, { short: { warn: 60, crit: 80 }, long: { warn: 75, crit: 90 } });

  assert.equal(bars[0].level, 'warn');
  assert.equal(bars[1].level, 'ok');
});

test('a quota bar appears only when the pool has actually been used', () => {
  const withQuota = (percent) => getUsageBars({ buckets: [], quota: { percent, currency: 'USD' } });
  assert.deepEqual(withQuota(0).map(b => b.key), []);       // 0% is not worth a bar
  assert.deepEqual(withQuota(7).map(b => b.key), ['quota']);
});

test('Stats cards carry every bucket, not just the two in the bar', () => {
  const cards = getUsageLimitCards(claude());
  assert.deepEqual(cards.map(c => c.label), ['Current session', 'Week (all models)', 'Week (Sonnet)']);
  assert.equal(cards[0].reset, '13:00 (BST)');
});

test('the quota card shows its amounts', () => {
  const cards = getUsageLimitCards({
    buckets: [],
    quota: { percent: 88, used: 176958, limit: 200000, currency: 'USD' },
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].label, 'Extra usage quota');
  assert.equal(cards[0].percent, 88);
  assert.match(cards[0].detail, /1,769\.58/);   // credits are cents
});

test('the tooltip names the backend, and says so when the figure is not live', () => {
  const live = getUsageTooltip(claude());
  assert.match(live, /^Claude Code\n/);
  assert.doesNotMatch(live, /as of its last run/);

  const codex = getUsageTooltip({
    backendId: 'codex', label: 'Codex', live: false,
    observedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    buckets: [{ key: 'primary', label: '5h', percent: 4, tier: 'short', bar: true, cardLabel: 'Window (5h)' }],
  });
  assert.match(codex, /^Codex \(as of its last run\)/);
  assert.match(codex, /Measured 3 hours ago\./);
});

test('a cached reading says why it is cached and when it will be tried again', () => {
  // Dimming a number without saying what went wrong just makes it look broken. The point of falling back
  // to the last good reading is that it stays usable while being visibly not fresh.
  const tip = getUsageTooltip({
    ...claude(),
    _stale: true,
    _staleMessage: 'Usage API rate limited',
    _retryAfterSeconds: 125,
  });
  assert.match(tip, /Cached — the last fetch failed\./);
  assert.match(tip, /Retrying in ~3 mins\./);
  assert.match(tip, /Last error: Usage API rate limited/);
});

test('a non-live reading goes stale with age; a live one never does', () => {
  const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  assert.equal(isStaleReading({ live: false, observedAt: old }), true);
  assert.equal(isStaleReading({ live: false, observedAt: new Date().toISOString() }), false);
  // Claude's is fetched on every poll — it is never "as of" anything.
  assert.equal(isStaleReading({ live: true, observedAt: old }), false);
});

test('a backend with nothing to draw states which backend it is', () => {
  // "Usage unavailable" beside a healthy segment tells you nothing about whose it is.
  assert.equal(formatUsageStatus({ label: 'Codex', _error: true, message: 'boom' }).text, 'Codex: unavailable');
  assert.equal(formatUsageStatus({ label: 'Codex', _rateLimited: true }).text, 'Codex: rate limited');
  // Installed, switched on, never run. NOT an error, and never a fabricated 0%.
  const noData = formatUsageStatus({ label: 'Codex', _noData: true });
  assert.equal(noData.text, 'Codex: no data yet');
  assert.equal(noData.level, 'empty');
});

test('an absent tick shows the segment; only an explicit false hides it', () => {
  const payload = { backends: [{ backendId: 'claude' }, { backendId: 'codex' }] };
  // Nothing decided yet → both show. This is why the stored value is a map and not a list: dropping a
  // key would be indistinguishable from deciding against it.
  assert.deepEqual(selectedUsageBackends(payload, {}).map(u => u.backendId), ['claude', 'codex']);
  assert.deepEqual(selectedUsageBackends(payload, { codex: false }).map(u => u.backendId), ['claude']);
  assert.deepEqual(selectedUsageBackends(payload, { codex: true }).map(u => u.backendId), ['claude', 'codex']);
});

test('the poll interval is the shortest any backend asks for', () => {
  assert.equal(getUsageRefreshDelayMs({ _rateLimited: true, retryAfterSeconds: 120 }), 125000);
  // Capped: a very long retry-after must not freeze the bar for the better part of an hour.
  assert.equal(getUsageRefreshDelayMs({ _rateLimited: true, retryAfterSeconds: 3600 }), 300000);
  assert.equal(getUsageRefreshDelayMs({ buckets: [] }), 60000);

  // A rate-limited Claude must not slow Codex's file read down to its backoff, and a healthy Codex must
  // not drag Claude's backoff down to 60s either — the bar polls at the shortest ask and each backend's
  // own state decides what it gets.
  assert.equal(getUsagePollDelayMs({ backends: [{ _rateLimited: true, retryAfterSeconds: 3600 }, { buckets: [] }] }), 60000);
  assert.equal(getUsagePollDelayMs({ backends: [] }), 60000);
});

test('usageLevel3 keeps its 3-tier scale', () => {
  assert.equal(usageLevel3(10, 60, 80), 'ok');
  assert.equal(usageLevel3(60, 60, 80), 'warn');
  assert.equal(usageLevel3(80, 60, 80), 'crit');
});
