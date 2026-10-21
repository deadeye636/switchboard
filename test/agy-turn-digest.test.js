'use strict';
// #507 T4: agy's `readTurnDigest` — a conversation database as neutral messages, behind a size guard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agy = require('../src/backends/agy');
const parser = require('../src/backends/agy/parser');
const turnDigest = require('../src/backends/agy/turn-digest');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-turn-digest-'));
test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function field1(s) {
  const body = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([0x0a, body.length]), body]);
}
let n = 0;
function makeDb(steps) {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(dir, `conv-${n++}.db`);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB, metadata BLOB)');
  const ins = db.prepare('INSERT INTO steps (idx, step_type, step_payload, metadata) VALUES (?, ?, ?, ?)');
  steps.forEach(([type, text], i) => ins.run(i, type, field1(text), null));
  db.close();
  return file;
}
const turns = (k) => Array.from({ length: k }, (_, i) => [i % 2 ? 15 : 14, `turn ${i} text here`]);

test('user and model turns come out as neutral messages; tool and lifecycle steps do not', async () => {
  const file = makeDb([[14, 'hello world'], [9, 'SECRET-TOOL-STEP list_dir'], [23, 'SECRET-TITLE-STEP'], [15, 'Hi there! How can I help you today?']]);
  const res = await agy.readTurnDigest({ filePath: file }, {});
  assert.equal(res.partial, false);
  assert.deepEqual(res.messages, [{ role: 'user', text: 'hello world' }, { role: 'assistant', text: 'Hi there! How can I help you today?' }]);
  assert.ok(!JSON.stringify(res).includes('SECRET'));
});

test('maxMessages keeps the newest and sets partial', async () => {
  const res = await agy.readTurnDigest({ filePath: makeDb(turns(6)) }, { maxMessages: 2 });
  assert.deepEqual(res.messages.map(m => m.text), ['turn 4 text here', 'turn 5 text here']);
  assert.equal(res.partial, true);
});

test('above the size guard the hook declines and never walks the store', async () => {
  const file = makeDb(turns(4));
  assert.ok(fs.statSync(file).size > 1);
  const real = parser.readMessages;
  let walked = 0;
  parser.readMessages = (...a) => { walked++; return real(...a); };
  try {
    assert.equal(await agy.readTurnDigest({ filePath: file }, { maxBytes: 1 }), null);
    assert.equal(walked, 0, 'no walk above the guard');
    assert.ok(await agy.readTurnDigest({ filePath: file }, {}));
    assert.equal(walked, 1);
  } finally { parser.readMessages = real; }
  assert.ok(turnDigest.MAX_EXPORT_BYTES > 0);
});

test('a missing, empty or unreadable store, no row and an aborted call all answer null', async () => {
  assert.equal(await agy.readTurnDigest({ filePath: path.join(dir, 'gone.db') }, {}), null);
  assert.equal(await agy.readTurnDigest({ filePath: makeDb([]) }, {}), null);
  const junk = path.join(dir, 'junk.db'); fs.writeFileSync(junk, 'not a database');
  assert.equal(await agy.readTurnDigest({ filePath: junk }, {}), null);
  assert.equal(await agy.readTurnDigest({}, {}), null);
  assert.equal(await agy.readTurnDigest(null, {}), null);
  const ac = new AbortController(); ac.abort();
  assert.equal(await agy.readTurnDigest({ filePath: makeDb(turns(2)) }, { signal: ac.signal }), null);
});
