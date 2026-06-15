const test = require('node:test');
const assert = require('node:assert/strict');

const { transformUsageResponse } = require('../claude-auth');

test('transformUsageResponse maps extra usage quota fields', () => {
  const usage = transformUsageResponse({
    five_hour: null,
    extra_usage: {
      is_enabled: true,
      monthly_limit: 200000,
      used_credits: 176958,
      utilization: 88.479,
      currency: 'USD',
      disabled_reason: null,
    },
  });

  assert.deepEqual(usage, {
    extraUsageEnabled: true,
    extraUsageLimit: 200000,
    extraUsageUsed: 176958,
    extraUsage: 88,
    extraUsageCurrency: 'USD',
  });
});
