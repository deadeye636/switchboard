'use strict';
// #507 T4: Hermes' `readTurnDigest` — its SQLite session as neutral messages, through the viewer's reader.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hermes = require('../src/backends/hermes');
const turnDigest = require('../src/backends/hermes/turn-digest');
const { makeHermesHome } = require('./fixtures/hermes-fixture');

const home = makeHermesHome();
hermes.setHome(home);
test.after(() => { hermes.setHome(null); fs.rmSync(home, { recursive: true, force: true }); });

test('a tool-using session gives user and assistant text only, as neutral messages', async () => {
  const res = await hermes.readTurnDigest({ sessionId: 'sess-tool-turn' }, {});
  assert.equal(res.partial, false);
  assert.deepEqual(res.messages.map(m => [m.role, m.text]), [
    ['user', 'List the files here and read one.txt.'],
    ['assistant', 'Two files. one.txt says: alpha'],
  ]);
  const all = JSON.stringify(res);
  assert.ok(!all.includes('total_count'), 'tool results never reach the digest');
  assert.match(res.messages[0].at, /^\d{4}-\d\d-\d\dT/);
});

test('maxMessages keeps the newest and sets partial', async () => {
  const res = await hermes.readTurnDigest({ sessionId: 'sess-tool-turn' }, { maxMessages: 1 });
  assert.deepEqual(res.messages.map(m => m.text), ['Two files. one.txt says: alpha']);
  assert.equal(res.partial, true);
});

test('the read is bounded by a row limit of one more than wanted, never the whole store', async () => {
  const reader = require('../src/backends/hermes/reader');
  const real = reader.readMessages;
  const seen = [];
  reader.readMessages = (id, o) => { seen.push(o.limit); return real(id, o); };
  try {
    await hermes.readTurnDigest({ sessionId: 'sess-tool-turn' }, { maxMessages: 3 });
    await hermes.readTurnDigest({ sessionId: 'sess-tool-turn' }, { maxMessages: 1e9 });
    await hermes.readTurnDigest({ sessionId: 'sess-tool-turn' }, {});
  } finally { reader.readMessages = real; }
  assert.deepEqual(seen, [4, turnDigest.MAX_READ_MESSAGES + 1, turnDigest.MAX_READ_MESSAGES + 1]);
});

test('a missing session, an empty id, no row and an aborted call all answer null', async () => {
  assert.equal(await hermes.readTurnDigest({ sessionId: 'no-such-session' }, {}), null);
  assert.equal(await hermes.readTurnDigest({}, {}), null);
  assert.equal(await hermes.readTurnDigest(null, {}), null);
  const ac = new AbortController(); ac.abort();
  assert.equal(await hermes.readTurnDigest({ sessionId: 'sess-tool-turn' }, { signal: ac.signal }), null);
});

test('a missing store answers null', async () => {
  hermes.setHome(path.join(os.tmpdir(), 'hermes-gone-' + Date.now()));
  try { assert.equal(await hermes.readTurnDigest({ sessionId: 'sess-tool-turn' }, {}), null); } finally { hermes.setHome(home); }
});
