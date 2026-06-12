const test = require('node:test');
const assert = require('node:assert/strict');

const { isSqliteBusy, runWithBusyRetry } = require('../sqlite-busy-retry');

test('isSqliteBusy recognizes busy and locked sqlite errors', () => {
  assert.equal(isSqliteBusy({ code: 'SQLITE_BUSY' }), true);
  assert.equal(isSqliteBusy({ code: 'SQLITE_LOCKED' }), true);
  assert.equal(isSqliteBusy({ message: 'database is locked' }), true);
  assert.equal(isSqliteBusy({ code: 'SQLITE_CONSTRAINT' }), false);
});

test('runWithBusyRetry retries transient busy errors', () => {
  let calls = 0;
  const result = runWithBusyRetry(() => {
    calls++;
    if (calls < 3) {
      const err = new Error('database is locked');
      err.code = 'SQLITE_BUSY';
      throw err;
    }
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('runWithBusyRetry does not retry non-busy errors', () => {
  let calls = 0;
  assert.throws(() => {
    runWithBusyRetry(() => {
      calls++;
      throw new Error('boom');
    });
  }, /boom/);
  assert.equal(calls, 1);
});
