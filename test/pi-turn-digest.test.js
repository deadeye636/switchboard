'use strict';
// #507 T3: Pi's `readTurnDigest` — its session file as neutral messages, from one bounded tail read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fileStore = require('../src/backends/file-store');
const backends = require('../src/backends');
const pi = require('../src/backends/pi');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-turn-digest-'));
test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function write(lines) {
  const file = path.join(dir, `s${n++}.jsonl`);
  fs.writeFileSync(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}
// Entries chain through parentId the way Pi writes them.
let seq = 0;
function chain(messages) {
  let parent = null;
  return messages.map((message) => {
    const id = `e${seq++}`;
    const entry = { type: 'message', id, parentId: parent, timestamp: '2026-01-01T00:00:00Z', message };
    parent = id;
    return entry;
  });
}
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (...content) => ({ role: 'assistant', content });

test('a small session is answered whole, not partial, as neutral messages', async () => {
  const file = write([
    { type: 'session', id: 's', cwd: '/p', timestamp: '2026-01-01T00:00:00Z' },
    ...chain([
      user('fix the bug'),
      assistant({ type: 'thinking', thinking: 'SECRET-REASONING' }, { type: 'text', text: 'Looking.' },
        { type: 'toolCall', id: 't1', name: 'read', arguments: { path: '/p/a.txt' } }),
      { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'SECRET-TOOL-OUTPUT' }] },
      { role: 'bashExecution', command: 'ls', output: 'SECRET-BASH' },
      assistant({ type: 'text', text: 'Done.' }),
    ]),
  ]);
  const res = await pi.readTurnDigest({ filePath: file }, {});
  assert.equal(res.partial, false);
  assert.deepEqual(res.messages.map(m => [m.role, m.text]), [['user', 'fix the bug'], ['assistant', 'Looking.'], ['assistant', 'Done.']]);
  assert.deepEqual(res.messages[1].tools, ['Read']);
  const all = JSON.stringify(res);
  for (const s of ['SECRET-REASONING', 'SECRET-TOOL-OUTPUT', 'SECRET-BASH']) {
    assert.ok(!all.includes(s), `${s} never reaches the digest`);
  }
});

test('an unknown record kind is skipped, not thrown', async () => {
  const file = write([
    ...chain([user('kept')]),
    { type: 'future_kind', id: 'zz', parentId: 'e-none', message: { role: 'user', content: 'UNKNOWN-KIND' } },
    'not json at all',
  ]);
  const res = await pi.readTurnDigest({ filePath: file }, {});
  assert.ok(!JSON.stringify(res).includes('UNKNOWN-KIND'));
});

test('a session larger than the window is partial, reads at most the cap, and starts on a whole line', async () => {
  const filler = 'x'.repeat(2000);
  const msgs = [];
  for (let i = 0; i < 400; i++) msgs.push(user(`q${i} ${filler}`), assistant({ type: 'text', text: `a${i}` }));
  const file = write(chain(msgs));
  assert.ok(fs.statSync(file).size > fileStore.MAX_TAIL_BYTES);
  const asked = [];
  const real = fileStore.readFileTailAsync;
  fileStore.readFileTailAsync = (f, bytes) => { asked.push(bytes); return real(f, bytes); };
  let res;
  try { res = await pi.readTurnDigest({ filePath: file }, {}); } finally { fileStore.readFileTailAsync = real; }
  assert.deepEqual(asked, [fileStore.MAX_TAIL_BYTES], 'one read, at the cap');
  assert.equal(res.partial, true);
  assert.ok(res.messages.length > 0);
  assert.equal(res.messages[res.messages.length - 1].text, 'a399');
  assert.match(res.messages[0].text, /^(q\d+ x{2000}|a\d+)$/);
});

test('maxMessages keeps the newest and says older ones were left out', async () => {
  const file = write(chain([user('one'), assistant({ type: 'text', text: 'two' }), user('three')]));
  const res = await pi.readTurnDigest({ filePath: file }, { maxMessages: 2 });
  assert.deepEqual(res.messages.map(m => m.text), ['two', 'three']);
  assert.equal(res.partial, true);
});

test('a missing file, no row and an aborted signal answer null', async () => {
  assert.equal(await pi.readTurnDigest({ filePath: path.join(dir, 'gone.jsonl') }, {}), null);
  assert.equal(await pi.readTurnDigest(null, {}), null);
  const ac = new AbortController();
  ac.abort();
  assert.equal(await pi.readTurnDigest({ filePath: write(chain([user('x')])) }, { signal: ac.signal }), null);
});

test('pi-native forwards the hook', () => {
  assert.equal(backends.get('pi-native').readTurnDigest, pi.readTurnDigest);
});
