const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldUseSingleInstanceLock } = require('../src/app/lifecycle');

// #220 inverted the dev default. It used to be "packaged only", because a dev lock was believed to hand
// `npm start` to the installed app. #216 gave the dev build its own userData, and Electron scopes the lock
// to userData (verified: two instances on different userData dirs both get the lock; a second on the SAME
// dir is refused and the first sees `second-instance`). So the two locks are different locks, and the
// exemption only ever bought leftover dev runs holding port 9222 and the dev DB.

test('every build takes the single-instance lock by default', () => {
  assert.equal(shouldUseSingleInstanceLock({ isPackaged: true, env: {} }), true);
  assert.equal(shouldUseSingleInstanceLock({ isPackaged: false, env: {} }), true);
});

test('a dev build can opt out to deliberately run two', () => {
  assert.equal(shouldUseSingleInstanceLock({
    isPackaged: false,
    env: { SWITCHBOARD_ALLOW_MULTIPLE_INSTANCES: '1' },
  }), false);
});

test('the packaged app cannot opt out — replacing the binary must not orphan the first run\'s PTYs', () => {
  assert.equal(shouldUseSingleInstanceLock({
    isPackaged: true,
    env: { SWITCHBOARD_ALLOW_MULTIPLE_INSTANCES: '1' },
  }), true);
});

test('the old SWITCHBOARD_FORCE_SINGLE_INSTANCE opt-in is still honoured', () => {
  // Redundant now that dev locks by default, but it is documented and someone's script may set it.
  assert.equal(shouldUseSingleInstanceLock({
    isPackaged: false,
    env: { SWITCHBOARD_FORCE_SINGLE_INSTANCE: '1' },
  }), true);
});

test('forcing the lock on beats asking for multiple instances', () => {
  // Both set is a contradiction; the safe reading wins rather than the last one checked.
  assert.equal(shouldUseSingleInstanceLock({
    isPackaged: false,
    env: { SWITCHBOARD_FORCE_SINGLE_INSTANCE: '1', SWITCHBOARD_ALLOW_MULTIPLE_INSTANCES: '1' },
  }), true);
});

test('only the exact value "1" opts out', () => {
  for (const v of ['0', 'true', '', 'yes']) {
    assert.equal(shouldUseSingleInstanceLock({
      isPackaged: false,
      env: { SWITCHBOARD_ALLOW_MULTIPLE_INSTANCES: v },
    }), true, `SWITCHBOARD_ALLOW_MULTIPLE_INSTANCES=${JSON.stringify(v)} must not opt out`);
  }
});
