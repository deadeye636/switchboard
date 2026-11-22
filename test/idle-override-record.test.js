'use strict';
// The stored shape of a session's idle-maintenance override (src/db/idle-override-record.js, spec 45 O2).
const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanIdleOverride } = require('../src/db/idle-override-record');

test('only idleMaintenance keys with a plain value survive', () => {
  assert.deepEqual(
    cleanIdleOverride({ idleMaintenanceMode: 'warm', idleMaintenanceRefreshLimit: 3, idleMaintenanceBestEffortCompact: true, other: 'x' }),
    { idleMaintenanceMode: 'warm', idleMaintenanceRefreshLimit: 3, idleMaintenanceBestEffortCompact: true },
  );
  assert.deepEqual(cleanIdleOverride({ idleMaintenanceMode: { a: 1 }, idleMaintenanceIdleMinutes: Infinity, idleMaintenanceRefreshMinutes: 5 }),
    { idleMaintenanceRefreshMinutes: 5 });
  assert.deepEqual(cleanIdleOverride({ idleMaintenanceMode: 'x'.repeat(33) }), null);
});

test('nothing left, or no object, is null', () => {
  for (const v of [null, undefined, 'warm', 3, [], {}, { other: 1 }]) assert.equal(cleanIdleOverride(v), null);
});
