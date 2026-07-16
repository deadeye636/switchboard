const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldUseSingleInstanceLock } = require('../src/app/lifecycle');

test('single-instance lock is only enabled for packaged builds by default', () => {
  assert.equal(shouldUseSingleInstanceLock({ isPackaged: true, env: {} }), true);
  assert.equal(shouldUseSingleInstanceLock({ isPackaged: false, env: {} }), false);
});

test('single-instance lock can be forced on in development', () => {
  assert.equal(shouldUseSingleInstanceLock({
    isPackaged: false,
    env: { SWITCHBOARD_FORCE_SINGLE_INSTANCE: '1' },
  }), true);
});
